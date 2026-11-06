import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

/**
 * Small "i" help icon for a field heading. Opens on hover, keyboard focus or click / tap (click pins it open for
 * touch); Escape, focus loss, any scroll or a second click closes it. The panel is position:fixed next to the icon so a scrolling table
 * never clips it, and it is clamped inside the viewport. Presentation only.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const open = hover || pinned;
  useEffect(() => {
    if (!open || !btn.current) return;
    const b = btn.current.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(b.left + b.width / 2 - w / 2, window.innerWidth - w - 8));
    // Open on the side with more room; never extend past the viewport (long help scrolls inside the panel).
    const roomBelow = window.innerHeight - b.bottom - 14;
    const roomAbove = b.top - 14;
    const down = roomBelow >= 260 || roomBelow >= roomAbove;
    setPos({ position: 'fixed', left, width: w, zIndex: 60, overflowY: 'auto', maxHeight: Math.max(120, down ? roomBelow : roomAbove), ...(down ? { top: b.bottom + 6 } : { bottom: window.innerHeight - b.top + 6 }) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => { setHover(false); setPinned(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // The panel is fixed to where the icon was: any scroll (page or table) closes it rather than detaching it.
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('keydown', esc); window.removeEventListener('scroll', close, true); };
  }, [open]);
  return (
    <span className="relative inline-block align-middle" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        ref={btn}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => { e.stopPropagation(); setPinned((p) => !p); }}
        onFocus={() => setHover(true)}
        onBlur={() => { setHover(false); setPinned(false); }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center text-ink-300 hover:text-white"
      >
        {/* Text-free icon: the field's own text (read by the panel tests and by screen readers) is unchanged. */}
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="8" cy="4.9" r="1" fill="currentColor" />
          <rect x="7.25" y="6.9" width="1.5" height="4.8" rx="0.6" fill="currentColor" />
        </svg>
      </button>
      {open && pos && (
        <span id={id} role="tooltip" style={pos} className="block whitespace-pre-line rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-left text-[11.5px] font-normal normal-case leading-snug tracking-normal text-ink-200 shadow-lg">
          <b className="mb-1 block text-[12px] text-ink-100">{label}</b>
          {text}
        </span>
      )}
    </span>
  );
}
