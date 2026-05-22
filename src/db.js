// db.js - SQLite 데이터베이스 관리
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// 테이블 생성
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
`);

// 공고 upsert (이미 있으면 무시, 없으면 새로 등록)
const insertNoticeStmt = db.prepare(`
  INSERT OR IGNORE INTO notices
    (id, site_id, region, org, title, url, posted_date, deadline, raw_text, summary, is_new, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
`);

const findByIdStmt = db.prepare(`SELECT id FROM notices WHERE id = ?`);

function upsertNotice(notice) {
  const now = Date.now();
  const existing = findByIdStmt.get(notice.id);
  if (existing) return { isNew: false };

  insertNoticeStmt.run(
    notice.id,
    notice.site_id,
    notice.region,
    notice.org || null,
    notice.title,
    notice.url,
    notice.posted_date || null,
    notice.deadline || null,
    notice.raw_text || null,
    notice.summary || null,
    now,
    now
  );
  return { isNew: true };
}

// 공고 조회 (필터링 가능)
function getNotices({ region, search, limit = 100, offset = 0 } = {}) {
  let sql = `SELECT * FROM notices WHERE 1=1`;
  const params = [];

  if (region && region !== '전체') {
    sql += ` AND region = ?`;
    params.push(region);
  }

  if (search) {
    sql += ` AND (title LIKE ? OR org LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }

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

// 크롤 로그
function logCrawlStart(site_id) {
  const result = db.prepare(`INSERT INTO crawl_log (site_id, started_at, status) VALUES (?, ?, 'running')`)
    .run(site_id, Date.now());
  return result.lastInsertRowid;
}

function logCrawlEnd(log_id, { status, found_count, new_count, error }) {
  db.prepare(`
    UPDATE crawl_log
    SET finished_at = ?, status = ?, found_count = ?, new_count = ?, error = ?
    WHERE id = ?
  `).run(Date.now(), status, found_count || 0, new_count || 0, error || null, log_id);
}

function getCrawlStats() {
  return db.prepare(`
    SELECT site_id,
           MAX(started_at) as last_run,
           SUM(new_count) as total_new
    FROM crawl_log
    WHERE status = 'success'
    GROUP BY site_id
  `).all();
}

// 푸시 구독 관리
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

module.exports = {
  db,
  upsertNotice,
  getNotices,
  getNewCount,
  markAsRead,
  logCrawlStart,
  logCrawlEnd,
  getCrawlStats,
  addSubscription,
  getSubscriptions,
  removeSubscription,
};
