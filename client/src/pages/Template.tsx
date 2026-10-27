import { useEffect, useRef, useState } from 'react';
import { api, type TemplatePreview } from '../api';
import { plural } from '../format';
import { Icon } from '../Icon';
import type { Ctx } from '../shell';

const PLACEHOLDERS = [
  { token: '{name}', label: 'Name' },
  { token: '{email}', label: 'Email' },
  { token: '{location}', label: 'Location' },
];

/** The email sent to rows whose CSV has no subject, edited next to a live preview, plus the test address. */
export function TemplatePage({ ctx }: { ctx: Ctx }) {
  const saved = ctx.state.settings;
  const [subject, setSubject] = useState(saved.templateSubject);
  const [body, setBody] = useState(saved.templateBody);
  const [testEmail, setTestEmail] = useState(saved.testEmail);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [working, setWorking] = useState<'save' | 'test' | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<'subject' | 'body'>('body');

  const dirty = subject !== saved.templateSubject || body !== saved.templateBody || testEmail !== saved.testEmail;
  const { setLeaveGuard } = ctx;

  useEffect(() => {
    setLeaveGuard(dirty ? 'You have unsaved changes to the template. Leave without saving?' : null);
  }, [dirty, setLeaveGuard]);
  useEffect(() => () => setLeaveGuard(null), [setLeaveGuard]);

  // Re-render the preview shortly after typing stops.
  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      api
        .templatePreview(subject, body)
        .then((p) => {
          if (!current) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err: Error) => current && setPreviewError(err.message));
    }, 350);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [subject, body]);

  /** Puts a placeholder at the cursor of the subject or message, whichever was used last. */
  const insert = (token: string) => {
    const isSubject = lastField.current === 'subject';
    const el = isSubject ? subjectRef.current : bodyRef.current;
    const value = isSubject ? subject : body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    (isSubject ? setSubject : setBody)(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const saveSettings = () => api.saveSettings({ templateSubject: subject, templateBody: body, testEmail });

  const onSave = async () => {
    setWorking('save');
    await ctx.run(async () => {
      await saveSettings();
      return 'Template saved. It applies to every email not sent yet.';
    });
    setWorking(null);
  };

  const onTest = async () => {
    setWorking('test');
    await ctx.run(async () => {
      await saveSettings(); // test exactly what is on screen
      const r = await api.sendTemplateTest();
      return `Saved, and a test filled in for ${r.filledFor} was sent to ${r.to}. Check Spam/Promotions if it doesn't arrive within a minute.`;
    });
    setWorking(null);
  };

  const discard = () => {
    setSubject(saved.templateSubject);
    setBody(saved.templateBody);
    setTestEmail(saved.testEmail);
  };

  return (
    <div className="page">
      <div className="page-intro">
        <p>
          Recipients whose CSV row has <strong>no subject</strong> get this email
          {preview && (
            <>
              {' '}
              — {plural(preview.recipients, 'recipient')}, {preview.unsent.toLocaleString()} not emailed yet
            </>
          )}
          . Rows with their own subject and content are sent as written.
        </p>
        <div className="page-intro-actions">
          {dirty && (
            <>
              <span className="unsaved">
                <i className="dot" /> Unsaved changes
              </span>
              <button className="btn ghost" disabled={!!working} onClick={discard}>
                Discard
              </button>
            </>
          )}
          <button className="btn primary" disabled={!!working || !dirty} onClick={onSave}>
            <Icon name="check" />
            {working === 'save' ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>

      <div className="editor-split">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Message</h2>
                <p className="card-sub">A link on its own line becomes a button; "Best regards," starts the signature.</p>
              </div>
            </div>
            <div className="card-body">
              <label className="field">
                <span>Subject</span>
                <input ref={subjectRef} value={subject} onFocus={() => (lastField.current = 'subject')} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <label className="field">
                <span>Message</span>
                <textarea ref={bodyRef} className="editor" rows={18} value={body} onFocus={() => (lastField.current = 'body')} onChange={(e) => setBody(e.target.value)} />
              </label>
              <div className="placeholders">
                <span className="muted small">Insert at cursor:</span>
                {PLACEHOLDERS.map((p) => (
                  <button key={p.token} type="button" className="chip" title={`Replaced with each recipient's ${p.label.toLowerCase()}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.token)}>
                    {p.token}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Send yourself a test</h2>
                <p className="card-sub">Saves first, then sends exactly what the preview shows.</p>
              </div>
            </div>
            <div className="card-body test-row">
              <label className="field grow">
                <span>Test address</span>
                <input type="email" placeholder="you@company.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
              </label>
              <button className="btn" disabled={!!working || !testEmail.trim()} onClick={onTest}>
                <Icon name="mail" />
                {working === 'test' ? 'Sending…' : 'Save & send test'}
              </button>
            </div>
          </section>
        </div>

        <section className="card preview-card" aria-label="Preview">
          <div className="card-head">
            <div>
              <h2 className="card-title">Preview</h2>
              <p className="card-sub">{preview ? `Filled in for ${preview.filledFor}` : 'Rendering…'}</p>
            </div>
          </div>
          <div className="inbox-line">
            <span className="muted">Subject</span>
            <strong>{preview?.subject ?? subject}</strong>
          </div>
          {previewError ? (
            <p className="error-text small card-body">{previewError}</p>
          ) : (
            <iframe className="preview-frame" title="Email preview" sandbox="" srcDoc={preview?.html ?? ''} />
          )}
        </section>
      </div>
    </div>
  );
}
