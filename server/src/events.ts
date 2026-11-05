import { config } from './config.js';
import { db, type MessageRow } from './db.js';
import { deleteEvents, receiveEvents, type SesEvent } from './ses.js';

let polledAt: number | null = null;
let pollError: string | null = null;
let polling = false;

export function eventsStatus() {
  return { polledAt, error: pollError, intervalSeconds: config.eventsPollSeconds };
}

/** SES eventType -> the name stored in `events.event` (and shown as a pill in the dashboard). */
const EVENT_NAME: Record<string, string> = {
  Send: 'accepted',
  Delivery: 'delivered',
  DeliveryDelay: 'delayed',
  Bounce: 'failed',
  Reject: 'failed',
  'Rendering Failure': 'failed',
  Complaint: 'complained',
  Subscription: 'unsubscribed',
  Open: 'opened',
  Click: 'clicked',
};

const isBot = (e: SesEvent) => (e.open ?? e.click)?.isBotEvent === 'Likely';

function when(e: SesEvent): number {
  const sub = e.delivery ?? e.bounce ?? e.complaint ?? e.deliveryDelay ?? e.open ?? e.click ?? e.subscription;
  return Date.parse(sub?.timestamp ?? e.mail.timestamp) || Date.now();
}

function describe(e: SesEvent): string | null {
  switch (e.eventType) {
    case 'Bounce': {
      const b = e.bounce;
      const why = b?.bouncedRecipients?.find((r) => r.diagnosticCode)?.diagnosticCode;
      return [`${b?.bounceType ?? 'Unknown'} bounce${b?.bounceSubType ? ` (${b.bounceSubType})` : ''}`, why].filter(Boolean).join(': ');
    }
    case 'DeliveryDelay': {
      const d = e.deliveryDelay;
      return [d?.delayType, d?.delayedRecipients?.find((r) => r.diagnosticCode)?.diagnosticCode].filter(Boolean).join(': ') || null;
    }
    case 'Complaint':
      return `The recipient marked the email as spam${e.complaint?.complaintFeedbackType ? ` (${e.complaint.complaintFeedbackType})` : ''}`;
    case 'Reject':
      return `Rejected by SES: ${e.reject?.reason ?? 'bad content'}`;
    case 'Rendering Failure':
      return `Rendering failed: ${e.failure?.errorMessage ?? 'unknown'}`;
    case 'Subscription':
      return 'The recipient unsubscribed';
    case 'Open':
    case 'Click':
      return isBot(e) ? 'Likely automated (security scanner or prefetch), not counted' : (e.click?.link ?? null);
    default:
      return null;
  }
}

/** True when a Subscription event means the recipient opted out (of everything or of our topic). */
function optedOut(e: SesEvent): boolean {
  const p = e.subscription?.newTopicPreferences;
  return Boolean(p?.unsubscribeAll || p?.topicSubscriptionStatus?.some((t) => t.subscriptionStatus === 'OptOut'));
}

/** Records one event and updates its message. Returns false if it was already applied or is not one of ours. */
function applyEvent(e: SesEvent): boolean {
  const name = EVENT_NAME[e.eventType];
  if (!name) return false;
  if (e.eventType === 'Subscription' && !optedOut(e)) return false;
  const row = db.prepare('SELECT * FROM messages WHERE provider_id = ?').get(e.mail.messageId) as MessageRow | undefined;
  if (!row) return false;

  const ts = when(e);
  const detail = describe(e);
  // SES events have no id of their own; type + message + time is stable, so a redelivered event is ignored.
  const inserted = db
    .prepare('INSERT OR IGNORE INTO events (id, message_id, event, severity, detail, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`${e.eventType}:${e.mail.messageId}:${ts}`, row.id, name, e.bounce?.bounceType ?? null, detail, ts);
  if (inserted.changes === 0) return false;

  const t = Date.now();
  switch (e.eventType) {
    case 'Delivery':
      db.prepare(
        `UPDATE messages SET status = 'delivered', delivered_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('sent', 'delivered')`,
      ).run(ts, t, row.id);
      break;
    case 'Bounce': // SES only reports bounces it has stopped retrying, so every one is final
    case 'Reject':
    case 'Rendering Failure':
      db.prepare("UPDATE messages SET status = 'failed', failed_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(
        ts,
        detail ?? 'Not delivered',
        t,
        row.id,
      );
      break;
    case 'DeliveryDelay':
      // SES keeps retrying. Events can arrive out of order, so a late delay must not mark a delivered email.
      db.prepare("UPDATE messages SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'sent'").run(
        `Delayed, SES is retrying${detail ? `: ${detail}` : ''}`,
        t,
        row.id,
      );
      break;
    case 'Open':
      if (!isBot(e)) db.prepare('UPDATE messages SET opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?').run(ts, t, row.id);
      break;
    case 'Click':
      if (!isBot(e)) db.prepare('UPDATE messages SET clicked_at = COALESCE(clicked_at, ?), updated_at = ? WHERE id = ?').run(ts, t, row.id);
      break;
  }
  return true;
}

/** Reads the SES events waiting in the SQS queue, applies them, then removes them from the queue. */
export async function pollEvents(): Promise<{ fetched: number; applied: number }> {
  if (polling) return { fetched: 0, applied: 0 };
  polling = true;
  try {
    const received = await receiveEvents();
    let applied = 0;
    const done: string[] = [];
    for (const { event, receipt } of received) {
      // Unknown or unparseable records (e.g. test sends) are removed too, so they don't come back forever.
      if (event && applyEvent(event)) applied++;
      done.push(receipt);
    }
    if (done.length) await deleteEvents(done);
    polledAt = Date.now();
    pollError = null;
    return { fetched: received.length, applied };
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
      if (applied) console.log(`[events] applied ${applied} new SES event(s)`);
    } catch (err) {
      console.error('[events]', (err as Error).message);
    }
    setTimeout(loop, config.eventsPollSeconds * 1000);
  };
  setTimeout(loop, 5_000);
}
