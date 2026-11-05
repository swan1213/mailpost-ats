import type { Row, Status } from './api';

const STATUS_LABEL: Record<Status, string> = {
  new: 'Not emailed',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  skipped: 'Skipped',
};

export function StatusPills({ row }: { row: Row }) {
  // A bounce after SES accepted it is "Bounced"; a failure before that can still be sent again.
  const label = row.status === 'failed' && row.sent_at ? 'Bounced' : STATUS_LABEL[row.status];
  return (
    <div className="pills">
      {row.duplicate ? <span className="pill skipped">Already emailed</span> : <span className={`pill ${row.status}`}>{label}</span>}
      {row.opened_at && <span className="pill opened">Opened</span>}
      {row.spam && <span className="pill complained">Reported spam</span>}
    </div>
  );
}
