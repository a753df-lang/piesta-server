// index.js - 메인 서버 (사용자 사이트 동적 등록 지원)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const crypto = require('crypto');

const { crawlAll, crawlSite, crawlUserSite } = require('./crawler');
const { notifyNewNotices, pushEnabled, VAPID_PUBLIC } = require('./notifier');
const {
  getNotices, getCrawlStats,
  addSubscription, removeSubscription, markAsRead,
  addUserSite, getUserSites, removeUserSite, updateUserSiteStatus,
  db,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========== 공고 API ==========

app.get('/api/notices', (req, res) => {
  try {
    const { region, search, limit, offset } = req.query;
    const notices = getNotices({
      region, search,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ ok: true, count: notices.length, notices });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/notices/:id/read', (req, res) => {
  try {
    markAsRead(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/crawl', async (req, res) => {
  try {
    const result = await crawlAll();
    if (result.totalNew > 0) {
      const recentNew = getNotices({ limit: result.totalNew });
      await notifyNewNotices(recentNew);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const totalNotices = db.prepare(`SELECT COUNT(*) as c FROM notices`).get().c;
    const recent24h = db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`)
      .get(Date.now() - 24 * 60 * 60 * 1000).c;
    const recent7d = db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`)
      .get(Date.now() - 7 * 24 * 60 * 60 * 1000).c;
    const sites = getCrawlStats();
    const subCount = db.prepare(`SELECT COUNT(*) as c FROM subscriptions`).get().c;
    const userSiteCount = db.prepare(`SELECT COUNT(*) as c FROM user_sites`).get().c;

    res.json({
      ok: true, totalNotices, recent24h, recent7d, sites,
      subscriptions: subCount,
      userSites: userSiteCount,
      pushEnabled,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== 푸시 알림 API ==========

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null, enabled: pushEnabled });
});

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

app.post('/api/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== 🆕 사용자 사이트 API ==========

// 사용자 사이트 추가
app.post('/api/user-sites', async (req, res) => {
  try {
    const { region, name, url, type } = req.body;
    if (!region || !name || !url) {
      return res.status(400).json({ ok: false, error: '지역, 이름, URL 모두 필요' });
    }

    // URL 정규화
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    // ID 생성 (URL + name 기반)
    const id = 'usr_' + crypto.createHash('md5')
      .update(normalizedUrl + '|' + name).digest('hex').slice(0, 12);

    addUserSite({ id, region, name, url: normalizedUrl, type: type || '관공서' });

    // 즉시 첫 크롤링 시도 (비동기, 응답은 바로 보냄)
    const userSite = { id, region, name, url: normalizedUrl, type };
    crawlSite(userSite, true).then(result => {
      console.log(`첫 크롤링 완료: ${name} (${result.found || 0}건)`);
    }).catch(err => {
      console.error(`첫 크롤링 실패: ${name}`, err.message);
    });

    res.json({ ok: true, id, message: '사이트 등록됨. 자동 크롤링 시작' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 사용자 사이트 목록
app.get('/api/user-sites', (req, res) => {
  try {
    const sites = getUserSites();
    res.json({ ok: true, count: sites.length, sites });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 사용자 사이트 삭제
app.delete('/api/user-sites/:id', (req, res) => {
  try {
    removeUserSite(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 특정 사용자 사이트만 수동 크롤링 (테스트용)
app.post('/api/user-sites/:id/crawl', async (req, res) => {
  try {
    const userSite = db.prepare(`SELECT * FROM user_sites WHERE id = ?`).get(req.params.id);
    if (!userSite) return res.status(404).json({ ok: false, error: 'site not found' });
    const result = await crawlSite(userSite, true);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== 헬스체크 ==========

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ========== 스케줄러 ==========

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

  if (process.env.CRAWL_ON_START === 'true') {
    console.log('🚀 시작 크롤링 실행...');
    crawlAll().catch(err => console.error('시작 크롤 실패:', err));
  }
});

process.on('SIGTERM', () => {
  console.log('서버 종료중...');
  db.close();
  process.exit(0);
});
