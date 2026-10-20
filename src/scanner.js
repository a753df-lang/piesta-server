// scanner.js - 사이트 구조에 덜 의존하는 범용 파서 모음
//  - fetchPage: 인코딩 자동 판별 + 재시도
//  - scanBoard: 어떤 게시판이든 "링크 + 날짜"가 있는 줄을 글로 인식
//  - 새올(eminwon) 고시공고: 전국 지자체 공통 시스템 전용 파서
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const https = require('https');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 20000;
const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // 지자체 인증서 체인 오류 대비

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeBody(buf, contentType) {
  let charset = (contentType.match(/charset=([^;]+)/i) || [])[1];
  if (!charset) {
    // 헤더에 없으면 HTML meta 태그에서 확인
    const head = buf.slice(0, 4096).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  charset = (charset || 'utf-8').trim().toLowerCase();
  if (charset.includes('euc-kr') || charset.includes('ks_c_5601') || charset.includes('cp949')) {
    return iconv.decode(buf, 'euc-kr');
  }
  return buf.toString('utf-8');
}

// 페이지 가져오기. 반환: { html, finalUrl, status }
async function fetchPage(url, { retries = 1, timeout = TIMEOUT } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await axios.get(url, {
        timeout,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        httpsAgent,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
        },
      });
      const buf = Buffer.from(res.data);
      const html = decodeBody(buf, res.headers['content-type'] || '');
      const finalUrl = ((res.request && res.request.res && res.request.res.responseUrl) || url).replace(/;jsessionid=[^?#]*/i, '');
      return { html, finalUrl, status: res.status };
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.status >= 400 && err.response.status < 500) break; // 4xx는 재시도 의미 없음
      if (i < retries) await sleep(2000);
    }
  }
  const status = lastErr && lastErr.response ? ` (HTTP ${lastErr.response.status})` : '';
  throw new Error(`${lastErr ? lastErr.code || lastErr.message : 'fetch 실패'}${status}`);
}

// ========== 날짜 ==========
const DATE_RE = /(20\d{2}|\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/;

function parseDate(text) {
  if (!text) return null;
  const m = String(text).match(DATE_RE);
  if (!m) return null;
  let [, y, mo, d] = m;
  if (y.length === 2) y = '20' + y;
  const yi = +y, mi = +mo, di = +d;
  if (yi < 2000 || yi > 2100 || mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  return `${y}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
}

// ========== 키워드 ==========
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

function makeKeywordMatcher(keywords) {
  const list = keywords.map(normalize).filter(Boolean);
  return (text) => {
    const t = normalize(text);
    return t.length > 0 && list.some(k => t.includes(k));
  };
}

// ========== 링크 ==========
function safeUrl(href, base) {
  try {
    // ;jsessionid=... 같은 접속 세션 값은 만료되므로 제거
    return new URL(href, base).href.replace(/;jsessionid=[^?#]*/i, '');
  } catch { return null; }
}

// 페이지 스크립트에서 "상세보기 함수"를 찾아 URL 조립 규칙을 뽑아냄
// 예) function fn_search_detail(no){ f.action = "/x/view.do?notAncmtMgtNo=" + no; f.submit(); }
//     → { fn_search_detail: { params:['no'], expr:'"/x/view.do?notAncmtMgtNo=" + no' } }
function extractLinkFunctions(html) {
  const map = {};
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{([\s\S]{0,1500}?)\n?\s*\}/g;
  let m;
  while ((m = re.exec(html))) {
    const [, name, paramStr, body] = m;
    const params = paramStr.split(',').map(s => s.trim()).filter(Boolean);
    if (!params.length) continue;
    const target = body.match(/(?:\.action|location\.href|location)\s*=\s*([^;\n]+)/) ||
      body.match(/(?:window\.open|location\.replace)\(\s*([^,)]+)/);
    if (!target) continue;
    const expr = target[1].trim();
    if (!/['"]/.test(expr)) continue;
    if (!params.some(p => new RegExp(`\\b${p}\\b`).test(expr))) continue;
    map[name] = { params, expr };
  }
  return map;
}

// '"/a?x=" + p1 + "&y=" + p2' 를 인자 값으로 치환해 문자열로 계산 (eval 사용 안 함)
function buildFromExpr(fnInfo, args) {
  const parts = fnInfo.expr.split('+').map(s => s.trim());
  let out = '';
  for (const part of parts) {
    const lit = part.match(/^['"](.*)['"]$/);
    if (lit) { out += lit[1]; continue; }
    const idx = fnInfo.params.indexOf(part);
    if (idx >= 0 && args[idx] != null) { out += encodeURIComponent(args[idx]); continue; }
    return null; // 알 수 없는 변수가 섞이면 포기
  }
  return out || null;
}

function parseCallArgs(argStr) {
  const args = [];
  const re = /'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(argStr))) args.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return args;
}

// <a> 의 실제 상세 페이지 주소를 최대한 복원. 실패하면 null
function resolveLink($, a, $row, pageUrl, linkFns = {}) {
  const $a = $(a);
  const href = ($a.attr('href') || '').trim();
  if (href && href !== '#' && !/^javascript:/i.test(href) && !href.startsWith('#')) {
    return safeUrl(href, pageUrl);
  }
  const code = [href, $a.attr('onclick'), $a.parent().attr('onclick'), $row.attr('onclick')]
    .filter(Boolean).join(' ');
  if (code) {
    const loc = code.match(/location\.href\s*=\s*['"]([^'"]+)['"]/) || code.match(/window\.open\(\s*['"]([^'"]+)['"]/);
    if (loc) return safeUrl(loc[1], pageUrl);
    // 상세보기 함수 호출: fn_view('123') → 페이지 스크립트의 함수 정의로 URL 조립
    const callRe = /([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
    let c;
    while ((c = callRe.exec(code))) {
      const info = linkFns[c[1]];
      if (!info) continue;
      const built = buildFromExpr(info, parseCallArgs(c[2]));
      if (built) return safeUrl(built, pageUrl);
    }
  }
  return null;
}

const NOISE_TEXT = /^(첨부|첨부파일|다운로드|미리보기|바로보기|새글|new|n|more|더보기|\d+)$/i;
// 카드형 목록에서 링크 안의 제목 요소
const TITLE_IN_LINK = 'strong, h3, h4, h5, .tit, .title, .subject, .sbj, .txt_t, .t_tit, .bbs_tit, dt';
// '작성일 : 2026.10.20' 처럼 라벨이 붙은 날짜를 먼저 찾음 (본문 요약 속 다른 날짜보다 우선)
const LABELED_DATE_RE = /(작성일|등록일|게시일|작성일자|등록일자|날짜|일자)\s*[:：]?\s*((20\d{2}|\d{2})\s*[.\-\/년]\s*\d{1,2}\s*[.\-\/월]\s*\d{1,2})/;

// 링크 안에서 제목만 꺼내기 (아이콘·'첨부파일 있음' 같은 표시 제거)
function titleFromLink($, a) {
  const $a = $(a);
  const $h = $a.find(TITLE_IN_LINK).first();
  const $t = ($h.length ? $h : $a).clone();
  $t.find('i, img, .ico_file, .ico, .blind, .sr-only, .hidden, .file, .date, .info, .txt, .num').remove();
  const text = $h.length ? $t.text() : $t.text();
  return cleanTitle(text.replace(/첨부\s*파일\s*(있음|없음)?/g, ' '));
}

function cleanTitle(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^(새글|공지|new|N)\s+/i, '')
    .replace(/\s+(새글|new|N)$/i, '')
    .trim();
}

// ========== 범용 게시판 스캐너 ==========
// 게시판 HTML 구조(class명 등)를 몰라도 "링크 + 날짜"가 함께 있는 줄을 게시글로 인식.
// 반환: { rows: 인식된 게시글 줄 수, items: [{title, url, date}] }
function scanBoard(html, pageUrl) {
  const linkFns = extractLinkFunctions(html);
  const $ = cheerio.load(html);
  $('script, style, noscript, header, footer, nav').remove();

  const items = [];
  const seen = new Set();
  let rows = 0;

  $('tr, li, dl, .item, .list_item').each((_, el) => {
    const $row = $(el);
    // 안쪽에 '링크가 있는' 줄이 또 있으면 바깥쪽은 건너뜀 (가장 안쪽 글 단위만 사용)
    // (날짜·작성자를 <ul><li> 로 감싼 카드형 목록은 안쪽 li 에 링크가 없으므로 바깥 li 를 글로 인식)
    if ($row.find('tr, li').filter((_, x) => $(x).find('a').length > 0).length > 0) return;
    const rowText = $row.text().replace(/\s+/g, ' ').trim();
    if (rowText.length < 6 || rowText.length > 1500) return;

    const anchors = $row.find('a').toArray();
    if (anchors.length === 0) return;

    // 제목 링크: 가장 긴 텍스트를 가진 링크
    let best = null, bestText = '';
    for (const a of anchors) {
      const raw = $(a).text().trim();
      const t = raw.length < 4 && $(a).attr('title') ? cleanTitle($(a).attr('title')) : titleFromLink($, a);
      if (t.length > bestText.length && !NOISE_TEXT.test(t)) { best = a; bestText = t; }
    }
    if (!best || bestText.length < 4) return;

    const labeled = rowText.match(LABELED_DATE_RE);
    const date = labeled ? parseDate(labeled[2]) : parseDate(rowText.replace(bestText, ' '));
    if (!date) return; // 날짜 없는 줄은 메뉴/배너일 가능성이 높음

    rows++;
    const url = resolveLink($, best, $row, pageUrl, linkFns);
    const key = (url || '') + '|' + bestText;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ title: bestText, url, date });
  });

  return { rows, items };
}

// ========== 새올(eminwon) 고시공고 ==========
const EMINWON_PATH = '/emwp/gov/mogaha/ntis/web/ofr/action/OfrAction.do';

function eminwonListUrl(origin, pageSize = 50) {
  const p = new URLSearchParams({
    jndinm: 'OfrNotAncmtEJB', context: 'NTIS',
    method: 'selectListOfrNotAncmt', methodnm: 'selectListOfrNotAncmtHomepage',
    homepage_pbs_yn: 'Y', subCheck: 'Y', ofr_pageSize: String(pageSize),
    not_ancmt_se_code: '01,02,03,04,05,06', title: '고시공고',
    initValue: 'Y', countYn: 'Y', pageIndex: '1',
  });
  return origin + EMINWON_PATH + '?' + p.toString();
}

function eminwonDetailUrl(origin, id) {
  const p = new URLSearchParams({
    jndinm: 'OfrNotAncmtEJB', context: 'NTIS',
    method: 'selectOfrNotAncmt', methodnm: 'selectOfrNotAncmtRegst',
    not_ancmt_mgt_no: String(id), homepage_pbs_yn: 'Y', subCheck: 'Y',
  });
  return origin + EMINWON_PATH + '?' + p.toString();
}

// 반환: { rows, items: [{title, url, date}] }
function parseEminwon(html, origin) {
  const $ = cheerio.load(html);
  const items = [];
  let rows = 0;
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const code = $tr.find('a').map((_, a) => ($(a).attr('href') || '') + ' ' + ($(a).attr('onclick') || '')).get().join(' ')
      + ' ' + ($tr.attr('onclick') || '');
    const m = code.match(/searchDetail\(\s*['"]?(\d+)['"]?\s*\)/);
    if (!m) return;
    rows++;
    // 제목 = 가장 긴 링크 텍스트 (번호/공고번호 칸 제외)
    let title = '';
    $tr.find('a').each((_, a) => {
      const t = cleanTitle($(a).attr('title') || $(a).text());
      if (t.length > title.length) title = t;
    });
    if (!title) {
      $tr.find('td').each((_, td) => {
        const t = cleanTitle($(td).text());
        if (t.length > title.length && !/^\d+$/.test(t)) title = t;
      });
    }
    const rowText = $tr.text().replace(/\s+/g, ' ');
    items.push({ title, url: eminwonDetailUrl(origin, m[1]), date: parseDate(rowText.replace(title, ' ')) });
  });
  return { rows, items };
}

// HTML 안에서 새올 시스템 주소(origin) 찾기
function findEminwonOrigins(html, baseUrl) {
  const found = new Set();
  const re = /(https?:)?\/\/([a-z0-9.\-]+(?::\d+)?)(?=\/emwp\/)/gi;
  let m;
  while ((m = re.exec(html))) found.add((m[1] || 'https:') + '//' + m[2].toLowerCase());
  const re2 = /(https?:)?\/\/(eminwon\.[a-z0-9.\-]+(?::\d+)?)/gi;
  while ((m = re2.exec(html))) found.add((m[1] || 'https:') + '//' + m[2].toLowerCase());
  // 같은 도메인 상대경로 /emwp/... 로 띄우는 경우
  if (/["']\/emwp\//.test(html) && baseUrl) {
    try { found.add(new URL(baseUrl).origin); } catch {}
  }
  return [...found];
}

module.exports = {
  fetchPage, parseDate, makeKeywordMatcher, normalize, safeUrl,
  scanBoard, parseEminwon, eminwonListUrl, eminwonDetailUrl, findEminwonOrigins, extractLinkFunctions,
  cheerio, sleep,
};
