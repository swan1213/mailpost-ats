import { useEffect, useRef, useState } from 'react';
import { api, type Settings } from './api';
import { delayRange } from './format';

/** Base delay + random extra between emails. Saved when a field loses focus; applies from the next email. */
export function DelayControl({ settings, run }: { settings: Settings; run: (action: () => Promise<string>) => Promise<void> }) {
  const [base, setBase] = useState(String(settings.delaySeconds));
  const [max, setMax] = useState(String(settings.delayRandomMax));
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
    setBase(String(settings.delaySeconds));
    setMax(String(settings.delayRandomMax));
  }, [settings.delaySeconds, settings.delayRandomMax]);

  const reset = () => {
    setBase(String(settings.delaySeconds));
    setMax(String(settings.delayRandomMax));
  };

  const commit = () => {
    editing.current = false;
    const s = Number(base);
    const m = Number(max);
    if (s === settings.delaySeconds && m === settings.delayRandomMax) return;
    // An emptied field reads as Number('') = 0, which would silently remove the delay between emails.
    if (!base.trim() || !max.trim()) return reset();
    void run(async () => {
      try {
        await api.saveSettings({ delaySeconds: s, delayRandomMax: m });
      } catch (err) {
        reset();
        throw err;
      }
      return `Pace saved: ${delayRange(s, m)}.`;
    });
  };

  const field = (id: string, label: string, hint: string, value: string, set: (v: string) => void) => (
    <label className="pace-field" htmlFor={id}>
      <span className="pace-label">{label}</span>
      <span className="input-suffix">
        <input
          id={id}
          className="num"
          type="number"
          min={0}
          max={3600}
          value={value}
          onFocus={() => (editing.current = true)}
          onChange={(e) => set(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              reset();
              editing.current = false;
            }
          }}
        />
        <span>sec</span>
      </span>
      <span className="pace-hint">{hint}</span>
    </label>
  );

  return (
    <div className="pace-fields">
      {field('delay-base', 'Base delay', 'Always waited between two emails', base, setBase)}
      {field('delay-random', 'Random extra', 'Up to this many seconds added, so the timing looks human', max, setMax)}
    </div>
  );
}
