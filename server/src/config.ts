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

/**
 * Where the database and uploaded CSVs live. On Vercel the code directory is read-only and only /tmp is
 * writable, and /tmp is wiped whenever Vercel replaces the instance, so data there is not kept.
 */
const DATA_DIR = process.env.VERCEL ? '/tmp' : ROOT;

export const config = {
  /**
   * Amazon SES. Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or any standard AWS credential
   * source); the names below are the resources the app creates on start-up when autoSetup is on.
   */
  ses: {
    region: required('AWS_REGION'),
    autoSetup: optional('SES_AUTO_SETUP', '1') !== '0',
    configurationSet: optional('SES_CONFIGURATION_SET', 'mailpost'),
    /** SES publishes delivery events to this SNS topic, which forwards them to the SQS queue the app reads. */
    eventsTopic: optional('SES_EVENTS_TOPIC', 'mailpost-ses-events'),
    eventsQueue: optional('SES_EVENTS_QUEUE', 'mailpost-ses-events'),
    /** One-click unsubscribe. An AWS account has a single contact list, so an existing one is reused. */
    contactList: optional('SES_CONTACT_LIST', 'mailpost'),
    unsubscribeTopic: optional('SES_UNSUBSCRIBE_TOPIC', 'outreach'),
    /** Open tracking (adds a tracking pixel). Set to 0 to turn off. */
    trackOpens: optional('SES_TRACK_OPENS', '1') !== '0',
  },
  /** Must be an address on a domain verified in SES (same region). "Name <address>" is fine. */
  mailFrom: required('MAIL_FROM'),
  replyTo: optional('REPLY_TO'),

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
  csvDir: path.resolve(DATA_DIR, optional('CSV_DIR', 'data')),

  /** Tag (and campaign) on every email; status polling only looks at this tag. */
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
  dbFile: path.resolve(DATA_DIR, optional('DB_FILE', 'mailpost.db')),

  /** Windows toast when sending pauses (only where the server runs on Windows). Set to 0 to turn off. */
  desktopNotifications: optional('DESKTOP_NOTIFICATIONS', '1') !== '0',
  /** Opened when the notification is clicked. */
  dashboardUrl: optional('DASHBOARD_URL', `http://${['0.0.0.0', '::'].includes(optional('HOST', '127.0.0.1')) ? '127.0.0.1' : optional('HOST', '127.0.0.1')}:${int('PORT', 8080)}`),
};
