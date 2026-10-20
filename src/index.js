// index.js - 메인 서버
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const crypto = require('crypto');

const { crawlAll, crawlSite, ensureRegion, discoverAndSave } = require('./crawler');
const { notifyNewNotices, pushEnabled, VAPID_PUBLIC } = require('./notifier');
const { naverEnabled } = require('./naver');
const { DEFAULT_REGIONS, KEYWORDS } = require('./sites.config');
const { findRegion } = require('./discover');
const { eminwonListUrl } = require('./scanner');
const {
  getNotices, getCrawlStats,
  addSubscription, removeSubscription, markAsRead, deleteNotice,
  addUserSite, getUserSites, removeUserSite,
  getRegion, getRegions, removeRegion, getSources, getMeta,
  db,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_REGIONS = 300;

app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const ok = (res, body = {}) => res.json({ ok: true, ...body });
const fail = (res, err, code = 500) => res.status(code).json({ ok: false, error: err.message || String(err) });

// 크롤 후 새 공고 웹푸시 (VAPID 설정 시)
async function crawlAndNotify() {
  const before = db.prepare(`SELECT MAX(created_at) as t FROM notices`).get().t || 0;
  const result = await crawlAll();
  if (result.totalNew > 0) {
    const newItems = db.prepare(`SELECT * FROM notices WHERE created_at > ? ORDER BY created_at DESC`).all(before);
    await notifyNewNotices(newItems);
  }
  return result;
}

function runInBackground(label) {
  crawlAndNotify().catch(err => console.error(`${label} 크롤 실패:`, err));
}

// ========== 공고 API ==========

app.get('/api/notices', (req, res) => {
  try {
    const { region, search, limit, offset, since } = req.query;
    const notices = getNotices({
      region, search,
      limit: Math.min(limit ? parseInt(limit) : 100, 500),
      offset: offset ? parseInt(offset) : 0,
      since: since ? parseInt(since) : undefined,
    });
    ok(res, { count: notices.length, notices });
  } catch (err) { fail(res, err); }
});

app.post('/api/notices/:id/read', (req, res) => {
  try { markAsRead(req.params.id); ok(res); } catch (err) { fail(res, err); }
});

app.delete('/api/notices/:id', (req, res) => {
  try {
    if (!deleteNotice(req.params.id)) return res.status(404).json({ ok: false, error: 'notice not found' });
    ok(res);
  } catch (err) { fail(res, err); }
});

// 수동 크롤 (?async=1 이면 바로 응답하고 백그라운드 실행 - 외부 스케줄러용)
app.post('/api/crawl', async (req, res) => {
  try {
    if (req.query.async) { runInBackground('수동'); return ok(res, { started: true }); }
    ok(res, await crawlAndNotify());
  } catch (err) { fail(res, err); }
});
app.get('/api/crawl', (req, res) => { runInBackground('수동(GET)'); ok(res, { started: true }); });

// ========== 🆕 지역 API (지역 이름만 넣으면 자동 연결) ==========

function regionView(r) {
  return {
    name: r.name, fullName: r.full_name, domain: r.domain,
    status: r.status, message: r.message, discoveredAt: r.discovered_at,
    isDefault: DEFAULT_REGIONS.includes(r.name),
    sources: getSources(r.name).map(s => ({
      kind: s.kind, name: s.name, url: s.url, status: s.status,
      // 사람이 열어볼 수 있는 목록 페이지 주소 (새올은 origin 만 저장돼 있으므로 목록 주소로 변환)
      link: s.kind === 'eminwon' ? eminwonListUrl(s.url, 10) : s.url,
      rows: s.rows_last, found: s.found_last, error: s.last_error, lastRun: s.last_run,
    })),
  };
}

app.get('/api/regions', (req, res) => {
  try { ok(res, { regions: getRegions().map(regionView) }); } catch (err) { fail(res, err); }
});

// 지역 하나 추가 → 즉시 자동 탐색 (최대 1분 정도 걸릴 수 있음)
app.post('/api/regions', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return fail(res, new Error('지역 이름이 필요합니다'), 400);
    if (!getRegion(name) && getRegions().length >= MAX_REGIONS) return fail(res, new Error('등록 가능한 지역 수를 초과했습니다'), 400);
    const row = ensureRegion(name);
    if (row.name !== name) {
      // 이미 같은 지자체가 등록돼 있음 → 그 지역 정보를 그대로 돌려줌
      return ok(res, { region: { ...regionView(row), name, sameAs: row.name }, log: [] });
    }
    const result = await discoverAndSave(name);
    runInBackground('지역 추가'); // 새 지역 바로 크롤
    ok(res, { region: regionView(getRegion(name)), log: result.log });
  } catch (err) { fail(res, err); }
});

app.post('/api/regions/:name/rediscover', async (req, res) => {
  try {
    if (!getRegion(req.params.name)) return fail(res, new Error('region not found'), 404);
    const result = await discoverAndSave(req.params.name);
    ok(res, { region: regionView(getRegion(req.params.name)), log: result.log });
  } catch (err) { fail(res, err); }
});

app.delete('/api/regions/:name', (req, res) => {
  try {
    if (DEFAULT_REGIONS.includes(req.params.name)) return fail(res, new Error('기본 지역은 삭제할 수 없습니다'), 400);
    removeRegion(req.params.name);
    ok(res);
  } catch (err) { fail(res, err); }
});

// 지역 이름 미리 확인 (자동 연결 가능한 지자체인지)
app.get('/api/regions/lookup', (req, res) => {
  const r = findRegion(req.query.name);
  ok(res, { found: !!r, region: r || null });
});

// ========== 🆕 앱 동기화 ==========
// 앱이 가진 지역/사이트 목록을 올려서 서버 DB 초기화(재배포·재시작)에도 자동 복구
app.post('/api/sync', (req, res) => {
  try {
    const regions = Array.isArray(req.body && req.body.regions) ? req.body.regions : [];
    const sites = Array.isArray(req.body && req.body.sites) ? req.body.sites : [];
    let added = 0;
    for (const raw of regions.slice(0, MAX_REGIONS)) {
      const name = String(raw || '').trim();
      if (!name || name === '전체') continue;
      if (!getRegion(name)) {
        if (getRegions().length >= MAX_REGIONS) break;
        ensureRegion(name); added++;
      }
    }
    const siteIds = [];
    for (const s of sites.slice(0, 200)) {
      if (!s || !s.region || !s.name || !s.url) continue;
      const url = normalizeUrl(s.url);
      const id = userSiteId(url, s.name);
      addUserSite({ id, region: s.region, name: s.name, url, type: s.type });
      siteIds.push({ url: s.url, name: s.name, serverId: id });
    }
    if (added > 0) runInBackground('동기화');
    ok(res, { added, sites: siteIds, regions: getRegions().map(regionView) });
  } catch (err) { fail(res, err); }
});

// ========== 상태 ==========

app.get('/api/stats', (req, res) => {
  try {
    const totalNotices = db.prepare(`SELECT COUNT(*) as c FROM notices`).get().c;
    const recent24h = db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`).get(Date.now() - 86400000).c;
    const recent7d = db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`).get(Date.now() - 7 * 86400000).c;
    const sources = getSources();
    ok(res, {
      totalNotices, recent24h, recent7d,
      lastCrawl: Number(getMeta('last_crawl') || 0) || null,
      regions: getRegions().length,
      sourcesOk: sources.filter(s => s.status === 'ok').length,
      sourcesProblem: sources.filter(s => s.status === 'empty' || s.status === 'error').length,
      sites: getCrawlStats(),
      subscriptions: db.prepare(`SELECT COUNT(*) as c FROM subscriptions`).get().c,
      userSites: db.prepare(`SELECT COUNT(*) as c FROM user_sites`).get().c,
      pushEnabled, naverEnabled, keywords: KEYWORDS,
    });
  } catch (err) { fail(res, err); }
});

// 사람이 보기 쉬운 점검 페이지
app.get('/status', (req, res) => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (t) => t ? new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-';
  const rows = getRegions().map(r => {
    const src = getSources(r.name).map(s =>
      `<div class="${s.status}">${esc(s.kind === 'eminwon' ? '고시공고' : '게시판')} · ${esc(s.status || '대기')} · 목록 ${s.rows_last || 0}줄 · 발견 ${s.found_last || 0}${s.last_error ? ' · ' + esc(s.last_error) : ''}<br><small>${esc(s.url)}</small></div>`).join('');
    let dlog = [];
    try { dlog = JSON.parse(getMeta('discover_log:' + r.name) || '[]'); } catch {}
    const logHtml = dlog.length ? `<details><summary><small>탐색 기록</small></summary><small>${dlog.map(esc).join('<br>')}</small></details>` : '';
    return `<tr><td><b>${esc(r.name)}</b><br><small>${esc(r.domain || '')}</small></td><td class="${esc(r.status)}">${esc(r.message || r.status)}${logHtml}</td><td>${src || '-'}</td></tr>`;
  }).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>푸드트럭 알리미 서버 상태</title>
<style>body{font-family:sans-serif;margin:16px;font-size:14px}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:6px;vertical-align:top}
.ok{color:#15803d}.partial,.empty{color:#b45309}.failed,.error,.unknown{color:#b91c1c}small{color:#666;word-break:break-all}</style>
<h2>🚚 서버 상태</h2><p>마지막 크롤: ${fmt(Number(getMeta('last_crawl') || 0))} · 네이버 보조검색: ${naverEnabled ? '켜짐' : '꺼짐'}</p>
<table><tr><th>지역</th><th>연결 상태</th><th>크롤 대상</th></tr>${rows}</table>`);
});

// ========== 푸시 알림 API (웹 브라우저용) ==========

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null, enabled: pushEnabled });
});

app.post('/api/subscribe', (req, res) => {
  try {
    const { subscription, regions } = req.body;
    if (!subscription || !subscription.endpoint) return fail(res, new Error('invalid subscription'), 400);
    addSubscription({ ...subscription, regions: regions || [] });
    ok(res);
  } catch (err) { fail(res, err); }
});

app.post('/api/unsubscribe', (req, res) => {
  try { removeSubscription(req.body.endpoint); ok(res); } catch (err) { fail(res, err); }
});

// ========== 사용자 직접 등록 사이트 API ==========

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
function userSiteId(url, name) {
  return 'usr_' + crypto.createHash('md5').update(url + '|' + name).digest('hex').slice(0, 12);
}

app.post('/api/user-sites', async (req, res) => {
  try {
    const { region, name, url, type } = req.body;
    if (!region || !name || !url) return fail(res, new Error('지역, 이름, URL 모두 필요'), 400);
    const normalizedUrl = normalizeUrl(url);
    const id = userSiteId(normalizedUrl, name);
    addUserSite({ id, region, name, url: normalizedUrl, type: type || '관공서' });
    const userSite = { id, region, name, url: normalizedUrl, type };
    // 바로 한 번 읽어서 결과를 알려줌 (게시판 목록 주소가 맞는지 확인용)
    const result = await crawlSite(userSite, true);
    ok(res, {
      id, rows: result.rows || 0, found: result.found || 0, error: result.error || null,
      message: result.error ? `접속 실패: ${result.error}`
        : result.rows > 0 ? `게시글 ${result.rows}개 인식, 자동 크롤링 시작`
        : '페이지는 열렸지만 게시글 목록을 못 찾았어요. 게시판 "목록" 페이지 주소인지 확인해 주세요.',
    });
  } catch (err) { fail(res, err); }
});

app.get('/api/user-sites', (req, res) => {
  try { const sites = getUserSites(); ok(res, { count: sites.length, sites }); } catch (err) { fail(res, err); }
});

app.delete('/api/user-sites/:id', (req, res) => {
  try { removeUserSite(req.params.id); ok(res); } catch (err) { fail(res, err); }
});

app.post('/api/user-sites/:id/crawl', async (req, res) => {
  try {
    const userSite = db.prepare(`SELECT * FROM user_sites WHERE id = ?`).get(req.params.id);
    if (!userSite) return fail(res, new Error('site not found'), 404);
    ok(res, await crawlSite(userSite, true));
  } catch (err) { fail(res, err); }
});

// ========== 헬스체크 ==========

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), lastCrawl: Number(getMeta('last_crawl') || 0) || null });
});

// ========== 스케줄러 ==========
// 매일 정해진 시각(한국시간)에만 수집. 기본: 오전 10시, 오후 2시, 오후 5시
// 무료 서버는 잠들어 있으면 예약이 안 돌기 때문에, 깃허브 Actions(.github/workflows/crawl-schedule.yml)가
// 같은 시각에 /api/crawl 을 호출해서 서버를 깨움. 놓친 시각이 있으면 깨어나자마자 수집.
const CRAWL_HOURS = (process.env.CRAWL_HOURS || '10,14,17')
  .split(',').map(h => parseInt(h, 10)).filter(h => h >= 0 && h < 24).sort((a, b) => a - b);
const CRON_SCHEDULE = process.env.CRAWL_CRON || `0 ${CRAWL_HOURS.join(',')} * * *`;
cron.schedule(CRON_SCHEDULE, () => runInBackground('스케줄'), { timezone: 'Asia/Seoul' });
console.log(`⏰ 스케줄러 등록됨: ${CRON_SCHEDULE} (Asia/Seoul)`);

// 가장 최근의 수집 예정 시각 (ms). 한국시간 기준
const KST = 9 * 3600000;
function latestSlot(now = Date.now()) {
  const k = new Date(now + KST);
  const dayStart = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST;
  const hour = k.getUTCHours();
  const todays = CRAWL_HOURS.filter(h => h <= hour);
  if (todays.length) return dayStart + todays[todays.length - 1] * 3600000;
  return dayStart - 86400000 + CRAWL_HOURS[CRAWL_HOURS.length - 1] * 3600000; // 어제 마지막 시각
}

// 놓친 수집 보정: 마지막 수집이 가장 최근 예정 시각보다 이전이면 실행
function catchUp(label) {
  const last = Number(getMeta('last_crawl') || 0);
  if (last < latestSlot()) runInBackground(label);
}
setInterval(() => catchUp('놓친 수집 보정'), 10 * 60000).unref();

// ========== 서버 시작 ==========

app.listen(PORT, () => {
  console.log(`\n🚚 푸드트럭 알리미 서버 실행중`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   상태 페이지: http://localhost:${PORT}/status\n`);

  // 재배포·재시작 직후: 서버 DB가 비어 있으면 바로 수집, 아니면 놓친 시각만 보정
  setTimeout(() => {
    if (process.env.CRAWL_ON_START === 'true' || !getMeta('last_crawl')) runInBackground('시작');
    else catchUp('시작 보정');
  }, 5000);
});

process.on('SIGTERM', () => {
  console.log('서버 종료중...');
  db.close();
  process.exit(0);
});
