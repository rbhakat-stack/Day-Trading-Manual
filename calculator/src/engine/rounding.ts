/**
 * Centralised price rounding for the RB v1 calculator.
 *
 * All calculations run at full floating-point precision. ONLY final order prices
 * (buffer, entry, stop, target) and the per-share risk used to place them are
 * rounded, and only through these functions.
 *
 * Tick size: U.S. stocks priced at $1.00 or more trade in $0.01 increments;
 * below $1.00 sub-penny ($0.0001) prices are allowed (SEC Rule 612 / Alpaca).
 */

export type RoundMode = 'nearest' | 'up' | 'down';

/** Tolerance used to neutralise binary floating-point noise (e.g. 0.1 / 0.01 = 10.000000000000002). */
const TICK_EPSILON = 1e-7;

/** Minimum price increment for a U.S. stock at this price level. */
export function tickSize(price: number): number {
  return Math.abs(price) >= 1 ? 0.01 : 0.0001;
}

/** Number of decimals that a price at this level is quoted with. */
export function priceDecimals(price: number): number {
  return tickSize(price) === 0.01 ? 2 : 4;
}

/**
 * Round a value to a whole number of ticks.
 * @param value  number to round
 * @param mode   'nearest' (half-up), 'up' (ceiling) or 'down' (floor)
 * @param tick   tick size; defaults to the tick for `value` itself
 */
export function roundToTick(value: number, mode: RoundMode = 'nearest', tick: number = tickSize(value)): number {
  const ticks = value / tick;
  let n: number;
  if (mode === 'nearest') n = Math.round(ticks + TICK_EPSILON);
  else if (mode === 'up') n = Math.ceil(ticks - TICK_EPSILON);
  else n = Math.floor(ticks + TICK_EPSILON);
  const decimals = tick >= 0.01 ? 2 : 4;
  return Number((n * tick).toFixed(decimals));
}

/** Round an order price (entry, stop, target) to its valid tick. */
export function roundPrice(price: number, mode: RoundMode = 'nearest'): number {
  return roundToTick(price, mode, tickSize(price));
}

/** Remove floating-point noise without materially changing a value (8 decimals). */
export function clean(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** Whole shares, always rounded DOWN. Never rounds up, even for 299.9999999. */
export function floorShares(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(clean(value));
}
