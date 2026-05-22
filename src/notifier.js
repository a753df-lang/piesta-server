// notifier.js - 웹푸시 알림 발송
const webpush = require('web-push');
const { getSubscriptions, removeSubscription } = require('./db');

// VAPID 키는 환경변수로 설정 (없으면 알림 비활성화)
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

let pushEnabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  pushEnabled = true;
  console.log('✅ 웹푸시 알림 활성화됨');
} else {
  console.log('⚠️  VAPID 키 미설정 - 푸시 알림 비활성화 (서버는 정상 작동)');
}

async function sendPushToAll(notice) {
  if (!pushEnabled) return { sent: 0, failed: 0 };

  const subs = getSubscriptions();
  let sent = 0, failed = 0;

  const payload = JSON.stringify({
    title: `🚚 새 푸드트럭 공고 [${notice.region}]`,
    body: notice.title,
    url: notice.url,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: notice.id,
  });

  for (const sub of subs) {
    // 지역 필터링: 구독자가 특정 지역만 구독한 경우
    let regions = [];
    try { regions = JSON.parse(sub.regions || '[]'); } catch {}
    if (regions.length > 0 && !regions.includes(notice.region)) continue;

    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
      }, payload);
      sent++;
    } catch (err) {
      failed++;
      // 만료된 구독 정리
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(sub.endpoint);
      }
    }
  }

  return { sent, failed };
}

async function notifyNewNotices(items) {
  if (!pushEnabled || items.length === 0) return;

  console.log(`📨 ${items.length}건 푸시 알림 발송 중...`);
  for (const item of items) {
    const result = await sendPushToAll(item);
    console.log(`  → ${item.title}: ${result.sent}건 발송, ${result.failed}건 실패`);
  }
}

module.exports = { sendPushToAll, notifyNewNotices, pushEnabled, VAPID_PUBLIC };
