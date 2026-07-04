// crawler.js v3 - 개별 공고 URL 추출 + 사용자 사이트 자동 감지
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const { SITES, KEYWORDS } = require('./sites.config');
const {
  upsertNotice, logCrawlStart, logCrawlEnd,
  getUserSites, updateUserSiteStatus,
} = require('./db');

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
    try { const u = new URL(linkBase); return u.origin + href; }
    catch { return linkBase + href; }
  }
  if (href.startsWith('?')) {
    const base = linkBase.split('?')[0];
    return base + href;
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

function extractNoticeUrl(titleEl, $row, linkBase, listUrl) {
  let href = titleEl.attr('href') || '';
  if (href && href !== '#' && !href.startsWith('javascript:')) {
    return toAbsoluteUrl(linkBase, href);
  }

  const onclick = titleEl.attr('onclick') || titleEl.parent().attr('onclick') || $row.attr('onclick') || '';
  if (onclick) {
    const hrefMatch = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (hrefMatch) return toAbsoluteUrl(linkBase, hrefMatch[1]);

    const idMatch = onclick.match(/(?:goView|fnView|view|moveView|boardView|fn_egov_select|doView)\s*\(\s*['"]?(\d+)['"]?/i);
    if (idMatch) {
      const noticeId = idMatch[1];
      const sep = listUrl.includes('?') ? '&' : '?';

      if (linkBase.includes('iksan.go.kr')) {
        return `${linkBase}/index.iksan?menuCd=DOM_000002003009003000&boardId=BBS_0000019&dataSid=${noticeId}`;
      }
      if (linkBase.includes('gunsan.go.kr')) {
        return `${linkBase}/main/view.gunsan?dataSid=${noticeId}&menuCd=DOM_000000104001003000`;
      }
      if (linkBase.includes('jeonbuk.go.kr')) {
        return `${linkBase}/board/view.jeonbuk?boardId=BBS_0000005&menuCd=DOM_000000110002000000&dataSid=${noticeId}`;
      }
      if (listUrl.includes('/list')) {
        return listUrl.replace('/list', '/view') + sep + 'dataSid=' + noticeId;
      }
      return listUrl + sep + 'dataSid=' + noticeId;
    }
  }

  const dataId = titleEl.attr('data-id') || titleEl.attr('data-no') || titleEl.attr('data-seq') || titleEl.attr('data-sid');
  if (dataId) {
    const sep = listUrl.includes('?') ? '&' : '?';
    return listUrl + sep + 'dataSid=' + dataId;
  }

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

// ========== 🆕 사용자 사이트 자동 크롤링 ==========

// 일반적인 한국 시청 게시판 selector 조합 (가능성 높은 순)
const AUTO_SELECTOR_PATTERNS = [
  { row: 'table.board_list tbody tr, .board_list tbody tr', title: 'td.subject a, td.title a, td a', date: 'td.date, td:last-child' },
  { row: 'table.bbs_list tbody tr, .bbs_list tbody tr', title: 'td.subject a, td a', date: 'td.date' },
  { row: 'table tbody tr', title: 'td.title a, td.subject a, td a', date: 'td:nth-last-child(2), td.date' },
  { row: '.board ul li, .notice_list li, .bbs_list li', title: 'a.subject, a.title, a', date: '.date, .day' },
  { row: 'tr.list_tr, tr.notice', title: 'a', date: '.date' },
  { row: 'tbody > tr', title: 'a[href*="view"], a[onclick*="view"], a', date: 'td' },
];

// 사용자 사이트 자동 크롤링 (여러 selector 시도)
async function crawlUserSite(userSite) {
  const html = await fetchHtml(userSite.url, 'utf-8');
  const $ = cheerio.load(html);

  // URL에서 base 추출
  let linkBase;
  try {
    const u = new URL(userSite.url);
    linkBase = u.origin;
  } catch {
    linkBase = userSite.url;
  }

  let bestResult = { items: [], pattern: null };

  // 각 selector 패턴 시도
  for (const pattern of AUTO_SELECTOR_PATTERNS) {
    const items = [];
    const rows = $(pattern.row);
    if (rows.length === 0) continue;

    rows.each((_, row) => {
      const $row = $(row);
      const titleEl = $row.find(pattern.title).first();
      const title = titleEl.text().trim().replace(/\s+/g, ' ');

      if (!title || title.length < 3) return;
      if (!isFoodTruckRelated(title)) return;

      const url = extractNoticeUrl(titleEl, $row, linkBase, userSite.url);
      const dateText = $row.find(pattern.date).first().text().trim();
      const postedDate = parseDate(dateText);

      items.push({
        id: makeNoticeId(userSite.id, url, title),
        site_id: userSite.id,
        region: userSite.region,
        org: userSite.name,
        title,
        url,
        posted_date: postedDate,
        raw_text: title,
      });
    });

    // 매칭되는 게시글 발견 → 이 패턴이 정답
    if (items.length > bestResult.items.length) {
      bestResult = { items, pattern };
    }

    // 푸드트럭 키워드 매칭된 항목이 1개라도 있으면 이게 정답
    if (items.length > 0) break;
  }

  return bestResult.items;
}

// ========== 크롤 실행 ==========

async function crawlSite(site, isUserSite = false) {
  const logId = logCrawlStart(site.id);
  console.log(`[${new Date().toISOString()}] 🔍 ${site.name} 크롤 시작...`);

  try {
    let items = [];
    if (isUserSite) {
      items = await crawlUserSite(site);
    } else if (site.type === 'generic') {
      items = await crawlGenericBoard(site);
    }

    let newCount = 0;
    for (const item of items) {
      const result = upsertNotice(item);
      if (result.isNew) newCount++;
    }

    logCrawlEnd(logId, { status: 'success', found_count: items.length, new_count: newCount });
    if (isUserSite) {
      updateUserSiteStatus(site.id, 'success', null, true);
    }
    console.log(`  ✅ ${site.name}: 발견 ${items.length}건, 신규 ${newCount}건`);
    return { site: site.name, found: items.length, isNew: newCount, items };
  } catch (err) {
    console.error(`  ❌ ${site.name} 크롤 실패:`, err.message);
    logCrawlEnd(logId, { status: 'error', error: err.message });
    if (isUserSite) {
      updateUserSiteStatus(site.id, 'error', err.message, false);
    }
    return { site: site.name, error: err.message };
  }
}

async function crawlAll() {
  console.log(`\n=== 푸드트럭 공고 크롤링 시작 (${new Date().toLocaleString('ko-KR')}) ===\n`);
  const results = [];

  // 기본 사이트 크롤링
  for (const site of SITES) {
    const result = await crawlSite(site, false);
    results.push(result);
    await new Promise(r => setTimeout(r, 1500));
  }

  // 🆕 사용자 등록 사이트 크롤링
  const userSites = getUserSites();
  if (userSites.length > 0) {
    console.log(`\n--- 사용자 등록 사이트 (${userSites.length}개) ---\n`);
    for (const userSite of userSites) {
      const result = await crawlSite(userSite, true);
      results.push(result);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const totalNew = results.reduce((sum, r) => sum + (r.isNew || 0), 0);
  const totalFound = results.reduce((sum, r) => sum + (r.found || 0), 0);
  const errors = results.filter(r => r.error).length;

  console.log(`\n=== 크롤 완료: 총 ${totalFound}건 발견, ${totalNew}건 신규, ${errors}건 실패 ===\n`);
  return { results, totalNew, totalFound };
}

module.exports = { crawlSite, crawlAll, crawlUserSite };

if (require.main === module) {
  crawlAll().then(() => process.exit(0)).catch(err => {
    console.error('크롤 실패:', err);
    process.exit(1);
  });
}
