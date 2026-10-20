// 오프라인 테스트: node test/run.js
// 실제 논산시청 페이지에서 떠온 HTML(fixtures)로 파서·자동 탐색·크롤 흐름을 검증한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `piesta-test-${process.pid}.db`);
process.env.DEFAULT_REGIONS = '논산';

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

// ---- 네트워크 대신 fixture 를 돌려주는 가짜 fetchPage ----
const scanner = require('../src/scanner');
const ROUTES = [
  [/^https:\/\/www\.nonsan\.go\.kr\/$/, 'nonsan-home.html'],
  [/\/kor\/html\/sub03\/030101\.html/, 'nonsan-notice.html'],
  [/\/kor\/html\/sub03\/03010201\.html/, 'nonsan-gosi.html'],
  [/^https:\/\/eminwon\.nonsan21\.net\/emwp\//, 'eminwon-nonsan.html'],
  [/\/cntf\/html\/sub05\/0501\.html/, 'nonsan-cntf.html'],
];
const requested = [];
scanner.fetchPage = async (url) => {
  requested.push(url);
  for (const [re, file] of ROUTES) if (re.test(url)) return { html: fx(file), finalUrl: url, status: 200 };
  throw new Error('ENOTFOUND (test)');
};

const { scanBoard, parseEminwon, parseDate, makeKeywordMatcher, findEminwonOrigins } = scanner;
const { findRegion, discoverRegion } = require('../src/discover');

test('날짜 파싱', () => {
  assert.strictEqual(parseDate('2026.10.20'), '2026-10-20');
  assert.strictEqual(parseDate(' 2026-7-3 '), '2026-07-03');
  assert.strictEqual(parseDate('26.10.05'), '2026-10-05');
  assert.strictEqual(parseDate('2026년 10월 1일'), '2026-10-01');
  assert.strictEqual(parseDate('1749'), null);
});

test('주소에서 jsessionid 제거', () => {
  assert.strictEqual(scanner.safeUrl('/bbs/list.do;jsessionid=ABC123?x=1', 'https://www.seocheon.go.kr/'), 'https://www.seocheon.go.kr/bbs/list.do?x=1');
});

test('키워드 매칭 (띄어쓰기 무시)', () => {
  const m = makeKeywordMatcher(['푸드트럭', '플리마켓']);
  assert.ok(m('강경젓갈축제 푸드 트럭 모집'));
  assert.ok(m('플리 마켓 셀러'));
  assert.ok(!m('도시관리계획 결정'));
});

test('공지사항 범용 스캐너: 조회수를 날짜로 읽지 않음', () => {
  const url = 'https://www.nonsan.go.kr/kor/html/sub03/030101.html';
  const { rows, items } = scanBoard(fx('nonsan-notice.html'), url);
  assert.strictEqual(rows, 4);
  assert.strictEqual(items[0].date, '2026-07-23');
  assert.strictEqual(items[0].title, '2027 논산세계딸기산업엑스포 입장권 사전예매 안내');
  assert.strictEqual(items[0].url, url + '?mode=V&no=2917bee586aa9538318201487e9ea4a0&GotoPage=1');
  const flea = items.find(i => i.title.includes('플리마켓'));
  assert.strictEqual(flea.date, '2026-10-16');
});

test('새올 고시공고 파서: 상세 링크 생성', () => {
  const { rows, items } = parseEminwon(fx('eminwon-nonsan.html'), 'https://eminwon.nonsan21.net');
  assert.strictEqual(rows, 4);
  const ft = items.find(i => i.title.includes('푸드트럭'));
  assert.ok(ft);
  assert.strictEqual(ft.date, '2026-10-19');
  assert.match(ft.url, /^https:\/\/eminwon\.nonsan21\.net\/emwp\/.*not_ancmt_mgt_no=52971/);
  assert.ok(items[0].title.startsWith('논산 도시관리계획'));
});

test('자바스크립트 상세보기 함수로 실제 글 주소 복원 (공주 고시공고)', () => {
  const url = 'https://www.gongju.go.kr/prog/saeolGosi/GOSI_01/sub04_03_01/list.do';
  const { rows, items } = scanBoard(fx('gongju-gosi.html'), url);
  assert.strictEqual(rows, 3);
  const ft = items.find(i => i.title.includes('푸드트럭'));
  assert.strictEqual(ft.url, 'https://www.gongju.go.kr/prog/saeolGosi/GOSI_01/sub04_03_01/view.do?notAncmtMgtNo=60510');
  assert.strictEqual(ft.date, '2026-10-16');
});

test('iframe 에서 새올 주소 찾기 (프로토콜 생략형)', () => {
  assert.deepStrictEqual(findEminwonOrigins(fx('nonsan-gosi.html'), 'https://www.nonsan.go.kr/x'), ['https://eminwon.nonsan21.net']);
});

test('지난 고시공고(보관 메뉴) 링크는 고르지 않음', async () => {
  const home = '<a href="/prog/saeolGosi/PREVIOUS/kor/sub04_06_08/list.do">고시공고</a><a href="/kor/old.do">지난 고시공고</a><a href="/prog/saeolGosi/GOSI/kor/sub04_06_01/list.do">고시공고</a>'
    + Array.from({ length: 45 }, (_, i) => `<a href="/m${i}.do">메뉴${i}</a>`).join('');
  fs.writeFileSync(path.join(__dirname, 'fixtures', '_tmp-seocheon.html'), home);
  ROUTES.unshift([/^https:\/\/www\.seocheon\.go\.kr\/$/, '_tmp-seocheon.html']);
  const before = requested.length;
  try { await discoverRegion({ name: '서천군', domain: 'seocheon.go.kr' }); }
  finally { ROUTES.shift(); fs.unlinkSync(path.join(__dirname, 'fixtures', '_tmp-seocheon.html')); }
  const seen = requested.slice(before);
  assert.ok(seen.some(u => u.includes('/GOSI/kor/sub04_06_01/')), JSON.stringify(seen));
  assert.ok(!seen.some(u => /PREVIOUS|old\.do/.test(u)), JSON.stringify(seen));
});

test('홈페이지 패밀리사이트(선택상자)에서 문화재단 찾아 공지·공모 게시판 연결', async () => {
  const dir = path.join(__dirname, 'fixtures');
  const home = '<select><option value="">패밀리사이트</option><option value="https://www.cacf.or.kr/">천안문화재단</option><option value="https://www.kcaf.or.kr/">한국문화예술위원회</option></select>'
    + Array.from({ length: 45 }, (_, i) => `<a href="/m${i}.do">메뉴${i}</a>`).join('');
  const cf = '<a href="/bbs/notice/list.do">공지사항</a><a href="/bbs/contest/list.do">공모사업</a><a href="https://other.com/">외부</a>';
  fs.writeFileSync(path.join(dir, '_t-home.html'), home);
  fs.writeFileSync(path.join(dir, '_t-cf.html'), cf);
  const extra = [
    [/^https:\/\/www\.cheonan\.go\.kr\/$/, '_t-home.html'],
    [/^https:\/\/www\.cacf\.or\.kr\/$/, '_t-cf.html'],
    [/^https:\/\/www\.cacf\.or\.kr\/bbs\/(notice|contest)\/list\.do$/, 'nonsan-notice.html'],
  ];
  ROUTES.unshift(...extra);
  let r;
  try { r = await discoverRegion('천안'); }
  finally { ROUTES.splice(0, extra.length); fs.unlinkSync(path.join(dir, '_t-home.html')); fs.unlinkSync(path.join(dir, '_t-cf.html')); }
  const rel = r.sources.filter(x => x.group === 'related');
  assert.deepStrictEqual(rel.map(x => x.url).sort(), ['https://www.cacf.or.kr/bbs/contest/list.do', 'https://www.cacf.or.kr/bbs/notice/list.do'], JSON.stringify(r.log, null, 1));
  assert.ok(rel.every(x => x.name.startsWith('천안문화재단')));
  assert.ok(!r.log.some(l => l.includes('한국문화예술위원회')));
});

test('지역 이름 매칭', () => {
  assert.strictEqual(findRegion('논산').name, '논산시');
  assert.strictEqual(findRegion('논산시').domain, 'nonsan.go.kr');
  assert.strictEqual(findRegion('서울 강남구').domain, 'gangnam.go.kr');
  assert.strictEqual(findRegion('강남구').name, '서울 강남구');
  assert.strictEqual(findRegion('중구'), null); // 여러 곳 → 모호
  assert.strictEqual(findRegion('제주').name, '제주시');
  assert.strictEqual(findRegion('없는동네'), null);
});

test('자동 탐색: 논산 → 시청 고시공고(새올) + 공지사항 + 문화관광재단', async () => {
  const r = await discoverRegion('논산');
  const gov = r.sources.filter(s => s.group === 'gov').map(s => s.kind).sort();
  assert.deepStrictEqual(gov, ['board', 'eminwon'], JSON.stringify(r.log, null, 1));
  assert.strictEqual(r.sources.find(s => s.kind === 'eminwon').url, 'https://eminwon.nonsan21.net');
  assert.strictEqual(r.sources.find(s => s.group === 'gov' && s.kind === 'board').url, 'https://www.nonsan.go.kr/kor/html/sub03/030101.html');
  const rel = r.sources.filter(s => s.group === 'related');
  assert.strictEqual(rel.length, 1, JSON.stringify(r.log, null, 1));
  assert.strictEqual(rel[0].name, '논산문화관광재단');
  assert.match(rel[0].url, /\/cntf\/html\/sub05\/0501\.html/);
});

test('전체 크롤: 시청·재단의 키워드 공고만 저장, 중복 없음, 상태 메시지', async () => {
  const { crawlAll } = require('../src/crawler');
  const { getNotices, getSources, getRegion } = require('../src/db');
  await crawlAll();
  const titles = getNotices({ limit: 50 }).map(n => n.title).sort();
  assert.deepStrictEqual(titles, [
    '2026 강경젓갈축제 푸드트럭 참가 모집',
    '2026 강경젓갈축제 플리마켓 셀러 모집',
    '2026 강경젓갈축제 푸드트럭 참가자 모집 공고',
  ].sort());
  const reg = getRegion('논산');
  assert.strictEqual(reg.status, 'ok');
  assert.strictEqual(reg.message, '시청 고시공고·공지사항 + 논산문화관광재단 자동 연결됨');
  assert.ok(getSources('논산').every(s => s.status === 'ok'));
  const second = await crawlAll();
  assert.strictEqual(second.totalNew, 0);
});

test.after(() => { try { fs.unlinkSync(process.env.DB_PATH); } catch {} });
