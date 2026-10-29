/**
 * Correlation rules — v1 is deliberately simple and transparent:
 * no statistics, only Sector / Industry / Theme labels.
 *
 *   HIGH   = same Industry, or same non-empty Theme   (e.g. NVDA vs AVGO: both Semiconductors)
 *   SECTOR = same Sector only                          (e.g. NVDA vs IBM: both Technology)
 *   NONE   = no shared label
 *
 * RB v1.1 default: overlaps count REGARDLESS OF DIRECTION. NVDA LONG + AVGO SHORT still consumes
 * capital, adds gross exposure and execution risk, and is not reliably a hedge. Only when the user turns
 * on allowOppositeDirection are opposite-direction overlaps treated as hedged (informational only).
 */
import type { Direction } from '../tradeCalculator';

export type CorrelationLevel = 'HIGH' | 'SECTOR' | 'NONE';

export interface Classified {
  ticker: string;
  direction: Direction;
  sector: string;
  industry: string;
  theme: string;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

export function correlationLevel(a: Classified, b: Classified): CorrelationLevel {
  if (norm(a.ticker) && norm(a.ticker) === norm(b.ticker)) return 'HIGH';
  if (norm(a.industry) && norm(a.industry) === norm(b.industry)) return 'HIGH';
  if (norm(a.theme) && norm(a.theme) === norm(b.theme)) return 'HIGH';
  if (norm(a.sector) && norm(a.sector) === norm(b.sector)) return 'SECTOR';
  return 'NONE';
}

export interface CorrelationAssessment {
  level: CorrelationLevel; // worst counted level
  highWith: string[]; // tickers with a counted HIGH overlap
  sectorWith: string[];
  oppositeWith: string[]; // opposite-direction overlaps exempted by allowOppositeDirection (informational)
  blocked: boolean;
  /** Points in default units (out of 7): NONE 7 · SECTOR 4 · HIGH allowed 1 · blocked 0 */
  basePoints: number;
}

export function assessCorrelation(
  candidate: Classified,
  exposures: Classified[],
  policy: { maxHighlyCorrelated: number; hardBlock: boolean; allowOppositeDirection: boolean },
): CorrelationAssessment {
  const highWith: string[] = [];
  const sectorWith: string[] = [];
  const oppositeWith: string[] = [];
  for (const e of exposures) {
    const lvl = correlationLevel(candidate, e);
    if (lvl === 'NONE') continue;
    const sameDir = e.direction === candidate.direction;
    if (!sameDir && policy.allowOppositeDirection) {
      oppositeWith.push(e.ticker);
      continue;
    }
    (lvl === 'HIGH' ? highWith : sectorWith).push(e.ticker);
  }
  const blocked = policy.hardBlock && highWith.length >= policy.maxHighlyCorrelated;
  const level: CorrelationLevel = highWith.length ? 'HIGH' : sectorWith.length ? 'SECTOR' : 'NONE';
  const basePoints = blocked ? 0 : level === 'HIGH' ? 1 : level === 'SECTOR' ? 4 : 7;
  return { level, highWith, sectorWith, oppositeWith, blocked, basePoints };
}

/** Built-in starting classifications (editable per candidate). */
export const KNOWN_CLASSIFICATIONS: Record<string, { sector: string; industry: string; theme: string }> = {
  NVDA: { sector: 'Technology', industry: 'Semiconductors', theme: 'AI Chips' },
  AVGO: { sector: 'Technology', industry: 'Semiconductors', theme: 'AI Infrastructure' },
  AMD: { sector: 'Technology', industry: 'Semiconductors', theme: 'AI Chips' },
  IBM: { sector: 'Technology', industry: 'IT Services', theme: 'Enterprise IT' },
  TRMB: { sector: 'Technology', industry: 'Electronic Equipment', theme: 'Industrial Software' },
  AEP: { sector: 'Utilities', industry: 'Electric Utilities', theme: 'Regulated Utilities' },
  NEE: { sector: 'Utilities', industry: 'Electric Utilities', theme: 'Renewables' },
  HCA: { sector: 'Healthcare', industry: 'Healthcare Facilities', theme: 'Hospitals' },
  DLTR: { sector: 'Consumer Staples', industry: 'Discount Retail', theme: 'Value Retail' },
  AAPL: { sector: 'Technology', industry: 'Consumer Electronics', theme: 'Mega-cap Tech' },
  MSFT: { sector: 'Technology', industry: 'Software', theme: 'Mega-cap Tech' },
};

export const SECTORS = [
  'Technology', 'Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials',
  'Healthcare', 'Industrials', 'Materials', 'Real Estate', 'Utilities',
];
