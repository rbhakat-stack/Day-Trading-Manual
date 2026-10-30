/**
 * NYSE regular-session calendar used by the automated alert path.
 *
 * Fail-closed: a date outside the years listed here is reported as UNKNOWN and the automated path refuses to
 * issue a trade ticket ("market calendar unavailable"). Extend the table each year from the official NYSE
 * holiday page (https://www.nyse.com/markets/hours-calendars) and record the change in the manual's Change Log.
 *
 * Early-close days (13:00 ET close): the RB v1.1 entry window (09:45 to before 15:30) was defined for a full
 * session and is not defined for a 13:00 close, so the automated path flags EVERY alert on an early-close day
 * for manual review instead of guessing a shortened window. The manual calculator is unaffected.
 */

export const CALENDAR_YEARS = [2026, 2027];

/** Full-day market holidays (NYSE). VERIFY each year against the official list. */
export const HOLIDAYS: Record<string, string> = {
  '2026-01-01': "New Year's Day",
  '2026-01-19': 'Martin Luther King Jr. Day',
  '2026-02-16': "Washington's Birthday",
  '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day',
  '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day (observed)',
  '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving Day',
  '2026-12-25': 'Christmas Day',
  '2027-01-01': "New Year's Day",
  '2027-01-18': 'Martin Luther King Jr. Day',
  '2027-02-15': "Washington's Birthday",
  '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day',
  '2027-06-18': 'Juneteenth (observed)',
  '2027-07-05': 'Independence Day (observed)',
  '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving Day',
  '2027-12-24': 'Christmas Day (observed)',
};

/** Early closes at 13:00 ET. VERIFY each year against the official list. */
export const EARLY_CLOSES: Record<string, string> = {
  '2026-11-27': 'Day after Thanksgiving',
  '2026-12-24': 'Christmas Eve',
  '2027-11-26': 'Day after Thanksgiving',
};

export type SessionKind = 'FULL' | 'EARLY_CLOSE' | 'HOLIDAY' | 'WEEKEND' | 'UNKNOWN';

export interface SessionInfo {
  date: string;
  kind: SessionKind;
  open: string | null; // HH:MM ET
  close: string | null; // HH:MM ET
  note: string;
}

export function sessionFor(date: string): SessionInfo {
  const y = Number(date.slice(0, 4));
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return { date, kind: 'WEEKEND', open: null, close: null, note: 'Weekend — market closed.' };
  if (!CALENDAR_YEARS.includes(y)) {
    return { date, kind: 'UNKNOWN', open: null, close: null, note: `Market calendar for ${y} is not loaded. Automated tickets are disabled until it is added.` };
  }
  if (HOLIDAYS[date]) return { date, kind: 'HOLIDAY', open: null, close: null, note: `Market holiday: ${HOLIDAYS[date]}.` };
  if (EARLY_CLOSES[date]) {
    return { date, kind: 'EARLY_CLOSE', open: '09:30', close: '13:00', note: `Early close 13:00 ET (${EARLY_CLOSES[date]}). The RB v1.1 window is not defined for early-close sessions — manual review only.` };
  }
  return { date, kind: 'FULL', open: '09:30', close: '16:00', note: 'Regular full session 09:30–16:00 ET.' };
}

/** Previous N trading dates before `date` (exclusive), newest first. Unknown years count weekdays only. */
export function previousTradingDates(date: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${date}T12:00:00Z`);
  while (out.length < n) {
    t -= 86400000;
    const d = new Date(t).toISOString().slice(0, 10);
    const k = sessionFor(d).kind;
    if (k === 'FULL' || k === 'EARLY_CLOSE' || k === 'UNKNOWN') out.push(d);
  }
  return out;
}
