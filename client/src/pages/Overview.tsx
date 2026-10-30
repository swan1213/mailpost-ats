import { useEffect, useState } from 'react';
import { api, type Overview } from '../api';
import { compact, timeAgo } from '../format';
import { Icon, type IconName } from '../Icon';
import { engineSummary, type Ctx } from '../shell';

const rate = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

export function OverviewPage({ ctx }: { ctx: Ctx }) {
  const { state, uploads, navigate, clock } = ctx;
  const [data, setData] = useState<Overview | null>(null);
  const c = state.counts;
  const engine = engineSummary(state, clock);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .overview()
        .then((d) => alive && setData(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const toRecipients = (status: string) => navigate('recipients', { status });

  return (
    <div className="page">
      <section className="kpis" aria-label="Totals across all files">
        <Kpi icon="users" label="Recipients" value={c.total} hint={`in ${uploads.length} files`} onClick={() => toRecipients('all')} />
        <Kpi icon="inbox" label="Not emailed yet" value={c.unsent} hint={c.queued ? `${c.queued.toLocaleString()} in the queue` : 'ready to send'} onClick={() => toRecipients('unsent')} />
        <Kpi icon="send" label="Sent" value={c.sent} hint={`${state.limits.sentToday.toLocaleString()} today`} onClick={() => toRecipients('sent')} />
        <Kpi icon="checkCircle" tone="good" label="Delivered" value={c.delivered} hint={`${rate(c.delivered, c.sent)} of sent`} onClick={() => toRecipients('delivered')} />
        <Kpi icon="eye" tone="accent" label="Opened" value={c.opened} hint={`${rate(c.opened, c.delivered)} of delivered`} onClick={() => toRecipients('opened')} />
        <Kpi icon="alert" tone={c.failed ? 'bad' : undefined} label="Failed" value={c.failed} hint={`${rate(c.failed, c.sent)} of sent`} onClick={() => toRecipients('failed')} />
      </section>

      <div className="grid-2">
        <section className="card">
          <SendsChart days={data?.days ?? null} />
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Delivery funnel</h2>
              <p className="card-sub">Every email Mailgun accepted</p>
            </div>
          </div>
          <div className="card-body">
            <Funnel
              steps={[
                { label: 'Sent', value: c.sent, note: '' },
                { label: 'Delivered', value: c.delivered, note: `${rate(c.delivered, c.sent)} of sent` },
                { label: 'Opened', value: c.opened, note: `${rate(c.opened, c.delivered)} of delivered` },
              ]}
            />
            <p className="fine-print">Opens are counted when the email's images load, so some inboxes under- or over-report them.</p>
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Recent activity</h2>
              <p className="card-sub">Latest delivery, open and bounce events from Mailgun</p>
            </div>
            <button className="btn ghost small" onClick={() => toRecipients('all')}>
              All recipients
              <Icon name="arrowRight" size={14} />
            </button>
          </div>
          {data?.recent.length ? (
            <ul className="activity">
              {data.recent.slice(0, 8).map((e) => (
                <li key={e.id}>
                  <button className="activity-row" onClick={() => navigate('recipients', { q: e.email, open: String(e.messageId) })}>
                    <span className={`activity-icon ${e.event}`}>
                      <Icon name={e.event === 'failed' ? 'alert' : e.event === 'opened' ? 'eye' : 'checkCircle'} size={14} />
                    </span>
                    <span className="activity-text">
                      <span className="activity-who">{e.name || e.email}</span>
                      <span className="activity-what">
                        {e.event === 'failed' ? 'Bounced' : e.event === 'opened' ? 'Opened the email' : e.event === 'clicked' ? 'Clicked a link' : 'Delivered'}
                        {e.name ? ` · ${e.email}` : ''}
                      </span>
                    </span>
                    <span className="activity-time">{timeAgo(e.ts, clock)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">{data ? 'No delivery events yet.' : 'Loading…'}</p>
          )}
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Sending</h2>
                <p className="card-sub">
                  {engine.paused ? `${engine.remaining.toLocaleString()} emails waiting in the queue` : engine.inFlight ? engine.activity : `${c.unsent.toLocaleString()} not emailed yet`}
                </p>
              </div>
              <span className={`engine-chip static ${engine.tone}`}>
                <span className="dot" />
                {engine.label}
              </span>
            </div>
            <div className="card-body">
              {engine.run ? (
                <>
                  <div className="mini-progress-head">
                    <span>
                      <b>{engine.done.toLocaleString()}</b> of {engine.run.total.toLocaleString()} {engine.inFlight ? 'in this run' : 'in the last run'}
                    </span>
                    <span className="muted">{Math.round(engine.pct)}%</span>
                  </div>
                  <div className="progress">
                    <div className={`progress-fill ${engine.live ? 'live' : ''}`} style={{ width: `${engine.pct}%` }} />
                  </div>
                </>
              ) : (
                <p className="muted small">Nothing has been sent yet.</p>
              )}
              <div className="card-actions">
                {!engine.inFlight && (
                  <button className="btn primary" disabled={!c.unsent} onClick={() => ctx.openStart(null)}>
                    <Icon name="play" />
                    Start sending
                  </button>
                )}
                <button className="btn" onClick={() => navigate('sending')}>
                  Open Sending
                  <Icon name="arrowRight" size={14} />
                </button>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Files</h2>
                <p className="card-sub">Progress per CSV</p>
              </div>
              <button className="btn ghost small" onClick={() => navigate('files')}>
                Manage
                <Icon name="arrowRight" size={14} />
              </button>
            </div>
            <ul className="file-mini">
              {uploads.slice(0, 4).map((u) => {
                const pct = u.total ? (u.sent / u.total) * 100 : 0;
                return (
                  <li key={u.id}>
                    <button onClick={() => navigate('recipients', { file: String(u.id) })}>
                      <span className="file-mini-name">
                        <Icon name="file" size={14} />
                        <span className="clamp1">{u.filename}</span>
                      </span>
                      <span className="file-mini-count">
                        {u.sent.toLocaleString()} / {u.total.toLocaleString()}
                      </span>
                      <span className="progress thin">
                        <span className="progress-fill" style={{ width: `${pct}%` }} />
                      </span>
                    </button>
                  </li>
                );
              })}
              {!uploads.length && <li className="empty-note">No files yet.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  icon: IconName;
  label: string;
  value: number;
  hint: string;
  tone?: 'good' | 'accent' | 'bad';
  onClick: () => void;
}) {
  return (
    <button className={`kpi ${tone ?? ''}`} onClick={onClick} title={`Show ${label.toLowerCase()}`}>
      <span className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className="kpi-icon">
          <Icon name={icon} />
        </span>
      </span>
      <span className="kpi-value">{value.toLocaleString()}</span>
      <span className="kpi-hint">{hint}</span>
    </button>
  );
}

/** Rounds a raw tick step up to 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, opts);

/** Emails sent per day, last 14 days. One series, so one color and no legend; hover or focus a day for details. */
function SendsChart({ days }: { days: Overview['days'] | null }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [active, setActive] = useState<number | null>(null);
  const total = days?.reduce((n, d) => n + d.sent, 0) ?? 0;
  const max = Math.max(1, ...(days ?? []).map((d) => d.sent));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const peak = days ? days.findIndex((d) => d.sent === max && max > 0) : -1;

  return (
    <>
      <div className="card-head">
        <div>
          <h2 className="card-title">Emails sent per day</h2>
          <p className="card-sub">Last 14 days · {total.toLocaleString()} sent</p>
        </div>
        <div className="view-switch" role="tablist" aria-label="Show as">
          <button role="tab" aria-selected={view === 'chart'} className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>
            <Icon name="barChart" size={14} />
            Chart
          </button>
          <button role="tab" aria-selected={view === 'table'} className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
            <Icon name="table" size={14} />
            Table
          </button>
        </div>
      </div>
      <div className="card-body">
        {!days ? (
          <div className="chart-loading">
            <span className="spinner" /> Loading…
          </div>
        ) : view === 'table' ? (
          <div className="table-scroll">
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="right">Sent</th>
                  <th className="right">Delivered</th>
                  <th className="right">Opened</th>
                </tr>
              </thead>
              <tbody>
                {[...days].reverse().map((d) => (
                  <tr key={d.day}>
                    <td>{dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                    <td className="right">{d.sent.toLocaleString()}</td>
                    <td className="right">{d.delivered.toLocaleString()}</td>
                    <td className="right">{d.opened.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="chart" onMouseLeave={() => setActive(null)}>
            <div className="chart-plot">
              {ticks.map((t) => (
                <div key={t} className="gridline" style={{ bottom: `${(t / top) * 100}%` }}>
                  <span className="tick">{compact(t)}</span>
                </div>
              ))}
              <div className="columns">
                {days.map((d, i) => (
                  <button
                    key={d.day}
                    className={`col-slot ${active === i ? 'active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    aria-label={`${dayLabel(d.day, { month: 'long', day: 'numeric' })}: ${d.sent} sent, ${d.delivered} delivered, ${d.opened} opened`}
                  >
                    <span className="col" style={{ height: `${(d.sent / top) * 100}%` }}>
                      {i === peak && active === null && <span className="col-label">{d.sent.toLocaleString()}</span>}
                    </span>
                    {active === i && (
                      <span className={`chart-tip ${i > days.length - 4 ? 'left' : ''}`} role="tooltip">
                        <strong>{dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                        <span>
                          <i className="key" /> {d.sent.toLocaleString()} sent
                        </span>
                        <span className="muted">
                          {d.delivered.toLocaleString()} delivered · {d.opened.toLocaleString()} opened
                        </span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="chart-x" aria-hidden="true">
              {days.map((d, i) => (
                <span key={d.day} className={`${i % 2 ? 'odd' : ''} ${i % 3 === 0 ? 'third' : ''}`}>
                  {dayLabel(d.day, { month: 'short', day: 'numeric' })}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Sent → delivered → opened, each bar's length relative to Sent, every value labelled. */
function Funnel({ steps }: { steps: { label: string; value: number; note: string }[] }) {
  const base = Math.max(1, steps[0].value);
  return (
    <ol className="funnel">
      {steps.map((s) => (
        <li key={s.label}>
          <div className="funnel-head">
            <span className="funnel-label">{s.label}</span>
            <span className="funnel-value">
              {s.value.toLocaleString()}
              {s.note && <span className="muted"> · {s.note}</span>}
            </span>
          </div>
          <div className="funnel-track">
            <div className="funnel-bar" style={{ width: `${Math.max(0.5, (s.value / base) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
