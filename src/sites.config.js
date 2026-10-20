// 크롤링 설정
// - 시·군·구청 고시공고/공지사항은 지역 이름만으로 자동 탐색됨 (discover.js)
// - 여기에는 자동 탐색으로 못 잡는 "추가 사이트"(문화재단 등)만 적는다.

// 제목에 이 중 하나라도 들어가면 수집 (띄어쓰기 무시, 대소문자 무시)
// 환경변수 KEYWORDS="푸드트럭,플리마켓" 으로 덮어쓸 수 있음
const DEFAULT_KEYWORDS = [
  '푸드트럭', 'food truck', 'foodtruck',
  '먹거리부스', '먹거리 장터', '먹거리장터', '푸드존', '푸드코트 운영',
  '플리마켓', '프리마켓', '벼룩시장', '야시장',
  '셀러 모집', '판매부스', '판매 부스', '판매자 모집', '부스 운영자', '입점업체 모집', '입점 업체 모집',
];

const KEYWORDS = process.env.KEYWORDS
  ? process.env.KEYWORDS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_KEYWORDS;

// 앱 기본 지역 (서버 DB가 초기화돼도 항상 복구)
const DEFAULT_REGIONS = (process.env.DEFAULT_REGIONS ||
  '논산,부여,공주,서천,보령,청양,익산,군산,김제,전주,완주')
  .split(',').map(s => s.trim()).filter(Boolean);

// 자동 탐색 외에 꼭 따로 볼 사이트가 있으면 여기에 추가 (범용 스캐너로 읽음 - 선택자 불필요)
// 문화재단 등 관련 기관은 이제 지역 자동 탐색(discover.js 의 RELATED_SEEDS / 홈페이지 링크)이 찾아줌
// 예: { id: 'my-site', region: '논산', name: '사이트 이름', listUrl: 'https://.../list.do' }
const SITES = [];

module.exports = { SITES, KEYWORDS, DEFAULT_REGIONS };
