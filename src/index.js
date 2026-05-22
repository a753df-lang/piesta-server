// index.js - 메인 서버
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const { crawlAll } = require('./crawler');
const { notifyNewNotices, pushEnabled, VAPID_PUBLIC } = require('./notifier');
const {
  getNotices,
  getCrawlStats,
  addSubscription,
  removeSubscription,
  markAsRead,
  db,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 정적 파일 서빙 (앱 빌드 결과물)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========== API 라우트 ==========

// 공고 목록
app.get('/api/notices', (req, res) => {
  try {
    const { region, search, limit, offset } = req.query;
    const notices = getNotices({
      region,
      search,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ ok: true, count: notices.length, notices });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 공고 읽음 처리
app.post('/api/notices/:id/read', (req, res) => {
  try {
    markAsRead(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 수동 크롤링 트리거 (관리용)
app.post('/api/crawl', async (req, res) => {
  try {
    const result = await crawlAll();

    // 새 공고가 있으면 푸시 알림 발송
    if (result.totalNew > 0) {
      const newItems = result.results
        .flatMap(r => (r.items || []).slice(0, r.isNew));
      // 단순화: isNew 카운트만큼 최근 항목으로 알림
      const recentNew = getNotices({ limit: result.totalNew });
      await notifyNewNotices(recentNew);
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 크롤 통계 / 서버 상태
app.get('/api/stats', (req, res) => {
  try {
    const totalNotices = db.prepare(`SELECT COUNT(*) as c FROM notices`).get().c;
    const recent24h = db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`)
      .get(Date.now() - 24 * 60 * 60 * 1000).c;
    const recent7d = db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`)
      .get(Date.now() - 7 * 24 * 60 * 60 * 1000).c;
    const sites = getCrawlStats();
    const subCount = db.prepare(`SELECT COUNT(*) as c FROM subscriptions`).get().c;

    res.json({
      ok: true,
      totalNotices,
      recent24h,
      recent7d,
      sites,
      subscriptions: subCount,
      pushEnabled,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// VAPID 공개키 제공 (앱이 푸시 구독 시 필요)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null, enabled: pushEnabled });
});

// 푸시 구독 등록
app.post('/api/subscribe', (req, res) => {
  try {
    const { subscription, regions } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ ok: false, error: 'invalid subscription' });
    }
    addSubscription({ ...subscription, regions: regions || [] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 구독 해제
app.post('/api/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 헬스체크
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ========== 스케줄러 ==========
// 기본: 매시간 정각에 크롤링 (CRAWL_CRON 환경변수로 변경 가능)
const CRON_SCHEDULE = process.env.CRAWL_CRON || '0 * * * *';

cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const before = db.prepare(`SELECT MAX(created_at) as t FROM notices`).get().t || 0;
    const result = await crawlAll();

    if (result.totalNew > 0) {
      const newItems = db.prepare(`SELECT * FROM notices WHERE created_at > ? ORDER BY created_at DESC`)
        .all(before);
      await notifyNewNotices(newItems);
    }
  } catch (err) {
    console.error('스케줄 크롤 실패:', err);
  }
}, { timezone: 'Asia/Seoul' });

console.log(`⏰ 스케줄러 등록됨: ${CRON_SCHEDULE} (Asia/Seoul)`);

// ========== 서버 시작 ==========
app.listen(PORT, () => {
  console.log(`\n🚚 푸드트럭 알리미 서버 실행중`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/notices`);
  console.log(`   상태: http://localhost:${PORT}/api/stats\n`);

  // 시작 시 크롤링 1회 실행 (옵션)
  if (process.env.CRAWL_ON_START === 'true') {
    console.log('🚀 시작 크롤링 실행...');
    crawlAll().catch(err => console.error('시작 크롤 실패:', err));
  }
});

// graceful shutdown
process.on('SIGTERM', () => {
  console.log('서버 종료중...');
  db.close();
  process.exit(0);
});
