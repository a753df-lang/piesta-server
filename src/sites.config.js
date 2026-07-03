// 크롤링 대상 사이트 설정 (검증된 URL만)

const KEYWORDS = ['푸드트럭', '푸드 트럭', 'food truck', '먹거리부스', '먹거리 부스', '플리마켓', '플리 마켓'];

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
  id: 'nonsan-cntf',
  region: '논산',
  name: '논산문화관광재단',
  listUrl: 'https://www.nonsan.go.kr/cntf/',
  type: 'generic',
  encoding: 'utf-8',
  rowSelector: 'table tbody tr, .board_list tr, .board tbody tr, .notice_list li',
  titleSelector: 'td a, .title a, a.subject, a',
  dateSelector: 'td.date, td:nth-child(4), td:nth-child(5), .date',
  linkBase: 'https://www.nonsan.go.kr',
}
  // ========== 부여군 (URL 수정됨) ==========
  {
    id: 'buyeo-notice',
    region: '부여',
    name: '부여군청 공지사항',
    listUrl: 'https://www.buyeo.go.kr/_prog/_board/?code=news_01&site_dvs_cd=kr&menu_dvs_cd=0401',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board tr',
    titleSelector: 'td a, .title a, a.subject',
    dateSelector: 'td.date, td:nth-child(4), td:nth-child(5)',
    linkBase: 'https://www.buyeo.go.kr',
  },

  // ========== 공주시 (신규 추가) ==========
  {
    id: 'gongju-notice',
    region: '공주',
    name: '공주시청 공지사항',
    listUrl: 'https://www.gongju.go.kr/kr/sub05_03_01.do',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.gongju.go.kr',
  },

  // ========== 서천군 (신규 추가) ==========
  {
    id: 'seocheon-notice',
    region: '서천',
    name: '서천군청 공지사항',
    listUrl: 'https://www.seocheon.go.kr/kor.do',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.seocheon.go.kr',
  },

  // ========== 보령시 (신규 추가) ==========
  {
    id: 'boryeong-notice',
    region: '보령',
    name: '보령시청 공지사항',
    listUrl: 'https://www.brcn.go.kr/kor.do',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.brcn.go.kr',
  },

  // ========== 청양군 (URL 수정됨) ==========
  {
    id: 'cheongyang-notice',
    region: '청양',
    name: '청양군청 공지사항',
    listUrl: 'https://www.cheongyang.go.kr/cop/bbs/BBSMSTR_000000000032/selectBoardList.do',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr',
    titleSelector: 'td.subject a, td.title a, td a',
    dateSelector: 'td.date, td:nth-child(4), td:nth-child(5)',
    linkBase: 'https://www.cheongyang.go.kr',
  },

  // ========== 익산시 (URL 최종 수정) ==========
  {
    id: 'iksan-notice',
    region: '익산',
    name: '익산시청 고시공고',
    listUrl: 'https://www.iksan.go.kr/index.iksan?menuCd=DOM_000002003009003000',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.board_list tbody tr, table tbody tr',
    titleSelector: 'td.subject a, td.title a, td a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.iksan.go.kr',
  },
  {
    id: 'iksan-ctf',
    region: '익산',
    name: '익산문화관광재단',
    listUrl: 'https://www.ictf.or.kr/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr, .notice_list li',
    titleSelector: 'a',
    dateSelector: '.date, td.date',
    linkBase: 'https://www.ictf.or.kr',
  },

  // ========== 군산시 (신규 추가) ==========
  {
    id: 'gunsan-notice',
    region: '군산',
    name: '군산시청 공지사항',
    listUrl: 'https://www.gunsan.go.kr/main/menu.gunsan?menuCd=DOM_000000104001003000',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.gunsan.go.kr',
  },

  // ========== 김제시 (신규 추가) ==========
  {
    id: 'gimje-notice',
    region: '김제',
    name: '김제시청 공지사항',
    listUrl: 'https://www.gimje.go.kr/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.gimje.go.kr',
  },

  // ========== 전주시 (신규 추가) ==========
  {
    id: 'jeonju-notice',
    region: '전주',
    name: '전주시청 공지사항',
    listUrl: 'https://www.jeonju.go.kr/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.jeonju.go.kr',
  },
  {
    id: 'jeonju-cf',
    region: '전주',
    name: '전주문화재단',
    listUrl: 'https://www.jjcf.or.kr/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr, .board_list tr',
    titleSelector: 'a',
    dateSelector: '.date, td.date',
    linkBase: 'https://www.jjcf.or.kr',
  },

  // ========== 완주군 (신규 추가) ==========
  {
    id: 'wanju-notice',
    region: '완주',
    name: '완주군청 공지사항',
    listUrl: 'https://www.wanju.go.kr/',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: 'table tbody tr',
    titleSelector: 'td a, td.title a',
    dateSelector: 'td.date, td:nth-child(4)',
    linkBase: 'https://www.wanju.go.kr',
  },
];

module.exports = { SITES, KEYWORDS };
