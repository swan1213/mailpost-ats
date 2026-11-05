import type { AppState, Upload } from './api';
import type { Confirm } from './ConfirmDialog';
import { plural } from './format';
import type { IconName } from './Icon';
import type { PushToast } from './Toasts';

export type PageName = 'overview' | 'recipients' | 'sending' | 'template' | 'files';

export const NAV: { page: PageName; label: string; icon: IconName; hint: string }[] = [
  { page: 'overview', label: 'Overview', icon: 'grid', hint: 'How your outreach is doing' },
  { page: 'recipients', label: 'Recipients', icon: 'users', hint: 'Everyone you have imported' },
  { page: 'sending', label: 'Sending', icon: 'send', hint: 'Start, pause and pace your emails' },
  { page: 'template', label: 'Template', icon: 'fileText', hint: 'Your default email' },
  { page: 'files', label: 'Files', icon: 'folder', hint: 'Your imported CSV lists' },
];

/** Everything a page needs from the shell. */
export interface Ctx {
  state: AppState;
  uploads: Upload[];
  busy: boolean;
  /** Ticks every second, for countdowns */
  clock: number;
  params: URLSearchParams;
  run: (action: () => Promise<string>) => Promise<void>;
  toast: PushToast;
  confirm: Confirm;
  navigate: (page: PageName, params?: Record<string, string>) => void;
  /** Opens the "Start sending" dialog, optionally with one file chosen */
  openStart: (uploadId?: number | null) => void;
  stopSending: () => Promise<void>;
  resume: () => Promise<void>;
  /** Opens the file picker for a CSV upload */
  pickFile: () => void;
  refresh: () => Promise<void>;
  /** A message to confirm before leaving the page (unsaved changes), or null */
  setLeaveGuard: (message: string | null) => void;
}

// Pages live in the URL hash (#/recipients?status=unsent) so Back, refresh and bookmarks work.
export function readRoute(): { page: PageName; params: URLSearchParams } {
  const [path, query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  const page = NAV.some((n) => n.page === path) ? (path as PageName) : 'overview';
  return { page, params: new URLSearchParams(query) };
}

export function routeHash(page: PageName, params?: Record<string, string>): string {
  const query = new URLSearchParams(params ?? {}).toString();
  return `#/${page}${query ? `?${query}` : ''}`;
}

/** Rows can be skipped when they were sent meanwhile, or the address was already emailed from another file. */
export function describeQueued(label: string, r: { queued: number; skipped: number }): string {
  const skipped = r.skipped ? ` ${plural(r.skipped, 'person')} ${r.skipped === 1 ? 'was' : 'were'} skipped because they were already emailed.` : '';
  if (!r.queued) throw new Error(`Nothing was added to the queue.${skipped}`);
  return `${label}. ${plural(r.queued, 'email')} added to the queue.${skipped}`;
}

/** What the send queue is doing, in words the dashboard shows everywhere. */
export function engineSummary(state: AppState, clock: number) {
  const { engine, counts } = state;
  const live = engine.sending || engine.state === 'running';
  const paused = engine.state === 'paused';
  const inFlight = counts.queued > 0 || engine.sending;
  const run = engine.run;
  const done = run ? run.ok + run.fail : 0;
  const pct = run && run.total ? Math.min(100, (done / run.total) * 100) : 0;
  const remaining = counts.queued + (engine.sending ? 1 : 0);
  const label = live ? 'Sending' : paused ? 'Paused' : 'Idle';
  const tone: 'live' | 'warn' | 'idle' = live ? 'live' : paused ? 'warn' : 'idle';
  let activity = 'Not started yet';
  if (engine.sending) activity = 'Sending an email right now';
  else if (engine.state === 'running' && engine.nextSendAt) {
    const s = Math.max(0, Math.round((engine.nextSendAt - clock) / 1000));
    activity = `Next email in ${s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}`;
  } else if (paused) activity = 'Paused';
  else if (run?.stopped) activity = 'Stopped';
  else if (run) activity = 'Finished';
  return { live, paused, inFlight, run, done, pct, remaining, label, tone, activity };
}
