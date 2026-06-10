import Database from 'better-sqlite3';
import { config } from './config';

export interface Topic {
  id: number;
  user_id: number;
  name: string;
}

export type SourceType = 'text' | 'voice' | 'forward' | 'api';

export interface Note {
  id: number;
  topic_id: number;
  user_id: number;
  source_type: SourceType;
  text: string;
  forward_from: string | null;
  created_at: string; // UTC 'YYYY-MM-DD HH:MM:SS'
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.function('contains_utf8', (val: unknown, search: unknown) => {
  if (typeof val !== 'string' || typeof search !== 'string') return 0;
  return val.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
});


db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name    TEXT    NOT NULL,
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  source_type  TEXT    NOT NULL DEFAULT 'text',
  text         TEXT    NOT NULL,
  forward_from TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic_id);
CREATE TABLE IF NOT EXISTS user_state (
  user_id         INTEGER PRIMARY KEY,
  active_topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL
);
`);

export function isDuplicateError(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

// ---------- темы ----------

export function listTopics(userId: number): Topic[] {
  return db
    .prepare('SELECT * FROM topics WHERE user_id = ? ORDER BY name')
    .all(userId) as Topic[];
}

export function getTopic(topicId: number, userId: number): Topic | undefined {
  return db
    .prepare('SELECT * FROM topics WHERE id = ? AND user_id = ?')
    .get(topicId, userId) as Topic | undefined;
}

export function getTopicAny(topicId: number): Topic | undefined {
  return db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) as Topic | undefined;
}

/** Бросает SQLITE_CONSTRAINT_UNIQUE при дубликате имени. */
export function createTopic(userId: number, name: string): Topic {
  const info = db
    .prepare('INSERT INTO topics (user_id, name) VALUES (?, ?)')
    .run(userId, name);
  return getTopic(Number(info.lastInsertRowid), userId)!;
}

/** Бросает SQLITE_CONSTRAINT_UNIQUE при дубликате имени. */
export function renameTopic(topicId: number, userId: number, name: string): void {
  db.prepare('UPDATE topics SET name = ? WHERE id = ? AND user_id = ?').run(
    name,
    topicId,
    userId,
  );
}

export function deleteTopic(topicId: number, userId: number): void {
  db.prepare('DELETE FROM topics WHERE id = ? AND user_id = ?').run(topicId, userId);
}

// ---------- заметки ----------

export function addNote(
  topic: Topic,
  sourceType: SourceType,
  text: string,
  forwardFrom: string | null = null,
): Note {
  const info = db
    .prepare(
      'INSERT INTO notes (topic_id, user_id, source_type, text, forward_from) VALUES (?, ?, ?, ?, ?)',
    )
    .run(topic.id, topic.user_id, sourceType, text, forwardFrom);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid) as Note;
}

/** Последние `limit` заметок в хронологическом порядке. */
export function listNotes(topicId: number, limit = 10): Note[] {
  const rows = db
    .prepare('SELECT * FROM notes WHERE topic_id = ? ORDER BY id DESC LIMIT ?')
    .all(topicId, limit) as Note[];
  return rows.reverse();
}

export function countNotes(topicId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM notes WHERE topic_id = ?')
    .get(topicId) as { n: number };
  return row.n;
}

/** Возвращает topic_id удалённой заметки или undefined, если заметка не найдена/чужая. */
export function deleteNote(noteId: number, userId: number): number | undefined {
  const row = db
    .prepare('SELECT topic_id FROM notes WHERE id = ? AND user_id = ?')
    .get(noteId, userId) as { topic_id: number } | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  return row.topic_id;
}

// ---------- активная тема ----------

export function getActiveTopic(userId: number): Topic | undefined {
  return db
    .prepare(
      `SELECT t.* FROM user_state s JOIN topics t ON t.id = s.active_topic_id
       WHERE s.user_id = ?`,
    )
    .get(userId) as Topic | undefined;
}

export function setActiveTopic(userId: number, topicId: number | null): void {
  db.prepare(
    `INSERT INTO user_state (user_id, active_topic_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET active_topic_id = excluded.active_topic_id`,
  ).run(userId, topicId);
}

// ---------- API ----------

export function apiTopics(userId?: number) {
  const where = userId !== undefined ? 'WHERE t.user_id = ?' : '';
  const params = userId !== undefined ? [userId] : [];
  return db
    .prepare(
      `SELECT t.id, t.user_id, t.name, COUNT(n.id) AS notes_count
       FROM topics t LEFT JOIN notes n ON n.topic_id = t.id
       ${where} GROUP BY t.id ORDER BY t.user_id, t.name`,
    )
    .all(...params);
}

export function apiNotes(filter: {
  userId?: number;
  topicId?: number;
  topicName?: string;
  since?: string;
}) {
  const conds: string[] = [];
  const params: (number | string)[] = [];
  if (filter.userId !== undefined) {
    conds.push('n.user_id = ?');
    params.push(filter.userId);
  }
  if (filter.topicId !== undefined) {
    conds.push('n.topic_id = ?');
    params.push(filter.topicId);
  }
  if (filter.topicName !== undefined) {
    conds.push('contains_utf8(t.name, ?)');
    params.push(filter.topicName);
  }
  if (filter.since) {
    // принимает '2026-06-10T12:00:00' и '2026-06-10 12:00:00' (UTC)
    conds.push('n.created_at >= ?');
    params.push(filter.since.replace('T', ' ').slice(0, 19));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT n.id, n.topic_id, t.name AS topic_name, n.user_id,
              n.source_type, n.text, n.forward_from, n.created_at
       FROM notes n JOIN topics t ON t.id = n.topic_id
       ${where} ORDER BY n.id`,
    )
    .all(...params);
}

export function mergeNotes(noteId: number, userId: number): boolean {
  const note = db
    .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?')
    .get(noteId, userId) as Note | undefined;
  if (!note) return false;

  const prevNote = db
    .prepare(
      'SELECT * FROM notes WHERE topic_id = ? AND user_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
    )
    .get(note.topic_id, userId, note.id) as Note | undefined;
  if (!prevNote) return false;

  const mergedText = prevNote.text + '\n\n' + note.text;
  db.prepare('UPDATE notes SET text = ? WHERE id = ?').run(mergedText, prevNote.id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  return true;
}

