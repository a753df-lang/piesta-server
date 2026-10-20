// crawler.js v4 - 지역 자동 탐색 + 범용 스캐너 + 자가 복구
//  - 지역마다 고시공고(새올)·공지사항을 자동으로 찾아 크롤링
//  - 게시판 줄을 하나도 못 읽으면 'empty' 로 기록 (조용히 0건 처리하지 않음)
//  - 12회 연속 실패/빈 결과면 해당 지역을 다시 탐색 (홈페이지 개편 자동 대응)
const crypto = require('crypto');
const { SITES, KEYWORDS, DEFAULT_REGIONS } = require('./sites.config');
const {
  fetchPage, scanBoard, parseEminwon, eminwonListUrl, makeKeywordMatcher, sleep,
} = require('./scanner');
const { findRegion, shortName, discoverRegion } = require('./discover');
const naver = require('./naver');
const {
  upsertNotice, logCrawlStart, logCrawlEnd, pruneCrawlLog, pruneOldNotices,
  getUserSites, updateUserSiteStatus,
  getRegion, getRegions, addRegion, setRegionStatus,
  replaceSources, getSources, updateSourceResult,
  getMeta, setMeta,
} = require('./db');

const isFoodTruckRelated = makeKeywordMatcher(KEYWORDS);
const DELAY = 1200;
const REDISCOVER_AFTER_FAILS = 12;           // 매시간 크롤 기준 약 12시간
const REDISCOVER_INTERVAL = 7 * 86400000;    // 정상이어도 7일마다 재탐색
const RETRY_FAILED_DISCOVERY = 6 * 3600000;  // 탐색 실패 지역은 6시간 뒤 재시도
const NAVER_INTERVAL = 3 * 3600000;
// 등록일이 이보다 오래된 공고는 저장·알림하지 않음 (기본 30일, 환경변수 MAX_AGE_DAYS 로 조정)
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || '30', 10);

function cutoffDate() {
  const d = new Date(Date.now() + 9 * 3600000 - MAX_AGE_DAYS * 86400000); // 한국시간 기준 날짜
  return d.toISOString().slice(0, 10);
}
// 등록일을 모르는 공고는 일단 통과 (날짜 없는 게시판 대비)
function isRecent(item) {
  return !item.date || item.date >= cutoffDate();
}

function makeNoticeId(siteId, url, title) {
  const hash = crypto.createHash('md5').update(url + '|' + title).digest('hex').slice(0, 12);
  return `${siteId}_${hash}`;
}

function toNotice(siteId, region, org, item, fallbackUrl) {
  const url = item.url || fallbackUrl;
  return {
    id: makeNoticeId(siteId, url, item.title),
    site_id: siteId, region, org,
    title: item.title, url,
    posted_date: item.date || null,
    raw_text: item.title,
  };
}

function saveItems(items) {
  let newCount = 0;
  for (const n of items) if (upsertNotice(n).isNew) newCount++;
  return newCount;
}

// ========== 지역 ==========

// 지역을 DB에 등록 (없으면). 반환: DB row
function ensureRegion(name) {
  let row = getRegion(name);
  if (row) return row;
  const info = findRegion(name);
  addRegion({ name, full_name: info ? info.name : null, domain: info ? info.domain : null });
  if (!info) setRegionStatus(name, 'unknown', '전국 지자체 목록에 없는 이름입니다. 사이트를 직접 추가해 주세요.');
  return getRegion(name);
}

// 지역 대상 사이트 자동 탐색 후 저장. 반환: { status, message, sources, log }
async function discoverAndSave(name) {
  const row = ensureRegion(name);
  if (!row.domain) {
    return { status: 'unknown', message: row.message, sources: [], log: [] };
  }
  const result = await discoverRegion({ name: row.full_name, domain: row.domain });
  const gov = result.sources.filter(s => s.group !== 'related');
  const relatedNames = [...new Set(result.sources.filter(s => s.group === 'related').map(s => s.name.replace(/\s\d+$/, '')))];
  const hasGosi = gov.some(s => s.kind === 'eminwon' || /고시공고/.test(s.name));
  const hasNotice = gov.some(s => /공지사항/.test(s.name));
  const govParts = [hasGosi && '고시공고', hasNotice && '공지사항'].filter(Boolean);
  const summary = [govParts.length ? '시청 ' + govParts.join('·') : '', relatedNames.join(', ')].filter(Boolean).join(' + ');
  let status, message;
  if (hasGosi && hasNotice) { status = 'ok'; message = `${summary} 자동 연결됨`; }
  else if (result.sources.length) {
    status = 'partial';
    const missing = ['고시공고', '공지사항'].filter(x => !govParts.includes(x)).join('·');
    message = `${summary} 연결됨 (시청 ${missing} 자동 인식 실패)`;
  } else {
    status = 'failed';
    message = result.log.find(l => /접속 불가/.test(l)) || '자동 연결 실패 - 사이트를 직접 추가해 주세요';
  }

  // 탐색 실패 시 기존에 잘 되던 대상은 유지 (일시적 장애로 지우지 않음)
  const existing = getSources(name);
  if (result.sources.length > 0 || existing.length === 0) {
    replaceSources(name, result.sources.map(s => ({ ...s, name: s.name.replace(row.full_name, name) })));
  }
  setRegionStatus(name, status, message);
  setMeta('discover_log:' + name, JSON.stringify(result.log.slice(-40)));
  console.log(`  🧭 ${name}: ${message}`);
  return { status, message, sources: getSources(name), log: result.log };
}

function needsDiscovery(region, sources) {
  if (!region.domain) return false;
  const now = Date.now();
  if (region.status === 'pending' || !region.discovered_at) return true;
  if (sources.length === 0) return now - region.discovered_at > RETRY_FAILED_DISCOVERY;
  if (now - region.discovered_at > REDISCOVER_INTERVAL) return true;
  return sources.some(s => s.fail_streak >= REDISCOVER_AFTER_FAILS);
}

// ========== 크롤 단위 ==========

async function crawlSource(src) {
  const logId = logCrawlStart(src.id);
  try {
    let parsed, fallbackUrl;
    if (src.kind === 'eminwon') {
      fallbackUrl = eminwonListUrl(src.url, 50);
      const { html } = await fetchPage(fallbackUrl);
      parsed = parseEminwon(html, src.url);
    } else {
      const { html, finalUrl } = await fetchPage(src.url);
      fallbackUrl = finalUrl;
      parsed = scanBoard(html, finalUrl);
    }
    const items = parsed.items
      .filter(it => isFoodTruckRelated(it.title) && isRecent(it))
      .map(it => toNotice(src.id, src.region, src.name, it, fallbackUrl));
    const newCount = saveItems(items);
    updateSourceResult(src.id, { ok: true, rows: parsed.rows, found: items.length });
    logCrawlEnd(logId, {
      status: parsed.rows > 0 ? 'success' : 'empty', found_count: items.length, new_count: newCount,
      error: parsed.rows > 0 ? null : '게시글 목록을 읽지 못함 (주소/구조 변경 의심)',
    });
    console.log(`  ${parsed.rows > 0 ? '✅' : '⚠️'} ${src.name}: 목록 ${parsed.rows}줄, 발견 ${items.length}, 신규 ${newCount}`);
    return { site: src.name, rows: parsed.rows, found: items.length, isNew: newCount };
  } catch (err) {
    updateSourceResult(src.id, { ok: false, error: err.message });
    logCrawlEnd(logId, { status: 'error', error: err.message });
    console.error(`  ❌ ${src.name}: ${err.message}`);
    return { site: src.name, error: err.message };
  }
}

// 고정 사이트 / 사용자 직접 등록 사이트 (범용 스캐너)
async function crawlSite(site, isUserSite = false) {
  const url = site.listUrl || site.url;
  const logId = logCrawlStart(site.id);
  try {
    const { html, finalUrl } = await fetchPage(url);
    const parsed = scanBoard(html, finalUrl);
    const items = parsed.items
      .filter(it => isFoodTruckRelated(it.title) && isRecent(it))
      .map(it => toNotice(site.id, site.region, site.name, it, finalUrl));
    const newCount = saveItems(items);
    const ok = parsed.rows > 0;
    logCrawlEnd(logId, {
      status: ok ? 'success' : 'empty', found_count: items.length, new_count: newCount,
      error: ok ? null : '게시글 목록을 읽지 못함 (게시판 목록 주소인지 확인 필요)',
    });
    if (isUserSite) updateUserSiteStatus(site.id, ok ? 'success' : 'empty', ok ? null : '게시글 목록을 읽지 못함', ok);
    console.log(`  ${ok ? '✅' : '⚠️'} ${site.name}: 목록 ${parsed.rows}줄, 발견 ${items.length}, 신규 ${newCount}`);
    return { site: site.name, rows: parsed.rows, found: items.length, isNew: newCount, items };
  } catch (err) {
    logCrawlEnd(logId, { status: 'error', error: err.message });
    if (isUserSite) updateUserSiteStatus(site.id, 'error', err.message, false);
    console.error(`  ❌ ${site.name}: ${err.message}`);
    return { site: site.name, error: err.message };
  }
}

// 하위 호환
const crawlUserSite = (site) => crawlSite(site, true);

async function crawlNaver(regions) {
  if (!naver.naverEnabled) return [];
  const last = Number(getMeta('naver_last') || 0);
  if (Date.now() - last < NAVER_INTERVAL) return [];
  setMeta('naver_last', Date.now());
  const results = [];
  for (const r of regions) {
    const short = shortName(r.full_name || r.name);
    const logId = logCrawlStart(`naver:${r.name}`);
    try {
      const found = await naver.searchRegion(short, isFoodTruckRelated);
      const items = found.filter(isRecent).map(it => toNotice('naver', r.name, it.source, it, it.url));
      const newCount = saveItems(items);
      logCrawlEnd(logId, { status: 'success', found_count: items.length, new_count: newCount });
      results.push({ site: `네이버:${r.name}`, found: items.length, isNew: newCount });
    } catch (err) {
      logCrawlEnd(logId, { status: 'error', error: err.message });
      results.push({ site: `네이버:${r.name}`, error: err.message });
    }
  }
  return results;
}

// ========== 전체 실행 ==========
let running = null;

async function crawlAll() {
  if (running) {
    console.log('⏳ 이미 크롤링 중 - 기존 작업 결과를 기다립니다');
    return running;
  }
  running = (async () => {
    console.log(`\n=== 푸드트럭 공고 크롤링 시작 (${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}) ===\n`);
    const results = [];

    for (const name of DEFAULT_REGIONS) ensureRegion(name);
    const regions = getRegions();

    for (const region of regions) {
      if (needsDiscovery(region, getSources(region.name))) {
        try { await discoverAndSave(region.name); }
        catch (e) { console.error(`  탐색 오류 ${region.name}:`, e.message); }
      }
      for (const src of getSources(region.name)) {
        results.push(await crawlSource(src));
        await sleep(DELAY);
      }
    }

    for (const site of SITES) {
      results.push(await crawlSite(site, false));
      await sleep(DELAY);
    }

    const userSites = getUserSites();
    for (const us of userSites) {
      results.push(await crawlSite(us, true));
      await sleep(DELAY);
    }

    results.push(...await crawlNaver(regions));
    pruneCrawlLog();
    const removed = pruneOldNotices(cutoffDate());
    if (removed) console.log(`  🧹 ${MAX_AGE_DAYS}일 지난 공고 ${removed}건 정리`);

    const totalNew = results.reduce((s, r) => s + (r.isNew || 0), 0);
    const totalFound = results.reduce((s, r) => s + (r.found || 0), 0);
    const errors = results.filter(r => r.error).length;
    const empty = results.filter(r => !r.error && r.rows === 0).length;
    setMeta('last_crawl', Date.now());
    console.log(`\n=== 크롤 완료: 발견 ${totalFound}, 신규 ${totalNew}, 실패 ${errors}, 목록없음 ${empty} ===\n`);
    return { results: results.map(({ items, ...r }) => r), totalNew, totalFound, errors, empty };
  })();
  try { return await running; } finally { running = null; }
}

module.exports = { crawlSite, crawlAll, crawlUserSite, ensureRegion, discoverAndSave, isFoodTruckRelated, isRecent, cutoffDate };

if (require.main === module) {
  crawlAll().then(() => process.exit(0)).catch(err => {
    console.error('크롤 실패:', err);
    process.exit(1);
  });
}
