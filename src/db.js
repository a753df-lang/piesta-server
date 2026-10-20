// db.js - SQLite 데이터베이스 관리
// 주의: Render 무료 플랜은 재배포/재시작 시 파일이 초기화될 수 있음.
//       → 앱이 /api/sync 로 지역·사이트를 다시 올려주고, 서버는 DEFAULT_REGIONS 를 항상 복구함.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    region TEXT NOT NULL,
    org TEXT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    posted_date TEXT,
    deadline TEXT,
    raw_text TEXT,
    summary TEXT,
    is_new INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_region ON notices(region);
  CREATE INDEX IF NOT EXISTS idx_created ON notices(created_at);
  CREATE INDEX IF NOT EXISTS idx_deadline ON notices(deadline);

  CREATE TABLE IF NOT EXISTS crawl_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT,
    found_count INTEGER DEFAULT 0,
    new_count INTEGER DEFAULT 0,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    regions TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_sites (
    id TEXT PRIMARY KEY,
    region TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    type TEXT,
    created_at INTEGER NOT NULL,
    last_status TEXT,
    last_error TEXT,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0
  );

  -- 🆕 앱에서 추가한 지역 (이름만 저장, 대상 사이트는 자동 탐색)
  CREATE TABLE IF NOT EXISTS regions (
    name TEXT PRIMARY KEY,          -- 앱에서 쓰는 이름 그대로 (예: '논산', '천안시')
    full_name TEXT,                 -- 지자체 목록상의 이름 (예: '논산시')
    domain TEXT,
    status TEXT,                    -- 'pending' | 'ok' | 'partial' | 'failed' | 'unknown'
    message TEXT,
    discovered_at INTEGER,
    created_at INTEGER NOT NULL
  );

  -- 🆕 자동 탐색된 크롤링 대상
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    region TEXT NOT NULL,
    kind TEXT NOT NULL,             -- 'eminwon' | 'board'
    name TEXT,
    url TEXT NOT NULL,
    status TEXT,                    -- 'ok' | 'empty' | 'error'
    rows_last INTEGER DEFAULT 0,    -- 마지막 크롤에서 인식한 게시글 줄 수 (0이면 구조 변경 의심)
    found_last INTEGER DEFAULT 0,
    last_error TEXT,
    last_run INTEGER,
    fail_streak INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sources_region ON sources(region);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ========== 공고 ==========
const insertNoticeStmt = db.prepare(`
  INSERT OR IGNORE INTO notices
    (id, site_id, region, org, title, url, posted_date, deadline, raw_text, summary, is_new, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
`);
const findByIdStmt = db.prepare(`SELECT id FROM notices WHERE id = ?`);
// 같은 공고가 공지사항·고시공고 양쪽에 올라오는 경우 중복 방지 (같은 지역 + 같은 제목, 60일 이내)
const findDupTitleStmt = db.prepare(`
  SELECT id FROM notices
  WHERE region = ? AND replace(title, ' ', '') = ? AND created_at > ?
  LIMIT 1
`);

function upsertNotice(notice) {
  const now = Date.now();
  if (findByIdStmt.get(notice.id)) return { isNew: false };
  const normTitle = String(notice.title || '').replace(/\s+/g, '');
  if (findDupTitleStmt.get(notice.region, normTitle, now - 60 * 86400000)) return { isNew: false };
  insertNoticeStmt.run(
    notice.id, notice.site_id, notice.region, notice.org || null,
    notice.title, notice.url, notice.posted_date || null, notice.deadline || null,
    notice.raw_text || null, notice.summary || null, now, now
  );
  return { isNew: true };
}

function getNotices({ region, search, limit = 100, offset = 0, since } = {}) {
  let sql = `SELECT * FROM notices WHERE 1=1`;
  const params = [];
  if (region && region !== '전체') { sql += ` AND region = ?`; params.push(region); }
  if (search) { sql += ` AND (title LIKE ? OR org LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
  if (since) { sql += ` AND created_at > ?`; params.push(since); }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function getNewCount(since) {
  return db.prepare(`SELECT COUNT(*) as c FROM notices WHERE created_at > ?`).get(since).c;
}

function markAsRead(id) {
  db.prepare(`UPDATE notices SET is_new = 0 WHERE id = ?`).run(id);
}

function deleteNotice(id) {
  const result = db.prepare(`DELETE FROM notices WHERE id = ?`).run(id);
  return result.changes > 0;
}

// 등록일이 기준일보다 오래된 공고 삭제 (등록일 모르는 공고는 유지). 반환: 삭제 건수
function pruneOldNotices(cutoffDate) {
  return db.prepare(`DELETE FROM notices WHERE posted_date IS NOT NULL AND posted_date < ?`).run(cutoffDate).changes;
}

// ========== 크롤 로그 ==========
function logCrawlStart(site_id) {
  const result = db.prepare(`INSERT INTO crawl_log (site_id, started_at, status) VALUES (?, ?, 'running')`)
    .run(site_id, Date.now());
  return result.lastInsertRowid;
}

function logCrawlEnd(log_id, { status, found_count, new_count, error }) {
  db.prepare(`
    UPDATE crawl_log SET finished_at = ?, status = ?, found_count = ?, new_count = ?, error = ?
    WHERE id = ?
  `).run(Date.now(), status, found_count || 0, new_count || 0, error || null, log_id);
}

// 오래된 로그 정리 (14일)
function pruneCrawlLog() {
  db.prepare(`DELETE FROM crawl_log WHERE started_at < ?`).run(Date.now() - 14 * 86400000);
}

// 사이트별 마지막 실행 결과 (성공/실패 모두)
function getCrawlStats() {
  return db.prepare(`
    SELECT c.site_id, c.started_at AS last_run, c.status, c.found_count, c.error,
           (SELECT SUM(new_count) FROM crawl_log WHERE site_id = c.site_id) AS total_new
    FROM crawl_log c
    WHERE c.id IN (SELECT MAX(id) FROM crawl_log GROUP BY site_id)
    ORDER BY c.site_id
  `).all();
}

// ========== 웹푸시 구독 ==========
function addSubscription(sub) {
  db.prepare(`
    INSERT OR REPLACE INTO subscriptions (endpoint, keys_p256dh, keys_auth, regions, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, JSON.stringify(sub.regions || []), Date.now());
}

function getSubscriptions() {
  return db.prepare(`SELECT * FROM subscriptions`).all();
}

function removeSubscription(endpoint) {
  db.prepare(`DELETE FROM subscriptions WHERE endpoint = ?`).run(endpoint);
}

// ========== 사용자 직접 등록 사이트 ==========
function addUserSite({ id, region, name, url, type }) {
  db.prepare(`
    INSERT INTO user_sites (id, region, name, url, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET region = excluded.region, name = excluded.name, url = excluded.url, type = excluded.type
  `).run(id, region, name, url, type || '관공서', Date.now());
}

function getUserSites() {
  return db.prepare(`SELECT * FROM user_sites ORDER BY created_at DESC`).all();
}

function removeUserSite(id) {
  db.prepare(`DELETE FROM user_sites WHERE id = ?`).run(id);
}

function updateUserSiteStatus(id, status, error, success) {
  if (success) {
    db.prepare(`
      UPDATE user_sites SET last_status = ?, last_error = NULL, success_count = success_count + 1
      WHERE id = ?
    `).run(status, id);
  } else {
    db.prepare(`
      UPDATE user_sites SET last_status = ?, last_error = ?, fail_count = fail_count + 1
      WHERE id = ?
    `).run(status, error || null, id);
  }
}

// ========== 🆕 지역 ==========
function getRegion(name) {
  return db.prepare(`SELECT * FROM regions WHERE name = ?`).get(name);
}

function getRegions() {
  return db.prepare(`SELECT * FROM regions ORDER BY created_at`).all();
}

function addRegion({ name, full_name, domain }) {
  db.prepare(`
    INSERT OR IGNORE INTO regions (name, full_name, domain, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(name, full_name || null, domain || null, Date.now());
}

function setRegionStatus(name, status, message) {
  db.prepare(`UPDATE regions SET status = ?, message = ?, discovered_at = ? WHERE name = ?`)
    .run(status, message || null, Date.now(), name);
}

function removeRegion(name) {
  db.prepare(`DELETE FROM sources WHERE region = ?`).run(name);
  db.prepare(`DELETE FROM regions WHERE name = ?`).run(name);
}

// ========== 🆕 크롤링 대상 ==========
function replaceSources(region, list) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM sources WHERE region = ?`).run(region);
    const ins = db.prepare(`
      INSERT OR REPLACE INTO sources (id, region, kind, name, url, status, rows_last, created_at)
      VALUES (?, ?, ?, ?, ?, 'ok', ?, ?)
    `);
    list.forEach((s, i) => ins.run(`${region}#${s.kind}#${i}`, region, s.kind, s.name, s.url, s.rows || 0, Date.now()));
  });
  tx();
}

function getSources(region) {
  if (region) return db.prepare(`SELECT * FROM sources WHERE region = ?`).all(region);
  return db.prepare(`SELECT * FROM sources ORDER BY region, kind`).all();
}

function updateSourceResult(id, { ok, rows, found, error }) {
  if (ok) {
    db.prepare(`
      UPDATE sources SET status = ?, rows_last = ?, found_last = ?, last_error = NULL, last_run = ?,
        fail_streak = CASE WHEN ? > 0 THEN 0 ELSE fail_streak + 1 END
      WHERE id = ?
    `).run(rows > 0 ? 'ok' : 'empty', rows, found, Date.now(), rows, id);
  } else {
    db.prepare(`
      UPDATE sources SET status = 'error', last_error = ?, last_run = ?, fail_streak = fail_streak + 1
      WHERE id = ?
    `).run(error || null, Date.now(), id);
  }
}

// ========== 기타 ==========
function getMeta(key) {
  const r = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, String(value));
}

module.exports = {
  db,
  upsertNotice, getNotices, getNewCount, markAsRead, deleteNotice, pruneOldNotices,
  logCrawlStart, logCrawlEnd, getCrawlStats, pruneCrawlLog,
  addSubscription, getSubscriptions, removeSubscription,
  addUserSite, getUserSites, removeUserSite, updateUserSiteStatus,
  getRegion, getRegions, addRegion, setRegionStatus, removeRegion,
  replaceSources, getSources, updateSourceResult,
  getMeta, setMeta,
};
