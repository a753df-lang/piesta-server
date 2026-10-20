# 🚚 푸드트럭 알리미 서버

충남/전북 푸드트럭 공고를 자동 크롤링하는 서버입니다.

## Render 배포 가이드

### 1. GitHub에 이 폴더 업로드
새 저장소 `piesta-server` 생성 후 모든 파일 업로드

### 2. Render 가입 & 배포
1. https://render.com 가입 (GitHub 계정)
2. New + → Web Service → 이 저장소 선택
3. 설정:
   - **Name**: piesta-server
   - **Region**: Singapore
   - **Build Command**: `npm install`
   - **Start Command**: `node src/index.js`
   - **Instance Type**: Free
4. Create Web Service

### 3. 환경변수 설정 (선택)
Render 대시보드 → Environment에서 추가:
- `CRAWL_ON_START=true` - 시작 시 즉시 크롤링
- `CRAWL_CRON=0 * * * *` - 매시간 크롤링 (기본값)

### 4. 앱 연결
배포 완료 후 URL 복사 (예: `https://piesta-server.onrender.com`)
앱의 `src/api.js`에서 `API_BASE` 값을 이 URL로 변경

## v4 변경 사항 (지역 자동 연결)

- **지역 이름만 추가하면 끝**: 앱에서 지역(전국 245개 시·군·구)을 추가하면 서버가 그 지자체 홈페이지에서
  **고시공고**(행안부 표준 '새올' 시스템)와 **공지사항** 게시판을 자동으로 찾아 연결합니다.
- **게시판 구조에 덜 의존**: 사이트별 선택자 대신 "링크 + 날짜가 있는 줄"을 게시글로 인식합니다.
  `fn_view('123')` 같은 자바스크립트 링크도 페이지 안의 함수를 읽어 실제 글 주소로 복원합니다.
- **조용한 0건 방지**: 게시글 목록을 하나도 못 읽으면 `empty`, 접속 실패는 `error`로 기록됩니다.
  12회 연속 문제가 생기거나 7일이 지나면 그 지역을 자동으로 다시 탐색합니다 (홈페이지 개편 대응).
- **DB 초기화 자동 복구**: 앱이 새로고침할 때마다 `/api/sync`로 지역·사이트 목록을 올려서 Render 재시작 후에도 복구됩니다.
- **중복 방지**: 같은 공고가 공지사항·고시공고 양쪽에 올라와도 한 번만 저장/알림합니다.

### 상태 확인
- 브라우저로 `https://piesta-server.onrender.com/status` 를 열면 지역별 연결 상태와 크롤 결과를 볼 수 있습니다.
- `npm run discover -- 천안` : 특정 지역 자동 탐색 결과만 확인 (국내 PC에서 실행 권장)
- `npm test` : 오프라인 파서 테스트

### 추가 환경변수 (모두 선택)
| 이름 | 설명 |
|---|---|
| `KEYWORDS` | 수집 키워드 쉼표 구분 (기본: 푸드트럭, 플리마켓, 먹거리부스, 셀러 모집 등) |
| `DEFAULT_REGIONS` | 항상 유지할 기본 지역 (기본: 논산,부여,공주,서천,보령,청양,익산,군산,김제,전주,완주) |
| `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | 네이버 검색 API 키. 넣으면 3시간마다 "지역 + 푸드트럭 모집" 뉴스/웹문서도 수집 (developers.naver.com, 무료) |

### 주의: 해외 서버 차단
Render 무료 서버는 싱가포르에 있어서 일부 지자체가 해외 접속을 막을 수 있습니다.
`/status` 에서 "홈페이지 접속 불가"가 많이 보이면 국내 리전 서버(예: 네이버클라우드, 집 PC)로 옮기는 것을 권장합니다.

## API 엔드포인트

- `GET /api/notices` - 공고 목록
- `GET /api/stats` - 서버 통계
- `POST /api/crawl` - 수동 크롤링
- `GET /api/health` - 헬스체크
- `GET /api/regions` / `POST /api/regions {name}` - 지역 목록 / 지역 추가(자동 연결)
- `POST /api/regions/:name/rediscover` - 지역 다시 연결
- `POST /api/sync` - 앱 지역·사이트 동기화
- `GET /status` - 사람이 보는 상태 페이지

## ⚠️ Render 무료 플랜 주의사항

- 15분 미사용 시 서버 잠듦 (다음 요청 시 30초~1분 깨어남)
- SQLite 데이터는 재시작 시 사라질 수 있음 → 매시간 크롤링으로 복구
- 무료 750시간/월 (한 서버는 24/7 가능)

## UptimeRobot으로 항상 깨워두기 (선택)

1. https://uptimerobot.com 가입
2. New Monitor → URL: `https://piesta-server.onrender.com/api/health`
3. Interval: 5 minutes
4. 매 5분마다 핑 → 서버 항상 깨어있음
