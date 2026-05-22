// crawler.js - 푸드트럭 공고 크롤링
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const { SITES, KEYWORDS } = require('./sites.config');
const { upsertNotice, logCrawlStart, logCrawlEnd } = require('./db');

const USER_AGENT = 'Mozilla/5.0 (compatible; FoodTruckBot/1.0; +https://example.com)';
const TIMEOUT = 15000;

// HTTP fetch with encoding 처리
async function fetchHtml(url, encoding = 'utf-8') {
  const res = await axios.get(url, {
    timeout: TIMEOUT,
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    // 일부 사이트는 SSL 인증서 문제가 있어 https 모듈을 lenient하게 처리
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  });

  // 한글 인코딩 자동 감지
  const contentType = res.headers['content-type'] || '';
  let charset = encoding;
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  if (charsetMatch) charset = charsetMatch[1].trim().toLowerCase();

  // 한국 사이트는 EUC-KR도 종종 있음
  let html;
  if (charset.includes('euc-kr') || charset.includes('ks_c_5601')) {
    html = iconv.decode(Buffer.from(res.data), 'euc-kr');
  } else {
    html = Buffer.from(res.data).toString('utf-8');
  }
  return html;
}

// 키워드 매칭 - 푸드트럭 관련 게시글인지 판단
function isFoodTruckRelated(text) {
  if (!text) return false;
  const lower = text.toLowerCase().replace(/\s/g, '');
  return KEYWORDS.some(kw => lower.includes(kw.toLowerCase().replace(/\s/g, '')));
}

// 절대 URL로 변환
function toAbsoluteUrl(linkBase, href) {
  if (!href) return null;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return linkBase + href;
  return linkBase + '/' + href;
}

// 공고 ID 생성 (URL 기반 해시)
function makeNoticeId(siteId, url, title) {
  const hash = crypto.createHash('md5').update(url + '|' + title).digest('hex').slice(0, 12);
  return `${siteId}_${hash}`;
}

// 날짜 텍스트 정제 (예: "2025.06.15", "2025-06-15", "2025/06/15" → "2025-06-15")
function parseDate(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s/g, '');
  const m = cleaned.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// 일반적인 게시판 크롤러 (대부분의 한국 관공서 사이트)
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
    if (!isFoodTruckRelated(title)) return; // 키워드 매칭 안되면 스킵

    let href = titleEl.attr('href') || '';
    // onclick="goView('123')" 같은 케이스도 있어서 onclick 추출 시도
    if (!href || href === '#') {
      const onclick = titleEl.attr('onclick') || '';
      const m = onclick.match(/['"]([^'"]+)['"]/);
      if (m) href = m[1];
    }

    const url = toAbsoluteUrl(site.linkBase, href) || site.listUrl;
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

// 사이트 하나 크롤링
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

    logCrawlEnd(logId, {
      status: 'success',
      found_count: items.length,
      new_count: newCount,
    });

    console.log(`  ✅ ${site.name}: 발견 ${items.length}건, 신규 ${newCount}건`);
    return { site: site.name, found: items.length, isNew: newCount, items };
  } catch (err) {
    console.error(`  ❌ ${site.name} 크롤 실패:`, err.message);
    logCrawlEnd(logId, {
      status: 'error',
      error: err.message,
    });
    return { site: site.name, error: err.message };
  }
}

// 모든 사이트 크롤
async function crawlAll() {
  console.log(`\n=== 푸드트럭 공고 크롤링 시작 (${new Date().toLocaleString('ko-KR')}) ===\n`);
  const results = [];
  for (const site of SITES) {
    const result = await crawlSite(site);
    results.push(result);
    // 사이트 간 부하 분산을 위해 간격을 둠
    await new Promise(r => setTimeout(r, 1500));
  }

  const totalNew = results.reduce((sum, r) => sum + (r.isNew || 0), 0);
  const totalFound = results.reduce((sum, r) => sum + (r.found || 0), 0);
  const errors = results.filter(r => r.error).length;

  console.log(`\n=== 크롤 완료: 총 ${totalFound}건 발견, ${totalNew}건 신규, ${errors}건 실패 ===\n`);
  return { results, totalNew, totalFound };
}

module.exports = { crawlSite, crawlAll };

// 직접 실행 시 (npm run crawl)
if (require.main === module) {
  crawlAll().then(() => process.exit(0)).catch(err => {
    console.error('크롤 실패:', err);
    process.exit(1);
  });
}
