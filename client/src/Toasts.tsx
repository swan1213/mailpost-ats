import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}

export type PushToast = (kind: Toast['kind'], text: string) => void;

/** Notifications in the corner, visible wherever the page is scrolled. Successes fade; errors stay until closed. */
export function useToasts(): [Toast[], PushToast, (id: number) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback<PushToast>((kind, text) => {
    // Keep the last few; an identical message replaces the old one instead of stacking.
    setToasts((all) => [...all.filter((t) => t.text !== text).slice(-3), { id: nextId.current++, kind, text }]);
  }, []);
  return [toasts, push, dismiss];
}

export function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.kind !== 'ok') return;
    const t = setTimeout(() => dismiss(toast.id), 6000);
    return () => clearTimeout(t);
  }, [toast, dismiss]);

  return (
    <div className={`toast ${toast.kind}`}>
      <Icon name={toast.kind === 'ok' ? 'checkCircle' : 'alert'} />
      <span className="toast-text">{toast.text}</span>
      <button className="icon-btn small" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
