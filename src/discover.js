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
  // 관련 사이트/패밀리 사이트 선택 상자
  $('option').each((_, o) => {
    const v = ($(o).attr('value') || '').trim();
    if (!/^https?:\/\//i.test(v)) return;
    const url = safeUrl(v, pageUrl);
    if (url) list.push({ text: $(o).text().replace(/\s+/g, ' ').trim(), url });
  });
  return list;
}

// ========== 관련 기관 (문화재단 등) ==========
// 시청 홈페이지의 링크/패밀리사이트에서 이 이름이 보이면 관련 기관으로 보고 같이 크롤링
// 문화재단 계열만 (평생학습관·청소년재단·장학재단 등은 푸드트럭 공고와 무관하므로 제외)
const RELATED_RE = /문화관광재단|문화재단|관광재단|문화제\s*재단|축제\s*(추진)?\s*위원회|축제\s*조직\s*위원회/;
const RELATED_EXCLUDE_RE = /평생|학습|청소년|복지|장학|교육|체육|한국|국립|중앙|전국/;
const RELATED_BOARD_PATTERNS = [
  /^공지사항$/, /^(공지|알림|새소식|알림마당)$/, /공지사항/,
  /^(공모|모집)/, /공모\s*사업|지원\s*사업|모집\s*공고|참여\s*모집|셀러/, /^입찰/, /^공고$/,
];
// 홈페이지에서 링크를 못 찾을 때를 위한 알려진 관련 기관 (지자체 도메인 → 기관)
const RELATED_SEEDS = {
  'nonsan.go.kr': [{ name: '논산문화관광재단', url: 'https://www.nonsan.go.kr/cntf/', boards: [
    'https://www.nonsan.go.kr/cntf/html/sub05/0501.html', 'https://www.nonsan.go.kr/cntf/html/sub05/0502.html',
    'https://www.nonsan.go.kr/cntf/html/sub05/0503.html'] }],
  'gongju.go.kr': [{ name: '공주문화관광재단', url: 'https://www.gongjucf.or.kr/gongjucf/main/view' },
    { name: '백제문화제재단', url: 'https://www.baekje.org/', boards: ['https://www.baekje.org/kor/html/sub05/0501.html'] }],
  'buyeo.go.kr': [
    { name: '백제문화재단', url: 'https://www.baekjecf.or.kr/', boards: [
      'https://www.baekjecf.or.kr/community/01.php', 'https://www.baekjecf.or.kr/community/03.php'] },
    { name: '백제문화제재단', url: 'https://www.baekje.org/', boards: ['https://www.baekje.org/kor/html/sub05/0501.html'] }],
  'seocheon.go.kr': [{ name: '서천문화관광재단', url: 'https://www.seocheonctf.or.kr/index.do',
    boards: ['https://www.seocheonctf.or.kr/board/notice/list.do'] }],
  'iksan.go.kr': [{ name: '익산문화관광재단', url: 'https://www.ictf.or.kr/' }],
  'jeonju.go.kr': [{ name: '전주문화재단', url: 'https://www.jjcf.or.kr/' }],
};
const MAX_RELATED_SITES = 3;
const MAX_BOARDS_PER_RELATED = 3;

function siteKey(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + '/' + (u.pathname.split('/')[1] || ''); }
  catch { return url; }
}

// 관련 기관 후보 목록 (홈페이지 링크 + 알려진 기관)
function findRelatedCandidates(anchors, domain) {
  const out = [];
  const seen = new Set();
  const add = (c) => { const k = siteKey(c.url); if (seen.has(k)) return; seen.add(k); out.push(c); };
  for (const seed of RELATED_SEEDS[domain] || []) add(seed);
  for (const a of anchors) {
    if (!a.text || a.text.length > 25 || !RELATED_RE.test(a.text)) continue;
    if (RELATED_EXCLUDE_RE.test(a.text)) continue; // 무관한 기관·전국 단위 기관 제외
    add({ name: a.text.replace(/\s*(바로가기|새창|새 창|열림)\s*/g, '').trim(), url: a.url });
  }
  return out.slice(0, MAX_RELATED_SITES + 2);
}

// 관련 기관 한 곳: 홈페이지에서 공지/공모/모집/입찰 게시판을 찾아 검증
async function discoverRelatedSite(site, log, usedUrls) {
  const found = [];
  let candidates = (site.boards || []).slice();
  try {
    let home = await fetchPage(site.url, { retries: 0 });
    const host = new URL(home.finalUrl).hostname;
    // 첫 화면이 이동용 빈 페이지(예: window.location='/index.do')거나 여러 기관을 묶은 포털이면 한 번 더 들어감
    const sameHost = (h) => collectAnchors(h.html, h.finalUrl).filter(a => { try { return new URL(a.url).hostname === host; } catch { return false; } });
    const hasBoardLink = (list) => list.some(a => a.text.length <= 15 && RELATED_BOARD_PATTERNS.some(re => re.test(a.text)));
    let first = sameHost(home);
    if (!hasBoardLink(first)) {
      const core = site.name.replace(/^\(재\)\s*/, '').replace(/\s+/g, '');
      const byName = first.find(a => a.text.replace(/\s+/g, '').includes(core) && a.url !== home.finalUrl);
      const next = (byName && byName.url) || findMainRedirect(home.html, home.finalUrl, host.replace(/^www\./, ''));
      if (next && next !== home.finalUrl) {
        try {
          home = await fetchPage(next, { retries: 0 });
          log.push(`관련기관 메인 이동: ${site.name} → ${home.finalUrl}`);
        } catch (e) { log.push(`관련기관 메인 이동 실패 ${site.name}: ${e.message}`); }
      }
    }
    const prefix = new URL(home.finalUrl).pathname.split('/')[1] || '';
    const usePrefix = prefix && !/\.\w+$/.test(prefix) && new URL(site.url).pathname.split('/')[1] === prefix;
    const anchors = collectAnchors(home.html, home.finalUrl).filter(a => {
      try {
        const u = new URL(a.url);
        if (u.hostname !== host) return false;
        // 시청 도메인 아래 하위 경로로 운영되는 재단(예: /cntf/)은 그 경로 안 링크만
        return !usePrefix || prefix.length < 3 || u.pathname.split('/')[1] === prefix;
      } catch { return false; }
    });
    for (const re of RELATED_BOARD_PATTERNS) {
      for (const a of anchors) {
        if (a.text.length > 15 || !re.test(a.text)) continue;
        if (OLD_ARCHIVE_TEXT.test(a.text) || OLD_ARCHIVE_URL.test(a.url)) continue;
        if (!candidates.includes(a.url)) candidates.push(a.url);
      }
    }
  } catch (e) {
    log.push(`관련기관 접속 실패 ${site.name}: ${e.message}`);
    if (!candidates.length) return found;
  }
  for (const c of candidates.slice(0, 6)) {
    if (found.length >= MAX_BOARDS_PER_RELATED) break;
    try {
      const v = await verifyBoard(c);
      if (v.rows >= 3 && !usedUrls.has(v.url)) {
        usedUrls.add(v.url);
        found.push({ kind: 'board', group: 'related', name: site.name, url: v.url, rows: v.rows });
        log.push(`관련기관 연결: ${site.name} ${v.url} (${v.rows}줄)`);
      }
    } catch {}
    await sleep(400);
  }
  // 같은 기관 게시판이 여러 개면 이름 뒤에 번호
  if (found.length > 1) found.forEach((f, i) => { f.name = `${site.name} ${i + 1}`; });
  return found;
}

function sameSite(url, domain) {
  try { return new URL(url).hostname.endsWith(domain); } catch { return false; }
}

// 우선순위 순서대로 시도
const NOTICE_PATTERNS = [
  /^공지\s*사항$/, /^새\s*소식$/, /^공지$/, /^(공지|공고)\s*사항$/, /^(시정|군정|구정|도정)\s*(소식|알림)$/,
  /^알림\s*(사항|소식)$/, /공지사항|새소식/,
];
// 홈페이지에 공지사항 링크가 없을 때 한 단계 더 들어가 볼 메뉴 (상위 메뉴 페이지)
const SECTION_PATTERNS = [/^(소식|알림|알림마당|소식\s*마당|열린\s*(시정|군정|구정|도정)|참여\s*마당|소통\s*(참여|마당)|군정\s*소식|시정\s*소식|정보\s*공개)$/];
const GOSI_PATTERNS = [
  /^고시\s*[\/·.,]?\s*공고$/, /^공고\s*[\/·.,]?\s*고시$/, /^고시공고$/, /^공고$/,
  /고시\s*[\/·.,]?\s*공고|공고\s*[\/·.,]?\s*고시/,
];

// 지난/이전 게시물 보관 메뉴는 제외 (예: '지난 고시공고', /PREVIOUS/)
const OLD_ARCHIVE_TEXT = /지난|이전|과거|종료/;
const OLD_ARCHIVE_URL = /previous|\/past|_past|archive/i;

function pickLinks(anchors, domain, patterns, max) {
  const pick = [];
  for (const re of patterns) {
    for (const a of anchors) {
      if (a.text.length > 15 || !re.test(a.text)) continue;
      if (OLD_ARCHIVE_TEXT.test(a.text) || OLD_ARCHIVE_URL.test(a.url)) continue;
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
    || anchors.find(a => /(홈페이지|누리집|메인\s*페이지)[^]{0,10}바로\s*가기/.test(a.text))
    || anchors.find(a => /\/(kor|kr|ko|main|index)(\.do|\.html|\.jsp|\/|$)/i.test(a.url) && !/intro/i.test(a.url));
  return main ? main.url : null;
}

// ========== 검증 ==========
// 홈페이지(메인) 주소는 최신글 목록이 섞여 있어 게시판으로 착각하기 쉬움 → 게시판 후보에서 제외
function isHomeLike(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '').toLowerCase();
    return p === '' || /^\/(index|main|kor|kr|ko|home|intro)(\.\w+)?$/.test(p) || /\/(main|index)\/view$/.test(p)
      || /^\/(kor|kr|ko|html\/kr|html\/kor)\/(index|main)(\.\w+)?$/.test(p) || /^\/(html\/)?(kr|kor)$/.test(p);
  } catch { return false; }
}

async function verifyEminwon(origin) {
  const url = eminwonListUrl(origin, 20);
  const { html } = await fetchPage(url, { retries: 0, timeout: 25000 });
  const { rows } = parseEminwon(html, origin);
  return rows;
}

async function verifyBoard(url) {
  if (isHomeLike(url)) return { rows: 0, html: '', url };
  const { html, finalUrl } = await fetchPage(url, { retries: 0 });
  if (isHomeLike(finalUrl)) return { rows: 0, html, url: finalUrl }; // 메뉴가 홈으로 되돌아간 경우
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
    // 인트로(첫 화면) 페이지면 실제 메인으로 이동: 링크가 적거나, 주소에 intro 가 있거나, 공지·고시 메뉴가 없을 때
    const looksIntro = anchors.filter(a => sameSite(a.url, domain)).length < 40
      || /intro/i.test(home.finalUrl)
      || (!pickLinks(anchors, domain, NOTICE_PATTERNS, 1).length && !pickLinks(anchors, domain, GOSI_PATTERNS, 1).length);
    if (looksIntro) {
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
        sources.push({ kind: 'eminwon', group: 'gov', name: `${label} 고시공고`, url: origin, rows });
        log.push(`고시공고 연결: ${origin} (${rows}건)`);
        break;
      }
    } catch (e) { log.push(`새올 확인 실패 ${origin}: ${e.message}`); }
  }

  // 3) 공지사항 (반드시 찾도록: 홈 → 상위 메뉴 페이지까지)
  let noticeLinks = pickLinks(anchors, domain, NOTICE_PATTERNS, 3);
  const boardUrls = new Set();
  const tryNotice = async (links) => {
    for (const n of links) {
      try {
        const v = await verifyBoard(n);
        if (v.rows >= 3 && !boardUrls.has(v.url)) {
          boardUrls.add(v.url);
          sources.push({ kind: 'board', group: 'gov', name: `${label} 공지사항`, url: v.url, rows: v.rows });
          log.push(`공지사항 연결: ${v.url} (${v.rows}줄)`);
          return true;
        }
        log.push(`공지사항 후보 인식 실패(${v.rows}줄): ${n}`);
      } catch (e) { log.push(`공지사항 실패 ${n}: ${e.message}`); }
      await sleep(500);
    }
    return false;
  };
  let noticeOk = await tryNotice(noticeLinks);
  if (!noticeOk) {
    const sections = pickLinks(anchors, domain, SECTION_PATTERNS, 4);
    log.push(`공지사항 못 찾음 → 상위 메뉴 ${sections.length}곳 탐색`);
    for (const sec of sections) {
      try {
        const r = await fetchPage(sec, { retries: 0 });
        const more = pickLinks(collectAnchors(r.html, r.finalUrl), domain, NOTICE_PATTERNS, 3)
          .filter(u => !noticeLinks.includes(u));
        noticeLinks = noticeLinks.concat(more);
        if (more.length && (noticeOk = await tryNotice(more))) break;
      } catch (e) { log.push(`상위 메뉴 실패 ${sec}: ${e.message}`); }
      await sleep(500);
    }
  }
  // 고시공고 메뉴가 새올이 아니고 일반 게시판인 경우도 수집
  if (!sources.some(s => s.kind === 'eminwon')) {
    for (const g of gosiLinks) {
      try {
        const v = await verifyBoard(g);
        if (v.rows >= 3 && !boardUrls.has(v.url)) {
          boardUrls.add(v.url);
          sources.push({ kind: 'board', group: 'gov', name: `${label} 고시공고`, url: v.url, rows: v.rows });
          log.push(`고시공고(일반 게시판) 연결: ${v.url}`);
          break;
        }
      } catch {}
    }
  }

  // 4) 시청 입찰공고 (푸드트럭 영업장 임대 등이 입찰로 올라오는 경우)
  const bidLinks = pickLinks(anchors, domain, [/^입찰\s*공고$/, /^입찰\s*정보$/], 2);
  for (const b of bidLinks) {
    try {
      const v = await verifyBoard(b);
      if (v.rows >= 3 && !boardUrls.has(v.url)) {
        boardUrls.add(v.url);
        sources.push({ kind: 'board', group: 'gov', name: `${label} 입찰공고`, url: v.url, rows: v.rows });
        log.push(`입찰공고 연결: ${v.url}`);
        break;
      }
    } catch {}
  }

  // 5) 관련 기관 (문화재단·문화관광재단·축제위원회 등)
  const related = findRelatedCandidates(anchors, domain);
  log.push(`관련기관 후보: ${related.map(r => r.name).join(', ') || '없음'}`);
  let relatedSites = 0;
  for (const site of related) {
    if (relatedSites >= MAX_RELATED_SITES) break;
    const boards = await discoverRelatedSite(site, log, boardUrls);
    if (boards.length) { sources.push(...boards); relatedSites++; }
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
