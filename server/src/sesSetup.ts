import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateContactListCommand,
  type EventType,
  GetAccountCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetContactListCommand,
  GetEmailIdentityCommand,
  ListContactListsCommand,
  UpdateConfigurationSetEventDestinationCommand,
  UpdateContactListCommand,
} from '@aws-sdk/client-sesv2';
import { CreateTopicCommand, SetTopicAttributesCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { config } from './config.js';
import { aws, classify, resolved, setReady } from './ses.js';

// Creates (or repairs) everything SES needs, so nothing has to be clicked together in the AWS console:
//   configuration set ──events──> SNS topic ──> SQS queue (read by events.ts)
//   contact list + topic (one-click unsubscribe)
// Every step is safe to run again. It runs on start-up and from "Set up SES again" on the Sending page.

const s = config.ses;
const EVENT_DESTINATION = 'mailpost-events';

export interface ProviderStatus {
  name: 'Amazon SES';
  region: string;
  checkedAt: number | null;
  setup: { ok: boolean; running: boolean; error: string | null; steps: string[]; contactList: string };
  /** From GetAccount; null until read (or when the credentials don't work) */
  account: {
    production: boolean;
    sendingEnabled: boolean;
    max24h: number;
    maxPerSecond: number;
    sentLast24h: number;
    enforcement: string | null;
  } | null;
  sender: { identity: string; verified: boolean; dkim: string | null } | null;
  error: string | null;
}

const status: ProviderStatus = {
  name: 'Amazon SES',
  region: s.region,
  checkedAt: null,
  setup: { ok: false, running: false, error: null, steps: [], contactList: s.contactList },
  account: null,
  sender: null,
  error: null,
};

export const providerStatus = () => status;

const isNotFound = (err: unknown) => /NotFound|NonExistent|QueueDoesNotExist/i.test((err as { name?: string })?.name ?? '');

async function ensureTopic(steps: string[]) {
  const { TopicArn } = await aws.sns.send(new CreateTopicCommand({ Name: s.eventsTopic }));
  if (!TopicArn) throw new Error('SNS did not return a topic ARN');
  const account = TopicArn.split(':')[4];
  // The owner keeps full control; SES (from this account only) may publish events.
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'OwnerFullAccess',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: ['SNS:GetTopicAttributes', 'SNS:SetTopicAttributes', 'SNS:Subscribe', 'SNS:ListSubscriptionsByTopic', 'SNS:Publish', 'SNS:DeleteTopic'],
        Resource: TopicArn,
      },
      {
        Sid: 'AllowSesToPublish',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 'SNS:Publish',
        Resource: TopicArn,
        Condition: { StringEquals: { 'AWS:SourceAccount': account } },
      },
    ],
  };
  await aws.sns.send(new SetTopicAttributesCommand({ TopicArn, AttributeName: 'Policy', AttributeValue: JSON.stringify(policy) }));
  steps.push(`SNS topic ${s.eventsTopic}`);
  return TopicArn;
}

async function ensureQueue(topicArn: string, steps: string[]) {
  let url: string | undefined;
  try {
    url = (await aws.sqs.send(new GetQueueUrlCommand({ QueueName: s.eventsQueue }))).QueueUrl;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // Keep undelivered events for 14 days (the maximum), so the app can be offline for a while.
    url = (await aws.sqs.send(new CreateQueueCommand({ QueueName: s.eventsQueue, Attributes: { MessageRetentionPeriod: '1209600' } }))).QueueUrl;
  }
  if (!url) throw new Error('SQS did not return a queue URL');
  const attrs = await aws.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  const queueArn = attrs.Attributes?.QueueArn;
  if (!queueArn) throw new Error('SQS did not return the queue ARN');
  // Only this SNS topic may put messages in the queue.
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSesEventsTopic',
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: queueArn,
        Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
      },
    ],
  };
  await aws.sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: { Policy: JSON.stringify(policy) } }));
  // Raw delivery: each queue message is the SES event itself, not wrapped in an SNS envelope.
  await aws.sns.send(
    new SubscribeCommand({ TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn, Attributes: { RawMessageDelivery: 'true' }, ReturnSubscriptionArn: true }),
  );
  resolved.queueUrl = url;
  steps.push(`SQS queue ${s.eventsQueue}`);
}

async function ensureConfigurationSet(topicArn: string, steps: string[]) {
  try {
    await aws.ses.send(
      new CreateConfigurationSetCommand({
        ConfigurationSetName: s.configurationSet,
        SendingOptions: { SendingEnabled: true },
        ReputationOptions: { ReputationMetricsEnabled: true },
        // Never send again to addresses that hard-bounced or complained.
        SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      }),
    );
  } catch (err) {
    if (!/AlreadyExists/i.test((err as { name?: string }).name ?? '')) throw err;
  }
  // Clicks are left out on purpose: click tracking would rewrite every link in the email.
  const types: EventType[] = ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY', 'SUBSCRIPTION', 'RENDERING_FAILURE'];
  if (s.trackOpens) types.push('OPEN');
  const destination = { Enabled: true, MatchingEventTypes: types, SnsDestination: { TopicArn: topicArn } };
  const existing = await aws.ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: s.configurationSet }));
  const Command = existing.EventDestinations?.some((d) => d.Name === EVENT_DESTINATION)
    ? UpdateConfigurationSetEventDestinationCommand
    : CreateConfigurationSetEventDestinationCommand;
  await aws.ses.send(new Command({ ConfigurationSetName: s.configurationSet, EventDestinationName: EVENT_DESTINATION, EventDestination: destination }));
  steps.push(`configuration set ${s.configurationSet} (events → SNS${s.trackOpens ? ', open tracking on' : ''})`);
}

async function ensureContactList(steps: string[]) {
  const topic = {
    TopicName: s.unsubscribeTopic,
    DisplayName: `${config.brand.name} emails`,
    Description: `Emails from ${config.brand.name}`,
    DefaultSubscriptionStatus: 'OPT_IN' as const,
  };
  // An AWS account can only have one contact list: reuse it if it exists, adding our topic when missing.
  const lists = await aws.ses.send(new ListContactListsCommand({}));
  const name = lists.ContactLists?.[0]?.ContactListName;
  if (!name) {
    await aws.ses.send(new CreateContactListCommand({ ContactListName: s.contactList, Description: 'MailPost unsubscribes', Topics: [topic] }));
    resolved.contactList = s.contactList;
  } else {
    const list = await aws.ses.send(new GetContactListCommand({ ContactListName: name }));
    if (!list.Topics?.some((t) => t.TopicName === topic.TopicName)) {
      await aws.ses.send(new UpdateContactListCommand({ ContactListName: name, Topics: [...(list.Topics ?? []), topic], Description: list.Description }));
    }
    resolved.contactList = name;
  }
  status.setup.contactList = resolved.contactList;
  steps.push(`contact list ${resolved.contactList} (topic ${s.unsubscribeTopic})`);
}

/** Account mode, quota and whether the From address can send. Cheap; refreshed every 10 minutes. */
export async function refreshAccount() {
  try {
    const a = await aws.ses.send(new GetAccountCommand({}));
    status.account = {
      production: Boolean(a.ProductionAccessEnabled),
      sendingEnabled: a.SendingEnabled !== false,
      max24h: a.SendQuota?.Max24HourSend ?? 0,
      maxPerSecond: a.SendQuota?.MaxSendRate ?? 0,
      sentLast24h: a.SendQuota?.SentLast24Hours ?? 0,
      enforcement: a.EnforcementStatus ?? null,
    };
    const from = /<([^>]+)>/.exec(config.mailFrom)?.[1] ?? config.mailFrom.trim();
    const domain = from.split('@')[1] ?? from;
    let sender: ProviderStatus['sender'] = null;
    for (const identity of [domain, from]) {
      try {
        const id = await aws.ses.send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
        sender = { identity, verified: Boolean(id.VerifiedForSendingStatus), dkim: id.DkimAttributes?.Status ?? null };
        break;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    status.sender = sender ?? { identity: domain, verified: false, dkim: null };
    status.error = null;
  } catch (err) {
    status.error = classify(err).message;
  }
  status.checkedAt = Date.now();
}

/** Creates or repairs the SES resources. Never throws; the outcome is in providerStatus(). */
export async function setupSes(): Promise<ProviderStatus> {
  if (status.setup.running) return status;
  status.setup.running = true;
  const steps: string[] = [];
  const run = (async () => {
    try {
      if (s.autoSetup) {
        const topicArn = await ensureTopic(steps);
        await ensureQueue(topicArn, steps);
        await ensureConfigurationSet(topicArn, steps);
        await ensureContactList(steps);
      } else {
        // Resources are managed by hand: just find the queue and the contact list.
        resolved.queueUrl = (await aws.sqs.send(new GetQueueUrlCommand({ QueueName: s.eventsQueue }))).QueueUrl ?? null;
        const lists = await aws.ses.send(new ListContactListsCommand({}));
        resolved.contactList = lists.ContactLists?.[0]?.ContactListName ?? s.contactList;
        status.setup.contactList = resolved.contactList;
        steps.push('using existing resources (SES_AUTO_SETUP=0)');
      }
      status.setup = { ...status.setup, ok: true, error: null, steps };
    } catch (err) {
      status.setup = { ...status.setup, ok: false, error: classify(err).message, steps };
      console.error('[ses] setup failed:', status.setup.error);
    } finally {
      status.setup.running = false;
    }
    await refreshAccount();
    return status;
  })();
  setReady(run);
  return run;
}

/** On start-up: set up SES, then keep the account status fresh. */
export function startProvider() {
  void setupSes().then((st) => {
    if (st.setup.ok) console.log(`[ses] ready in ${st.region}: ${st.setup.steps.join(', ')}`);
  });
  setInterval(() => void refreshAccount(), 10 * 60_000).unref();
}
