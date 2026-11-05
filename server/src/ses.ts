import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { SNSClient } from '@aws-sdk/client-sns';
import { DeleteMessageBatchCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config.js';
import { emailHtml } from './emailHtml.js';
import type { EmailStyle } from './settings.js';

// Amazon SES (API v2). Delivery events can't be pulled from SES: it publishes them to an SNS topic, which
// forwards them to an SQS queue this app reads (see sesSetup.ts, which creates both).

const region = config.ses.region;

/**
 * The sending client makes exactly one attempt: SES has no idempotency key, so the SDK's automatic retry after a
 * timeout could deliver the same email twice. sender.ts decides what to retry, based on ProviderError.kind.
 */
export const aws = {
  send: new SESv2Client({ region, maxAttempts: 1, requestHandler: { requestTimeout: 30_000, connectionTimeout: 10_000 } }),
  ses: new SESv2Client({ region }),
  sns: new SNSClient({ region }),
  sqs: new SQSClient({ region }),
};

/** What a failure means for the queue. */
export type FailureKind =
  /** Only a person can fix it (credentials, permissions, suspended/paused account, sandbox, unverified sender) */
  | 'account'
  /** Send rate or daily quota: wait, then retry the same email */
  | 'throttle'
  /** SES itself failed or couldn't be reached, so nothing was sent: wait, then retry */
  | 'outage'
  /** The request may have reached SES (timeout, dropped connection): don't retry automatically */
  | 'unclear'
  /** This email was refused (bad address or content): counts as one failed try */
  | 'message';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    /** How long to wait before retrying (throttle) */
    readonly waitMs?: number,
  ) {
    super(message);
  }
}

const NO_CONNECTION = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ConnectTimeout|connect ETIMEDOUT/i;

/** Turns an AWS SDK error into a plain message and what the queue should do about it. */
export function classify(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? 'Error';
  const msg = String(e?.message ?? err);
  const status = e?.$metadata?.httpStatusCode;
  const detail = `${name}: ${msg}`;

  if (
    /CredentialsProviderError|UnrecognizedClient|InvalidClientTokenId|InvalidSignature|SignatureDoesNotMatch|ExpiredToken|AccessDenied|NotAuthorized|AuthorizationError/i.test(name) ||
    status === 401 ||
    status === 403
  )
    return new ProviderError(
      `AWS rejected the credentials or permissions (${detail}). Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY and the IAM policy in docs/aws-iam-policy.json, restart the server, then Resume`,
      'account',
    );
  if (name === 'AccountSuspendedException')
    return new ProviderError(`Amazon SES has stopped this account from sending (${detail}). Contact AWS Support`, 'account');
  if (name === 'SendingPausedException')
    return new ProviderError(
      `Sending is paused on the SES account or configuration set (${detail}), usually after high bounce or complaint rates. Check SES console → Reputation, then Resume`,
      'account',
    );
  if (name === 'MailFromDomainNotVerifiedException' || /not verified/i.test(msg))
    return new ProviderError(
      `SES refused the address (${detail}). The From domain must be verified in ${region}; while the account is in the SES sandbox, every recipient must be verified too (request production access to lift this)`,
      'account',
    );
  if (name === 'NotFoundException')
    return new ProviderError(`An SES resource is missing (${detail}). Run "Set up SES again" on the Sending page, then Resume`, 'account');
  if (/daily message quota|Max24HourSend/i.test(msg))
    return new ProviderError(`SES daily sending quota reached (${detail})`, 'throttle', 60 * 60_000);
  if (/Throttl|TooManyRequests|LimitExceeded/i.test(name) || status === 429 || /sending rate/i.test(msg))
    return new ProviderError(`SES is limiting the send rate (${detail})`, 'throttle', 60_000);
  if (status && status >= 500) return new ProviderError(`SES error ${status} (${detail})`, 'outage');
  if (!status) {
    if (NO_CONNECTION.test(`${e?.code ?? ''} ${name} ${msg}`)) return new ProviderError(`Could not reach SES (${detail})`, 'outage');
    return new ProviderError(`No answer from SES (${detail})`, 'unclear');
  }
  return new ProviderError(`SES refused this email (${detail})`, 'message');
}

/** Set by sesSetup.ts once resources are resolved; until then the configured names are used. */
export const resolved: { contactList: string; queueUrl: string | null } = {
  contactList: config.ses.contactList,
  queueUrl: null,
};
let ready: Promise<unknown> = Promise.resolve();
/** Sending and event reads wait for the start-up setup to finish (it never rejects). */
export function setReady(p: Promise<unknown>) {
  ready = p.catch(() => {});
}

/** Display names must be ASCII in SES headers; anything else is MIME-encoded. */
function address(email: string, name?: string): string {
  const n = name?.replace(/["\\\r\n]/g, '').trim();
  if (!n) return email;
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${email}>` : `=?UTF-8?B?${Buffer.from(n).toString('base64')}?= <${email}>`;
}

function fromAddress(value: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  return m ? address(m[2].trim(), m[1]) : value.trim();
}

/** SES tag values allow only letters, digits, "_" and "-". */
const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'mailpost';

export interface OutgoingMail {
  to: string;
  name?: string;
  subject: string;
  text: string;
  tag: string;
  style?: EmailStyle;
}

const UNSUBSCRIBE = '{{amazonSESUnsubscribeUrl}}';

/** Sends one email and returns SES's MessageId, which its delivery events refer back to. */
export async function sendMail(mail: OutgoingMail): Promise<string> {
  await ready;
  try {
    const out = await aws.send.send(
      new SendEmailCommand({
        FromEmailAddress: fromAddress(config.mailFrom),
        Destination: { ToAddresses: [address(mail.to, mail.name)] },
        ReplyToAddresses: config.replyTo ? [config.replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: {
              // SES fills the unsubscribe placeholder (at most twice per email: once here, once in the HTML).
              Text: { Data: `${mail.text}\n\n--\nUnsubscribe: ${UNSUBSCRIBE}`, Charset: 'UTF-8' },
              Html: { Data: emailHtml(mail.subject, mail.text, { unsubscribeUrl: UNSUBSCRIBE, style: mail.style }), Charset: 'UTF-8' },
            },
          },
        },
        EmailTags: [{ Name: 'campaign', Value: tagValue(mail.tag) }],
        ConfigurationSetName: config.ses.configurationSet,
        // One-click unsubscribe headers + the footer link; unsubscribed contacts get a bounce instead of the email.
        ListManagementOptions: { ContactListName: resolved.contactList, TopicName: config.ses.unsubscribeTopic },
      }),
    );
    if (!out.MessageId) throw new ProviderError('SES accepted the request but returned no message id', 'unclear');
    return out.MessageId;
  } catch (err) {
    throw classify(err);
  }
}

/** One SES event record (the parts this app uses). */
export interface SesEvent {
  eventType: string;
  mail: { messageId: string; timestamp: string; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; bouncedRecipients?: { diagnosticCode?: string }[] };
  complaint?: { timestamp?: string; complaintFeedbackType?: string };
  delivery?: { timestamp?: string; smtpResponse?: string };
  deliveryDelay?: { timestamp?: string; delayType?: string; delayedRecipients?: { diagnosticCode?: string }[] };
  open?: { timestamp?: string; isBotEvent?: string };
  click?: { timestamp?: string; link?: string; isBotEvent?: string };
  reject?: { reason?: string };
  failure?: { errorMessage?: string };
  subscription?: {
    timestamp?: string;
    newTopicPreferences?: { unsubscribeAll?: boolean; topicSubscriptionStatus?: { topicName?: string; subscriptionStatus?: string }[] };
  };
}

/** Accepts the raw SES record, an SNS envelope (raw delivery off) or an EventBridge event. */
function parseEvent(body: string | undefined): SesEvent | null {
  try {
    let obj = JSON.parse(body ?? '');
    if (obj?.Type === 'Notification' && typeof obj.Message === 'string') obj = JSON.parse(obj.Message);
    if (obj?.detail && obj['detail-type']) obj = obj.detail;
    if (!obj?.eventType && obj?.notificationType) obj.eventType = obj.notificationType;
    return obj?.eventType && obj?.mail?.messageId ? (obj as SesEvent) : null;
  } catch {
    return null;
  }
}

async function queueUrl(): Promise<string> {
  if (!resolved.queueUrl) {
    const out = await aws.sqs.send(new GetQueueUrlCommand({ QueueName: config.ses.eventsQueue }));
    resolved.queueUrl = out.QueueUrl ?? null;
  }
  if (!resolved.queueUrl) throw new ProviderError(`SQS queue ${config.ses.eventsQueue} not found`, 'account');
  return resolved.queueUrl;
}

/** Reads what's waiting in the events queue (up to `max`). Delete the receipts once the events are stored. */
export async function receiveEvents(max = 1000): Promise<{ event: SesEvent | null; receipt: string }[]> {
  await ready;
  try {
    const url = await queueUrl();
    const out: { event: SesEvent | null; receipt: string }[] = [];
    while (out.length < max) {
      const res = await aws.sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 120 }));
      const messages = res.Messages ?? [];
      if (!messages.length) break;
      for (const m of messages) if (m.ReceiptHandle) out.push({ event: parseEvent(m.Body), receipt: m.ReceiptHandle });
    }
    return out;
  } catch (err) {
    throw classify(err);
  }
}

export async function deleteEvents(receipts: string[]): Promise<void> {
  const url = await queueUrl();
  for (let i = 0; i < receipts.length; i += 10) {
    const batch = receipts.slice(i, i + 10);
    await aws.sqs.send(
      new DeleteMessageBatchCommand({ QueueUrl: url, Entries: batch.map((ReceiptHandle, n) => ({ Id: String(n), ReceiptHandle })) }),
    );
  }
}
