import { api } from '../api';
import { DelayControl } from '../DelayControl';
import { emailsPerHour, estimateDuration, formatDuration, plural, timeAgo } from '../format';
import { Icon } from '../Icon';
import { engineSummary, type Ctx } from '../shell';

/** New Mailgun accounts on probation are capped at this many emails per hour. */
const PROBATION_PER_HOUR = 100;

export function SendingPage({ ctx }: { ctx: Ctx }) {
  const { state, busy, run, clock, navigate } = ctx;
  const { counts, settings, limits, events } = state;
  const engine = engineSummary(state, clock);
  const perHour = emailsPerHour(settings.delaySeconds, settings.delayRandomMax);
  const title = engine.live ? 'Sending in progress' : engine.paused ? 'Sending is paused' : counts.unsent ? 'Ready to send' : 'Everyone has been emailed';

  return (
    <div className="page">
      <section className={`card hero ${engine.tone}`} aria-label="Send queue">
        <div className="hero-main">
          <span className={`engine-chip static ${engine.tone}`}>
            <span className="dot" />
            {engine.label}
          </span>
          <h2 className="hero-title">{title}</h2>
          <p className="hero-sub">
            {engine.paused
              ? `${plural(engine.remaining, 'email')} waiting in the queue. ${state.engine.lastError ?? 'The queue was not running when the server started: resume to continue, or cancel the queue.'}`
              : engine.inFlight
                ? engine.activity
                : counts.unsent
                ? `${counts.unsent.toLocaleString()} recipients have not been emailed yet.`
                : 'Upload a new CSV to reach more people.'}
          </p>

          {engine.run && (
            <div className="hero-progress">
              <div className="progress lg" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(engine.pct)}>
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
                Queue more
              </button>
            </>
          ) : (
            <button className="btn primary lg" disabled={busy || !counts.unsent} onClick={() => ctx.openStart(null)}>
              <Icon name="play" />
              Start sending
            </button>
          )}
          <button className="btn ghost" onClick={() => navigate('recipients', { status: 'unsent' })}>
            Pick recipients by hand
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

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Pace</h2>
              <p className="card-sub">Emails go out one at a time. Changes apply from the next email.</p>
            </div>
          </div>
          <div className="card-body">
            <DelayControl settings={settings} run={run} />
            <div className="pace-summary">
              <div>
                <span className="muted">Between emails</span>
                <strong>
                  {settings.delayRandomMax > 0
                    ? `${formatDuration(settings.delaySeconds + 1)} – ${formatDuration(settings.delaySeconds + settings.delayRandomMax)}`
                    : formatDuration(settings.delaySeconds)}
                </strong>
              </div>
              <div>
                <span className="muted">Per hour</span>
                <strong>{Number.isFinite(perHour) ? `~${Math.round(perHour).toLocaleString()}` : 'no limit'}</strong>
              </div>
              <div>
                <span className="muted">Per day</span>
                <strong>{Number.isFinite(perHour) ? `~${Math.round(perHour * 24).toLocaleString()}` : 'no limit'}</strong>
              </div>
            </div>
            {perHour > PROBATION_PER_HOUR && (
              <div className="callout warn">
                <Icon name="alert" />
                <span>
                  Faster than {PROBATION_PER_HOUR} emails an hour. While the Mailgun account is on probation it allows only{' '}
                  {PROBATION_PER_HOUR} per hour; extra sends wait automatically until Mailgun allows them again.
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Sending rules</h2>
              <p className="card-sub">Set on the server in .env</p>
            </div>
          </div>
          <dl className="facts-list">
            <div>
              <dt>Sender</dt>
              <dd>{limits.from}</dd>
            </div>
            <div>
              <dt>Sent today</dt>
              <dd>
                {limits.sentToday.toLocaleString()}
                {limits.dailyLimit ? ` of ${limits.dailyLimit.toLocaleString()} allowed` : ' · no daily limit'}
              </dd>
            </div>
            <div>
              <dt>Tries per email</dt>
              <dd>{limits.maxAttempts} before it is marked failed</dd>
            </div>
            <div>
              <dt>Duplicates</dt>
              <dd>An address is never emailed twice, even if it is in several files</dd>
            </div>
            <div>
              <dt>Mailgun status sync</dt>
              <dd>
                Every {events.intervalSeconds}s · last {timeAgo(events.polledAt, clock)}
                {events.error && <span className="error-text"> · {events.error}</span>}
                <button
                  className="link-btn inline"
                  disabled={busy}
                  onClick={() => run(async () => `Synced with Mailgun · ${plural((await api.pollEvents()).applied, 'new event')}.`)}
                >
                  Sync now
                </button>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
