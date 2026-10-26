import { useEffect, useRef, useState } from 'react';
import { api, type AppState } from './api';
import { delayRange, estimateDuration, formatDuration, plural } from './format';
import { Icon } from './Icon';

export type SendScope = 'view' | 'all';

interface Props {
  state: AppState;
  /** Sendable recipients in the current file / search (status tab ignored) */
  viewUnsent: number;
  /** e.g. "in all-sending.csv"; null when the view is every file with no search */
  viewLabel: string | null;
  busy: boolean;
  clock: number;
  run: (action: () => Promise<string>) => Promise<void>;
  onStart: (scope: SendScope, count: number) => Promise<void>;
  onStop: () => void;
}

/** Everything about the send queue in one place: start, progress, pause/resume, stop, and the delay. */
export function SendingPanel({ state, viewUnsent, viewLabel, busy, clock, run, onStart, onStop }: Props) {
  const { engine, counts, settings } = state;
  const [starting, setStarting] = useState(false);

  const inFlight = counts.queued > 0 || engine.sending;
  const paused = engine.state === 'paused';
  const runInfo = engine.run;
  const done = runInfo ? runInfo.ok + runInfo.fail : 0;
  const pct = runInfo && runInfo.total ? Math.min(100, (done / runInfo.total) * 100) : 0;
  const remaining = counts.queued + (engine.sending ? 1 : 0);
  const live = engine.sending || engine.state === 'running';

  let activity = '';
  if (engine.sending) activity = 'Sending now…';
  else if (engine.state === 'running' && engine.nextSendAt)
    activity = `Next email in ${formatDuration((engine.nextSendAt - clock) / 1000)}`;
  else if (paused) activity = 'Paused';
  else if (runInfo?.stopped) activity = 'Stopped';
  else if (runInfo) activity = 'Finished';

  return (
    <section className="card send-card" aria-label="Sending">
      <div className="card-head">
        <div>
          <h2 className="card-title">Sending</h2>
          <p className="card-sub">
            From <strong>{state.limits.from}</strong> · one email at a time
          </p>
        </div>
        <DelayControl settings={settings} run={run} />
      </div>

      {paused && (
        <div className="callout warn panel-callout">
          <Icon name="alert" />
          <div className="callout-text">
            <strong>Sending is paused · {plural(remaining, 'email')} waiting in the queue.</strong>
            <span>{engine.lastError ?? 'The queue was not running when the server started. Resume to continue, or cancel the queue.'}</span>
          </div>
          <div className="callout-actions">
            <button className="btn primary" disabled={busy} onClick={() => run(async () => (await api.resume(), 'Sending resumed.'))}>
              <Icon name="play" />
              Resume
            </button>
            <button className="btn ghost" disabled={busy} onClick={onStop}>
              Cancel queue
            </button>
          </div>
        </div>
      )}
      {!paused && engine.lastError && (
        <div className="callout warn panel-callout">
          <Icon name="hourglass" />
          <div className="callout-text">
            <span>{engine.lastError}</span>
          </div>
        </div>
      )}

      <div className="send-body">
        <div className="run">
          {runInfo ? (
            <>
              <div className="run-top">
                <span className="run-label">{inFlight ? 'Current run' : 'Last run'}</span>
                <span className={`run-activity ${live ? 'live' : paused ? 'warn' : ''}`}>
                  <Icon name="clock" size={14} />
                  {activity}
                </span>
              </div>
              <div className="run-count">
                <b>{done.toLocaleString()}</b> of {runInfo.total.toLocaleString()} processed
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-label="Run progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
              >
                <div className={`progress-fill ${live ? 'live' : ''}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="run-meta">
                <span>
                  <i className="swatch good" />
                  {runInfo.ok.toLocaleString()} sent
                </span>
                <span>
                  <i className="swatch bad" />
                  {runInfo.fail.toLocaleString()} failed
                </span>
                {inFlight && remaining > 0 && (
                  <span>
                    {remaining.toLocaleString()} left · about {estimateDuration(remaining, settings.delaySeconds, settings.delayRandomMax)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="run-empty">
              <strong>Nothing sent yet</strong>
              <span className="muted">Start sending and progress shows up here.</span>
            </div>
          )}
        </div>

        <div className="send-cta">
          {live ? (
            <>
              <button className="btn danger" disabled={busy} onClick={onStop}>
                <Icon name="stop" />
                Stop sending
              </button>
              <button className="btn" disabled={busy || !counts.unsent} onClick={() => setStarting(true)}>
                <Icon name="send" />
                Queue more
              </button>
            </>
          ) : (
            !paused && (
              <>
                <button className="btn primary lg" disabled={busy || !counts.unsent} onClick={() => setStarting(true)}>
                  <Icon name="play" />
                  Start sending
                </button>
                <span className="muted small">
                  {counts.unsent ? `${counts.unsent.toLocaleString()} unsent recipients ready` : 'Everyone has been emailed'}
                </span>
              </>
            )
          )}
        </div>
      </div>

      {starting && (
        <StartDialog
          state={state}
          viewUnsent={viewUnsent}
          viewLabel={viewLabel}
          inFlight={inFlight}
          onCancel={() => setStarting(false)}
          onConfirm={(scope, count) => {
            setStarting(false);
            void onStart(scope, count);
          }}
        />
      )}
    </section>
  );
}

function StartDialog({
  state,
  viewUnsent,
  viewLabel,
  inFlight,
  onCancel,
  onConfirm,
}: {
  state: AppState;
  viewUnsent: number;
  viewLabel: string | null;
  inFlight: boolean;
  onCancel: () => void;
  onConfirm: (scope: SendScope, count: number) => void;
}) {
  const { settings, counts } = state;
  // Offer "this view" only when it is narrower than everything and has someone to send to.
  const narrowed = viewLabel !== null && viewUnsent > 0 && viewUnsent !== counts.unsent;
  const [scope, setScope] = useState<SendScope>(narrowed && viewUnsent ? 'view' : 'all');
  const count = scope === 'view' ? viewUnsent : counts.unsent;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const option = (value: SendScope, title: string, n: number) => (
    <label className={`choice ${scope === value ? 'active' : ''} ${n ? '' : 'disabled'}`}>
      <input type="radio" name="scope" checked={scope === value} disabled={!n} onChange={() => setScope(value)} />
      <span className="choice-text">
        <strong>{title}</strong>
        <span className="muted small">{plural(n, 'recipient')}</span>
      </span>
    </label>
  );

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Start sending" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Start sending</h2>
          <button className="icon-btn" aria-label="Close" onClick={onCancel}>
            <Icon name="x" />
          </button>
        </div>
        <p className="muted small">Who should get the email? Addresses already emailed from another file are skipped.</p>
        <div className="choices">
          {narrowed && option('view', `Unsent recipients ${viewLabel}`, viewUnsent)}
          {option('all', 'All unsent recipients in every file', counts.unsent)}
        </div>
        <div className="summary">
          <div>
            <span className="muted">Sender</span>
            <strong>{state.limits.from}</strong>
          </div>
          <div>
            <span className="muted">Pace</span>
            <strong>{delayRange(settings.delaySeconds, settings.delayRandomMax)}</strong>
          </div>
          <div>
            <span className="muted">Estimated time</span>
            <strong>about {estimateDuration(count, settings.delaySeconds, settings.delayRandomMax)}</strong>
          </div>
          {state.limits.dailyLimit > 0 && (
            <div>
              <span className="muted">Daily limit</span>
              <strong>{state.limits.dailyLimit} per day (continues the next day)</strong>
            </div>
          )}
        </div>
        {inFlight && <p className="dialog-note">They join the run already in progress.</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!count} onClick={() => onConfirm(scope, count)}>
            <Icon name="send" />
            Send {plural(count, 'email')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Delay [30]s + random 1–[10]s". Saved on blur; applies from the next email. */
function DelayControl({
  settings,
  run,
}: {
  settings: AppState['settings'];
  run: (action: () => Promise<string>) => Promise<void>;
}) {
  const [base, setBase] = useState(String(settings.delaySeconds));
  const [max, setMax] = useState(String(settings.delayRandomMax));
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
    setBase(String(settings.delaySeconds));
    setMax(String(settings.delayRandomMax));
  }, [settings.delaySeconds, settings.delayRandomMax]);

  const reset = () => {
    setBase(String(settings.delaySeconds));
    setMax(String(settings.delayRandomMax));
  };

  const commit = () => {
    editing.current = false;
    const s = Number(base);
    const m = Number(max);
    if (s === settings.delaySeconds && m === settings.delayRandomMax) return;
    // An emptied field reads as Number('') = 0, which would silently remove the delay between emails.
    if (!base.trim() || !max.trim()) return reset();
    void run(async () => {
      try {
        await api.saveSettings({ delaySeconds: s, delayRandomMax: m });
      } catch (err) {
        reset();
        throw err;
      }
      return `Delay saved: ${delayRange(s, m)}.`;
    });
  };

  const field = (value: string, set: (v: string) => void, label: string) => (
    <input
      className="num"
      type="number"
      min={0}
      max={3600}
      aria-label={label}
      value={value}
      onFocus={() => (editing.current = true)}
      onChange={(e) => set(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          reset();
          editing.current = false;
        }
      }}
    />
  );

  return (
    <div className="delay" title={`${delayRange(Number(base) || 0, Number(max) || 0)}. Applies from the next email.`}>
      <span className="delay-label">
        <Icon name="clock" size={14} />
        Delay
      </span>
      {field(base, setBase, 'Delay seconds')}
      <span className="muted">s + random 1–</span>
      {field(max, setMax, 'Random maximum seconds')}
      <span className="muted">s</span>
    </div>
  );
}
