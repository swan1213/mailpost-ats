import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, type AppState, type Upload } from './api';
import { useConfirm } from './ConfirmDialog';
import { plural, timeAgo } from './format';
import { Icon, ThemeToggle } from './Icon';
import { FilesPage } from './pages/Files';
import { OverviewPage } from './pages/Overview';
import { RecipientsPage } from './pages/Recipients';
import { SendingPage } from './pages/Sending';
import { TemplatePage } from './pages/Template';
import { describeQueued, engineSummary, NAV, readRoute, routeHash, type Ctx, type PageName } from './shell';
import { StartDialog } from './StartDialog';
import { ToastStack, useToasts } from './Toasts';

// Every control from the boss's reference screenshot (docs/boss-reference-ui.png) still exists, now grouped by
// task: Overview (totals), Recipients (search / filters / table / select & send), Sending (start / stop / delay /
// progress), Template (template & test), Files (upload / re-import).

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [state, setState] = useState<AppState | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [startFor, setStartFor] = useState<{ uploadId: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toasts, toast, dismissToast] = useToasts();
  const [confirm, confirmDialog] = useConfirm();
  const leaveGuard = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo({ top: 0 });
    };
    // Unsaved template edits survive neither a reload nor closing the tab without asking.
    const onUnload = (e: BeforeUnloadEvent) => {
      if (leaveGuard.current) e.preventDefault();
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([api.state(), api.uploads()]);
      setState(s);
      setUploads(u);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 3000);
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      try {
        toast('ok', await action());
      } catch (err) {
        toast('error', (err as Error).message);
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh, toast],
  );

  const navigate = useCallback((page: PageName, params?: Record<string, string>) => {
    if (leaveGuard.current && !window.confirm(leaveGuard.current)) return;
    leaveGuard.current = null;
    window.location.hash = routeHash(page, params);
  }, []);

  const setLeaveGuard = useCallback((message: string | null) => {
    leaveGuard.current = message;
  }, []);

  // ---- actions shared by several pages --------------------------------------

  const uploadFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      await run(async () => {
        if (!/\.csv$/i.test(file.name)) throw new Error(`${file.name} is not a .csv file`);
        const r = await api.upload(file.name, await file.text());
        navigate('recipients', { file: String(r.uploadId) });
        const extra = [
          r.updated && `${r.updated} updated`,
          r.removed && `${r.removed} no longer in the file removed`,
          r.duplicates && `${r.duplicates} duplicate rows skipped`,
          r.invalid && `${r.invalid} invalid`,
        ]
          .filter(Boolean)
          .join(', ');
        return `${r.filename}: ${r.rows.toLocaleString()} rows, ${r.added.toLocaleString()} new${extra ? `, ${extra}` : ''}.`;
      });
    },
    [run, navigate],
  );

  const ctx = useMemo<Ctx | null>(() => {
    if (!state) return null;
    const { engine, counts } = state;
    return {
      state,
      uploads,
      busy,
      clock,
      params: route.params,
      run,
      toast,
      confirm,
      navigate,
      setLeaveGuard,
      refresh,
      openStart: (uploadId = null) => setStartFor({ uploadId }),
      pickFile: () => fileInput.current?.click(),
      resume: () => run(async () => (await api.resume(), 'Sending resumed.')),
      stopSending: async () => {
        const paused = engine.state === 'paused';
        const ok = await confirm({
          title: paused ? 'Cancel the queue?' : 'Stop sending?',
          confirmLabel: paused ? 'Cancel queue' : 'Stop sending',
          danger: true,
          body: (
            <p>
              {plural(counts.queued, 'queued email')} go back to Unsent. You can start again at any time.
              {engine.sending && ' The email being sent right now still finishes.'}
            </p>
          ),
        });
        if (!ok) return;
        await run(async () => `Stopped. ${plural((await api.stop()).cancelled, 'email')} went back to Unsent.`);
      },
    };
  }, [state, uploads, busy, clock, route.params, run, toast, confirm, navigate, setLeaveGuard, refresh]);

  const startSending = async (uploadId: number | null) => {
    setStartFor(null);
    await run(async () => describeQueued('Sending started', await api.sendFilter({ status: 'unsent', uploadId })));
  };

  if (!state || !ctx) {
    return (
      <main className="boot">
        {loadError ? (
          <div className="callout error">
            <Icon name="alert" />
            <span>Cannot reach the server: {loadError}</span>
          </div>
        ) : (
          <div className="boot-loading">
            <span className="spinner" />
            Loading MailPost…
          </div>
        )}
      </main>
    );
  }

  const engine = engineSummary(state, clock);
  const current = NAV.find((n) => n.page === route.page) ?? NAV[0];
  const badge = (page: PageName) =>
    page === 'sending' && engine.inFlight ? (
      <span className={`nav-badge ${engine.tone}`}>{engine.remaining.toLocaleString()}</span>
    ) : page === 'recipients' && state.counts.unsent ? (
      <span className="nav-badge">{state.counts.unsent.toLocaleString()}</span>
    ) : null;

  const navLink = (n: (typeof NAV)[number], className: string) => (
    <a
      key={n.page}
      href={routeHash(n.page)}
      className={`${className} ${route.page === n.page ? 'active' : ''}`}
      aria-current={route.page === n.page ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(n.page);
      }}
    >
      <Icon name={n.icon} size={18} />
      <span className="nav-label">{n.label}</span>
      {className === 'nav-item' && badge(n.page)}
      {className === 'tab-item' && n.page === 'sending' && engine.live && <span className="tab-dot" />}
    </a>
  );

  return (
    <div
      className="shell"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        void uploadFile(e.dataTransfer.files[0]);
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="mail" size={18} />
          </span>
          <div>
            <div className="brand-name">MailPost</div>
            <div className="brand-sub">ATS Group outreach</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => navLink(n, 'nav-item'))}
        </nav>
        <div className="sidebar-foot">
          <div className="foot-row">
            <span className="foot-label">Sender</span>
            <span className="foot-value" title={state.limits.from}>
              {state.limits.from}
            </span>
          </div>
          <div className="foot-row">
            <span className="foot-label">Mailgun sync</span>
            <span className={`foot-value ${state.events.error ? 'error-text' : ''}`} title={state.events.error ?? undefined}>
              {state.events.error ? 'Problem' : timeAgo(state.events.polledAt, clock)}
            </span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="brand-mark small mobile-only">
              <Icon name="mail" size={15} />
            </span>
            <div>
              <h1>{current.label}</h1>
              <p className="topbar-hint">{current.hint}</p>
            </div>
          </div>
          <div className="topbar-right">
            <button
              className={`engine-chip ${engine.tone}`}
              onClick={() => navigate('sending')}
              title={`${engine.activity} · open Sending`}
            >
              <span className="dot" />
              <span>{engine.label}</span>
              {engine.inFlight && engine.run && (
                <span className="engine-progress">
                  {engine.done.toLocaleString()}/{engine.run.total.toLocaleString()}
                </span>
              )}
            </button>
            <ThemeToggle />
          </div>
        </header>

        {loadError && (
          <div className="callout error page-alert">
            <Icon name="alert" />
            <span>Lost connection to the server ({loadError}). Retrying…</span>
          </div>
        )}

        <main className="content" key={route.page}>
          {route.page === 'overview' && <OverviewPage ctx={ctx} />}
          {route.page === 'recipients' && <RecipientsPage ctx={ctx} />}
          {route.page === 'sending' && <SendingPage ctx={ctx} />}
          {route.page === 'template' && <TemplatePage ctx={ctx} />}
          {route.page === 'files' && <FilesPage ctx={ctx} />}
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => navLink(n, 'tab-item'))}
      </nav>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          void uploadFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {startFor && (
        <StartDialog
          state={state}
          uploads={uploads}
          initialUploadId={startFor.uploadId}
          onCancel={() => setStartFor(null)}
          onConfirm={(uploadId) => void startSending(uploadId)}
        />
      )}
      {dragging && (
        <div className="drop-hint">
          <Icon name="upload" size={28} />
          Drop the CSV to upload it
          <span className="drop-sub">It needs an "email" column. Nothing is sent until you start sending.</span>
        </div>
      )}
      {confirmDialog}
      <ToastStack toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
