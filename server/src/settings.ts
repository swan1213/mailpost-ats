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
}

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
  kvSet(KEY, JSON.stringify(next));
  return next;
}

const fill = (text: string, row: Pick<MessageRow, 'name' | 'email' | 'location'>) =>
  text.replaceAll('{name}', row.name).replaceAll('{email}', row.email).replaceAll('{location}', row.location);

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
