/**
 * America/New_York time helpers for the automated alert path.
 *
 * All RB v1 time rules use Eastern Time. These helpers never use the browser's or the server's local
 * timezone; Intl handles daylight saving. Internally every instant is an epoch-ms number / ISO string.
 */

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface EtParts {
  /** YYYY-MM-DD (ET) */
  date: string;
  /** HH:MM (ET, 24h) */
  hhmm: string;
  /** HH:MM:SS (ET, 24h) */
  hhmmss: string;
  /** Minutes since ET midnight, fractional (seconds included). */
  minuteOfDay: number;
  /** ISO weekday 1 = Monday … 7 = Sunday */
  weekday: number;
}

export function etParts(epochMs: number): EtParts {
  const p = Object.fromEntries(FMT.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const h = Number(p.hour);
  const m = Number(p.minute);
  const s = Number(p.second);
  const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return {
    date,
    hhmm: `${p.hour}:${p.minute}`,
    hhmmss: `${p.hour}:${p.minute}:${p.second}`,
    minuteOfDay: h * 60 + m + s / 60,
    weekday,
  };
}

/** UTC offset of America/New_York at an instant, in minutes (EDT −240, EST −300). */
function etOffsetMinutes(epochMs: number): number {
  const p = etParts(epochMs);
  const [y, mo, d] = p.date.split('-').map(Number);
  const [h, mi, s] = p.hhmmss.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

/** Epoch ms of an ET wall-clock time (YYYY-MM-DD + HH:MM[:SS]). DST-correct for regular-session hours. */
export function etToEpoch(date: string, hhmm: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s = 0] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes resolve the offset around DST changes (never at 09:30–16:00, but keep it exact anyway).
  let t = guess - etOffsetMinutes(guess) * 60000;
  t = guess - etOffsetMinutes(t) * 60000;
  return t;
}

/** Parse an ISO-8601 timestamp that carries an explicit offset or Z. Naive timestamps are rejected (ambiguous). */
export function parseIsoWithZone(s: string): number | null {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export const fmtEt = (epochMs: number) => `${etParts(epochMs).hhmmss} ET`;

/** mm:ss for durations (negative → 00:00). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
