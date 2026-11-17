import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'amber',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  preacher TEXT NOT NULL DEFAULT '',
  preached_at TEXT NOT NULL DEFAULT (date('now')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  audio_file TEXT NOT NULL DEFAULT '',
  audio_mime TEXT NOT NULL DEFAULT '',
  duration_sec REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT NOT NULL DEFAULT '',
  transcript_json TEXT NOT NULL DEFAULT '',
  analysis_json TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  cost_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notes_created ON notes(created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bible (
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (book, chapter, verse)
) WITHOUT ROWID;
`;

export function openDb(file, { bibleFile } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  if (bibleFile) loadBible(db, bibleFile);
  return db;
}

/** Cambios de esquema sobre bases existentes (idempotente). */
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  // Cada persona ve solo sus notas y carpetas.
  if (!cols('notes').includes('user_id')) db.exec('ALTER TABLE notes ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  if (!cols('folders').includes('user_id')) db.exec('ALTER TABLE folders ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  // Marca personal (logo y nombre del negocio) para las imágenes.
  if (!cols('users').includes('brand_json')) db.exec("ALTER TABLE users ADD COLUMN brand_json TEXT NOT NULL DEFAULT '{}'");
  db.exec('CREATE INDEX IF NOT EXISTS notes_user ON notes(user_id, preached_at DESC)');
  if (!cols('users').includes('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  // Plática por persona: en una nota compartida cada quien tiene su propia conversación.
  if (!cols('chat_messages').includes('user_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
    db.exec('UPDATE chat_messages SET user_id = (SELECT user_id FROM notes WHERE notes.id = chat_messages.note_id) WHERE user_id IS NULL');
  }
  // Grupos (familia o iglesia) para compartir prédicas.
  db.exec(`
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'familia',
  code TEXT NOT NULL UNIQUE,
  brand_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'miembro',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);
CREATE TABLE IF NOT EXISTS note_shares (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  shared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  shared_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (note_id, group_id)
);
CREATE INDEX IF NOT EXISTS note_shares_group ON note_shares(group_id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  hour INTEGER NOT NULL DEFAULT 7,
  tz TEXT NOT NULL DEFAULT 'America/Mexico_City',
  daily INTEGER NOT NULL DEFAULT 1,
  last_daily TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
  // Perfil y plan de cada cuenta.
  if (!cols('users').includes('display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  if (!cols('users').includes('plan')) db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'familia'");
  if (!cols('users').includes('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!cols('users').includes('paid_until')) db.exec("ALTER TABLE users ADD COLUMN paid_until TEXT NOT NULL DEFAULT ''");
  // Lo creado antes de haber varias cuentas pertenece a la primera cuenta.
  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (first) {
    if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(first.id);
    db.prepare('UPDATE notes SET user_id = ? WHERE user_id IS NULL').run(first.id);
    db.prepare('UPDATE folders SET user_id = ? WHERE user_id IS NULL').run(first.id);
  }
}

function loadBible(db, bibleFile) {
  const { n } = db.prepare('SELECT count(*) AS n FROM bible').get();
  if (n > 31000) return;
  const text = zlib.gunzipSync(fs.readFileSync(bibleFile)).toString('utf8');
  const insert = db.prepare('INSERT OR REPLACE INTO bible (book, chapter, verse, text) VALUES (?, ?, ?, ?)');
  const tx = db.transaction((lines) => {
    for (const line of lines) {
      const m = /^(\w{3}) (\d+):(\d+) (.*)$/.exec(line.trim());
      if (m) insert.run(m[1], Number(m[2]), Number(m[3]), m[4].trim());
    }
  });
  tx(text.split('\n'));
}

/** Reindexa una nota en la búsqueda de texto completo. */
export function indexNote(db, noteId) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId);
  if (!note) return;
  const parts = [note.preacher];
  if (note.transcript_json) {
    const t = JSON.parse(note.transcript_json);
    parts.push(t.segments.map((s) => s.text).join(' '));
  }
  if (note.analysis_json) {
    const a = JSON.parse(note.analysis_json);
    parts.push(a.central_idea, ...(a.main_points || []).map((p) => `${p.title} ${p.detail}`));
    parts.push(...(a.verses || []).map((v) => v.reference || ''));
  }
  db.prepare('INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)').run(
    noteId,
    note.title,
    parts.filter(Boolean).join('\n'),
  );
}
