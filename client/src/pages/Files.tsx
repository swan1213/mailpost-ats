import { useState } from 'react';
import { api } from '../api';
import { formatTime, plural } from '../format';
import { Icon } from '../Icon';
import type { Ctx } from '../shell';

/** Uploaded CSV files: add one, see each file's progress, open or send a single file. */
export function FilesPage({ ctx }: { ctx: Ctx }) {
  const { uploads, busy, run, navigate } = ctx;
  const [over, setOver] = useState(false);

  const rescan = () =>
    run(async () => {
      const r = await api.reimport();
      if (!r.files) return `No CSV files in ${r.folder}.`;
      const errors = r.errors.map((e) => `${e.filename}: ${e.error}`).join('; ');
      if (errors && !r.added && !r.updated) throw new Error(errors);
      return `Rescanned ${plural(r.files, 'file')}: ${r.added} new, ${r.updated} updated, ${r.removed} removed.${errors ? ` Problems: ${errors}` : ''}`;
    });

  return (
    <div className="page">
      <button
        className={`dropzone ${over ? 'over' : ''}`}
        disabled={busy}
        onClick={ctx.pickFile}
        onDragEnter={() => setOver(true)}
        onDragLeave={() => setOver(false)}
        onDrop={() => setOver(false)}
      >
        <span className="dropzone-icon">
          <Icon name="upload" size={22} />
        </span>
        <span className="dropzone-text">
          <strong>Drop a CSV here, or click to choose one</strong>
          <span>
            Needs an <code>email</code> column; <code>name</code>, <code>location</code>, <code>subject</code> and{' '}
            <code>content</code> are optional. Re-uploading a file with the same name updates it. Nothing is sent until you
            start sending.
          </span>
        </span>
      </button>

      <section className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Files</h2>
            <p className="card-sub">{plural(uploads.length, 'file')} · newest first</p>
          </div>
          <button className="btn ghost" disabled={busy} onClick={rescan} title="Re-read every CSV in the server's CSV folder">
            <Icon name="refresh" />
            Rescan folder
          </button>
        </div>

        {uploads.length ? (
          <div className="table-wrap">
            <table className="files-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th className="right">Recipients</th>
                  <th>Sent</th>
                  <th className="right">Delivered</th>
                  <th className="right">Not emailed</th>
                  <th className="right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((u) => {
                  const pct = u.total ? (u.sent / u.total) * 100 : 0;
                  return (
                    <tr key={u.id}>
                      <td className="file-name">
                        <span className="file-icon">
                          <Icon name="file" />
                        </span>
                        <span className="file-text">
                          <strong className="clamp1">{u.filename}</strong>
                          <span className="muted small">Uploaded {formatTime(u.uploaded_at)}</span>
                        </span>
                      </td>
                      <td className="right num-cell" data-label="Recipients">
                        {u.total.toLocaleString()}
                      </td>
                      <td className="file-progress" data-label="Sent">
                        <span className="progress thin">
                          <span className="progress-fill" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="small">
                          {u.sent.toLocaleString()} <span className="muted">· {Math.round(pct)}%</span>
                        </span>
                      </td>
                      <td className="right num-cell" data-label="Delivered">
                        {u.delivered.toLocaleString()}
                      </td>
                      <td className="right num-cell" data-label="Not emailed">
                        {u.unsent.toLocaleString()}
                      </td>
                      <td className="right file-actions">
                        <button className="btn small" onClick={() => navigate('recipients', { file: String(u.id) })}>
                          View
                        </button>
                        <button className="btn small primary" disabled={busy || !u.unsent} onClick={() => ctx.openStart(u.id)}>
                          <Icon name="send" size={14} />
                          Send
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-note">No files yet. Upload a CSV to get started.</p>
        )}
      </section>
    </div>
  );
}
