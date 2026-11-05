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

const STYLES = [
  { value: 'plain', label: 'Plain', hint: 'Reads like a personal note. Best for reaching the inbox.' },
  { value: 'branded', label: 'Branded', hint: 'ATS Group header, button and footer.' },
] as const;

/** The email sent to rows whose CSV has no subject, edited next to a live preview, plus the test address. */
export function TemplatePage({ ctx }: { ctx: Ctx }) {
  const saved = ctx.state.settings;
  const [subject, setSubject] = useState(saved.templateSubject);
  const [body, setBody] = useState(saved.templateBody);
  const [testEmail, setTestEmail] = useState(saved.testEmail);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [working, setWorking] = useState<'save' | 'test' | null>(null);
  const style = saved.emailStyle;
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
        .templatePreview(subject, body, style)
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
  }, [subject, body, style]);

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

  // The editor grows with the message, so the whole email is visible without scrolling inside it.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [body]);

  const saveSettings = () => api.saveSettings({ templateSubject: subject, templateBody: body, testEmail });

  const onSave = async () => {
    setWorking('save');
    await ctx.run(async () => {
      await saveSettings();
      return "Template saved. Every email that hasn't gone out yet will use it.";
    });
    setWorking(null);
  };

  const onTest = async () => {
    setWorking('test');
    await ctx.run(async () => {
      await saveSettings(); // test exactly what is on screen
      const r = await api.sendTemplateTest();
      return `Saved, and a test made out to ${r.filledFor} is on its way to ${r.to}. If it isn't there in a minute, check Spam or Promotions.`;
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
          This is the email for anyone whose CSV row has <strong>no subject of its own</strong>
          {preview && (
            <>
              {' '}
              ({plural(preview.recipients, 'person')}, {preview.unsent.toLocaleString()} not emailed yet)
            </>
          )}
          . Rows that come with their own subject and message are sent exactly as written.
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
                <p className="card-sub">
                  {style === 'branded'
                    ? 'A link on a line of its own becomes a button, and "Best regards," starts the signature.'
                    : 'Sent just as you type it. Links stay as ordinary links.'}
                </p>
              </div>
            </div>
            <div className="card-body">
              <label className="field">
                <span>Subject</span>
                <input ref={subjectRef} value={subject} onFocus={() => (lastField.current = 'subject')} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <label className="field">
                <span>Message</span>
                <textarea ref={bodyRef} className="editor" rows={14} value={body} onFocus={() => (lastField.current = 'body')} onChange={(e) => setBody(e.target.value)} />
              </label>
              <div className="placeholders">
                <span className="muted small">Insert:</span>
                {PLACEHOLDERS.map((p) => (
                  <button key={p.token} type="button" className="chip" title={
                      p.token === '{name}'
                        ? 'Replaced with each recipient\'s name. With no name, "Hi {name}," becomes "Hi,"'
                        : `Replaced with each recipient's ${p.label.toLowerCase()}`
                    } onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.token)}>
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
                <p className="card-sub">Saves your changes, then sends exactly what the preview shows.</p>
              </div>
            </div>
            <div className="card-body test-row">
              <label className="field grow">
                <span>Send it to</span>
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
              <p className="card-sub">{preview ? `As ${preview.filledFor} would see it` : 'Loading…'}</p>
            </div>
          </div>
          <div className="style-switch" role="radiogroup" aria-label="Email style">
            {STYLES.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={style === o.value}
                className={`style-option ${style === o.value ? 'active' : ''}`}
                disabled={ctx.busy}
                onClick={() =>
                  style !== o.value && ctx.run(async () => (await api.saveSettings({ emailStyle: o.value }), `Email style: ${o.label}. Applies to every email not sent yet.`))
                }
              >
                <strong>{o.label}</strong>
                <span>{o.hint}</span>
              </button>
            ))}
          </div>
          <div className="inbox-line">
            <span className="muted">Subject</span>
            <strong>{preview?.subject ?? subject}</strong>
          </div>
          {previewError ? (
            <p className="error-text small card-body">{previewError}</p>
          ) : (
            <iframe
              className="preview-frame"
              title="Email preview"
              // Same-origin (scripts stay blocked) so the frame can be sized to the email instead of scrolling inside.
              sandbox="allow-same-origin"
              srcDoc={preview?.html ?? ''}
              onLoad={(e) => {
                const frame = e.currentTarget;
                const doc = frame.contentDocument;
                if (doc) frame.style.height = `${Math.max(320, doc.documentElement.scrollHeight)}px`;
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}
