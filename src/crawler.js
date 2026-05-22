// crawler.js - 푸드트럭 공고 크롤링 (v2 - 개별 공고 URL 추출 강화)
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const { SITES, KEYWORDS } = require('./sites.config');
const { upsertNotice, logCrawlStart, logCrawlEnd } = require('./db');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

async function fetchHtml(url, encoding = 'utf-8') {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  });

  const contentType = res.headers['content-type'] || '';
  let charset = encoding;
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  if (charsetMatch) charset = charsetMatch[1].trim().toLowerCase();

  let html;
  if (charset.includes('euc-kr') || charset.includes('ks_c_5601')) {
    html = iconv.decode(Buffer.from(res.data), 'euc-kr');
  } else {
    html = Buffer.from(res.data).toString('utf-8');
  }
  return html;
}

function isFoodTruckRelated(text) {
  if (!text) return false;
  const lower = text.toLowerCase().replace(/\s/g, '');
  return KEYWORDS.some(kw => lower.includes(kw.toLowerCase().replace(/\s/g, '')));
}

function toAbsoluteUrl(linkBase, href) {
  if (!href) return null;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) {
    try {
      const url = new URL(linkBase);
      return url.origin + href;
    } catch {
      return linkBase + href;
    }
  }
  if (!linkBase.endsWith('/')) linkBase = linkBase + '/';
  return linkBase + href;
}

function makeNoticeId(siteId, url, title) {
  const hash = crypto.createHash('md5').update(url + '|' + title).digest('hex').slice(0, 12);
  return `${siteId}_${hash}`;
}

function parseDate(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s/g, '');
  const m = cleaned.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// 🆕 개별 공고 URL 추출 - 한국 시청 게시판의 다양한 패턴 지원
function extractNoticeUrl(titleEl, $row, linkBase, listUrl) {
  // 패턴 1: 일반 a 태그 href
  let href = titleEl.attr('href') || '';
  if (href && href !== '#' && !href.startsWith('javascript:')) {
    return toAbsoluteUrl(linkBase, href);
  }

  // 패턴 2: onclick 속성에서 id 추출
  const onclick = titleEl.attr('onclick') || titleEl.parent().attr('onclick') || $row.attr('onclick') || '';
  if (onclick) {
    // location.href='/board/view.do?id=123' 패턴
    const hrefMatch = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (hrefMatch) {
      return toAbsoluteUrl(linkBase, hrefMatch[1]);
    }

    // goView(123) / fnView(123) / view(123) / moveView(123) 패턴
    const idMatch = onclick.match(/(?:goView|fnView|view|moveView|boardView|fn_egov_select|doView)\s*\(\s*['"]?(\d+)['"]?/i);
    if (idMatch) {
      const noticeId = idMatch[1];
      const sep = listUrl.includes('?') ? '&' : '?';

      // 사이트별 특수 URL 패턴
      if (linkBase.includes('iksan.go.kr')) {
        return `${linkBase}/index.iksan?menuCd=DOM_000002003009003000&boardId=BBS_0000019&dataSid=${noticeId}`;
      }
      if (linkBase.includes('gunsan.go.kr')) {
        return `${linkBase}/main/view.gunsan?dataSid=${noticeId}&menuCd=DOM_000000104001003000`;
      }
      if (linkBase.includes('jeonbuk.go.kr')) {
        return `${linkBase}/board/view.jeonbuk?boardId=BBS_0000005&menuCd=DOM_000000110002000000&dataSid=${noticeId}`;
      }

      // 일반 패턴: listUrl의 'list'를 'view'로 바꾸기
      if (listUrl.includes('/list')) {
        return listUrl.replace('/list', '/view') + sep + 'dataSid=' + noticeId;
      }

      // 그 외: id 파라미터만 추가
      return listUrl + sep + 'dataSid=' + noticeId;
    }
  }

  // 패턴 3: data-* 속성
  const dataId = titleEl.attr('data-id') || titleEl.attr('data-no') || titleEl.attr('data-seq') || titleEl.attr('data-sid');
  if (dataId) {
    const sep = listUrl.includes('?') ? '&' : '?';
    return listUrl + sep + 'dataSid=' + dataId;
  }

  // 추출 실패 → 게시판 목록 URL (시청 메인보다는 나음)
  return listUrl;
}

async function crawlGenericBoard(site) {
  const html = await fetchHtml(site.listUrl, site.encoding);
  const $ = cheerio.load(html);

  const items = [];
  const rows = $(site.rowSelector);

  rows.each((_, row) => {
    const $row = $(row);
    const titleEl = $row.find(site.titleSelector).first();
    const title = titleEl.text().trim().replace(/\s+/g, ' ');

    if (!title) return;
    if (!isFoodTruckRelated(title)) return;

    // 🆕 개선된 URL 추출
    const url = extractNoticeUrl(titleEl, $row, site.linkBase, site.listUrl);

    const dateText = $row.find(site.dateSelector).first().text().trim();
    const postedDate = parseDate(dateText);

    items.push({
      id: makeNoticeId(site.id, url, title),
      site_id: site.id,
      region: site.region,
      org: site.name,
      title,
      url,
      posted_date: postedDate,
      raw_text: title,
    });
  });

  return items;
}

async function crawlSite(site) {
  const logId = logCrawlStart(site.id);
  console.log(`[${new Date().toISOString()}] 🔍 ${site.name} 크롤 시작...`);

  try {
    let items = [];
    if (site.type === 'generic') {
      items = await crawlGenericBoard(site);
    }

    let newCount = 0;
    for (const item of items) {
      const result = upsertNotice(item);
      if (result.isNew) newCount++;
    }

    logCrawlEnd(logId, { status: 'success', found_count: items.length, new_count: newCount });
    console.log(`  ✅ ${site.name}: 발견 ${items.length}건, 신규 ${newCount}건`);
    return { site: site.name, found: items.length, isNew: newCount, items };
  } catch (err) {
    console.error(`  ❌ ${site.name} 크롤 실패:`, err.message);
    logCrawlEnd(logId, { status: 'error', error: err.message });
    return { site: site.name, error: err.message };
  }
}

async function crawlAll() {
  console.log(`\n=== 푸드트럭 공고 크롤링 시작 (${new Date().toLocaleString('ko-KR')}) ===\n`);
  const results = [];
  for (const site of SITES) {
    const result = await crawlSite(site);
    results.push(result);
    await new Promise(r => setTimeout(r, 1500));
  }

  const totalNew = results.reduce((sum, r) => sum + (r.isNew || 0), 0);
  const totalFound = results.reduce((sum, r) => sum + (r.found || 0), 0);
  const errors = results.filter(r => r.error).length;

  console.log(`\n=== 크롤 완료: 총 ${totalFound}건 발견, ${totalNew}건 신규, ${errors}건 실패 ===\n`);
  return { results, totalNew, totalFound };
}

module.exports = { crawlSite, crawlAll };

if (require.main === module) {
  crawlAll().then(() => process.exit(0)).catch(err => {
    console.error('크롤 실패:', err);
    process.exit(1);
  });
}
