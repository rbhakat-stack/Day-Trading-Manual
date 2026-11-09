/**
 * Defect 2 — CHARACTERIZATION of the current behaviour (base 3e61dbf). Not a fix.
 * An open broker position that no active RB record represents is counted at the flat conservative risk
 * (equity × risk % = $250) whatever its real protective stop. Fixtures: REAL broker states reconstructed from the
 * archived Alpaca PAPER orders, plus labelled SYNTHETIC variants (defect2-broker-positions.fixtures.json).
 * The Defect 2 implementation will replace the `CURRENT` assertions with each fixture's `expected` values.
 */
import { describe, expect, it } from 'vitest';
import FX from './defect2-broker-positions.fixtures.json';
import { reconcileExposure, type BrokerExposureInput } from '../lifecycle/portfolioExposure';

type Fixture = { name: string; source: 'PAPER_HISTORY' | 'SYNTHETIC'; asOf: string; ticker: string; expected: Record<string, unknown>; broker: BrokerExposureInput };
const fixtures = FX.fixtures as unknown as Fixture[];
const CONSERVATIVE = FX.conservativeRiskToday; // 100,000 × 0.25 %
const run = (f: Fixture) => reconcileExposure([], [], f.broker, { classify: () => null, conservativeRisk: CONSERVATIVE, now: Date.parse(f.asOf), maxPositionValue: 20_000 });

describe('fixtures are internally consistent (real broker states)', () => {
  it('every PAPER_HISTORY fixture holds the position and an open opposite-side protective stop (new or held OCO leg)', () => {
    for (const f of fixtures.filter((x) => x.source === 'PAPER_HISTORY')) {
      const p = f.broker.positions.find((x) => x.symbol === f.ticker)!;
      expect([f.name, !!p]).toEqual([f.name, true]);
      const long = Number(p.qty) > 0;
      const stops = (f.broker.openOrders as Record<string, unknown>[]).filter((o) => o.symbol === f.ticker && /stop/.test(String(o.type)) && o.side === (long ? 'sell' : 'buy'));
      expect([f.name, stops.length > 0, stops.every((s) => ['new', 'held', 'accepted'].includes(String(s.status)))]).toEqual([f.name, true, true]);
    }
  });
  it('expected confirmed risk = |qty| × |entry − stop| for the single-stop real cases', () => {
    for (const f of fixtures.filter((x) => x.source === 'PAPER_HISTORY' && typeof x.expected.plannedRisk === 'number')) {
      const e = f.expected as { qty: number; entry: number; stop: number; plannedRisk: number };
      expect([f.ticker, Math.round(Math.abs(e.qty) * Math.abs(e.entry - e.stop) * 100) / 100]).toEqual([f.ticker, e.plannedRisk]);
    }
  });
});

describe('CURRENT behaviour (the defect): unrepresented broker positions use the flat $250', () => {
  it('every verified fixture with a broker-only position → plannedRisk = 250 regardless of its stop', () => {
    const rows: [string, number, unknown][] = [];
    for (const f of fixtures.filter((x) => x.broker.verified)) {
      const out = run(f);
      const bp = out.brokerPositions.find((x) => x.ticker === f.ticker)!;
      expect([f.name, bp.plannedRisk]).toEqual([f.name, CONSERVATIVE]);
      rows.push([f.ticker, bp.plannedRisk, f.expected.plannedRisk]);
    }
    // Overstated for every protected real position (e.g. FIS 104.79, GM 60.21) and UNDERSTATED for the ambiguous wide stop (274.45).
    expect(rows.filter(([, , e]) => typeof e === 'number' && (e as number) < CONSERVATIVE).length).toBeGreaterThan(0);
    expect(rows.some(([, , e]) => typeof e === 'number' && (e as number) > CONSERVATIVE)).toBe(true);
  });
  it('a position represented by an active RB record is not double counted (behaviour to preserve)', () => {
    const f = fixtures.find((x) => x.ticker === 'GM')!;
    const cand = { id: 'GM-L-140617', ticker: 'GM', direction: 'LONG', status: 'FILLED', entry: 89.47, stop: 89.22, target: 89.97, shares: 223, positionValue: 19_951.81, plannedRisk: 55.75, archived: false, date: '2026-11-02', inputs: { sector: 'X', industry: 'Y', theme: '' } };
    const out = reconcileExposure([cand as never], [], f.broker, { classify: () => null, conservativeRisk: CONSERVATIVE, now: Date.parse(f.asOf), maxPositionValue: 20_000 });
    expect(out.brokerPositions.find((x) => x.ticker === 'GM')).toBeUndefined();
  });
});
