import { config } from './config.js';
import {
  db,
  filterSql,
  getMessage,
  kvGet,
  kvSet,
  now,
  transaction,
  UNSENT_SQL,
  type MessageFilter,
  type MessageRow,
} from './db.js';
import { MailgunError, sendMail } from './mailgun.js';
import { notifyDesktop } from './notify.js';
import { getSettings, render, ValidationError } from './settings.js';

/** idle = nothing queued · running = working through the queue · paused = stopped by an error, queue kept */
export type EngineState = 'idle' | 'running' | 'paused';

/** Progress of the current sending run, shown as "32/32 (ok 32, fail 0)". */
interface Run {
  total: number;
  ok: number;
  fail: number;
  startedAt: number;
  stopped: boolean;
}

const RUNNING_KEY = 'engine_running';
const RUN_KEY = 'run';

let state: EngineState = 'idle';
let timer: NodeJS.Timeout | undefined;
let nextSendAt: number | null = null;
let lastDelaySeconds: number | null = null;
let lastError: string | null = null;
let busy = false;

function getRun(): Run | null {
  const raw = kvGet(RUN_KEY);
  return raw ? (JSON.parse(raw) as Run) : null;
}

function updateRun(change: (run: Run) => void) {
  const run = getRun();
  if (!run) return;
  change(run);
  kvSet(RUN_KEY, JSON.stringify(run));
}

export function engineStatus() {
  return { state, nextSendAt, lastDelaySeconds, lastError, sending: busy, run: getRun() };
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function sentToday(): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sent_at >= ?').get(startOfToday().getTime()) as { n: number }
  ).n;
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  nextSendAt = Date.now() + ms;
  timer = setTimeout(() => {
    timer = undefined;
    nextSendAt = null;
    void tick();
  }, ms);
}

function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  nextSendAt = null;
}

function run() {
  if (state === 'running') return;
  state = 'running';
  lastError = null;
  kvSet(RUNNING_KEY, '1');
  schedule(0);
}

function pause(reason: string) {
  stopTimer();
  state = 'paused';
  kvSet(RUNNING_KEY, '0');
  lastError = reason;
  // Pauses only happen on errors that need a person, so tell them even if the dashboard isn't open.
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'queued'").get() as { n: number }).n;
  notifyDesktop('MailPost: sending paused', `${waiting.toLocaleString()} emails are waiting. ${reason.replace(/^Paused: /, '')}`).catch(
    () => {}, // already logged; a missing notification must never break sending
  );
}

/**
 * Queues unsent rows (by id, or everything matching a filter) and starts sending.
 * A new run starts when nothing was in flight; otherwise the rows join the current run.
 */
export function queueMessages(target: { ids?: number[]; filter?: MessageFilter }): { queued: number; skipped: number } {
  let candidates: number[];
  if (target.ids) {
    candidates = [...new Set(target.ids.map(Number).filter(Number.isInteger))];
    if (!candidates.length) throw new ValidationError('No recipients selected');
  } else if (target.filter) {
    const { where, params } = filterSql(target.filter);
    candidates = (
      db.prepare(`SELECT id FROM messages WHERE ${where} AND ${UNSENT_SQL} ORDER BY id`).all(...params) as { id: number }[]
    ).map((r) => r.id);
    if (!candidates.length) throw new ValidationError('No unsent recipients match');
  } else {
    throw new ValidationError('Nothing to send');
  }

  const inFlight = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status IN ('queued', 'sending')").get() as { n: number }
  ).n;

  const queued = transaction(() => {
    const stmt = db.prepare(
      `UPDATE messages SET status = 'queued', queued_at = ?, attempts = 0, last_error = NULL, failed_at = NULL,
         updated_at = ? WHERE id = ? AND ${UNSENT_SQL}`,
    );
    // The same address can be in several CSVs. Skip it if another row already emailed it (or is about to),
    // so nobody gets the email twice. Bounced addresses count as emailed, so they aren't retried either.
    const emailOf = db.prepare('SELECT email FROM messages WHERE id = ?');
    const taken = db.prepare(
      `SELECT 1 FROM messages WHERE email = ? AND id <> ? AND (sent_at IS NOT NULL OR status IN ('queued', 'sending')) LIMIT 1`,
    );
    const t = now();
    let count = 0;
    for (const id of candidates) {
      const row = emailOf.get(id) as { email: string } | undefined;
      if (!row || taken.get(row.email, id)) continue;
      count += Number(stmt.run(t, t, id).changes);
    }
    return count;
  });

  if (queued) {
    if (inFlight === 0) {
      kvSet(RUN_KEY, JSON.stringify({ total: queued, ok: 0, fail: 0, startedAt: now(), stopped: false } satisfies Run));
    } else {
      updateRun((r) => (r.total += queued));
    }
    run();
  }
  return { queued, skipped: candidates.length - queued };
}

/** Stops sending. Emails not sent yet go back to "unsent". */
export function stop(): number {
  stopTimer();
  // An email already being sent still finishes. If it fails, putBack() returns it to Unsent instead of the queue.
  state = 'idle';
  lastError = null;
  kvSet(RUNNING_KEY, '0');
  const cancelled = Number(
    db.prepare("UPDATE messages SET status = 'new', queued_at = NULL, updated_at = ? WHERE status = 'queued'").run(now())
      .changes,
  );
  updateRun((r) => {
    r.total -= cancelled;
    r.stopped = true;
  });
  return cancelled;
}

/** Called once at boot: recover from a crash mid-send and resume if the queue was running. */
export function resumeOnBoot() {
  db.prepare("UPDATE messages SET status = 'queued', updated_at = ? WHERE status = 'sending'").run(now());
  const queued = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'queued'").get() as { n: number }).n;
  if (!queued) return;
  if (kvGet(RUNNING_KEY) === '1') run();
  else state = 'paused';
}

/** Restarts a queue that was paused by an error (e.g. after fixing the API key). */
export function resume() {
  run();
}

/** How long to wait before retrying when Mailgun is unreachable or overloaded. */
const BACKOFF_MS = 5 * 60_000;

/**
 * A row that could not be sent goes back in the queue; if sending was stopped meanwhile, back to Unsent
 * (and out of the run's total), like the rest of the queue.
 */
function putBack(id: number, error: string, attempts?: number) {
  if (state === 'running') {
    db.prepare(
      "UPDATE messages SET status = 'queued', attempts = COALESCE(?, attempts), last_error = ?, updated_at = ? WHERE id = ?",
    ).run(attempts ?? null, error, now(), id);
  } else {
    db.prepare(
      "UPDATE messages SET status = 'new', queued_at = NULL, attempts = COALESCE(?, attempts), last_error = ?, updated_at = ? WHERE id = ?",
    ).run(attempts ?? null, error, now(), id);
    updateRun((r) => r.total--);
  }
}

/** Keeps the queue running but waits before the next try, and says why in the dashboard. */
function backOff(reason: string, ms: number) {
  lastError = `${reason.replace(/\.?$/, '.')} Retrying automatically at ${new Date(Date.now() + ms).toLocaleTimeString()}.`;
  schedule(ms);
}

async function tick() {
  if (state !== 'running' || busy) return;
  busy = true;
  try {
    await sendNext();
  } catch (err) {
    // Unexpected error (e.g. the database): pause rather than crash the server or retry in a loop.
    pause(`Paused: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy = false;
  }
}

async function sendNext() {
  if (config.dailyLimit > 0 && sentToday() >= config.dailyLimit) {
    const tomorrow = startOfToday();
    tomorrow.setDate(tomorrow.getDate() + 1);
    lastError = `Daily limit of ${config.dailyLimit} reached. Continuing tomorrow.`;
    schedule(tomorrow.getTime() - Date.now());
    return;
  }

  const row = db
    .prepare("SELECT * FROM messages WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1")
    .get() as MessageRow | undefined;
  if (!row) {
    state = 'idle';
    kvSet(RUNNING_KEY, '0');
    return;
  }

  const settings = getSettings();

  db.prepare("UPDATE messages SET status = 'sending', updated_at = ? WHERE id = ?").run(now(), row.id);
  try {
    const mail = render(row, settings);
    const mailgunId = await sendMail({
      to: row.email,
      name: row.name,
      subject: mail.subject,
      text: mail.body,
      tag: config.mailTag,
      variables: { mailpost_id: String(row.id) },
    });
    db.prepare(
      `UPDATE messages SET status = 'sent', mailgun_id = ?, sent_subject = ?, sent_body = ?, sent_at = ?,
         attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`,
    ).run(mailgunId, mail.subject, mail.body, now(), now(), row.id);
    updateRun((r) => r.ok++);
    // A send went through, so an earlier "daily limit" or "Mailgun unreachable" message no longer applies.
    if (state === 'running') lastError = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Accounts on probation get a 403 "limited to 100 messages / hour ... enabled in 1020 seconds".
    // That is a rate limit, not a bad key: wait as long as Mailgun says, then carry on by itself.
    const enabledIn = err instanceof MailgunError && err.status === 403 ? Number(/enabled in (\d+) seconds/i.exec(message)?.[1]) : NaN;
    if (enabledIn > 0) {
      putBack(row.id, message);
      if (state === 'running') backOff(message, (enabledIn + 30) * 1000);
      return;
    }

    // Bad API key / domain: every send would fail the same way, so stop instead of burning attempts.
    if (err instanceof MailgunError && [401, 403, 404].includes(err.status)) {
      putBack(row.id, message);
      if (state === 'running') pause(`Paused: ${message}`);
      return;
    }

    // Mailgun unreachable or overloaded: wait and retry this same email without using up its attempts,
    // so a network outage doesn't mark the whole queue as failed one row after another.
    if (err instanceof MailgunError && (err.status === 0 || err.status === 429 || err.status >= 500)) {
      putBack(row.id, message);
      if (state === 'running') backOff(message, BACKOFF_MS);
      return;
    }

    const attempts = row.attempts + 1;
    if (attempts >= config.maxAttempts) {
      db.prepare(
        "UPDATE messages SET status = 'failed', attempts = ?, last_error = ?, failed_at = ?, updated_at = ? WHERE id = ?",
      ).run(attempts, message, now(), now(), row.id);
      updateRun((r) => r.fail++);
    } else {
      putBack(row.id, message, attempts);
    }
  }

  if (state !== 'running') return;
  // Read every time, so delay changes in the dashboard apply to the next email.
  // Wait = delay + random whole number of seconds from 1 to max, e.g. 30 + random 1–10 = 31–40s.
  const extra = settings.delayRandomMax > 0 ? 1 + Math.floor(Math.random() * settings.delayRandomMax) : 0;
  lastDelaySeconds = settings.delaySeconds + extra;
  schedule(lastDelaySeconds * 1000);
}

export async function sendTest(messageId: number) {
  const settings = getSettings();
  if (!settings.testEmail) throw new ValidationError('Set a test email address in Settings first');
  const row = getMessage(messageId);
  if (!row) throw new ValidationError('Recipient not found');

  const mail = render(row, settings);
  await sendMail({
    to: settings.testEmail,
    subject: `[TEST] ${mail.subject}`,
    text: mail.body,
    tag: `${config.mailTag}-test`,
  });
  return { to: settings.testEmail, basedOn: row.email };
}

/**
 * Sends the saved template to the test address, filled in for a real recipient who gets the template
 * (or a sample name when nobody does yet), exactly as it would go out.
 */
export async function sendTemplateTest() {
  const settings = getSettings();
  if (!settings.testEmail) throw new ValidationError('Enter a test email address first');
  const sample = (db.prepare("SELECT * FROM messages WHERE TRIM(csv_subject) = '' AND status <> 'skipped' ORDER BY id LIMIT 1").get() as
    | MessageRow
    | undefined) ?? { name: 'Alex', email: settings.testEmail, location: '', csv_subject: '', csv_content: '' };

  const mail = render({ ...sample, csv_subject: '', csv_content: '' }, settings);
  await sendMail({
    to: settings.testEmail,
    subject: `[TEST] ${mail.subject}`,
    text: mail.body,
    tag: `${config.mailTag}-test`,
  });
  return { to: settings.testEmail, filledFor: sample.name || sample.email };
}
