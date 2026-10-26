import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, type AppState, type Filter, type Page, type Row, type StatusFilter, type Upload } from './api';
import { useConfirm } from './ConfirmDialog';
import { delayRange, estimateDuration, formatTime, plural } from './format';
import { Icon, ThemeToggle, type IconName } from './Icon';
import { MessageDrawer } from './MessageDrawer';
import { SendingPanel, type SendScope } from './SendingPanel';
import { StatusPills } from './StatusPills';
import { TemplateDialog } from './TemplateDialog';
import { ToastStack, useToasts } from './Toasts';

// Every control from the boss's reference screenshot (docs/boss-reference-ui.png) is still here, regrouped:
// totals, one sending panel (start / stop / resume / delay / progress), then the recipients table.

const STATUS_TABS: { value: StatusFilter; label: string; hint: string; hideWhenEmpty?: boolean }[] = [
  { value: 'all', label: 'All', hint: 'Every recipient' },
  { value: 'unsent', label: 'Unsent', hint: 'Not emailed yet, ready to send' },
  { value: 'queued', label: 'Queued', hint: 'Waiting in the send queue' },
  { value: 'sent', label: 'Sent', hint: 'Accepted by Mailgun (includes delivered and bounced)' },
  { value: 'delivered', label: 'Delivered', hint: 'Reached the inbox server' },
  { value: 'opened', label: 'Opened', hint: 'Opened at least once' },
  { value: 'failed', label: 'Failed', hint: 'Bounced, or could not be sent after all tries' },
  {
    value: 'duplicate',
    label: 'Already emailed',
    hint: 'Same address was emailed from another file; it will not be sent again',
    hideWhenEmpty: true,
  },
  { value: 'skipped', label: 'Invalid', hint: 'Bad CSV row, e.g. an invalid email address', hideWhenEmpty: true },
];

const PAGE_SIZES = [50, 100, 200, 500];
const FILE_KEY = 'mailpost-file';

function rememberedFile(): string | null {
  try {
    return localStorage.getItem(FILE_KEY);
  } catch {
    return null;
  }
}

function rememberFile(value: string) {
  try {
    localStorage.setItem(FILE_KEY, value);
  } catch {
    // not remembered; still applied
  }
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>({ q: '', status: 'all', uploadId: null });
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** "Select all matching": how many unsent rows it covers; null when off */
  const [allMatching, setAllMatching] = useState<number | null>(null);
  const [openRow, setOpenRow] = useState<Row | null>(null);

  const [toasts, toast, dismissToast] = useToasts();
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [showTemplate, setShowTemplate] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);
  const fileChosen = useRef(false);

  // Search waits until typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Open on the file picked last time in this browser. Otherwise all files, so the table matches the totals
  // above it (opening on the newest upload showed a 2-row test file under 36,909 recipients).
  useEffect(() => {
    if (fileChosen.current || !uploads.length) return;
    fileChosen.current = true;
    const file = uploads.find((u) => String(u.id) === rememberedFile());
    if (file) setFilter((f) => ({ ...f, uploadId: file.id }));
  }, [uploads]);

  // A different filter means a different list: back to page 1, nothing selected.
  useEffect(() => {
    setPageNo(1);
    setSelected(new Set());
    setAllMatching(null);
  }, [filter]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [s, p, u] = await Promise.all([api.state(), api.messages(filter, pageNo, pageSize), api.uploads()]);
      if (seq !== loadSeq.current) return; // a newer load already started
      setState(s);
      setPage(p);
      setUploads(u);
      setLoadError(null);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError((err as Error).message);
    }
  }, [filter, pageNo, pageSize]);

  useEffect(() => {
    void load();
    const refresh = setInterval(load, 3000);
    return () => clearInterval(refresh);
  }, [load]);

  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Keep the open side panel in step with the table's refreshes.
  useEffect(() => {
    if (!page) return;
    setOpenRow((open) => (open && page.rows.find((r) => r.id === open.id)) || open);
  }, [page]);

  const run = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      try {
        toast('ok', await action());
      } catch (err) {
        toast('error', (err as Error).message);
      } finally {
        setBusy(false);
        await load();
      }
    },
    [load, toast],
  );

  const closeDrawer = useCallback(() => setOpenRow(null), []);

  if (!state || !page) {
    return (
      <main className="page boot">
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

  const { engine, counts, settings } = state;
  const inFlight = counts.queued > 0 || engine.sending;
  const pageUnsent = page.rows.filter((r) => r.unsent);
  const pageAllSelected = pageUnsent.length > 0 && pageUnsent.every((r) => allMatching !== null || selected.has(r.id));
  const pageSomeSelected = !pageAllSelected && pageUnsent.some((r) => selected.has(r.id));
  const selectionCount = allMatching ?? selected.size;
  const currentFile = uploads.find((u) => u.id === filter.uploadId);
  const tab = STATUS_TABS.find((t) => t.value === filter.status) ?? STATUS_TABS[0];

  const viewParts: string[] = [];
  if (currentFile) viewParts.push(`in ${currentFile.filename}`);
  if (filter.q) viewParts.push(`matching "${filter.q}"`);
  const viewLabel = viewParts.length ? viewParts.join(' ') : null;

  const setTab = (status: StatusFilter) => setFilter((f) => (f.status === status ? f : { ...f, status }));
  const chooseFile = (uploadId: number | null) => {
    fileChosen.current = true;
    rememberFile(uploadId ? String(uploadId) : 'all');
    setFilter((f) => ({ ...f, uploadId }));
  };

  // ---- sending -------------------------------------------------------------

  /** Rows can be skipped when they were sent meanwhile, or the address was already emailed from another file. */
  const describeQueued = (label: string, r: { queued: number; skipped: number }) => {
    const skipped = r.skipped ? ` ${plural(r.skipped, 'recipient')} skipped (already emailed).` : '';
    if (!r.queued) throw new Error(`Nothing was queued.${skipped}`);
    return `${label}: ${plural(r.queued, 'email')} queued.${skipped}`;
  };

  // After a send, show every status so the rows being sent stay visible.
  const afterQueue = () => setTab('all');

  const confirmSend = (count: number, scope: string) =>
    confirm({
      title: `Send to ${plural(count, 'recipient')}?`,
      confirmLabel: `Send ${plural(count, 'email')}`,
      body: (
        <>
          <p>
            {scope}, from <strong>{state.limits.from}</strong>.
          </p>
          <p className="muted">
            One at a time, {delayRange(settings.delaySeconds, settings.delayRandomMax)}. Estimated time: about{' '}
            {estimateDuration(count, settings.delaySeconds, settings.delayRandomMax)}.
          </p>
          {inFlight && <p className="muted">They join the run already in progress.</p>}
        </>
      ),
    });

  const startSending = async (scope: SendScope) => {
    await run(async () =>
      describeQueued(
        'Sending started',
        await api.sendFilter(scope === 'all' ? { status: 'unsent' } : { q: filter.q, uploadId: filter.uploadId, status: 'all' }),
      ),
    );
    afterQueue();
  };

  const sendSelection = async () => {
    const scope =
      allMatching !== null
        ? `All unsent recipients in the "${tab.label}" tab${viewLabel ? ` ${viewLabel}` : ''}`
        : 'The selected recipients';
    if (!(await confirmSend(selectionCount, scope))) return;
    await run(async () => {
      const r = allMatching !== null ? await api.sendFilter(filter) : await api.sendIds([...selected]);
      setSelected(new Set());
      setAllMatching(null);
      return describeQueued('Sending started', r);
    });
    afterQueue();
  };

  const sendOne = async (row: Row) => {
    if (!(await confirmSend(1, `${row.name ? `${row.name} ` : ''}<${row.email}>`))) return;
    await run(async () => describeQueued('Queued', await api.sendIds([row.id])));
  };

  const stopSending = async () => {
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
  };

  // ---- files ---------------------------------------------------------------

  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    await run(async () => {
      if (!/\.csv$/i.test(file.name)) throw new Error(`${file.name} is not a .csv file`);
      const r = await api.upload(file.name, await file.text());
      chooseFile(r.uploadId);
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
  };

  const reimport = () =>
    run(async () => {
      const r = await api.reimport();
      if (!r.files) return `No CSV files in ${r.folder}.`;
      const errors = r.errors.map((e) => `${e.filename}: ${e.error}`).join('; ');
      if (errors && !r.added && !r.updated) throw new Error(errors);
      return `Rescanned ${plural(r.files, 'file')}: ${r.added} new, ${r.updated} updated, ${r.removed} removed.${errors ? ` Problems: ${errors}` : ''}`;
    });

  const syncMailgun = () =>
    run(async () => `Synced with Mailgun · ${plural((await api.pollEvents()).applied, 'new event')}.`);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFile(e.dataTransfer.files[0]);
  };

  // ---- selection -----------------------------------------------------------

  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(null);
  };

  const toggleRow = (id: number) => {
    if (allMatching !== null) {
      // Leaving "all matching": keep this page's rows except the one just unticked.
      setAllMatching(null);
      setSelected(new Set(pageUnsent.map((r) => r.id).filter((x) => x !== id)));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    if (allMatching !== null) return clearSelection();
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of pageUnsent) {
        if (pageAllSelected) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  };

  const selectAllMatching = async () => {
    try {
      const { count } = await api.countUnsent(filter);
      setSelected(new Set());
      setAllMatching(count);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  const rate = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');
  const first = page.total ? (page.page - 1) * page.pageSize + 1 : 0;
  const last = Math.min(page.total, page.page * page.pageSize);
  const live = engine.sending || engine.state === 'running';
  const engineTone = live ? 'live' : engine.state === 'paused' ? 'warn' : 'idle';

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="appbar">
        <div className="appbar-inner">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="mail" size={18} />
            </span>
            <div>
              <div className="brand-name">MailPost</div>
              <div className="brand-sub">ATS Group outreach</div>
            </div>
          </div>
          <span className={`engine-chip ${engineTone}`} title="Send queue status">
            <span className="dot" />
            {live ? 'Sending' : engine.state === 'paused' ? 'Paused' : 'Idle'}
          </span>
          <div className="appbar-right">
            <ThemeToggle />
            <button className="btn" onClick={() => setShowTemplate(true)}>
              <Icon name="edit" />
              <span>Template &amp; test</span>
            </button>
          </div>
        </div>
      </header>

      <main className="page">
        {loadError && (
          <div className="callout error">
            <Icon name="alert" />
            <span>Lost connection to the server: {loadError}. Retrying…</span>
          </div>
        )}

        <section aria-label="Overview">
          <div className="section-label">
            <span>Overview</span>
            <span className="muted">All files</span>
          </div>
          <div className="stats">
            <Stat icon="users" label="Recipients" value={counts.total} hint={`in ${plural(uploads.length, 'file')}`} onClick={() => setTab('all')} active={filter.status === 'all'} />
            <Stat
              icon="inbox"
              label="Unsent"
              value={counts.unsent}
              hint={counts.queued ? `${counts.queued.toLocaleString()} queued` : 'ready to send'}
              onClick={() => setTab('unsent')}
              active={filter.status === 'unsent'}
            />
            <Stat
              icon="send"
              label="Sent"
              value={counts.sent}
              hint={`${state.limits.sentToday.toLocaleString()}${state.limits.dailyLimit ? ` / ${state.limits.dailyLimit}` : ''} today`}
              onClick={() => setTab('sent')}
              active={filter.status === 'sent'}
            />
            <Stat
              icon="checkCircle"
              label="Delivered"
              value={counts.delivered}
              hint={`${rate(counts.delivered, counts.sent)} of sent`}
              tone="good"
              onClick={() => setTab('delivered')}
              active={filter.status === 'delivered'}
            />
            <Stat
              icon="eye"
              label="Opened"
              value={counts.opened}
              hint={`${rate(counts.opened, counts.delivered)} of delivered`}
              tone="accent"
              onClick={() => setTab('opened')}
              active={filter.status === 'opened'}
            />
            <Stat
              icon="alert"
              label="Failed"
              value={counts.failed}
              hint={`${rate(counts.failed, counts.sent)} of sent`}
              tone={counts.failed ? 'bad' : undefined}
              onClick={() => setTab('failed')}
              active={filter.status === 'failed'}
            />
          </div>
        </section>

        <SendingPanel
          state={state}
          viewUnsent={page.counts.unsent}
          viewLabel={viewLabel}
          busy={busy}
          clock={clock}
          run={run}
          onStart={startSending}
          onStop={stopSending}
        />

        <section className="card table-card" aria-label="Recipients">
          <div className="card-head">
            <div>
              <h2 className="card-title">Recipients</h2>
              <p className="card-sub">
                {page.counts.all.toLocaleString()} {currentFile ? `in ${currentFile.filename}` : 'across all files'}
                {filter.q && ` matching "${filter.q}"`}
              </p>
            </div>
            <div className="btn-group">
              <button className="btn ghost" disabled={busy} onClick={reimport} title="Re-read every CSV in the server's CSV folder">
                <Icon name="folder" />
                <span>Rescan folder</span>
              </button>
              <button className="btn ghost" disabled={busy} onClick={syncMailgun} title="Fetch the latest delivery and open events from Mailgun now">
                <Icon name="refresh" />
                <span>Sync Mailgun</span>
              </button>
              <button className="btn primary" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Icon name="upload" />
                <span>Upload CSV</span>
              </button>
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
            </div>
          </div>

          <div className="filters">
            <label className="search">
              <Icon name="search" />
              <input
                type="search"
                placeholder="Search name, email, location or subject"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="select">
              <select aria-label="File" value={filter.uploadId ?? ''} onChange={(e) => chooseFile(e.target.value ? Number(e.target.value) : null)}>
                <option value="">All files</option>
                {uploads.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.filename} · {u.sent.toLocaleString()}/{u.total.toLocaleString()} sent
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={14} />
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Status">
            {STATUS_TABS.filter((t) => !t.hideWhenEmpty || page.counts[t.value] || filter.status === t.value).map((t) => (
              <button
                key={t.value}
                role="tab"
                aria-selected={filter.status === t.value}
                className={`tab ${filter.status === t.value ? 'active' : ''}`}
                title={t.hint}
                onClick={() => setTab(t.value)}
              >
                {t.label}
                <span className="tab-count">{page.counts[t.value].toLocaleString()}</span>
              </button>
            ))}
          </div>

          {selectionCount > 0 && (
            <div className="bulk-bar">
              <span className="bulk-count">
                {allMatching !== null
                  ? `All ${plural(allMatching, 'unsent recipient')} in this view selected`
                  : `${plural(selected.size, 'recipient')} selected`}
              </span>
              {allMatching === null && pageAllSelected && page.pages > 1 && (
                <button className="link-btn" onClick={selectAllMatching}>
                  Select all unsent in this view
                </button>
              )}
              <span className="spacer" />
              <button className="btn ghost small" onClick={clearSelection}>
                Clear
              </button>
              <button className="btn primary" disabled={busy} onClick={sendSelection}>
                <Icon name="send" />
                Send {plural(selectionCount, 'email')}
              </button>
            </div>
          )}

          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="check">
                    <input
                      type="checkbox"
                      aria-label="Select unsent recipients on this page"
                      title="Select unsent recipients on this page"
                      checked={pageAllSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = pageSomeSelected;
                      }}
                      disabled={!pageUnsent.length}
                      onChange={togglePage}
                    />
                  </th>
                  <th>Recipient</th>
                  <th>Message</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th className="right">Sent</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <TableRow
                    key={r.id}
                    row={r}
                    checked={r.unsent && (allMatching !== null || selected.has(r.id))}
                    active={openRow?.id === r.id}
                    onCheck={() => toggleRow(r.id)}
                    onOpen={() => setOpenRow(r)}
                  />
                ))}
                {!page.rows.length && (
                  <tr className="empty-row">
                    <td colSpan={6}>
                      <div className="empty">
                        <span className="empty-icon">
                          <Icon name={uploads.length ? 'inbox' : 'upload'} size={22} />
                        </span>
                        <strong>{uploads.length ? `No ${tab.value === 'all' ? '' : `${tab.label.toLowerCase()} `}recipients here` : 'No CSV yet'}</strong>
                        <span className="muted">
                          {uploads.length
                            ? filter.q
                              ? 'Try a different search.'
                              : tab.hint
                            : 'Upload a CSV with an "email" column, or drop the file anywhere on this page.'}
                        </span>
                        {!uploads.length && (
                          <button className="btn primary" onClick={() => fileInput.current?.click()}>
                            <Icon name="upload" />
                            Upload CSV
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <nav className="pager" aria-label="Pages">
            <span className="pager-info">
              {first.toLocaleString()}–{last.toLocaleString()} of {page.total.toLocaleString()}
            </span>
            <div className="pager-controls">
              <button className="icon-btn" disabled={page.page <= 1} onClick={() => setPageNo(1)} aria-label="First page">
                <Icon name="chevronsLeft" />
              </button>
              <button className="icon-btn" disabled={page.page <= 1} onClick={() => setPageNo(page.page - 1)} aria-label="Previous page">
                <Icon name="chevronLeft" />
              </button>
              <span className="pager-page">
                Page {page.page.toLocaleString()} of {page.pages.toLocaleString()}
              </span>
              <button className="icon-btn" disabled={page.page >= page.pages} onClick={() => setPageNo(page.page + 1)} aria-label="Next page">
                <Icon name="chevronRight" />
              </button>
              <button className="icon-btn" disabled={page.page >= page.pages} onClick={() => setPageNo(page.pages)} aria-label="Last page">
                <Icon name="chevronsRight" />
              </button>
            </div>
            <label className="pager-size">
              Rows
              <span className="select">
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPageNo(1);
                  }}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={14} />
              </span>
            </label>
          </nav>
        </section>

        <footer className="footer">
          <span>
            Mailgun synced every {state.events.intervalSeconds}s · last {formatTime(state.events.polledAt)}
          </span>
          {state.events.error && <span className="error-text">Sync problem: {state.events.error}</span>}
          <span>
            {state.limits.maxAttempts} tries per email · daily limit {state.limits.dailyLimit || 'none'}
          </span>
        </footer>
      </main>

      {openRow && (
        <MessageDrawer
          row={openRow}
          filename={uploads.find((u) => u.id === openRow.upload_id)?.filename}
          testEmail={settings.testEmail}
          busy={busy}
          run={run}
          onSendNow={sendOne}
          onClose={closeDrawer}
        />
      )}
      {dragging && (
        <div className="drop-hint">
          <Icon name="upload" size={28} />
          Drop the CSV to upload it
        </div>
      )}
      {showTemplate && <TemplateDialog state={state} run={run} onClose={() => setShowTemplate(false)} />}
      {confirmDialog}
      <ToastStack toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  value: number;
  hint: string;
  tone?: 'good' | 'accent' | 'bad';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`stat ${tone ?? ''} ${active ? 'active' : ''}`} onClick={onClick} title={`Show ${label.toLowerCase()} recipients`}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className="stat-icon">
          <Icon name={icon} />
        </span>
      </div>
      <div className="stat-value">{value.toLocaleString()}</div>
      <div className="stat-hint">{hint}</div>
    </button>
  );
}

interface RowProps {
  row: Row;
  checked: boolean;
  active: boolean;
  onCheck: () => void;
  onOpen: () => void;
}

function TableRow({ row: r, checked, active, onCheck, onOpen }: RowProps) {
  const lockedReason = r.duplicate ? 'Already emailed from another file' : r.status === 'skipped' ? 'Invalid row' : 'Already sent or queued';
  return (
    <tr
      className={`row ${active ? 'active' : ''} ${checked ? 'checked' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      tabIndex={0}
    >
      <td className="check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${r.email}`}
          checked={checked}
          disabled={!r.unsent}
          title={r.unsent ? undefined : lockedReason}
          onChange={onCheck}
        />
      </td>
      <td className="who">
        <div className="who-inner">
          <span className="avatar" aria-hidden="true">
            {(r.name || r.email).trim().charAt(0).toUpperCase()}
          </span>
          <div className="who-text">
            <div className="who-name">{r.name || '—'}</div>
            <div className="who-email">{r.email}</div>
          </div>
        </div>
      </td>
      <td className="message">
        <div className="msg-subject">
          <span className="clamp1">{r.subject}</span>
          {r.source === 'template' && <span className="tag">template</span>}
        </div>
        <div className="msg-preview clamp1">{r.bodyPreview}</div>
      </td>
      <td className={`loc ${r.location ? '' : 'none'}`}>{r.location || <span className="muted">—</span>}</td>
      <td className="status">
        <StatusPills row={r} />
        {r.last_error && (
          <div className="status-error clamp1" title={r.last_error}>
            {r.last_error}
          </div>
        )}
      </td>
      <td className="sent">{r.sent_at ? formatTime(r.sent_at) : <span className="muted">—</span>}</td>
    </tr>
  );
}
