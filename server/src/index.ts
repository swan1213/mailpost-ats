import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, ROOT } from './config.js';
import {
  db,
  EMAILED_ELSEWHERE_SQL,
  filterSql,
  getMessage,
  SENDABLE_SQL,
  STATUS_FILTERS,
  statusCounts,
  UNSENT_SQL,
  type MessageFilter,
  type MessageRow,
  type StatusFilter,
} from './db.js';
import { emailHtml } from './emailHtml.js';
import { eventsStatus, pollEvents, startEventPoller } from './events.js';
import { reimportFolder, saveAndImport } from './importer.js';
import { desktopNotificationsAvailable, notifyDesktop } from './notify.js';
import { engineStatus, queueMessages, resume, resumeOnBoot, sendTemplateTest, sendTest, sentToday, stop } from './sender.js';
import { getSettings, render, updateSettings, ValidationError } from './settings.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

function readFilter(source: Record<string, unknown> | undefined): MessageFilter {
  const status = String(source?.status ?? 'all') as StatusFilter;
  return {
    q: source?.q ? String(source.q) : undefined,
    status: STATUS_FILTERS.includes(status) ? status : 'all',
    uploadId: Number(source?.uploadId) || undefined,
  };
}

const PREVIEW_CHARS = 140;

app.get('/api/state', (_req, res) => {
  const count = (where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get() as { n: number }).n;
  const { where: unsent } = filterSql({ status: 'unsent' });
  res.json({
    engine: engineStatus(),
    events: eventsStatus(),
    counts: {
      total: count('1'),
      sent: count('sent_at IS NOT NULL'),
      unsent: count(unsent),
      queued: count("status IN ('queued', 'sending')"),
      delivered: count("status = 'delivered'"),
      opened: count('opened_at IS NOT NULL'),
      failed: count("status = 'failed'"),
    },
    settings: getSettings(),
    limits: { from: config.mailFrom, dailyLimit: config.dailyLimit, maxAttempts: config.maxAttempts, sentToday: sentToday() },
    desktopNotifications: desktopNotificationsAvailable(),
  });
});

app.put('/api/settings', (req, res) => {
  res.json(updateSettings(req.body ?? {}));
});

app.get('/api/uploads', (_req, res) => {
  // "messages" is joined without an alias because SENDABLE_SQL refers to messages.email / messages.id.
  res.json(
    db
      .prepare(
        `SELECT u.id, u.filename, u.uploaded_at, COUNT(messages.id) AS total,
           COALESCE(SUM(messages.sent_at IS NOT NULL), 0) AS sent,
           COALESCE(SUM(messages.status = 'delivered'), 0) AS delivered,
           COALESCE(SUM(${SENDABLE_SQL}), 0) AS unsent
         FROM uploads u LEFT JOIN messages ON messages.upload_id = u.id
         GROUP BY u.id ORDER BY u.uploaded_at DESC`,
      )
      .all(),
  );
});

const DAY_MS = 86_400_000;
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Overview page: sent / delivered / opened per day for the last 14 days, and the latest Mailgun events. */
app.get('/api/overview', (_req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setTime(start.getTime() - 13 * DAY_MS);
  const perDay = (column: string) =>
    new Map(
      (
        db
          .prepare(
            `SELECT date(${column} / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
             FROM messages WHERE ${column} >= ? GROUP BY day`,
          )
          .all(start.getTime()) as { day: string; n: number }[]
      ).map((r) => [r.day, r.n]),
    );
  const sent = perDay('sent_at');
  const delivered = perDay('delivered_at');
  const opened = perDay('opened_at');
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const day = localDay(d);
    return { day, sent: sent.get(day) ?? 0, delivered: delivered.get(day) ?? 0, opened: opened.get(day) ?? 0 };
  });

  const recent = db
    .prepare(
      `SELECT e.id, e.event, e.ts, e.detail, m.id AS messageId, m.email, m.name
       FROM events e JOIN messages m ON m.id = e.message_id
       WHERE e.event IN ('delivered', 'opened', 'clicked', 'failed')
       ORDER BY e.ts DESC LIMIT 12`,
    )
    .all();

  res.json({ days, recent });
});

/** Template page: the template as typed (not saved yet), rendered for a real recipient who would get it. */
app.post('/api/template/preview', (req, res) => {
  const subject = String(req.body?.subject ?? '');
  const body = String(req.body?.body ?? '');
  const usesTemplate = "TRIM(csv_subject) = '' AND status <> 'skipped'";
  const sample = (db.prepare(`SELECT * FROM messages WHERE ${usesTemplate} ORDER BY id LIMIT 1`).get() as MessageRow | undefined) ?? {
    name: 'Alex',
    email: 'alex@example.com',
    location: '',
  };
  const mail = render(
    { name: sample.name, email: sample.email, location: sample.location, csv_subject: '', csv_content: '' },
    { ...getSettings(), templateSubject: subject, templateBody: body },
  );
  const count = (where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get() as { n: number }).n;
  res.json({
    subject: mail.subject,
    html: emailHtml(mail.subject, mail.body),
    filledFor: sample.name || sample.email,
    recipients: count(usesTemplate),
    unsent: count(`${usesTemplate} AND ${SENDABLE_SQL}`),
  });
});

/** Body: the raw CSV text (Content-Type text/csv); ?filename=list.csv. Raw text, because the main CSV is ~46 MB. */
app.post('/api/uploads', express.text({ type: 'text/*', limit: '500mb' }), (req, res) => {
  const content: unknown = req.body;
  if (typeof content !== 'string' || !content) throw new ValidationError('No file content received');
  res.json(saveAndImport(String(req.query.filename || 'upload.csv'), content));
});

app.post('/api/reimport', (_req, res) => {
  res.json(reimportFolder());
});

/** One page of the table: ?q=&status=&uploadId=&page=1&pageSize=100 */
app.get('/api/messages', (req, res) => {
  const filter = readFilter(req.query as Record<string, unknown>);
  const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize) || 100));
  const { where, params } = filterSql(filter);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));

  const settings = getSettings();
  const rows = db
    .prepare(
      `SELECT *, (${UNSENT_SQL} AND ${EMAILED_ELSEWHERE_SQL}) AS duplicate FROM messages WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as (MessageRow & { duplicate: number })[];

  res.json({
    total,
    page,
    pageSize,
    pages,
    counts: statusCounts({ q: filter.q, uploadId: filter.uploadId }),
    rows: rows.map((m) => {
      const preview = render(m, settings);
      const body = (m.sent_body ?? preview.body).replace(/\s+/g, ' ').trim();
      return {
        id: m.id,
        upload_id: m.upload_id,
        email: m.email,
        name: m.name,
        location: m.location,
        subject: m.sent_subject ?? preview.subject,
        bodyPreview: body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body,
        source: preview.source,
        status: m.status,
        // "unsent" = can be selected and sent; "duplicate" = unsent here, but the address was emailed from another file.
        unsent: (m.status === 'new' || (m.status === 'failed' && !m.mailgun_id)) && !m.duplicate,
        duplicate: Boolean(m.duplicate),
        last_error: m.last_error,
        attempts: m.attempts,
        sent_at: m.sent_at,
        delivered_at: m.delivered_at,
        opened_at: m.opened_at,
        updated_at: m.updated_at,
      };
    }),
  });
});

app.get('/api/messages/:id', (req, res) => {
  const message = getMessage(Number(req.params.id));
  if (!message) {
    res.status(404).json({ error: 'Recipient not found' });
    return;
  }
  const preview = render(message);
  res.json({
    id: message.id,
    source: preview.source,
    // Once sent, show exactly what went out; before that, what would go out now.
    subject: message.sent_subject ?? preview.subject,
    body: message.sent_body ?? preview.body,
    final: message.sent_body !== null,
    mailgunId: message.mailgun_id,
    attempts: message.attempts,
    sentAt: message.sent_at,
    events: db.prepare('SELECT * FROM events WHERE message_id = ? ORDER BY ts').all(message.id),
  });
});

/** The branded HTML email exactly as it is (or will be) sent, for the preview in the dashboard. */
app.get('/api/messages/:id/html', (req, res) => {
  const message = getMessage(Number(req.params.id));
  if (!message) {
    res.status(404).send('Recipient not found');
    return;
  }
  const preview = render(message);
  res.type('html').send(emailHtml(message.sent_subject ?? preview.subject, message.sent_body ?? preview.body));
});

/** Body: { ids: number[] } for "Send selected", or { filter } for "Send all unsent" / "Start auto-send". */
app.post('/api/send', (req, res) => {
  const body = req.body ?? {};
  if (Array.isArray(body.ids)) res.json(queueMessages({ ids: body.ids }));
  else res.json(queueMessages({ filter: readFilter(body.filter) }));
});

/** Counts what a filter-based send would queue (same rows as POST /api/send with that filter), for the confirmation. */
app.post('/api/send/preview', (req, res) => {
  const { where, params } = filterSql(readFilter(req.body?.filter));
  res.json({
    count: (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where} AND ${SENDABLE_SQL}`).get(...params) as { n: number }).n,
  });
});

app.post('/api/stop', (_req, res) => {
  res.json({ cancelled: stop() });
});

app.post('/api/resume', (_req, res) => {
  resume();
  res.json(engineStatus());
});

app.post('/api/test', async (req, res) => {
  res.json(await sendTest(Number(req.body?.messageId)));
});

app.post('/api/test/template', async (_req, res) => {
  res.json(await sendTemplateTest());
});

app.post('/api/events/poll', async (_req, res) => {
  res.json(await pollEvents());
});

/** Shows a sample "sending paused" notification on the server's Windows desktop. */
app.post('/api/notify/test', async (_req, res) => {
  if (!desktopNotificationsAvailable()) throw new ValidationError('Windows notifications are off (the server is not on Windows, or DESKTOP_NOTIFICATIONS=0)');
  await notifyDesktop('MailPost: test notification', 'This is how MailPost tells you when sending pauses. Click to open the dashboard.');
  res.json({ ok: true });
});

// Serve the built dashboard (npm run build) from the same port.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) res.sendFile(path.join(dist, 'index.html'));
    else next();
  });
}

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  // Body-parser errors carry their own 4xx status (413 too large, 400 bad JSON).
  const status = err instanceof ValidationError ? 400 : err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[api]', err.message);
  res.status(status).json({ error: status === 413 ? 'The upload is too large' : err.message });
});

resumeOnBoot();
startEventPoller();

app.listen(config.port, config.host, () => {
  console.log(`[server] MailPost on http://${config.host}:${config.port} · CSV folder ${config.csvDir}`);
});
