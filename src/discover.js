// discover.js - 지역 이름만으로 크롤링 대상(고시공고/공지사항)을 자동으로 찾아냄
const { REGION_DATABASE } = require('./regions.data');
const {
  fetchPage, scanBoard, parseEminwon, eminwonListUrl, findEminwonOrigins,
  cheerio, safeUrl, sleep,
} = require('./scanner');

// ========== 지역 이름 → 지자체 정보 ==========
const SUFFIX_RE = /(특별자치시|특별자치도|광역시|특별시|시청|군청|구청|도청|시|군|구|도)$/;

function shortName(name) {
  return String(name || '').trim().split(/\s+/).pop().replace(SUFFIX_RE, '');
}

// '논산', '논산시', '서울 강남구', '강남구' 모두 허용. 못 찾거나 애매하면 null
function findRegion(input) {
  const q = String(input || '').trim();
  if (!q) return null;
  const exact = REGION_DATABASE.find(r => r.name === q);
  if (exact) return exact;
  const noSpace = q.replace(/\s+/g, '');
  const exact2 = REGION_DATABASE.find(r => r.name.replace(/\s+/g, '') === noSpace);
  if (exact2) return exact2;

  const s = shortName(q);
  let cands = REGION_DATABASE.filter(r => shortName(r.name) === s);
  if (cands.length > 1) {
    // '제주' 처럼 광역+기초가 겹치면 기초(시·군·구)를 우선
    const local = cands.filter(r => !/(도|특별자치도|광역시|특별시)$/.test(r.name));
    if (local.length === 1) cands = local;
  }
  return cands.length === 1 ? cands[0] : null;
}

// ========== 링크 수집 ==========
function collectAnchors(html, pageUrl) {
  const $ = cheerio.load(html);
  const list = [];
  $('a').each((_, a) => {
    const $a = $(a);
    const text = $a.text().replace(/\s+/g, ' ').trim() || ($a.attr('title') || '').trim();
    const href = ($a.attr('href') || '').trim();
    if (!href || href === '#' || /^javascript:/i.test(href) || /^mailto:|^tel:/i.test(href)) return;
    const url = safeUrl(href, pageUrl);
    if (url) list.push({ text, url });
  });
  return list;
}

function sameSite(url, domain) {
  try { return new URL(url).hostname.endsWith(domain); } catch { return false; }
}

// 우선순위 순서대로 시도
const NOTICE_PATTERNS = [
  /^공지사항$/, /^새소식$/, /^공지$/, /^(시정|군정|구정|도정)\s*소식$/, /^알림사항$/,
  /공지사항|새소식/,
];
const GOSI_PATTERNS = [
  /^고시\s*[\/·.,]?\s*공고$/, /^공고\s*[\/·.,]?\s*고시$/, /^고시공고$/, /^공고$/,
  /고시\s*[\/·.,]?\s*공고|공고\s*[\/·.,]?\s*고시/,
];

function pickLinks(anchors, domain, patterns, max) {
  const pick = [];
  for (const re of patterns) {
    for (const a of anchors) {
      if (a.text.length > 15 || !re.test(a.text)) continue;
      if (!sameSite(a.url, domain) || pick.includes(a.url)) continue;
      pick.push(a.url);
    }
  }
  return pick.slice(0, max);
}

// 인트로 페이지(언어선택/팝업)면 실제 메인으로 한 번 더 이동
function findMainRedirect(html, pageUrl, domain) {
  const meta = html.match(/http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i);
  if (meta) return safeUrl(meta[1], pageUrl);
  const js = html.match(/(?:location\.href|location\.replace\(|location\s*=)\s*['"]([^'"]+)['"]/);
  if (js) return safeUrl(js[1], pageUrl);
  const anchors = collectAnchors(html, pageUrl).filter(a => sameSite(a.url, domain));
  const main = anchors.find(a => /^(한국어|국문|korean|kor|메인|홈페이지|바로가기)/i.test(a.text))
    || anchors.find(a => /\/(kor|kr|ko|main|index)(\.do|\.html|\.jsp|\/|$)/i.test(a.url));
  return main ? main.url : null;
}

// ========== 검증 ==========
async function verifyEminwon(origin) {
  const url = eminwonListUrl(origin, 20);
  const { html } = await fetchPage(url, { retries: 0, timeout: 10000 });
  const { rows } = parseEminwon(html, origin);
  return rows;
}

async function verifyBoard(url) {
  const { html, finalUrl } = await fetchPage(url, { retries: 0 });
  let { rows } = scanBoard(html, finalUrl);
  let boardUrl = finalUrl;
  if (rows < 3) {
    // 게시판을 iframe 으로 띄우는 경우
    const $ = cheerio.load(html);
    const frames = $('iframe').map((_, f) => $(f).attr('src')).get().filter(Boolean).slice(0, 2);
    for (const src of frames) {
      const fu = safeUrl(src, finalUrl);
      if (!fu || /\/emwp\//.test(fu)) continue;
      try {
        const r = await fetchPage(fu, { retries: 0 });
        const s = scanBoard(r.html, r.finalUrl);
        if (s.rows > rows) { rows = s.rows; boardUrl = r.finalUrl; }
      } catch {}
    }
  }
  return { rows, html, url: boardUrl };
}

// ========== 메인: 지역 자동 탐색 ==========
// 반환: { region, ok, sources: [{kind, name, url, rows}], log: [...] }
async function discoverRegion(regionInput) {
  const region = typeof regionInput === 'string' ? findRegion(regionInput) : regionInput;
  const log = [];
  if (!region) return { region: null, ok: false, sources: [], log: ['지자체 목록에서 찾을 수 없음'] };

  const domain = region.domain;
  const label = region.name;
  const sources = [];

  // 1) 홈페이지 열기
  let home = null;
  for (const u of [`https://www.${domain}/`, `https://${domain}/`, `http://www.${domain}/`]) {
    try { home = await fetchPage(u, { retries: 0 }); break; }
    catch (e) { log.push(`홈페이지 실패 ${u}: ${e.message}`); }
  }

  let anchors = [];
  const pages = [];
  if (home) {
    pages.push(home);
    anchors = collectAnchors(home.html, home.finalUrl);
    if (anchors.filter(a => sameSite(a.url, domain)).length < 40) {
      const next = findMainRedirect(home.html, home.finalUrl, domain);
      if (next && next !== home.finalUrl) {
        try {
          const main = await fetchPage(next, { retries: 0 });
          pages.push(main);
          anchors = anchors.concat(collectAnchors(main.html, main.finalUrl));
          log.push(`메인 이동: ${main.finalUrl}`);
        } catch (e) { log.push(`메인 이동 실패: ${e.message}`); }
      }
    }
    log.push(`홈페이지 링크 ${anchors.length}개`);
  }

  // 2) 고시공고 (새올)
  let eminwonOrigins = [];
  for (const p of pages) eminwonOrigins.push(...findEminwonOrigins(p.html, p.finalUrl));
  const gosiLinks = pickLinks(anchors, domain, GOSI_PATTERNS, 3);
  if (eminwonOrigins.length === 0) {
    for (const g of gosiLinks) {
      try {
        const r = await fetchPage(g, { retries: 0 });
        eminwonOrigins.push(...findEminwonOrigins(r.html, r.finalUrl));
        if (eminwonOrigins.length) break;
      } catch (e) { log.push(`고시공고 메뉴 실패: ${e.message}`); }
      await sleep(500);
    }
  }
  eminwonOrigins.push(`https://eminwon.${domain}`, `http://eminwon.${domain}`);
  eminwonOrigins = [...new Set(eminwonOrigins)];

  for (const origin of eminwonOrigins) {
    try {
      const rows = await verifyEminwon(origin);
      if (rows > 0) {
        sources.push({ kind: 'eminwon', name: `${label} 고시공고`, url: origin, rows });
        log.push(`고시공고 연결: ${origin} (${rows}건)`);
        break;
      }
    } catch (e) { log.push(`새올 확인 실패 ${origin}: ${e.message}`); }
  }

  // 3) 공지사항
  const noticeLinks = pickLinks(anchors, domain, NOTICE_PATTERNS, 3);
  const boardUrls = new Set();
  for (const n of noticeLinks) {
    try {
      const v = await verifyBoard(n);
      if (v.rows >= 3 && !boardUrls.has(v.url)) {
        boardUrls.add(v.url);
        sources.push({ kind: 'board', name: `${label} 공지사항`, url: v.url, rows: v.rows });
        log.push(`공지사항 연결: ${v.url} (${v.rows}줄)`);
        break; // 공지사항은 하나면 충분
      } else {
        log.push(`공지사항 후보 인식 실패(${v.rows}줄): ${n}`);
      }
    } catch (e) { log.push(`공지사항 실패 ${n}: ${e.message}`); }
    await sleep(500);
  }

  // 고시공고 메뉴가 새올이 아니고 일반 게시판인 경우도 수집
  if (!sources.some(s => s.kind === 'eminwon')) {
    for (const g of gosiLinks) {
      try {
        const v = await verifyBoard(g);
        if (v.rows >= 3 && !boardUrls.has(v.url)) {
          boardUrls.add(v.url);
          sources.push({ kind: 'board', name: `${label} 고시공고`, url: v.url, rows: v.rows });
          log.push(`고시공고(일반 게시판) 연결: ${v.url}`);
          break;
        }
      } catch {}
    }
  }

  if (!home) log.push('홈페이지 접속 불가 - 도메인 오류이거나 해외 접속 차단 가능성');
  return { region, ok: sources.length > 0, sources, log };
}

module.exports = { findRegion, shortName, discoverRegion };

// CLI 테스트: node src/discover.js 논산
if (require.main === module) {
  const name = process.argv[2] || '논산';
  discoverRegion(name).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); });
}
