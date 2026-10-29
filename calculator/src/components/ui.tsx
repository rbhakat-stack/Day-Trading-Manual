import { useId, useState, type ReactNode } from 'react';
import type { Tone } from '../engine/tradeCalculator';

export function Panel({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-ink-700 bg-ink-850 ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-describedby={id}
        aria-label="Explain"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-ink-500 text-[9px] font-bold text-ink-300 hover:border-ink-300 hover:text-ink-100"
      >
        i
      </button>
      <span
        id={id}
        role="tooltip"
        className={`${open ? 'block' : 'hidden'} absolute left-1/2 top-5 z-50 w-64 -translate-x-1/2 rounded-lg border border-ink-600 bg-ink-950 p-2.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-ink-200 shadow-xl`}
      >
        {text}
      </span>
    </span>
  );
}

export function Label({ children, tip, htmlFor }: { children: ReactNode; tip?: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 flex items-center text-[11px] font-medium uppercase tracking-wider text-ink-300">
      {children}
      {tip && <InfoTip text={tip} />}
    </label>
  );
}

export function NumberField({
  id, label, tip, value, onChange, prefix, suffix, error, placeholder, step = 'any', inputMode = 'decimal', disabled = false,
}: {
  id: string; label: string; tip?: string; value: string; onChange: (v: string) => void; prefix?: string; suffix?: string;
  error?: string; placeholder?: string; step?: string; inputMode?: 'decimal' | 'numeric'; disabled?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id} tip={tip}>{label}</Label>
      <div className={`flex items-center rounded-lg border bg-ink-900 px-2.5 focus-within:border-[#5b8cff] ${error ? 'border-short' : 'border-ink-600'} ${disabled ? 'opacity-50' : ''}`}>
        {prefix && <span className="num mr-1 text-sm text-ink-400">{prefix}</span>}
        <input
          id={id}
          type="text"
          inputMode={inputMode}
          autoComplete="off"
          step={step}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="num w-full bg-transparent py-2 text-[15px] text-ink-100 outline-none placeholder:text-ink-500"
          aria-invalid={!!error}
        />
        {suffix && <span className="num ml-1 text-sm text-ink-400">{suffix}</span>}
      </div>
      {error && <p className="mt-1 text-xs text-short">{error}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, size = 'md',
}: {
  value: T; options: { value: T; label: string; tone?: 'long' | 'short' | 'neutral' }[]; onChange: (v: T) => void; size?: 'md' | 'lg';
}) {
  return (
    <div className="grid gap-1.5 rounded-lg bg-ink-900 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const active = o.value === value;
        const tone =
          o.tone === 'long'
            ? active ? 'bg-long text-ink-950' : 'text-long hover:bg-long-dim'
            : o.tone === 'short'
              ? active ? 'bg-short text-ink-950' : 'text-short hover:bg-short-dim'
              : active ? 'bg-ink-600 text-ink-100' : 'text-ink-300 hover:bg-ink-700';
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`rounded-md font-semibold tracking-wide transition ${size === 'lg' ? 'py-2.5 text-base' : 'py-1.5 text-sm'} ${tone}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Stat({ label, value, tip, tone, big, sub }: { label: string; value: ReactNode; tip?: string; tone?: Tone; big?: boolean; sub?: ReactNode }) {
  const color =
    tone === 'long' ? 'text-long' : tone === 'short' || tone === 'danger' ? 'text-short' : tone === 'warn' ? 'text-warn' : 'text-ink-100';
  return (
    <div className="min-w-0">
      <div className="flex items-center text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {label}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className={`num truncate ${big ? 'text-2xl font-semibold' : 'text-[15px]'} ${color}`}>{value}</div>
      {sub && <div className="text-xs text-ink-400">{sub}</div>}
    </div>
  );
}

export function Row({ label, value, tip, tone, strong }: { label: string; value: ReactNode; tip?: string; tone?: Tone; strong?: boolean }) {
  const color =
    tone === 'long' ? 'text-long' : tone === 'short' || tone === 'danger' ? 'text-short' : tone === 'warn' ? 'text-warn' : 'text-ink-100';
  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-700/60 py-1.5 last:border-0">
      <span className="flex items-center text-sm text-ink-300">
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <span className={`num text-sm ${strong ? 'font-semibold' : ''} ${color}`}>{value}</span>
    </div>
  );
}

export const toneClasses: Record<Tone, { card: string; text: string; badge: string }> = {
  long: { card: 'border-long/60 bg-long-dim/50', text: 'text-long', badge: 'bg-long text-ink-950' },
  short: { card: 'border-short/60 bg-short-dim/50', text: 'text-short', badge: 'bg-short text-ink-950' },
  warn: { card: 'border-warn/60 bg-warn-dim/50', text: 'text-warn', badge: 'bg-warn text-ink-950' },
  danger: { card: 'border-short/70 bg-short-dim/60', text: 'text-short', badge: 'bg-short text-ink-950' },
  neutral: { card: 'border-ink-600 bg-ink-800', text: 'text-ink-200', badge: 'bg-ink-600 text-ink-100' },
};
