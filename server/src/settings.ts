import fs from 'node:fs';
import { config } from './config.js';
import { kvGet, kvSet, type MessageRow } from './db.js';

export interface Settings {
  /** Wait between emails = delaySeconds + random whole number of seconds in [1, delayRandomMax] (0 = no random part) */
  delaySeconds: number;
  delayRandomMax: number;
  /** Sent to rows whose CSV subject is empty. {name}, {email} and {location} are filled in. */
  templateSubject: string;
  templateBody: string;
  testEmail: string;
  /** branded = ATS Group layout with header and button · plain = looks like a personal email (better for inboxing) */
  emailStyle: EmailStyle;
  /** Most emails per calendar day; 0 = no limit */
  dailyLimit: number;
  /** Warm-up: day 1 allows warmupStart emails, each later day warmupGrowthPct % more, never above dailyLimit */
  warmupEnabled: boolean;
  warmupStart: number;
  warmupGrowthPct: number;
  /** When warm-up was switched on (day 1); set by the server */
  warmupStartedAt: number | null;
  /** Pause sending when too many of the last emails bounced or were reported as spam */
  safetyEnabled: boolean;
  maxBouncePct: number;
  maxSpamPct: number;
}

export type EmailStyle = 'branded' | 'plain';

const KEY = 'settings';
export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n').trim();

function defaults(): Settings {
  const d = config.defaults;
  let templateBody = '';
  try {
    templateBody = normalizeText(fs.readFileSync(d.templateFile, 'utf8'));
  } catch {
    // no template file; the dashboard will ask for one
  }
  return {
    delaySeconds: d.delaySeconds,
    delayRandomMax: d.delayRandomMax,
    templateSubject: d.templateSubject,
    templateBody,
    testEmail: d.testEmail,
    emailStyle: 'branded',
    dailyLimit: config.dailyLimit,
    warmupEnabled: false,
    warmupStart: 50,
    warmupGrowthPct: 20,
    warmupStartedAt: null,
    safetyEnabled: true,
    maxBouncePct: 5,
    maxSpamPct: 0.1,
  };
}

export function getSettings(): Settings {
  const saved = kvGet(KEY);
  if (!saved) return defaults();
  // Before the delay became "base + random", settings were stored as delayStepSeconds / delayMaxSteps.
  const { delayStepSeconds, delayMaxSteps, ...rest } = JSON.parse(saved) as Partial<Settings> & {
    delayStepSeconds?: number;
    delayMaxSteps?: number;
  };
  return {
    ...defaults(),
    ...(delayStepSeconds !== undefined && { delaySeconds: delayStepSeconds }),
    ...(delayMaxSteps !== undefined && { delayRandomMax: delayMaxSteps }),
    ...rest,
  };
}

export class ValidationError extends Error {}

function decimal(value: unknown, label: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${label} must be a number from ${min} to ${max}`);
  return Math.round(n * 100) / 100;
}

function wholeNumber(value: unknown, label: string, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ValidationError(`${label} must be a whole number from 0 to ${max}`);
  return n;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings() };
  if (patch.delaySeconds !== undefined) next.delaySeconds = wholeNumber(patch.delaySeconds, 'Delay (seconds)', 3600);
  if (patch.delayRandomMax !== undefined)
    next.delayRandomMax = wholeNumber(patch.delayRandomMax, 'Random maximum (seconds)', 3600);
  if (patch.templateSubject !== undefined) {
    next.templateSubject = String(patch.templateSubject).trim();
    if (!next.templateSubject) throw new ValidationError('Template subject cannot be empty');
  }
  if (patch.templateBody !== undefined) {
    next.templateBody = normalizeText(String(patch.templateBody));
    if (!next.templateBody) throw new ValidationError('Template message cannot be empty');
  }
  if (patch.testEmail !== undefined) {
    next.testEmail = String(patch.testEmail).trim();
    if (next.testEmail && !EMAIL_RE.test(next.testEmail)) throw new ValidationError('Test email is not a valid address');
  }
  if (patch.emailStyle !== undefined) {
    if (patch.emailStyle !== 'branded' && patch.emailStyle !== 'plain') throw new ValidationError('Email style must be branded or plain');
    next.emailStyle = patch.emailStyle;
  }
  if (patch.dailyLimit !== undefined) next.dailyLimit = wholeNumber(patch.dailyLimit, 'Daily limit', 1_000_000);
  if (patch.warmupStart !== undefined) {
    next.warmupStart = wholeNumber(patch.warmupStart, 'Warm-up start', 1_000_000);
    if (next.warmupStart < 1) throw new ValidationError('Warm-up start must be at least 1 email a day');
  }
  if (patch.warmupGrowthPct !== undefined) next.warmupGrowthPct = decimal(patch.warmupGrowthPct, 'Daily increase (%)', 0, 100);
  if (patch.warmupEnabled !== undefined) {
    const on = Boolean(patch.warmupEnabled);
    // Switching warm-up on starts it at day 1 today; switching it off forgets the start.
    if (on && !next.warmupEnabled) next.warmupStartedAt = Date.now();
    if (!on) next.warmupStartedAt = null;
    next.warmupEnabled = on;
  }
  if (patch.safetyEnabled !== undefined) next.safetyEnabled = Boolean(patch.safetyEnabled);
  if (patch.maxBouncePct !== undefined) next.maxBouncePct = decimal(patch.maxBouncePct, 'Bounce limit (%)', 0.5, 50);
  if (patch.maxSpamPct !== undefined) next.maxSpamPct = decimal(patch.maxSpamPct, 'Spam limit (%)', 0.01, 5);
  kvSet(KEY, JSON.stringify(next));
  return next;
}

const DAY_MS = 86_400_000;
const dayStart = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Warm-up limit on a given day (1 = the day warm-up was switched on). */
export const warmupLimitOn = (s: Pick<Settings, 'warmupStart' | 'warmupGrowthPct'>, day: number) =>
  Math.round(s.warmupStart * (1 + s.warmupGrowthPct / 100) ** (day - 1));

/** Today's sending limit: the daily limit, lowered by warm-up while it is running. 0 = no limit. */
export function dailyCap(s: Settings = getSettings(), at = Date.now()) {
  const fixed = s.dailyLimit > 0 ? s.dailyLimit : Infinity;
  if (!s.warmupEnabled || !s.warmupStartedAt) return { limit: s.dailyLimit, warmupDay: null, warmupDone: false };
  // Calendar days, rounded so a daylight-saving change doesn't shift the count.
  const day = Math.max(1, Math.round((dayStart(at) - dayStart(s.warmupStartedAt)) / DAY_MS) + 1);
  const warm = warmupLimitOn(s, day);
  const limit = Math.min(fixed, warm);
  return { limit: Number.isFinite(limit) ? limit : 0, warmupDay: day, warmupDone: warm >= fixed };
}

/** Fills {name}, {email}, {location}. With no name, "Hi {name}," becomes "Hi," (the space before it goes too). */
const fill = (text: string, row: Pick<MessageRow, 'name' | 'email' | 'location'>) => {
  const name = row.name.trim();
  return (name ? text.replaceAll('{name}', name) : text.replace(/[ \t]*\{name\}/g, ''))
    .replaceAll('{email}', row.email)
    .replaceAll('{location}', row.location);
};

/** What this row will be sent as: its own subject/content, or the template when the CSV subject is empty. */
export function render(
  row: Pick<MessageRow, 'name' | 'email' | 'location' | 'csv_subject' | 'csv_content'>,
  settings = getSettings(),
) {
  if (row.csv_subject.trim()) {
    return { source: 'csv' as const, subject: row.csv_subject.trim(), body: row.csv_content };
  }
  return { source: 'template' as const, subject: fill(settings.templateSubject, row), body: fill(settings.templateBody, row) };
}
