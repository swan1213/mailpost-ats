import path from 'node:path';
import { config } from './config.js';
import { db, kvGet, kvSet, now, transaction } from './db.js';
import { engineStatus } from './sender.js';
import { ValidationError } from './settings.js';

// Rows that look unsent (new / queued) although their own event history shows SES (or Mailgun before it) accepted
// them. This happened when a run reset rows to "new" and lost sent_at; the events were kept.
const BROKEN_SQL = `status IN ('new', 'queued') AND sent_at IS NULL
  AND EXISTS (SELECT 1 FROM events a WHERE a.message_id = messages.id AND a.event = 'accepted')`;

export function repairableCount(): { total: number; queued: number } {
  return db
    .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'queued'), 0) AS queued FROM messages WHERE ${BROKEN_SQL}`)
    .get() as { total: number; queued: number };
}

interface Ev {
  event: string;
  ts: number;
  detail: string | null;
}

/**
 * Restores sent / delivered / opened / bounced from each row's events, so the totals are right and the rows leave
 * the queue. Backs up the database first. Refused while sending, so the queue isn't changed under the sender.
 */
export function repairHistory(): { repaired: number; fromQueue: number; backup: string } {
  const engine = engineStatus();
  if (engine.state === 'running' || engine.sending) throw new ValidationError('Stop or pause sending before repairing');
  const { total } = repairableCount();
  if (!total) return { repaired: 0, fromQueue: 0, backup: '' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(path.dirname(config.dbFile), `mailpost.backup-before-repair-${stamp}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

  const rows = db.prepare(`SELECT id, status, attempts FROM messages WHERE ${BROKEN_SQL}`).all() as {
    id: number;
    status: string;
    attempts: number;
  }[];
  const eventsOf = db.prepare('SELECT event, ts, detail FROM events WHERE message_id = ? ORDER BY ts');
  const update = db.prepare(
    `UPDATE messages SET status = ?, sent_at = ?, delivered_at = ?, opened_at = COALESCE(opened_at, ?),
       clicked_at = COALESCE(clicked_at, ?), failed_at = ?, last_error = ?, queued_at = NULL,
       provider_id = COALESCE(provider_id, ?), attempts = MAX(attempts, 1), updated_at = ? WHERE id = ?`,
  );

  let fromQueue = 0;
  transaction(() => {
    for (const row of rows) {
      const evs = eventsOf.all(row.id) as unknown as Ev[];
      const sentAt = Math.max(...evs.filter((e) => e.event === 'accepted').map((e) => e.ts));
      const first = (name: string) => evs.find((e) => e.event === name)?.ts ?? null;
      // The latest delivered / failed event after the last send decides the outcome.
      const outcome = [...evs].reverse().find((e) => (e.event === 'delivered' || e.event === 'failed') && e.ts >= sentAt);
      const delivered = [...evs].reverse().find((e) => e.event === 'delivered')?.ts ?? null;
      const status = outcome?.event === 'failed' ? 'failed' : outcome?.event === 'delivered' ? 'delivered' : 'sent';
      update.run(
        status,
        sentAt,
        status === 'delivered' ? delivered : null,
        first('opened'),
        first('clicked'),
        status === 'failed' ? outcome!.ts : null,
        status === 'failed' ? (outcome!.detail ?? 'Bounced') : null,
        // A marker (not a real SES id), so the row never counts as "failed before sending" and gets re-queued.
        `restored-${row.id}`,
        now(),
        row.id,
      );
      if (row.status === 'queued') fromQueue++;
    }
    // Those rows were part of the current run's total.
    const raw = kvGet('run');
    if (raw && fromQueue) {
      const run = JSON.parse(raw) as { total: number };
      run.total = Math.max(0, run.total - fromQueue);
      kvSet('run', JSON.stringify(run));
    }
  });
  return { repaired: rows.length, fromQueue, backup };
}
