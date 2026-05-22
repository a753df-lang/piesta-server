// 크롤링 대상 사이트 설정
// 각 사이트마다 HTML 구조가 달라서 selector를 다르게 정의합니다.
// 키워드에 매칭되는 게시글만 새 공고로 등록합니다.

const KEYWORDS = ['푸드트럭', '푸드 트럭', 'food truck', '먹거리부스', '먹거리 부스'];

const SITES = [
  // ========== 충청남도 ==========
  {
    id: 'chungnam-gosi',
    region: '충남',
    name: '충청남도청 고시공고',
    listUrl: 'https://www.chungnam.go.kr/cnnet/board.do?mnu_cd=CNNMENU00309',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td.title a, td a',
    dateSelector: 'td:nth-child(5), td.date',
    linkBase: 'https://www.chungnam.go.kr',
  },

  // ========== 전라북도 ==========
  {
    id: 'jeonbuk-gosi',
    region: '전북',
    name: '전북특별자치도 고시공고',
    listUrl: 'https://www.jeonbuk.go.kr/board/list.jeonbuk?boardId=BBS_0000005&menuCd=DOM_000000110002000000',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.board_list tbody tr, table tbody tr',
    titleSelector: 'td.subject a, td.title a, td a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.jeonbuk.go.kr',
  },

  // ========== 논산시 ==========
  {
    id: 'nonsan-notice',
    region: '논산',
    name: '논산시청 공고/고시',
    listUrl: 'https://www.nonsan.go.kr/kor/html/sub03/030102.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr',
    titleSelector: 'td a, .title a',
    dateSelector: 'td.date, td:nth-child(4), td:nth-child(5)',
    linkBase: 'https://www.nonsan.go.kr',
  },
  {
    id: 'nonsan-news',
    region: '논산',
    name: '논산시청 공지사항',
    listUrl: 'https://www.nonsan.go.kr/kor/html/sub03/030101.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr',
    titleSelector: 'td a, .title a',
    dateSelector: 'td.date, td:nth-child(4), td:nth-child(5)',
    linkBase: 'https://www.nonsan.go.kr',
  },

  // ========== 부여군 ==========
  {
    id: 'buyeo-notice',
    region: '부여',
    name: '부여군청 공지사항',
    listUrl: 'https://www.buyeo.go.kr/html/kr/board/board_03_01.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board tr',
    titleSelector: 'td a, .title a',
    dateSelector: 'td.date, td:nth-child(4), td:nth-child(5)',
    linkBase: 'https://www.buyeo.go.kr',
  },
  {
    id: 'buyeo-ctf',
    region: '부여',
    name: '부여문화관광재단',
    listUrl: 'https://www.buyeoctf.or.kr/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr, .notice_list li',
    titleSelector: 'a',
    dateSelector: '.date, td.date',
    linkBase: 'https://www.buyeoctf.or.kr',
  },

  // ========== 익산시 ==========
  {
    id: 'iksan-notice',
    region: '익산',
    name: '익산시청 고시공고',
    listUrl: 'https://www.iksan.go.kr/board/list.iksan?boardId=BBS_0000019&menuCd=DOM_000000104004001000',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.board_list tbody tr, table tbody tr',
    titleSelector: 'td.subject a, td.title a, td a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.iksan.go.kr',
  },
  {
    id: 'iksan-cf',
    region: '익산',
    name: '익산문화관광재단',
    listUrl: 'https://www.iksancf.com/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr, .notice li',
    titleSelector: 'a',
    dateSelector: '.date, td.date',
    linkBase: 'https://www.iksancf.com',
  },
];

module.exports = { SITES, KEYWORDS };
