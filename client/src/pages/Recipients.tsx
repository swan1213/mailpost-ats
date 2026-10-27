import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Filter, type Page, type Row, type StatusFilter } from '../api';
import { delayRange, estimateDuration, formatTime, plural } from '../format';
import { Icon } from '../Icon';
import { MessageDrawer } from '../MessageDrawer';
import { describeQueued, routeHash, type Ctx } from '../shell';
import { StatusPills } from '../StatusPills';

const STATUS_TABS: { value: StatusFilter; label: string; hint: string; hideWhenEmpty?: boolean }[] = [
  { value: 'all', label: 'All', hint: 'Every recipient' },
  { value: 'unsent', label: 'Not emailed', hint: 'Not emailed yet, ready to send' },
  { value: 'queued', label: 'Queued', hint: 'Waiting in the send queue' },
  { value: 'sent', label: 'Sent', hint: 'Accepted by Mailgun (includes delivered and bounced)' },
  { value: 'delivered', label: 'Delivered', hint: 'Reached the inbox server' },
  { value: 'opened', label: 'Opened', hint: 'Opened at least once' },
  { value: 'failed', label: 'Failed', hint: 'Bounced, or could not be sent after all tries' },
  { value: 'duplicate', label: 'Already emailed', hint: 'Same address was emailed from another file', hideWhenEmpty: true },
  { value: 'skipped', label: 'Invalid', hint: 'Bad CSV row, e.g. an invalid email address', hideWhenEmpty: true },
];

const PAGE_SIZES = [50, 100, 200, 500];

function filterFromParams(params: URLSearchParams): Filter {
  const status = params.get('status') as StatusFilter;
  return {
    q: params.get('q') ?? '',
    status: STATUS_TABS.some((t) => t.value === status) ? status : 'all',
    uploadId: Number(params.get('file')) || null,
  };
}

export function RecipientsPage({ ctx }: { ctx: Ctx }) {
  const { state, uploads, busy, run, toast, confirm } = ctx;
  const [initial] = useState(() => filterFromParams(ctx.params));
  const [search, setSearch] = useState(initial.q);
  const [filter, setFilter] = useState<Filter>(initial);
  const [page, setPage] = useState<Page | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** "Select all matching": how many unsent rows it covers; null when off */
  const [allMatching, setAllMatching] = useState<number | null>(null);
  const [openRow, setOpenRow] = useState<Row | null>(null);
  const pendingOpen = useRef(Number(ctx.params.get('open')) || null);
  const loadSeq = useRef(0);
  const first = useRef(true);

  // Search waits until typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A different filter means a different list: back to page 1, nothing selected. The URL follows the filter.
  useEffect(() => {
    const params: Record<string, string> = {};
    if (filter.status !== 'all') params.status = filter.status;
    if (filter.uploadId) params.file = String(filter.uploadId);
    if (filter.q) params.q = filter.q;
    window.history.replaceState(null, '', routeHash('recipients', params));
    if (first.current) {
      first.current = false;
      return;
    }
    setPageNo(1);
    setSelected(new Set());
    setAllMatching(null);
  }, [filter]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const p = await api.messages(filter, pageNo, pageSize);
      if (seq !== loadSeq.current) return;
      setPage(p);
      setLoadError(null);
      // Opened from Overview's activity list: show that recipient's details once.
      if (pendingOpen.current) {
        const row = p.rows.find((r) => r.id === pendingOpen.current);
        pendingOpen.current = null;
        if (row) setOpenRow(row);
      }
    } catch (err) {
      if (seq === loadSeq.current) setLoadError((err as Error).message);
    }
  }, [filter, pageNo, pageSize]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // Keep the open side panel in step with the table's refreshes.
  useEffect(() => {
    if (!page) return;
    setOpenRow((open) => (open && page.rows.find((r) => r.id === open.id)) || open);
  }, [page]);

  const closeDrawer = useCallback(() => setOpenRow(null), []);

  // After an action, reload the table too (the shell reloads totals).
  const act = (action: () => Promise<string>) =>
    run(action).then(() => {
      void load();
    });

  if (!page) {
    return (
      <div className="page">
        <div className="card">
          <div className="chart-loading">{loadError ? <span className="error-text">{loadError}</span> : <><span className="spinner" /> Loading recipients…</>}</div>
        </div>
      </div>
    );
  }

  const { settings } = state;
  const inFlight = state.counts.queued > 0 || state.engine.sending;
  const pageUnsent = page.rows.filter((r) => r.unsent);
  const pageAllSelected = pageUnsent.length > 0 && pageUnsent.every((r) => allMatching !== null || selected.has(r.id));
  const pageSomeSelected = !pageAllSelected && pageUnsent.some((r) => selected.has(r.id));
  const selectionCount = allMatching ?? selected.size;
  const currentFile = uploads.find((u) => u.id === filter.uploadId);
  const tab = STATUS_TABS.find((t) => t.value === filter.status) ?? STATUS_TABS[0];
  const setTab = (status: StatusFilter) => setFilter((f) => (f.status === status ? f : { ...f, status }));

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

  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(null);
  };

  const sendSelection = async () => {
    const scope = allMatching !== null ? `Everyone not emailed yet in "${tab.label}"${currentFile ? ` in ${currentFile.filename}` : ''}` : 'The selected recipients';
    if (!(await confirmSend(selectionCount, scope))) return;
    await act(async () => {
      const r = allMatching !== null ? await api.sendFilter(filter) : await api.sendIds([...selected]);
      clearSelection();
      return describeQueued('Sending started', r);
    });
  };

  const sendOne = async (row: Row) => {
    if (!(await confirmSend(1, `${row.name ? `${row.name} ` : ''}<${row.email}>`))) return;
    await act(async () => describeQueued('Queued', await api.sendIds([row.id])));
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

  const firstRow = page.total ? (page.page - 1) * page.pageSize + 1 : 0;
  const lastRow = Math.min(page.total, page.page * page.pageSize);

  return (
    <div className="page">
      <section className="card table-card" aria-label="Recipients">
        <div className="toolbar">
          <label className="search">
            <Icon name="search" />
            <input type="search" placeholder="Search name, email, location or subject" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="select">
            <select
              aria-label="File"
              value={filter.uploadId ?? ''}
              onChange={(e) => setFilter((f) => ({ ...f, uploadId: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">All files</option>
              {uploads.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.filename} · {u.sent.toLocaleString()}/{u.total.toLocaleString()} sent
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} />
          </div>
          <div className="toolbar-actions">
            <button
              className="icon-btn"
              disabled={busy}
              title="Fetch the latest delivery and open events from Mailgun now"
              aria-label="Sync with Mailgun"
              onClick={() => act(async () => `Synced with Mailgun · ${plural((await api.pollEvents()).applied, 'new event')}.`)}
            >
              <Icon name="refresh" />
            </button>
            <button className="btn primary" disabled={busy} onClick={ctx.pickFile}>
              <Icon name="upload" />
              <span>Upload CSV</span>
            </button>
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
              {allMatching !== null ? `All ${plural(allMatching, 'unsent recipient')} in this view selected` : `${plural(selected.size, 'recipient')} selected`}
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
                <th className="col-loc">Location</th>
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
                      <strong>{uploads.length ? `No ${tab.value === 'all' ? '' : `"${tab.label}" `}recipients here` : 'No CSV yet'}</strong>
                      <span className="muted">
                        {uploads.length ? (filter.q ? 'Try a different search.' : tab.hint) : 'Upload a CSV with an "email" column, or drop the file anywhere on this page.'}
                      </span>
                      {!uploads.length && (
                        <button className="btn primary" onClick={ctx.pickFile}>
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
            {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {page.total.toLocaleString()}
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

      {openRow && (
        <MessageDrawer
          row={openRow}
          filename={uploads.find((u) => u.id === openRow.upload_id)?.filename}
          testEmail={settings.testEmail}
          busy={busy}
          run={act}
          onSendNow={sendOne}
          onClose={closeDrawer}
        />
      )}
    </div>
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
    <tr className={`row ${active ? 'active' : ''} ${checked ? 'checked' : ''}`} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()} tabIndex={0}>
      <td className="check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Select ${r.email}`} checked={checked} disabled={!r.unsent} title={r.unsent ? undefined : lockedReason} onChange={onCheck} />
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
