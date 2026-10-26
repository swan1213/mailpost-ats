import { useEffect, useState } from 'react';
import { api, type MessageDetail as Detail, type Row } from './api';
import { formatTime } from './format';
import { Icon } from './Icon';
import { StatusPills } from './StatusPills';

interface Props {
  row: Row;
  filename: string | undefined;
  testEmail: string;
  busy: boolean;
  run: (action: () => Promise<string>) => Promise<void>;
  onSendNow: (row: Row) => void;
  onClose: () => void;
}

/** Side panel for one recipient: what was (or will be) sent, delivery activity, and actions. */
export function MessageDrawer({ row, filename, testEmail, busy, run, onSendNow, onClose }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'email' | 'text'>('email');

  useEffect(() => {
    // Ignore a reply that arrives after a newer one was requested, and clear an earlier error once one succeeds.
    let current = true;
    api
      .message(row.id)
      .then((d) => {
        if (!current) return;
        setDetail(d);
        setError(null);
      })
      .catch((err: Error) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [row.id, row.updated_at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const facts: [string, React.ReactNode][] = [
    ['File', filename ?? '—'],
    ['Location', row.location || '—'],
    ['Sent', formatTime(row.sent_at)],
    ['Delivered', formatTime(row.delivered_at)],
    ['Opened', formatTime(row.opened_at)],
    ['Attempts', String(detail?.attempts ?? row.attempts)],
  ];

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Email to ${row.email}`}>
        <header className="drawer-head">
          <span className="avatar lg" aria-hidden="true">
            {(row.name || row.email).trim().charAt(0).toUpperCase()}
          </span>
          <div className="drawer-title">
            <h2>{row.name || row.email}</h2>
            <div className="muted small">{row.email}</div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <div className="drawer-body">
          <StatusPills row={row} />

          <dl className="facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {row.duplicate && (
            <div className="callout warn">
              <Icon name="alert" />
              <span>This address was already emailed from another file, so it won't be sent again.</span>
            </div>
          )}
          {row.last_error && (
            <div className={`callout ${row.status === 'failed' ? 'error' : 'warn'}`}>
              <Icon name="alert" />
              <span>{row.last_error}</span>
            </div>
          )}

          <div className="drawer-actions">
            {row.unsent && (
              <button className="btn primary" disabled={busy} onClick={() => onSendNow(row)}>
                <Icon name="send" />
                Send now
              </button>
            )}
            <button
              className="btn"
              disabled={busy || !testEmail}
              title={testEmail ? 'Sends this exact email to your test address' : 'Set a test address under "Template & test"'}
              onClick={() =>
                run(async () => {
                  const r = await api.sendTest(row.id);
                  return `Test of ${r.basedOn}'s email sent to ${r.to}.`;
                })
              }
            >
              <Icon name="mail" />
              {testEmail ? `Send test to ${testEmail}` : 'Send test'}
            </button>
          </div>

          <section className="drawer-section">
            <div className="section-head">
              <h3>{detail?.final ? 'Email as sent' : 'Email preview'}</h3>
              <div className="view-switch" role="tablist">
                <button role="tab" aria-selected={view === 'email'} className={view === 'email' ? 'active' : ''} onClick={() => setView('email')}>
                  Formatted
                </button>
                <button role="tab" aria-selected={view === 'text'} className={view === 'text' ? 'active' : ''} onClick={() => setView('text')}>
                  Plain text
                </button>
              </div>
            </div>
            {error && <p className="error-text small">{error}</p>}
            {!detail && !error && (
              <div className="detail-loading">
                <span className="spinner" /> Loading…
              </div>
            )}
            {detail && (
              <>
                <p className="email-subject">
                  <span className="muted">Subject</span>
                  <strong>{detail.subject}</strong>
                  {detail.source === 'template' && <span className="tag">template</span>}
                </p>
                {view === 'email' ? (
                  <iframe
                    className="email-frame"
                    title={`Email to ${row.email}`}
                    sandbox=""
                    src={`/api/messages/${row.id}/html?v=${row.updated_at}`}
                  />
                ) : (
                  <pre className="body">{detail.body}</pre>
                )}
              </>
            )}
          </section>

          <section className="drawer-section">
            <h3>Delivery activity</h3>
            {detail?.events.length ? (
              <ul className="events">
                {detail.events.map((e) => (
                  <li key={e.id} className={e.event}>
                    <div className="event-line">
                      <span className={`pill ${e.event}`}>{e.event}</span>
                      <span className="event-time">{formatTime(e.ts)}</span>
                    </div>
                    {e.detail && <div className="event-detail">{e.detail}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{row.sent_at ? 'No events from Mailgun yet.' : 'Not sent yet.'}</p>
            )}
            {detail?.mailgunId && <p className="mono-note">Mailgun ID {detail.mailgunId}</p>}
          </section>
        </div>
      </aside>
    </>
  );
}
