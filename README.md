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

## API 엔드포인트

- `GET /api/notices` - 공고 목록
- `GET /api/stats` - 서버 통계
- `POST /api/crawl` - 수동 크롤링
- `GET /api/health` - 헬스체크

## ⚠️ Render 무료 플랜 주의사항

- 15분 미사용 시 서버 잠듦 (다음 요청 시 30초~1분 깨어남)
- SQLite 데이터는 재시작 시 사라질 수 있음 → 매시간 크롤링으로 복구
- 무료 750시간/월 (한 서버는 24/7 가능)

## UptimeRobot으로 항상 깨워두기 (선택)

1. https://uptimerobot.com 가입
2. New Monitor → URL: `https://piesta-server.onrender.com/api/health`
3. Interval: 5 minutes
4. 매 5분마다 핑 → 서버 항상 깨어있음
