import { describe, expect, it } from 'vitest';
import { etToEpoch } from '../../etTime';
import { mapSignalCandle, v12DedupeKey } from '../signalMapping';

const D = '2026-10-30'; // Friday, full session
const at = (hhmm: string, plusSec = 0, date = D) => etToEpoch(date, hhmm) + plusSec * 1000;

describe('receipt → signal candle mapping', () => {
  it.each([
    [0, 'ON_TIME'],
    [10, 'ON_TIME'],
    [30, 'ON_TIME'],
    [60, 'ON_TIME'],
    [61, 'DELAYED'],
    [120, 'DELAYED'],
    [121, 'AMBIGUOUS'],
  ])('lag %i s after the 12:30 close → %s, candle 12:25–12:30', (lag, status) => {
    const m = mapSignalCandle(at('12:30', lag));
    expect(m.status).toBe(status);
    expect(m.lagSec).toBe(lag);
    expect(m.label).toBe('12:25–12:30');
    expect(m.candleStartMs).toBe(at('12:25'));
    expect(m.candleEndMs).toBe(at('12:30'));
  });

  it('production receipts (10–18 s after the close) map to the just-completed candle', () => {
    expect(mapSignalCandle(at('15:55', 10.417)).label).toBe('15:50–15:55'); // IBM
    expect(mapSignalCandle(at('16:00', 13.968))).toMatchObject({ status: 'ON_TIME', label: '15:55–16:00' }); // AVGO
  });

  it('before the first candle closes (09:35) → BEFORE_FIRST_CANDLE, no candle', () => {
    const m = mapSignalCandle(at('09:34', 59));
    expect(m.status).toBe('BEFORE_FIRST_CANDLE');
    expect(m.candleStartMs).toBeNull();
    expect(mapSignalCandle(at('09:35', 5))).toMatchObject({ status: 'ON_TIME', label: '09:30–09:35' });
    expect(mapSignalCandle(at('08:00')).status).toBe('BEFORE_FIRST_CANDLE');
  });

  it('near the 16:00 close: receipts after the close map to 15:55–16:00 within 120 s, then AFTER_SESSION', () => {
    expect(mapSignalCandle(at('16:00', 12))).toMatchObject({ status: 'ON_TIME', label: '15:55–16:00', lagSec: 12 });
    expect(mapSignalCandle(at('16:00', 90))).toMatchObject({ status: 'DELAYED', label: '15:55–16:00' });
    expect(mapSignalCandle(at('16:00', 120)).status).toBe('DELAYED');
    expect(mapSignalCandle(at('16:00', 121))).toMatchObject({ status: 'AFTER_SESSION', candleStartMs: null });
    expect(mapSignalCandle(at('15:59', 50))).toMatchObject({ status: 'AMBIGUOUS', label: '15:50–15:55' }); // 4m50s after 15:55
  });

  it('after hours and closed days', () => {
    expect(mapSignalCandle(at('18:30')).status).toBe('AFTER_SESSION');
    expect(mapSignalCandle(at('12:30', 5, '2026-10-31'))).toMatchObject({ status: 'NO_SESSION', session: 'WEEKEND' }); // Saturday
    expect(mapSignalCandle(at('12:30', 5, '2026-11-26'))).toMatchObject({ status: 'NO_SESSION', session: 'HOLIDAY' }); // Thanksgiving
    expect(mapSignalCandle(at('12:30', 5, '2030-01-07'))).toMatchObject({ status: 'NO_SESSION', session: 'UNKNOWN' }); // calendar not loaded
  });

  it('early-close session: the 13:00 close caps the boundary', () => {
    const m = mapSignalCandle(at('13:00', 20, '2026-11-27'));
    expect(m).toMatchObject({ status: 'ON_TIME', session: 'EARLY_CLOSE', label: '12:55–13:00' });
    expect(mapSignalCandle(at('13:05', 0, '2026-11-27')).status).toBe('AFTER_SESSION');
  });
});

describe('v1.2 dedupe key', () => {
  it('same symbol/direction/candle/rule set → same key regardless of receipt second (redelivery collapses)', () => {
    const a = v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('12:30', 12)), 'RBTS-L-901');
    const b = v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('12:30', 47)), 'RBTS-L-901');
    expect(a).toBe(b);
    expect(a.startsWith('v12|VRSK|LONG|C')).toBe(true);
  });
  it('different candle, direction, symbol or rule set → different key; unmapped receipts keep their second', () => {
    const base = v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('12:30', 12)), 'RBTS-L-901');
    expect(v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('12:35', 12)), 'RBTS-L-901')).not.toBe(base);
    expect(v12DedupeKey('VRSK', 'SHORT', mapSignalCandle(at('12:30', 12)), 'RBTS-L-901')).not.toBe(base);
    expect(v12DedupeKey('IBM', 'LONG', mapSignalCandle(at('12:30', 12)), 'RBTS-L-901')).not.toBe(base);
    expect(v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('12:30', 12)), null)).not.toBe(base);
    const u1 = v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('18:30', 1)), null);
    const u2 = v12DedupeKey('VRSK', 'LONG', mapSignalCandle(at('18:30', 2)), null);
    expect(u1).not.toBe(u2);
    expect(u1).toContain('|R');
  });
});
