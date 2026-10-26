import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

/** new = imported, not sent yet · skipped = bad row in the CSV, never sendable */
export type Status = 'new' | 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'skipped';

export interface MessageRow {
  id: number;
  upload_id: number;
  email: string;
  name: string;
  location: string;
  csv_subject: string;
  csv_content: string;
  status: Status;
  attempts: number;
  last_error: string | null;
  mailgun_id: string | null;
  sent_subject: string | null;
  sent_body: string | null;
  created_at: number;
  updated_at: number;
  queued_at: number | null;
  sent_at: number | null;
  delivered_at: number | null;
  opened_at: number | null;
  clicked_at: number | null;
  failed_at: number | null;
}

export const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- One row per CSV file name; re-uploading or re-importing the same name merges into it
  CREATE TABLE IF NOT EXISTS uploads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    NOT NULL UNIQUE,
    uploaded_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id    INTEGER NOT NULL REFERENCES uploads (id),
    email        TEXT    NOT NULL,
    name         TEXT    NOT NULL DEFAULT '',
    location     TEXT    NOT NULL DEFAULT '',
    csv_subject  TEXT    NOT NULL DEFAULT '',
    csv_content  TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    mailgun_id   TEXT,
    sent_subject TEXT,
    sent_body    TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    queued_at    INTEGER,
    sent_at      INTEGER,
    delivered_at INTEGER,
    opened_at    INTEGER,
    clicked_at   INTEGER,
    failed_at    INTEGER,
    UNIQUE (upload_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status, queued_at);
  CREATE INDEX IF NOT EXISTS idx_messages_mailgun_id ON messages (mailgun_id);
  -- Duplicate-recipient check across CSV files when queueing
  CREATE INDEX IF NOT EXISTS idx_messages_email ON messages (email);

  -- Mailgun events, keyed by Mailgun's event id so repeated polls never double-apply
  CREATE TABLE IF NOT EXISTS events (
    id         TEXT    PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    event      TEXT    NOT NULL,
    severity   TEXT,
    detail     TEXT,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_message ON events (message_id);

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const now = () => Date.now();

export function kvGet(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function getMessage(id: number): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Rows that can be put in the send queue: never sent, or failed before Mailgun accepted them. */
export const UNSENT_SQL = "(status = 'new' OR (status = 'failed' AND mailgun_id IS NULL))";

/** Another row (usually from another CSV) already emailed this address, or is about to. */
export const EMAILED_ELSEWHERE_SQL = `EXISTS (SELECT 1 FROM messages o WHERE o.email = messages.email AND o.id <> messages.id
  AND (o.sent_at IS NOT NULL OR o.status IN ('queued', 'sending')))`;

/** Unsent rows that would really be sent: queueMessages() skips addresses already emailed from another file. */
export const SENDABLE_SQL = `(${UNSENT_SQL} AND NOT ${EMAILED_ELSEWHERE_SQL})`;

export type StatusFilter =
  | 'all'
  | 'unsent'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'failed'
  | 'duplicate'
  | 'skipped';

export interface MessageFilter {
  q?: string;
  status?: StatusFilter;
  uploadId?: number;
}

const STATUS_SQL: Record<StatusFilter, string> = {
  all: '1',
  unsent: SENDABLE_SQL,
  queued: "status IN ('queued', 'sending')",
  // Everything Mailgun accepted (delivered and bounced included), matching the "Sent" total on the dashboard.
  sent: 'sent_at IS NOT NULL',
  delivered: "status = 'delivered'",
  opened: 'opened_at IS NOT NULL',
  failed: "status = 'failed'",
  duplicate: `(${UNSENT_SQL} AND ${EMAILED_ELSEWHERE_SQL})`,
  skipped: "status = 'skipped'",
};

export const STATUS_FILTERS = Object.keys(STATUS_SQL) as StatusFilter[];

/** How many rows each status tab would show for this search / file. */
export function statusCounts(filter: Omit<MessageFilter, 'status'>): Record<StatusFilter, number> {
  const { where, params } = filterSql({ ...filter, status: 'all' });
  const columns = STATUS_FILTERS.map((s) => `COALESCE(SUM(${STATUS_SQL[s]}), 0) AS "${s}"`).join(', ');
  return db.prepare(`SELECT ${columns} FROM messages WHERE ${where}`).get(...params) as Record<StatusFilter, number>;
}

/** WHERE clause + params for the dashboard's search / status / file filters. */
export function filterSql(filter: MessageFilter): { where: string; params: (string | number)[] } {
  const parts = [STATUS_SQL[filter.status ?? 'all'] ?? '1'];
  const params: (string | number)[] = [];
  if (filter.uploadId) {
    parts.push('upload_id = ?');
    params.push(filter.uploadId);
  }
  const q = filter.q?.trim();
  if (q) {
    parts.push("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR csv_subject LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like, like);
  }
  return { where: parts.join(' AND '), params };
}
