export function formatTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 95 -> "1m 35s", 3725 -> "1h 2m", 1355160 -> "15d 16h" */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const d = Math.floor(s / 86400);
  if (d) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** "30s + random 1–10s = 31–40s between emails" */
export function delayRange(base: number, randomMax: number): string {
  if (randomMax <= 0) return `${formatDuration(base)} between emails`;
  return `${base}s + random 1–${randomMax}s = ${formatDuration(base + 1)}–${formatDuration(base + randomMax)} between emails`;
}

/** Rough total time for n emails: the average wait is base + (1 + randomMax) / 2. */
export function estimateDuration(n: number, base: number, randomMax: number): string {
  const averageWait = base + (randomMax > 0 ? (1 + randomMax) / 2 : 0);
  return formatDuration(Math.max(0, n - 1) * averageWait);
}

/** "just now", "4m ago", "3h ago", "2d ago" */
export function timeAgo(ms: number | null, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** 950 -> "950", 1200 -> "1.2K", 36909 -> "37K" */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${Math.round(n / 1000)}K`;
}

/** Emails per hour at this pace (average wait = base + (1 + randomMax) / 2) */
export function emailsPerHour(base: number, randomMax: number): number {
  const averageWait = base + (randomMax > 0 ? (1 + randomMax) / 2 : 0);
  return averageWait > 0 ? 3600 / averageWait : Infinity;
}

export const plural =(n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
