export type Status = 'new' | 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'skipped';
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

export interface Filter {
  q: string;
  status: StatusFilter;
  uploadId: number | null;
}

export interface Row {
  id: number;
  upload_id: number;
  email: string;
  name: string;
  location: string;
  subject: string;
  bodyPreview: string;
  source: 'csv' | 'template';
  status: Status;
  /** Can be selected and sent */
  unsent: boolean;
  /** Not sent here, but the address was already emailed from another file */
  duplicate: boolean;
  last_error: string | null;
  attempts: number;
  sent_at: number | null;
  delivered_at: number | null;
  opened_at: number | null;
  updated_at: number;
}

export interface Page {
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Rows per status tab for the current search and file */
  counts: Record<StatusFilter, number>;
  rows: Row[];
}

export interface Upload {
  id: number;
  filename: string;
  uploaded_at: number;
  total: number;
  sent: number;
  delivered: number;
  /** Not emailed yet and would really be sent */
  unsent: number;
}

export interface Overview {
  /** Last 14 days, oldest first; day is YYYY-MM-DD in the server's time zone */
  days: { day: string; sent: number; delivered: number; opened: number }[];
  recent: { id: string; event: string; ts: number; detail: string | null; messageId: number; email: string; name: string }[];
}

export interface TemplatePreview {
  subject: string;
  html: string;
  filledFor: string;
  /** Recipients whose CSV row has no subject, so they get the template */
  recipients: number;
  unsent: number;
}

export interface MailEvent {
  id: string;
  event: string;
  severity: string | null;
  detail: string | null;
  ts: number;
}

export interface MessageDetail {
  id: number;
  source: 'csv' | 'template';
  subject: string;
  body: string;
  final: boolean;
  mailgunId: string | null;
  attempts: number;
  sentAt: number | null;
  events: MailEvent[];
}

export interface Settings {
  /** Wait = delaySeconds + random whole number of seconds 1..delayRandomMax */
  delaySeconds: number;
  delayRandomMax: number;
  templateSubject: string;
  templateBody: string;
  testEmail: string;
}

export interface AppState {
  engine: {
    state: 'idle' | 'running' | 'paused';
    nextSendAt: number | null;
    lastDelaySeconds: number | null;
    lastError: string | null;
    sending: boolean;
    run: { total: number; ok: number; fail: number; startedAt: number; stopped: boolean } | null;
  };
  events: { polledAt: number | null; error: string | null; intervalSeconds: number };
  counts: Record<'total' | 'sent' | 'unsent' | 'queued' | 'delivered' | 'opened' | 'failed', number>;
  settings: Settings;
  limits: { from: string; dailyLimit: number; maxAttempts: number; sentToday: number };
  /** The server shows a Windows notification when sending pauses */
  desktopNotifications: boolean;
}

export interface ImportResult {
  uploadId: number;
  filename: string;
  rows: number;
  added: number;
  updated: number;
  removed: number;
  duplicates: number;
  invalid: number;
}

export interface ReimportResult {
  folder: string;
  files: number;
  added: number;
  updated: number;
  removed: number;
  errors: { filename: string; error: string }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const send = <T,>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const filterBody = (f: Partial<Filter>) => ({ q: f.q || undefined, status: f.status, uploadId: f.uploadId ?? undefined });

export const api = {
  state: () => request<AppState>('/state'),
  messages: (f: Filter, page: number, pageSize: number) => {
    const params = new URLSearchParams({ status: f.status, page: String(page), pageSize: String(pageSize) });
    if (f.q.trim()) params.set('q', f.q.trim());
    if (f.uploadId) params.set('uploadId', String(f.uploadId));
    return request<Page>(`/messages?${params}`);
  },
  message: (id: number) => request<MessageDetail>(`/messages/${id}`),
  uploads: () => request<Upload[]>('/uploads'),
  upload: (filename: string, content: string) =>
    request<ImportResult>(`/uploads?${new URLSearchParams({ filename })}`, {
      method: 'POST',
      body: content,
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    }),
  reimport: () => send<ReimportResult>('POST', '/reimport'),
  sendIds: (ids: number[]) => send<{ queued: number; skipped: number }>('POST', '/send', { ids }),
  sendFilter: (f: Partial<Filter>) => send<{ queued: number; skipped: number }>('POST', '/send', { filter: filterBody(f) }),
  countUnsent: (f: Partial<Filter>) => send<{ count: number }>('POST', '/send/preview', { filter: filterBody(f) }),
  stop: () => send<{ cancelled: number }>('POST', '/stop'),
  resume: () => send('POST', '/resume'),
  saveSettings: (settings: Partial<Settings>) => send<Settings>('PUT', '/settings', settings),
  sendTest: (messageId: number) => send<{ to: string; basedOn: string }>('POST', '/test', { messageId }),
  sendTemplateTest: () => send<{ to: string; filledFor: string }>('POST', '/test/template'),
  pollEvents: () => send<{ fetched: number; applied: number }>('POST', '/events/poll'),
  overview: () => request<Overview>('/overview'),
  testNotification: () => send<{ ok: true }>('POST', '/notify/test'),
  templatePreview: (subject: string, body: string) => send<TemplatePreview>('POST', '/template/preview', { subject, body }),
};
