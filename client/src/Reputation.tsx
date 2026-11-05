import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Health, type Settings } from './api';
import { plural } from './format';
import { Icon } from './Icon';
import type { Ctx } from './shell';

/** A number saved when the field loses focus (or on Enter); Escape puts the saved value back. */
export function NumberSetting({
  id,
  label,
  hint,
  suffix,
  value,
  min,
  max,
  step = 1,
  disabled,
  onSave,
}: {
  id: string;
  label: string;
  hint?: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onSave: (n: number) => Promise<void>;
}) {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);

  const commit = () => {
    editing.current = false;
    const n = Number(text);
    // An emptied field would read as 0 and quietly change the meaning (e.g. "no daily limit").
    if (!text.trim() || !Number.isFinite(n)) return setText(String(value));
    if (n === value) return;
    onSave(n).catch(() => setText(String(value)));
  };

  return (
    <label className="pace-field" htmlFor={id}>
      <span className="pace-label">{label}</span>
      <span className="input-suffix">
        <input
          id={id}
          className="num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          disabled={disabled}
          onFocus={() => (editing.current = true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              editing.current = false;
              setText(String(value));
            }
          }}
        />
        <span>{suffix}</span>
      </span>
      {hint && <span className="pace-hint">{hint}</span>}
    </label>
  );
}

function Switch({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
    </label>
  );
}

const fmtPct = (n: number) => `${n.toFixed(n > 0 && n < 1 ? 2 : 1)}%`;

/** A rate against its limit: green under half the limit, amber up to it, red above. */
export function RateMeter({ label, value, count, of, limit }: { label: string; value: number; count: number; of: number; limit: number }) {
  const ratio = limit > 0 ? value / limit : 0;
  const tone = ratio > 1 ? 'bad' : ratio >= 0.5 ? 'warn' : 'good';
  const verdict = !of ? '' : tone === 'bad' ? 'Over the limit' : tone === 'warn' ? 'Getting close' : 'Healthy';
  return (
    <div className="rate">
      <div className="rate-top">
        <span className="rate-label">{label}</span>
        <span className={`rate-value ${tone}`}>{of ? fmtPct(value) : '—'}</span>
      </div>
      <div
        className="progress thin"
        role="meter"
        aria-label={`${label}: ${fmtPct(value)}, limit ${fmtPct(limit)}`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
      >
        <div className={`progress-fill ${tone}`} style={{ width: `${Math.max(of ? 2 : 0, Math.min(100, ratio * 100))}%` }} />
      </div>
      <span className="rate-note">
        {of ? (
          <>
            <span className={`rate-verdict ${tone}`}>{verdict}</span> · {count.toLocaleString()} of {of.toLocaleString()} · limit {fmtPct(limit)}
          </>
        ) : (
          'Nothing sent yet'
        )}
      </span>
    </div>
  );
}

/** Bounce/spam rates, the warm-up plan and repairable rows; reloaded when settings or counts change. */
export function useHealth(ctx: Ctx) {
  const { state } = ctx;
  const [health, setHealth] = useState<Health | null>(null);
  const load = useCallback(() => api.health().then(setHealth).catch(() => {}), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load, state.settings, state.counts.sent, state.counts.spam, state.counts.failed, state.counts.queued]);
  return { health, reload: load };
}

export type Save = (patch: Partial<Settings>, message: string) => Promise<void>;

/** Saves settings through ctx.run (busy state + toast) and resolves or rejects for the field that asked. */
export function useSave(ctx: Ctx): Save {
  return (patch, message) =>
    new Promise<void>((resolve, reject) => {
      void ctx.run(async () => {
        try {
          await api.saveSettings(patch);
        } catch (err) {
          reject(err);
          throw err;
        }
        resolve();
        return message;
      });
    });
}

export function LimitCard({ ctx, health, save }: { ctx: Ctx; health: Health | null; save: Save }) {
  const { settings: s, limits } = ctx.state;
  const busy = ctx.busy;
  const warming = limits.warmupDay !== null && !limits.warmupDone;
  const usedPct = limits.limit > 0 ? Math.min(100, (limits.sentToday / limits.limit) * 100) : 0;
  return (
    <section className="card" aria-label="Daily limit">
      <div className="card-head">
        <div>
          <h2 className="card-title">Daily limit</h2>
          <p className="card-sub">New domains need to start small. A sudden jump in volume lands in spam.</p>
        </div>
      </div>
      <div className="card-body">
        <div className="today-limit">
          <div className="today-limit-top">
            <span className="muted">Sent today</span>
            <strong>
              {limits.sentToday.toLocaleString()}
              <span className="muted"> {limits.limit ? `of ${limits.limit.toLocaleString()}` : '· no limit'}</span>
            </strong>
          </div>
          {limits.limit > 0 && (
            <div className="progress thin" aria-hidden="true">
              <div className={`progress-fill ${usedPct >= 100 ? 'warn' : ''}`} style={{ width: `${usedPct}%` }} />
            </div>
          )}
          <span className="pace-hint">
            {warming
              ? `Warm-up day ${limits.warmupDay}. Tomorrow's limit is ${s.warmupGrowthPct}% higher${s.dailyLimit ? `, up to ${s.dailyLimit.toLocaleString()} a day` : ''}.`
              : limits.warmupDone
                ? 'Warm-up is complete, so the daily limit now applies.'
                : limits.limit
                  ? 'Once the limit is reached, sending pauses until tomorrow and then carries on.'
                  : 'There is no cap on how many emails go out each day.'}
          </span>
        </div>

        <div className="pace-fields">
          <NumberSetting
            id="daily-limit"
            label="Most emails per day"
            hint="Set 0 for no limit"
            suffix="a day"
            value={s.dailyLimit}
            min={0}
            max={1_000_000}
            disabled={busy}
            onSave={(n) => save({ dailyLimit: n }, n ? `Daily limit set to ${n.toLocaleString()}.` : 'Daily limit removed.')}
          />
        </div>

        <div className="setting-block">
          <Switch
            checked={s.warmupEnabled}
            disabled={busy}
            label="Warm up gradually"
            hint="Start low and send a little more each day"
            onChange={(on) => save({ warmupEnabled: on }, on ? 'Warm-up is on. Today counts as day 1.' : 'Warm-up is off.')}
          />
          <div className="pace-fields">
            <NumberSetting
              id="warmup-start"
              label="First day"
              suffix="emails"
              value={s.warmupStart}
              min={1}
              max={1_000_000}
              disabled={busy}
              onSave={(n) => save({ warmupStart: n }, `Warm-up now starts at ${n.toLocaleString()} a day.`)}
            />
            <NumberSetting
              id="warmup-growth"
              label="Increase each day"
              suffix="%"
              value={s.warmupGrowthPct}
              min={0}
              max={100}
              disabled={busy}
              onSave={(n) => save({ warmupGrowthPct: n }, `Warm-up now grows by ${n}% a day.`)}
            />
          </div>
          {health && (
            <div className={`warmup-plan-wrap ${s.warmupEnabled ? '' : 'dim'}`}>
              <span className="pace-hint">{s.warmupEnabled ? 'The next 7 days' : 'What the first week would look like'}</span>
              <ol className="warmup-plan">
                {health.warmupPlan.map((d) => (
                  <li key={d.day} className={limits.warmupDay === d.day ? 'today' : ''}>
                    <span>{limits.warmupDay === d.day ? 'Today' : `Day ${d.day}`}</span>
                    <strong>{d.limit.toLocaleString()}</strong>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function SafetyCard({ ctx, health, save }: { ctx: Ctx; health: Health | null; save: Save }) {
  const s = ctx.state.settings;
  const busy = ctx.busy;
  const r = health?.recent;
  const all = health?.allTime;
  return (
    <section className="card" aria-label="Automatic safety pause">
      <div className="card-head">
        <div>
          <h2 className="card-title">Safety pause</h2>
          <p className="card-sub">
            {r && r.sent ? `Based on your last ${r.sent.toLocaleString()} emails` : 'Kicks in once you have sent 200 emails'}
          </p>
        </div>
      </div>
      <div className="card-body">
        {r && (
          <div className="rates">
            <RateMeter label="Bounce rate" value={r.bouncePct} count={r.bounced} of={r.sent} limit={s.maxBouncePct} />
            <RateMeter label="Spam reports" value={r.spamPct} count={r.spam} of={r.sent} limit={s.maxSpamPct} />
          </div>
        )}
        {all && all.sent > 0 && (
          <p className="pace-hint all-time">
            Since the start: {fmtPct(all.bouncePct)} bounced and {fmtPct(all.spamPct)} reported as spam, across {plural(all.sent, 'email')}.
          </p>
        )}

        <div className="setting-block">
          <Switch
            checked={s.safetyEnabled}
            disabled={busy}
            label="Pause automatically if a rate gets too high"
            hint="Checked before every email. You'll also get a Windows alert."
            onChange={(on) => save({ safetyEnabled: on }, on ? 'Safety pause is on.' : 'Safety pause is off. Sending will carry on even if bounces or spam reports climb.')}
          />
          <div className="pace-fields">
            <NumberSetting
              id="max-bounce"
              label="Pause above this bounce rate"
              suffix="%"
              value={s.maxBouncePct}
              min={0.5}
              max={50}
              step={0.5}
              disabled={busy || !s.safetyEnabled}
              onSave={(n) => save({ maxBouncePct: n }, `Sending will now pause above ${n}% bounces.`)}
            />
            <NumberSetting
              id="max-spam"
              label="Pause above this spam rate"
              suffix="%"
              value={s.maxSpamPct}
              min={0.01}
              max={5}
              step={0.01}
              disabled={busy || !s.safetyEnabled}
              onSave={(n) => save({ maxSpamPct: n }, `Sending will now pause above ${n}% spam reports.`)}
            />
          </div>
          <span className="pace-hint">Amazon SES starts reviewing accounts at 5% bounces or 0.1% spam reports, so stay below those.</span>
        </div>
      </div>
    </section>
  );
}

export function RepairCallout({ ctx, health, onDone }: { ctx: Ctx; health: Health; onDone: () => void }) {
  const { total, queued } = health.repairable;
  const running = ctx.state.engine.state === 'running';
  const repair = async () => {
    const ok = await ctx.confirm({
      title: 'Fix the sending history?',
      body: (
        <>
          <p>
            {plural(total, 'person')} {total === 1 ? 'was' : 'were'} emailed before, but {total === 1 ? 'their record was' : 'their records were'} later reset to
            "not sent"{queued ? `, and ${queued.toLocaleString()} ended up back in the queue` : ''}.
          </p>
          <p>
            This restores what really happened (sent, delivered, opened or bounced) from the delivery log and takes them out of the queue. A backup of
            the database is saved first.
          </p>
        </>
      ),
      confirmLabel: 'Back up and fix',
    });
    if (!ok) return;
    await ctx.run(async () => {
      const r = await api.repair();
      onDone();
      return `Fixed ${plural(r.repaired, 'record')}${r.fromQueue ? ` and took ${r.fromQueue.toLocaleString()} out of the queue` : ''}. Backup saved to ${r.backup}`;
    });
  };
  return (
    <div className="callout warn">
      <Icon name="alert" />
      <div className="callout-text">
        <strong>
          {plural(total, 'person')} in your list {total === 1 ? 'was' : 'were'} already emailed, but {total === 1 ? 'shows' : 'show'} as not sent
        </strong>
        <span>
          Nobody will get a second email: the sender checks the history and skips them. Fixing the records makes your totals accurate
          {queued ? ' and clears them out of the queue' : ''}.
        </span>
      </div>
      <button className="btn small" disabled={ctx.busy || running} title={running ? 'Pause or stop sending first' : undefined} onClick={repair}>
        Fix history
      </button>
    </div>
  );
}
