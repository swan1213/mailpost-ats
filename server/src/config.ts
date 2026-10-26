import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

dotenv.config({ path: path.join(ROOT, '.env') });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number >= 0 (got "${raw}")`);
  return value;
}

const unsubscribe = optional('UNSUBSCRIBE_MAILTO');

export const config = {
  mailgun: {
    apiKey: required('MAILGUN_API_KEY'),
    domain: required('MAILGUN_DOMAIN'),
    baseUrl: optional('MAILGUN_BASE_URL', 'https://api.mailgun.net').replace(/\/+$/, ''),
  },
  mailFrom: required('MAIL_FROM'),
  replyTo: optional('REPLY_TO'),
  unsubscribeMailto: unsubscribe && !unsubscribe.startsWith('mailto:') ? `mailto:${unsubscribe}` : unsubscribe,

  /** Branding for the HTML email layout */
  brand: {
    name: optional('BRAND_NAME', 'ATS Group'),
    url: optional('BRAND_URL', 'https://www.atsgroup.world'),
    /** Must be a PNG/JPG on a public URL: Gmail and Outlook don't show SVG. */
    logoUrl: optional('BRAND_LOGO_URL', 'https://www.atsgroup.world/apple-icon'),
    tagline: optional('BRAND_TAGLINE', 'Software Engineering & AI, built in Japan'),
    location: optional('BRAND_LOCATION', 'Tokyo, Japan'),
    established: optional('BRAND_ESTABLISHED', '2024'),
  },

  /** Uploaded CSVs are saved here; "Re-import" re-reads every CSV in it. */
  csvDir: path.resolve(ROOT, optional('CSV_DIR', 'data')),

  /** Mailgun tag on every email; status polling only looks at this tag. */
  mailTag: optional('CAMPAIGN_TAG', 'mailpost'),
  dailyLimit: int('DAILY_LIMIT', 0),
  maxAttempts: Math.max(1, int('MAX_ATTEMPTS', 3)),
  eventsPollSeconds: Math.max(15, int('EVENTS_POLL_SECONDS', 60)),

  /** First-run defaults only. After that, the dashboard's Settings tab owns these values. */
  defaults: {
    delaySeconds: int('DELAY_SECONDS', 30),
    delayRandomMax: int('DELAY_RANDOM_MAX', 10),
    templateFile: path.resolve(ROOT, optional('TEMPLATE_FILE', 'template.txt')),
    templateSubject: optional('TEMPLATE_SUBJECT', 'Hello'),
    testEmail: optional('TEST_EMAIL'),
  },

  host: optional('HOST', '127.0.0.1'),
  port: int('PORT', 8080),
  dbFile: path.resolve(ROOT, optional('DB_FILE', 'mailpost.db')),
};
