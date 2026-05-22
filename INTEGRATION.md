# 📱 안드로이드 앱 ↔ 크롤링 서버 통합 가이드

기존 React 앱(`foodtruck-app.jsx`)이 샘플 데이터 대신 이 서버에서 실시간으로 공고를 받아오도록 수정하는 방법입니다.

---

## 1단계: API URL 설정

앱 코드 상단(import 문 아래)에 추가:

```js
const API_BASE = 'http://YOUR_SERVER_IP:3000'; // 또는 https://your-domain.com
```

---

## 2단계: 샘플 데이터 → 서버 호출로 교체

기존 코드:
```js
const [notices, setNotices] = useState(SAMPLE_NOTICES);
```

수정 후:
```js
const [notices, setNotices] = useState([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(null);

useEffect(() => {
  const fetchNotices = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/notices?limit=200`);
      const data = await res.json();
      if (data.ok) {
        // 서버 응답을 앱 데이터 형식으로 변환
        const mapped = data.notices.map(n => ({
          id: n.id,
          region: n.region,
          title: n.title,
          org: n.org,
          deadline: n.deadline || n.posted_date || '',
          eventDate: '',
          location: '',
          url: n.url,
          summary: n.raw_text || '',
          fee: '',
          isNew: !!n.is_new,
        }));
        setNotices(mapped);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  fetchNotices();
  // 5분마다 자동 새로고침
  const interval = setInterval(fetchNotices, 5 * 60 * 1000);
  return () => clearInterval(interval);
}, []);
```

---

## 3단계: 푸시 알림 구독 (옵션)

설정 화면에서 알림 ON 시 서비스워커 등록:

```js
// public/sw.js 파일을 별도로 만들고
self.addEventListener('push', (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

앱 코드에서 구독:
```js
async function subscribePush(regions = []) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  const reg = await navigator.serviceWorker.register('/sw.js');

  // 서버에서 공개키 받기
  const keyRes = await fetch(`${API_BASE}/api/vapid-public-key`);
  const { key, enabled } = await keyRes.json();
  if (!enabled || !key) return;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  await fetch(`${API_BASE}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub, regions }),
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}
```

---

## 4단계: 안드로이드 APK로 변환 (Capacitor)

```bash
# 1. React 앱 빌드
npm run build

# 2. Capacitor 설치
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "푸드트럭알리미" "com.example.foodtruck" --web-dir=build

# 3. 안드로이드 플랫폼 추가
npx cap add android

# 4. 빌드 결과 동기화
npx cap sync

# 5. Android Studio에서 열기
npx cap open android
```

Android Studio에서:
- `Build > Generate Signed Bundle / APK` → APK 선택 → 서명 키 생성 → 빌드
- 결과물: `android/app/release/app-release.apk`

---

## 5단계: 네트워크 보안 설정 (HTTP 사용 시)

`android/app/src/main/AndroidManifest.xml`에 추가:
```xml
<application
    android:usesCleartextTraffic="true"
    ...>
```

또는 HTTPS로 배포(권장).

---

## 추천 배포 흐름

1. **개발 단계**: 로컬에서 `npm start` → 같은 와이파이의 폰 브라우저로 `http://컴퓨터IP:3000` 접속해 테스트
2. **소규모 운영**: Railway / Render 무료 플랜에 서버 배포 → 앱에서 해당 도메인 호출
3. **APK 배포**: Capacitor로 빌드한 APK를 카톡/구글드라이브로 공유 (Play Store 배포는 별도 등록 절차 필요)

---

## 동작 흐름 요약

```
[관공서 홈페이지들]
        ↓ 매시간 크롤링
[crawler.js] → SQLite DB 저장
        ↓
[Express API 서버]
        ↓ HTTPS 호출
[안드로이드 앱]
        ↓
[푸시 알림 (옵션)]
```
