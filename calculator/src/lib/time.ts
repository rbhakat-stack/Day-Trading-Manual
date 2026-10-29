/** Eastern-time helpers (the market's clock). */
export function nowEt(d = new Date()): { date: string; time: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = g('hour') === '24' ? '00' : g('hour');
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${hour}:${g('minute')}`, minutes: Number(hour) * 60 + Number(g('minute')) };
}

/** HH:MM ET, `minutesAgo` minutes before now (never earlier than 00:00). */
export function etTimeMinusMinutes(minutesAgo: number | null): string {
  const { minutes } = nowEt();
  const m = Math.max(0, minutes - Math.max(0, Math.round(minutesAgo ?? 0)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
