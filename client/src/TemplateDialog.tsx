import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppState } from './api';
import { Icon } from './Icon';

interface Props {
  state: AppState;
  run: (action: () => Promise<string>) => Promise<void>;
  onClose: () => void;
}

const PLACEHOLDERS = ['{name}', '{email}', '{location}'];

/** Template used for rows with an empty subject, plus the test address. The delay lives in the Sending panel. */
export function TemplateDialog({ state, run, onClose }: Props) {
  const saved = state.settings;
  const [subject, setSubject] = useState(saved.templateSubject);
  const [body, setBody] = useState(saved.templateBody);
  const [testEmail, setTestEmail] = useState(saved.testEmail);
  const [working, setWorking] = useState<'save' | 'test' | null>(null);
  // Shown inside the dialog: the page's own notices sit behind the overlay.
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<'subject' | 'body'>('body');

  const dirty = subject !== saved.templateSubject || body !== saved.templateBody || testEmail !== saved.testEmail;

  /** Closing never silently throws away edits. */
  const requestClose = useCallback(() => {
    if (!dirty || window.confirm('Discard your unsaved changes to the template?')) onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && requestClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  /** Puts a placeholder at the cursor of the subject or message, whichever was used last. */
  const insert = (token: string) => {
    const el = lastField.current === 'subject' ? subjectRef.current : bodyRef.current;
    const value = lastField.current === 'subject' ? subject : body;
    const set = lastField.current === 'subject' ? setSubject : setBody;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const saveSettings = () => api.saveSettings({ templateSubject: subject, templateBody: body, testEmail });

  const save = async () => {
    setWorking('save');
    await run(async () => {
      await saveSettings();
      onClose();
      return 'Template saved. It applies to emails not sent yet.';
    });
    setWorking(null);
  };

  const sendTest = async () => {
    setWorking('test');
    setStatus(null);
    try {
      await saveSettings(); // test exactly what is on screen
      const r = await api.sendTemplateTest();
      setStatus({
        kind: 'ok',
        text: `Saved, and a test email (filled in for ${r.filledFor}) was sent to ${r.to}. It usually arrives within a minute; check Spam/Promotions if not.`,
      });
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="overlay" onMouseDown={requestClose}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-label="Template and test" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Template &amp; test</h2>
          <button className="icon-btn" aria-label="Close" onClick={requestClose}>
            <Icon name="x" />
          </button>
        </div>
        <p className="muted small">
          Recipients whose CSV row has an <strong>empty subject</strong> get this email. Rows with their own subject and
          content are sent as written.
        </p>
        <label className="field">
          <span>Subject</span>
          <input ref={subjectRef} value={subject} onFocus={() => (lastField.current = 'subject')} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="field">
          <span>Message</span>
          <textarea
            ref={bodyRef}
            rows={12}
            value={body}
            onFocus={() => (lastField.current = 'body')}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <div className="placeholders">
          <span className="muted small">Insert:</span>
          {PLACEHOLDERS.map((p) => (
            <button key={p} type="button" className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p)}>
              {p}
            </button>
          ))}
          <span className="muted small">filled in per recipient · a link on its own line becomes a button</span>
        </div>
        <label className="field">
          <span>Test emails go to</span>
          <input type="email" placeholder="you@company.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
        </label>
        <p className="dialog-note">
          Sender {state.limits.from} · {state.limits.maxAttempts} tries per email · daily limit {state.limits.dailyLimit || 'none'}{' '}
          (set in .env)
        </p>
        {status && (
          <div className={`callout ${status.kind === 'ok' ? 'ok' : 'error'}`}>
            <Icon name={status.kind === 'ok' ? 'checkCircle' : 'alert'} />
            <span>{status.text}</span>
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn" disabled={!!working || !testEmail.trim()} onClick={sendTest} title="Saves, then sends this template to the test address">
            <Icon name="mail" />
            {working === 'test' ? 'Sending…' : 'Save & send test'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={requestClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!working || !dirty} onClick={save}>
            {working === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
