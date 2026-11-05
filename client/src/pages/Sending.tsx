import type { ReactNode } from 'react';
import { api } from '../api';
import { DelayControl } from '../DelayControl';
import { emailsPerHour, estimateDuration, formatDuration, plural, timeAgo } from '../format';
import { Icon, type IconName } from '../Icon';
import { LimitCard, RepairCallout, SafetyCard, useHealth, useSave } from '../Reputation';
import { engineSummary, type Ctx } from '../shell';

export function SendingPage({ ctx }: { ctx: Ctx }) {
  const { state, busy, navigate, clock } = ctx;
  const { counts, settings } = state;
  const engine = engineSummary(state, clock);
  const { health, reload } = useHealth(ctx);
  const save = useSave(ctx);

  const title = engine.live ? 'Sending in progress' : engine.paused ? 'Sending is paused' : counts.unsent ? 'Ready when you are' : 'Everyone has been emailed';
  const subtitle = engine.paused
    ? (state.engine.lastError ??
      `${plural(engine.remaining, 'email')} ${engine.remaining === 1 ? 'is' : 'are'} waiting. Sending stopped when the server restarted, so press Resume to carry on.`)
    : engine.inFlight
      ? `${engine.activity}. ${plural(engine.remaining, 'email')} left in the queue.`
      : counts.unsent
        ? `${plural(counts.unsent, 'person')} ${counts.unsent === 1 ? "hasn't" : "haven't"} been emailed yet.`
        : 'Upload another CSV whenever you want to reach more people.';

  return (
    <div className="page">
      <section className={`card hero ${engine.tone}`} aria-label="Send queue">
        <div className="hero-main">
          <span className={`engine-chip static ${engine.tone}`}>
            <span className="dot" />
            {engine.label}
          </span>
          <h2 className="hero-title">{title}</h2>
          <p className="hero-sub">{subtitle}</p>

          {engine.run && (
            <div className="hero-progress">
              <div className="progress lg" role="progressbar" aria-label="Progress of this run" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(engine.pct)}>
                <div className={`progress-fill ${engine.live ? 'live' : ''}`} style={{ width: `${engine.pct}%` }} />
              </div>
              <dl className="metrics">
                <div>
                  <dt>{engine.inFlight ? 'This run' : 'Last run'}</dt>
                  <dd>
                    {engine.done.toLocaleString()} <span className="muted">of {engine.run.total.toLocaleString()}</span>
                  </dd>
                </div>
                <div>
                  <dt>
                    <i className="swatch good" /> Sent
                  </dt>
                  <dd>{engine.run.ok.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>
                    <i className="swatch bad" /> Failed
                  </dt>
                  <dd>{engine.run.fail.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Left</dt>
                  <dd>{engine.inFlight ? engine.remaining.toLocaleString() : '—'}</dd>
                </div>
                <div>
                  <dt>Time left</dt>
                  <dd>{engine.inFlight ? `~${estimateDuration(engine.remaining, settings.delaySeconds, settings.delayRandomMax)}` : '—'}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        <div className="hero-actions">
          {engine.paused ? (
            <>
              <button className="btn primary lg" disabled={busy} onClick={ctx.resume}>
                <Icon name="play" />
                Resume
              </button>
              <button className="btn lg" disabled={busy} onClick={ctx.stopSending}>
                Cancel queue
              </button>
            </>
          ) : engine.live ? (
            <>
              <button className="btn danger lg" disabled={busy} onClick={ctx.stopSending}>
                <Icon name="stop" />
                Stop sending
              </button>
              <button className="btn lg" disabled={busy || !counts.unsent} onClick={() => ctx.openStart(null)}>
                <Icon name="send" />
                Add more
              </button>
            </>
          ) : (
            <button className="btn primary lg" disabled={busy || !counts.unsent} onClick={() => ctx.openStart(null)}>
              <Icon name="play" />
              Start sending
            </button>
          )}
          <button className="btn ghost" onClick={() => navigate('recipients', { status: 'unsent' })}>
            Choose people by hand
            <Icon name="arrowRight" size={14} />
          </button>
        </div>
      </section>

      {!engine.paused && state.engine.lastError && (
        <div className="callout warn">
          <Icon name="hourglass" />
          <div className="callout-text">
            <strong>Waiting before the next email</strong>
            <span>{state.engine.lastError}</span>
          </div>
        </div>
      )}

      {health && health.repairable.total > 0 && <RepairCallout ctx={ctx} health={health} onDone={reload} />}

      {/* Two independent columns, so a tall card never leaves a gap beside a short one. */}
      <div className="columns-2">
        <div className="stack">
          <PaceCard ctx={ctx} />
          <SafetyCard ctx={ctx} health={health} save={save} />
        </div>
        <div className="stack">
          <LimitCard ctx={ctx} health={health} save={save} />
          <SesCard ctx={ctx} />
        </div>
      </div>

      <GoodToKnow ctx={ctx} />
    </div>
  );
}

function PaceCard({ ctx }: { ctx: Ctx }) {
  const { settings } = ctx.state;
  const account = ctx.state.provider.account;
  const perHour = emailsPerHour(settings.delaySeconds, settings.delayRandomMax);
  const perDay = perHour * 24;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Pace</h2>
          <p className="card-sub">Emails go out one at a time. A change applies from the next email.</p>
        </div>
      </div>
      <div className="card-body">
        <DelayControl settings={settings} run={ctx.run} />
        <div className="pace-summary">
          <div>
            <span className="muted">Gap between emails</span>
            <strong>
              {settings.delayRandomMax > 0
                ? `${formatDuration(settings.delaySeconds + 1)} – ${formatDuration(settings.delaySeconds + settings.delayRandomMax)}`
                : formatDuration(settings.delaySeconds)}
            </strong>
          </div>
          <div>
            <span className="muted">Per hour</span>
            <strong>{Number.isFinite(perHour) ? `about ${Math.round(perHour).toLocaleString()}` : 'no limit'}</strong>
          </div>
          <div>
            <span className="muted">Per day</span>
            <strong>{Number.isFinite(perDay) ? `about ${Math.round(perDay).toLocaleString()}` : 'no limit'}</strong>
          </div>
        </div>
        {account && account.max24h > 0 && perDay > account.max24h && (
          <div className="callout warn">
            <Icon name="alert" />
            <span>
              At this pace you'd send about {Math.round(perDay).toLocaleString()} a day, but Amazon SES allows {account.max24h.toLocaleString()} every 24
              hours. When you hit that, sending simply waits until there's room again.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Whether the SES account can send: sandbox, quota, sender verification, and what the app set up in AWS. */
function SesCard({ ctx }: { ctx: Ctx }) {
  const { state, busy, run, clock } = ctx;
  const p = state.provider;
  const a = p.account;
  // The account check, setup and delivery updates usually fail for the same reason (e.g. bad keys): show it once.
  const seen = new Set<string>();
  const once = (text: string | null | undefined, prefix = '') => {
    if (!text) return null;
    // Ignore the AWS error code in brackets: "InvalidClientTokenId" and "UnrecognizedClientException" mean the same thing.
    const key = text.replace(/\([^)]*\)/g, '').slice(0, 60);
    if (seen.has(key)) return null;
    seen.add(key);
    return prefix + text;
  };
  const problems = [
    once(p.error),
    once(p.setup.error, "Setup didn't finish: "),
    once(state.events.error, "Delivery updates can't be read: "),
    a && !a.sendingEnabled ? 'Sending is turned off for this Amazon SES account.' : null,
    p.sender && !p.sender.verified ? `${p.sender.identity} isn't verified in Amazon SES (${p.region}), so nothing can be sent from it yet.` : null,
  ].filter((x): x is string => Boolean(x));
  const sandbox = a && !a.production;
  const every = state.events.intervalSeconds;

  return (
    <section className="card" aria-label="Amazon SES">
      <div className="card-head">
        <div>
          <h2 className="card-title">Amazon SES</h2>
          <p className="card-sub">
            Region {p.region} · checked {timeAgo(p.checkedAt, clock)}
          </p>
        </div>
        <div className="btn-group">
          <button className="btn ghost small" disabled={busy} onClick={() => run(async () => (await api.refreshProvider(), 'Amazon SES status is up to date.'))}>
            <Icon name="refresh" size={14} />
            Refresh
          </button>
          <button
            className="btn small"
            disabled={busy || p.setup.running}
            title="Creates or repairs the configuration set, SNS topic, SQS queue and contact list"
            onClick={() => run(async () => `Amazon SES is set up: ${(await api.setupProvider()).setup.steps.join(', ')}.`)}
          >
            {p.setup.running ? 'Setting up…' : 'Run setup again'}
          </button>
        </div>
      </div>
      {(problems.length > 0 || sandbox) && (
        <div className="card-body ses-problems">
          {problems.map((text) => (
            <div key={text} className="callout error">
              <Icon name="alert" />
              <span>{text}</span>
            </div>
          ))}
          {sandbox && (
            <div className="callout warn">
              <Icon name="alert" />
              <span>
                Your account is still in the sandbox, so it can only email addresses you've verified, up to 200 a day. Request production access in the
                Amazon SES console to lift this.
              </span>
            </div>
          )}
        </div>
      )}
      <dl className="facts-list">
        <div>
          <dt>Account</dt>
          <dd>
            {a
              ? `${a.production ? 'Production' : 'Sandbox'}${a.enforcement && a.enforcement !== 'HEALTHY' ? ` · under review (${a.enforcement.toLowerCase()})` : ' · in good standing'}`
              : "Couldn't be read yet"}
          </dd>
        </div>
        <div>
          <dt>Quota</dt>
          <dd>{a ? `${a.sentLast24h.toLocaleString()} of ${a.max24h.toLocaleString()} used in the last 24 hours · ${a.maxPerSecond.toLocaleString()} per second` : '—'}</dd>
        </div>
        <div>
          <dt>Sending domain</dt>
          <dd>
            {p.sender
              ? `${p.sender.identity} · ${p.sender.verified ? 'verified' : 'not verified'}${p.sender.dkim ? ` · DKIM ${p.sender.dkim.toLowerCase()}` : ''}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Delivery updates</dt>
          <dd>
            Every {every >= 120 ? `${Math.round(every / 60)} minutes` : `${every} seconds`} · last {timeAgo(state.events.polledAt, clock)}
            <button
              className="link-btn inline"
              disabled={busy}
              onClick={() => run(async () => `Checked Amazon SES: ${plural((await api.pollEvents()).applied, 'new update')}.`)}
            >
              Check now
            </button>
          </dd>
        </div>
        <div>
          <dt>Set up in AWS</dt>
          <dd>{p.setup.ok ? p.setup.steps.join(' · ') : p.setup.running ? 'Running…' : 'Not yet'}</dd>
        </div>
      </dl>
    </section>
  );
}

/** The fixed rules, in one strip. */
function GoodToKnow({ ctx }: { ctx: Ctx }) {
  const { state, busy, run } = ctx;
  const { limits } = state;
  const items: { icon: IconName; title: string; text: ReactNode }[] = [
    { icon: 'mail', title: 'Sent from', text: limits.from },
    { icon: 'users', title: 'Never twice', text: "Nobody gets a second email, even if they're in several files or were emailed before." },
    { icon: 'refresh', title: 'Retries', text: `A failed email is tried ${plural(limits.maxAttempts, 'time')} before it's marked as failed.` },
    {
      icon: 'alert',
      title: 'Pause alerts',
      text: state.desktopNotifications ? (
        <>
          A Windows notification pops up on the server PC whenever sending pauses.
          <button
            className="link-btn inline"
            disabled={busy}
            onClick={() => run(async () => (await api.testNotification(), 'A test notification was shown on the server PC.'))}
          >
            Try it
          </button>
        </>
      ) : (
        "Off. The server isn't on Windows, or DESKTOP_NOTIFICATIONS is set to 0."
      ),
    },
  ];
  return (
    <section className="card" aria-label="Good to know">
      <div className="card-head">
        <div>
          <h2 className="card-title">Good to know</h2>
          <p className="card-sub">These rules are set on the server in .env</p>
        </div>
      </div>
      <ul className="rules">
        {items.map((i) => (
          <li key={i.title}>
            <span className="rule-icon">
              <Icon name={i.icon} size={16} />
            </span>
            <div>
              <strong>{i.title}</strong>
              <span>{i.text}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
