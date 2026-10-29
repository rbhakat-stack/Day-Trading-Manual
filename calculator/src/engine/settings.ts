/** RB v1 rule settings. All percentages are stored as FRACTIONS (0.0025 = 0.25%). */

export type StrategyMode = 'RB_V1_BREAKOUT' | 'PULLBACK_EXPERIMENTAL';

export interface RbSettings {
  /** Minimum breakout buffer in dollars. RB v1: $0.01 */
  minBuffer: number;
  /** Percentage breakout buffer as a fraction of the signal price. RB v1: 0.0002 (0.02%) */
  bufferPct: number;
  /** Minimum stop distance in ATR multiples. RB v1: 1.0 */
  atrStopMultiple: number;
  /** Target as a multiple of R. RB v1: 2 */
  rewardMultiple: number;
  /** Maximum distance past the trigger, in ATR, before a breakout counts as chased. RB v1: 0.25 */
  chaseThresholdAtr: number;
  /** Maximum account risk per trade as a fraction of equity. RB v1: 0.0025 (0.25%) */
  riskPct: number;
  /** Maximum notional dollars per ticker. RB v1: $20,000 */
  investmentCap: number;
  /** Default account equity. $100,000 */
  accountEquity: number;
  /** Alert considered stale if the breakout has not happened within this many minutes. RB v1: 10 */
  alertWindowMinutes: number;
  /** Signal timeframe in minutes (informational; converts minutes ↔ candles). RB v1: 5 */
  timeframeMinutes: number;
  /** New entries allowed from (ET, HH:MM). RB v1.1: 09:45 — earlier = TOO EARLY (hard fail). */
  entryWindowStart: string;
  /** New entries NOT allowed at or after (ET, HH:MM). RB v1.1: 15:30 (hard fail). */
  entryWindowEnd: string;
  /** Allow a second same-direction position in a ticker. RB v1: false (no pyramiding). */
  allowPyramiding: boolean;
  /** RB v1 Breakout is the only implemented mode. */
  strategyMode: StrategyMode;
}

export const RB_V1_DEFAULTS: Readonly<RbSettings> = Object.freeze({
  minBuffer: 0.01,
  bufferPct: 0.0002,
  atrStopMultiple: 1.0,
  rewardMultiple: 2,
  chaseThresholdAtr: 0.25,
  riskPct: 0.0025,
  investmentCap: 20000,
  accountEquity: 100000,
  alertWindowMinutes: 10,
  timeframeMinutes: 5,
  entryWindowStart: '09:45',
  entryWindowEnd: '15:30',
  allowPyramiding: false,
  strategyMode: 'RB_V1_BREAKOUT',
});

/** Validate settings; returns a list of human-readable problems (empty = OK). */
export function validateSettings(s: RbSettings): string[] {
  const errs: string[] = [];
  const pos = (v: number, name: string) => {
    if (!Number.isFinite(v) || v <= 0) errs.push(`${name} must be greater than 0.`);
  };
  pos(s.minBuffer, 'Minimum buffer');
  if (!Number.isFinite(s.bufferPct) || s.bufferPct < 0) errs.push('Percentage buffer cannot be negative.');
  pos(s.atrStopMultiple, 'ATR stop multiple');
  pos(s.rewardMultiple, 'Reward/Risk multiple');
  pos(s.chaseThresholdAtr, 'Chase threshold');
  pos(s.riskPct, 'Risk %');
  if (s.riskPct > 0.05) errs.push('Risk % above 5% per trade is not allowed in this calculator.');
  pos(s.investmentCap, 'Investment cap');
  pos(s.accountEquity, 'Account equity');
  pos(s.alertWindowMinutes, 'Alert window');
  pos(s.timeframeMinutes, 'Timeframe');
  const t = (x: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(x ?? '') ? Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5)) : NaN);
  const a = t(s.entryWindowStart);
  const b = t(s.entryWindowEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) errs.push('Entry window times must be HH:MM (24h, ET).');
  else if (!(a >= 570 && b <= 960 && a < b)) errs.push('Entry window must be inside 09:30–16:00 ET and start before it ends.');
  return errs;
}
