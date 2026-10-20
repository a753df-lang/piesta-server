// naver.js - (선택) 네이버 검색 API로 시청 게시판 밖의 모집 공고 보조 수집
// 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 있을 때만 동작
// 무료 한도: 하루 25,000회 (지역당 2회 × 하루 8번 = 지역 100곳까지 1,600회)
const axios = require('axios');

const ID = process.env.NAVER_CLIENT_ID;
const SECRET = process.env.NAVER_CLIENT_SECRET;
const naverEnabled = !!(ID && SECRET);

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim();
}

function toDate(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

// type: 'news' | 'webkr'
async function search(type, query, display = 20) {
  const res = await axios.get(`https://openapi.naver.com/v1/search/${type}.json`, {
    params: { query, display, sort: type === 'news' ? 'date' : undefined },
    headers: { 'X-Naver-Client-Id': ID, 'X-Naver-Client-Secret': SECRET },
    timeout: 15000,
  });
  return res.data.items || [];
}

// regionShort: '논산' 같은 짧은 이름. isMatch: 키워드 판별 함수
// 반환: [{title, url, date, source}]
async function searchRegion(regionShort, isMatch) {
  if (!naverEnabled) return [];
  const out = [];
  const queries = [
    ['news', `${regionShort} 푸드트럭 모집`],
    ['webkr', `${regionShort} 푸드트럭 모집 공고`],
  ];
  for (const [type, q] of queries) {
    const items = await search(type, q);
    for (const it of items) {
      const title = stripTags(it.title);
      const desc = stripTags(it.description);
      // 제목에 키워드, 제목/본문에 지역명이 있어야 수집 (엉뚱한 지역 기사 제외)
      if (!isMatch(title)) continue;
      if (!(title + desc).includes(regionShort)) continue;
      const date = toDate(it.pubDate);
      // 뉴스는 45일 이내만
      if (type === 'news' && date && Date.now() - new Date(date).getTime() > 45 * 86400000) continue;
      out.push({ title, url: it.originallink || it.link, date, source: type === 'news' ? '네이버 뉴스' : '네이버 웹문서' });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

module.exports = { naverEnabled, searchRegion };
