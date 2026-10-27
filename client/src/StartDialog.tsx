import { useEffect, useState } from 'react';
import type { AppState, Upload } from './api';
import { emailsPerHour, estimateDuration, formatDuration, plural } from './format';
import { Icon } from './Icon';

interface Props {
  state: AppState;
  uploads: Upload[];
  /** File chosen up front (from the Files page), or null for every file */
  initialUploadId: number | null;
  onCancel: () => void;
  onConfirm: (uploadId: number | null, count: number) => void;
}

/** Choose who gets the email (every file, or one file), with the pace and time it will take. */
export function StartDialog({ state, uploads, initialUploadId, onCancel, onConfirm }: Props) {
  const { settings, counts, limits } = state;
  const files = uploads.filter((u) => u.unsent > 0);
  // Per-file choices only appear when more than one file has someone left to email.
  const perFile = files.length > 1;
  const [choice, setChoice] = useState<number | null>(perFile && files.some((f) => f.id === initialUploadId) ? initialUploadId : null);
  const count = choice === null ? counts.unsent : (files.find((f) => f.id === choice)?.unsent ?? 0);
  const perHour = Math.round(emailsPerHour(settings.delaySeconds, settings.delayRandomMax));
  const inFlight = counts.queued > 0 || state.engine.sending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const option = (id: number | null, title: string, sub: string, n: number) => (
    <label key={id ?? 'all'} className={`choice ${choice === id ? 'active' : ''}`}>
      <input type="radio" name="scope" checked={choice === id} onChange={() => setChoice(id)} />
      <span className="choice-text">
        <strong>{title}</strong>
        <span className="muted small">{sub}</span>
      </span>
      <span className="choice-count">{n.toLocaleString()}</span>
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
        <p className="muted small">Who should get the email? Addresses already emailed from another file are skipped automatically.</p>

        <div className="choices">
          {option(null, 'Everyone not emailed yet', `Across all ${plural(uploads.length, 'file')}`, counts.unsent)}
          {perFile && files.map((f) => option(f.id, f.filename, `${f.sent.toLocaleString()} of ${f.total.toLocaleString()} already sent`, f.unsent))}
        </div>

        <dl className="summary">
          <div>
            <dt>Sender</dt>
            <dd>{limits.from}</dd>
          </div>
          <div>
            <dt>Pace</dt>
            <dd>
              {settings.delayRandomMax > 0
                ? `${formatDuration(settings.delaySeconds + 1)}–${formatDuration(settings.delaySeconds + settings.delayRandomMax)} apart`
                : `${formatDuration(settings.delaySeconds)} apart`}{' '}
              · ~{perHour.toLocaleString()}/hour
            </dd>
          </div>
          <div>
            <dt>Estimated time</dt>
            <dd>{count <= 1 ? 'under a minute' : `about ${estimateDuration(count, settings.delaySeconds, settings.delayRandomMax)}`}</dd>
          </div>
          {limits.dailyLimit > 0 && (
            <div>
              <dt>Daily limit</dt>
              <dd>{limits.dailyLimit.toLocaleString()} per day, then continues the next day</dd>
            </div>
          )}
        </dl>
        {inFlight && <p className="dialog-note">These join the run that is already in progress.</p>}

        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!count} onClick={() => onConfirm(choice, count)}>
            <Icon name="send" />
            Send {plural(count, 'email')}
          </button>
        </div>
      </div>
    </div>
  );
}
