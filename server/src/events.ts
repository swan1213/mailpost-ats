import { config } from './config.js';
import { db, getMessage, kvGet, kvSet, type MessageRow } from './db.js';
import { fetchEvents, type MailgunEvent } from './mailgun.js';

const CURSOR_KEY = 'events_cursor';
// Mailgun can record events a little out of order, so each poll re-reads this much history.
const OVERLAP_SECONDS = 30 * 60;

let polledAt: number | null = null;
let pollError: string | null = null;
let polling = false;

export function eventsStatus() {
  return { polledAt, error: pollError, intervalSeconds: config.eventsPollSeconds };
}

function findMessage(event: MailgunEvent): MessageRow | undefined {
  const mailgunId = event.message?.headers?.['message-id'];
  if (mailgunId) {
    const row = db.prepare('SELECT * FROM messages WHERE mailgun_id = ?').get(mailgunId) as MessageRow | undefined;
    if (row) return row;
  }
  const localId = Number(event['user-variables']?.mailpost_id);
  return localId ? getMessage(localId) : undefined;
}

/** Records one event and updates its message. Returns false if it was already applied or is unknown. */
function applyEvent(event: MailgunEvent): boolean {
  const row = findMessage(event);
  if (!row) return false;

  const ts = Math.round(event.timestamp * 1000);
  const status = event['delivery-status'];
  const detail = status?.message || status?.description || event.reason || null;

  const inserted = db
    .prepare('INSERT OR IGNORE INTO events (id, message_id, event, severity, detail, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event.id, row.id, event.event, event.severity ?? null, detail, ts);
  if (inserted.changes === 0) return false;

  switch (event.event) {
    case 'delivered':
      db.prepare(
        `UPDATE messages SET status = 'delivered', delivered_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('sent', 'delivered')`,
      ).run(ts, Date.now(), row.id);
      break;
    case 'failed':
      if (event.severity === 'permanent') {
        db.prepare(
          "UPDATE messages SET status = 'failed', failed_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
        ).run(ts, detail ?? 'Permanent failure', Date.now(), row.id);
      } else {
        // Mailgun keeps retrying temporary failures itself; just surface the reason. Events can arrive out of
        // order, so a late "temporary failure" must not put an error on a message that was already delivered.
        db.prepare("UPDATE messages SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'sent'").run(
          `Temporary failure, Mailgun is retrying: ${detail ?? 'unknown reason'}`,
          Date.now(),
          row.id,
        );
      }
      break;
    case 'opened':
      db.prepare('UPDATE messages SET opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?').run(
        ts,
        Date.now(),
        row.id,
      );
      break;
    case 'clicked':
      db.prepare('UPDATE messages SET clicked_at = COALESCE(clicked_at, ?), updated_at = ? WHERE id = ?').run(
        ts,
        Date.now(),
        row.id,
      );
      break;
  }
  return true;
}

export async function pollEvents(): Promise<{ fetched: number; applied: number }> {
  if (polling) return { fetched: 0, applied: 0 };
  const first = db
    .prepare('SELECT MIN(sent_at) AS t FROM messages WHERE sent_at IS NOT NULL')
    .get() as { t: number | null };
  if (!first.t) return { fetched: 0, applied: 0 };

  polling = true;
  try {
    const cursor = Number(kvGet(CURSOR_KEY) ?? 0);
    const begin = Math.max(Math.floor(first.t / 1000) - 60, cursor - OVERLAP_SECONDS);
    const events = await fetchEvents(config.mailTag, begin);

    let applied = 0;
    let latest = cursor;
    for (const event of events) {
      if (applyEvent(event)) applied++;
      latest = Math.max(latest, Math.floor(event.timestamp));
    }
    kvSet(CURSOR_KEY, String(latest));
    polledAt = Date.now();
    pollError = null;
    return { fetched: events.length, applied };
  } catch (err) {
    pollError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    polling = false;
  }
}

export function startEventPoller() {
  const loop = async () => {
    try {
      const { applied } = await pollEvents();
      if (applied) console.log(`[events] applied ${applied} new Mailgun event(s)`);
    } catch (err) {
      console.error('[events]', (err as Error).message);
    }
    setTimeout(loop, config.eventsPollSeconds * 1000);
  };
  setTimeout(loop, 5_000);
}
