/** Display formatting only — never used for calculations. */

export const usd = (v: number, dp = 2) =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const price = (v: number, dp = 2) => v.toFixed(dp);

export const pct = (fraction: number, dp = 2) => `${(fraction * 100).toFixed(dp)}%`;

export const signedUsd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(v))}`;

export const signedR = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`;

/** Parse a user-typed number ("1,234.50", "$20,000", " 0.157 "). Empty → NaN. */
export function parseNum(s: string): number {
  const t = s.replace(/[$,\s]/g, '');
  if (t === '' || t === '-' || t === '.') return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
