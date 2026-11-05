import { db, SPAM_SQL } from './db.js';
import type { Settings } from './settings.js';

/** How many of the most recent sends the safety check looks at. */
export const HEALTH_WINDOW = 1000;
/** Too few sends say nothing yet: one bounce in 20 emails is 5%. */
const MIN_SAMPLE = 200;

export interface Rates {
  sent: number;
  bounced: number;
  spam: number;
  /** Percentages, 0 when nothing was sent */
  bouncePct: number;
  spamPct: number;
}

const pct = (n: number, of: number) => (of ? (n / of) * 100 : 0);

/** Bounces and spam reports among the last `limit` emails SES accepted (all of them when limit is 0). */
export function rates(limit = 0): Rates {
  // Aliased "messages" because SPAM_SQL refers to messages.id.
  const r = db
    .prepare(
      `SELECT COUNT(*) AS sent, COALESCE(SUM(status = 'failed'), 0) AS bounced, COALESCE(SUM(${SPAM_SQL}), 0) AS spam
       FROM (SELECT id, status FROM messages WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT ?) AS messages`,
    )
    .get(limit > 0 ? limit : -1) as { sent: number; bounced: number; spam: number };
  return { ...r, bouncePct: pct(r.bounced, r.sent), spamPct: pct(r.spam, r.sent) };
}

const fmt = (n: number) => `${n.toFixed(n < 1 ? 2 : 1)}%`;

/** Why sending must stop to protect the sender reputation, or null when it is fine to go on. */
export function safetyProblem(s: Settings): string | null {
  if (!s.safetyEnabled) return null;
  const r = rates(HEALTH_WINDOW);
  if (r.sent < MIN_SAMPLE) return null;
  const fix = 'Check the Failed and Reported spam lists, then raise the limit or turn the safety check off on the Sending page before resuming.';
  if (r.spamPct > s.maxSpamPct)
    return `Paused for safety: ${r.spam} of the last ${r.sent.toLocaleString()} emails were reported as spam (${fmt(r.spamPct)}, limit ${fmt(s.maxSpamPct)}). ${fix}`;
  if (r.bouncePct > s.maxBouncePct)
    return `Paused for safety: ${r.bounced} of the last ${r.sent.toLocaleString()} emails bounced (${fmt(r.bouncePct)}, limit ${fmt(s.maxBouncePct)}). ${fix}`;
  return null;
}
