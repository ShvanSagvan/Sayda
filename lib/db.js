import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(process.env.DB_FILE || path.join(config.dataDir, 'site.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('verify','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY,
  grade INTEGER NOT NULL CHECK (grade IN (10,11,12)),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  thumbnail TEXT,
  video_provider TEXT,
  video_id TEXT,
  video_status TEXT NOT NULL DEFAULT 'none',
  published INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS textbooks (
  id INTEGER PRIMARY KEY,
  grade INTEGER NOT NULL CHECK (grade IN (10,11,12)),
  title TEXT NOT NULL DEFAULT '',
  track TEXT NOT NULL DEFAULT 'Literary (Wezhay / Adabi)',
  language TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  publication_year TEXT NOT NULL DEFAULT '',
  academic_year TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT '' CHECK (source_kind IN ('','official','authorized')),
  pdf_file TEXT,
  pdf_permission_note TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','in_review','verified')),
  published INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS candidate_links (
  id INTEGER PRIMARY KEY,
  grade INTEGER NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'to_review' CHECK (status IN ('to_review','matches','does_not_match')),
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS lesson_refs (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  textbook_id INTEGER NOT NULL REFERENCES textbooks(id) ON DELETE CASCADE,
  chapter TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL DEFAULT '',
  pages TEXT NOT NULL DEFAULT '',
  exercises TEXT NOT NULL DEFAULT '',
  reviewed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (lesson_id, textbook_id)
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked','cancelled')),
  price_iqd INTEGER NOT NULL,
  grades TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  access_end_date TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  whatsapp_opened_at TEXT,
  whatsapp_open_count INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id),
  payment_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_enroll_user ON enrollments(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending ON enrollments(user_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS enrollment_events (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

// Migration: each student belongs to one grade (10, 11 or 12) and can only unlock that grade.
if (!db.prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name = 'grade'`).get()) db.exec('ALTER TABLE users ADD COLUMN grade INTEGER');
// Open requests made before grades existed: narrow them to the student's grade once it is known.
db.exec(`UPDATE enrollments SET grades = '[' || (SELECT grade FROM users u WHERE u.id = enrollments.user_id) || ']'
         WHERE status = 'pending' AND (SELECT grade FROM users u WHERE u.id = enrollments.user_id) IS NOT NULL`);

export const nowIso = () => new Date().toISOString();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

// ---------- settings ----------
export const DEFAULT_SETTINGS = {
  teacher_name: '[Teacher Name]',
  teacher_intro: '',
  teacher_photo: '',
  city: 'Duhok',
  course_title: 'Wezhay / Adabi Mathematics',
  course_subtitle: 'KRG Literary track — Grades 10, 11 and 12',
  price_iqd: 0,
  grades_included: [10, 11, 12],
  access_mode: 'ongoing', // ongoing | end_date
  access_end_date: '', // YYYY-MM-DD, end of that day in site timezone
  whatsapp_number: '', // international format digits, e.g. 9647501234567
  whatsapp_message:
    "Hello, I'd like to pay through FIB for Wezhay / Adabi Mathematics, [Grade]. The course price is [Price] IQD. The student's enrollment reference is [Reference]. Student: [Name] ([Email]). Please send me the payment instructions.",
  demo: null, // { provider, video_id, title, duration_seconds, thumbnail, published }
  site_language: 'en', // en | ku
  wording: {}, // { en: {key: text}, ku: {key: text} } teacher-confirmed overrides
  wording_confirmed: { en: true, ku: false },
};

export function getSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of all('SELECT key, value FROM settings')) {
    try { s[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt */ }
  }
  return s;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// ---------- first-run seed: empty textbook records + private candidate links ----------
if (!one('SELECT 1 FROM textbooks LIMIT 1')) {
  for (const g of [10, 11, 12]) {
    run(`INSERT INTO textbooks (grade, notes) VALUES (?, ?)`, g,
      g === 10 ? 'KRG revised Grade 10 Literary Mathematics for 2025–2026. Check the cover and edition against the book students use in Duhok.' : '');
  }
}
if (!one('SELECT 1 FROM candidate_links LIMIT 1')) {
  const c = [
    [0, 'KRG Ministry of Education — e-Parwarda portal (starting point for official links)', 'https://parwarda.edu.krd/'],
    [10, 'Grade 10, Badini Literary Mathematics listing (Telegram)', 'https://t.me/s/talaat_math?before=143'],
    [11, 'Grade 11, Literary Mathematics listing (Telegram)', 'https://t.me/kurdishlearn/403'],
    [12, 'Grade 12, Literary Mathematics listing (Telegram)', 'https://t.me/kurdishlearn/404'],
  ];
  for (const [g, l, u] of c) run('INSERT INTO candidate_links (grade, label, url) VALUES (?, ?, ?)', g, l, u);
}
