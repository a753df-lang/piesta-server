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
    id: 'nonsan-notice',
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
  {
    id: 'nonsan-cntf',
    region: '논산',
    name: '논산문화관광재단(공지사항)',
    listUrl: 'https://www.nonsan.go.kr/cntf/html/sub05/0501.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.bd_list_wrap tbody tr',
    titleSelector: 'td.title a',
    dateSelector: 'td.reg_date',
    linkBase: 'https://www.nonsan.go.kr/cntf/html/sub05/0501.html',
  },
  {
    id: 'nonsan-cntf-support',
    region: '논산',
    name: '논산문화관광재단(지원사업공모)',
    listUrl: 'https://www.nonsan.go.kr/cntf/html/sub05/0502.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.bd_list_wrap tbody tr',
    titleSelector: 'td.title a',
    dateSelector: 'td.reg_date',
    linkBase: 'https://www.nonsan.go.kr/cntf/html/sub05/0502.html',
  },
  {
    id: 'nonsan-cntf-bid',
    region: '논산',
    name: '논산문화관광재단(입찰공고)',
    listUrl: 'https://www.nonsan.go.kr/cntf/html/sub05/0503.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.bd_list_wrap tbody tr',
    titleSelector: 'td.title a',
    dateSelector: 'td.reg_date',
    linkBase: 'https://www.nonsan.go.kr/cntf/html/sub05/0503.html',
  },
  {
    id: 'nonsan-cntf-press',
    region: '논산',
    name: '논산문화관광재단(보도자료)',
    listUrl: 'https://www.nonsan.go.kr/cntf/html/sub05/0505.html',
    type: 'generic',
    encoding: 'utf-8',
    rowSelector: '.bd_list_wrap tbody tr',
    titleSelector: 'td.title a',
    dateSelector: 'td.reg_date',
    linkBase: 'https://www.nonsan.go.kr/cntf/html/sub05/0505.html',
  },

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

];

module.exports = { SITES, KEYWORDS };
