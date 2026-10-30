import { config } from './config.js';
import { emailHtml } from './emailHtml.js';

export class MailgunError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got a response */
    readonly status: number,
  ) {
    super(message);
  }
}

const auth = 'Basic ' + Buffer.from(`api:${config.mailgun.apiKey}`).toString('base64');
const apiBase = `${config.mailgun.baseUrl}/v3/${config.mailgun.domain}`;

async function request(url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: auth, ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MailgunError(`Could not reach Mailgun: ${(err as Error).message}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { message?: string; Error?: string };
      detail = body.message ?? body.Error ?? detail;
    } catch {
      // not JSON; keep the raw text
    }
    // 401 means Mailgun refused the API key itself (wrong, deleted or disabled), which only the account owner can fix.
    if (res.status === 401) {
      throw new MailgunError(
        `Mailgun rejected the API key (401: ${detail}). It may be disabled or wrong: check the Mailgun dashboard, put a working key in MAILGUN_API_KEY, restart the server, then Resume`,
        401,
      );
    }
    throw new MailgunError(`Mailgun ${res.status}: ${detail}`, res.status);
  }
  return JSON.parse(text);
}

export interface OutgoingMail {
  to: string;
  name?: string;
  subject: string;
  text: string;
  tag: string;
  variables?: Record<string, string>;
}

/** Sends one email and returns Mailgun's message id (without angle brackets). */
export async function sendMail(mail: OutgoingMail): Promise<string> {
  const form = new URLSearchParams();
  form.set('from', config.mailFrom);
  const displayName = mail.name?.replace(/["\\\r\n]/g, '').trim();
  form.set('to', displayName ? `"${displayName}" <${mail.to}>` : mail.to);
  form.set('subject', mail.subject);
  form.set('text', mail.text);
  form.set('html', emailHtml(mail.subject, mail.text));
  form.set('o:tag', mail.tag);
  form.set('o:tracking-opens', 'yes');
  if (config.replyTo) form.set('h:Reply-To', config.replyTo);
  if (config.unsubscribeMailto) form.set('h:List-Unsubscribe', `<${config.unsubscribeMailto}>`);
  for (const [key, value] of Object.entries(mail.variables ?? {})) form.set(`v:${key}`, value);

  const data = (await request(`${apiBase}/messages`, { method: 'POST', body: form })) as { id: string };
  return data.id.replace(/^<|>$/g, '');
}

export interface MailgunEvent {
  id: string;
  event: string;
  timestamp: number;
  severity?: string;
  reason?: string;
  'delivery-status'?: { message?: string; description?: string; code?: number };
  message?: { headers?: { 'message-id'?: string } };
  'user-variables'?: Record<string, string>;
}

/** Fetches all events for a tag since `begin` (unix seconds), oldest first. */
export async function fetchEvents(tag: string, begin: number): Promise<MailgunEvent[]> {
  const params = new URLSearchParams({ tags: tag, begin: String(begin), ascending: 'yes', limit: '300' });
  let url = `${apiBase}/events?${params}`;
  const all: MailgunEvent[] = [];
  for (let page = 0; page < 100; page++) {
    const data = (await request(url)) as { items: MailgunEvent[]; paging?: { next?: string } };
    all.push(...data.items);
    if (!data.items.length || !data.paging?.next) break;
    url = data.paging.next;
  }
  return all;
}
