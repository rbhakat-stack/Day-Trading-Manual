import { afterEach, describe, expect, it, vi } from 'vitest';
import { historicalRequestBody, runHistoricalSip } from '../automationClient';

const IBM = { symbol: 'IBM', direction: 'LONG', alertEt: '2026-10-30 15:55:10', label: 'IBM SIP check', precision: 'EXACT' as const };

describe('Historical SIP Test request wiring', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the form values IBM / LONG / 2026-10-30 15:55:10 / IBM SIP check become exactly the server payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, kind: 'INVALID_REQUEST', error: 'x' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await runHistoricalSip('tok', IBM);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/.netlify/functions/rb-historical-parity');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(IBM);
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(['symbol', 'direction', 'alertEt', 'label', 'precision']);
  });

  it('trimming / upper-casing never blanks valid input (FormData values as typed)', () => {
    expect(historicalRequestBody({ symbol: ' ibm ', direction: 'long', alertEt: ' 2026-10-30 15:55:10 ', label: ' IBM SIP check ', precision: 'exact' })).toEqual(IBM);
    expect(historicalRequestBody({ symbol: 'NEE', direction: 'SHORT', alertEt: '2026-10-30 15:44', label: '', precision: 'minute' })).toEqual({ symbol: 'NEE', direction: 'SHORT', alertEt: '2026-10-30 15:44', label: '', precision: 'MINUTE' });
    expect(historicalRequestBody({ symbol: 'brk.b', direction: 'SHORT', alertEt: '2026-10-30T15:55:10', label: '' })).toEqual({ symbol: 'BRK.B', direction: 'SHORT', alertEt: '2026-10-30T15:55:10', label: '', precision: 'EXACT' });
    expect(historicalRequestBody({ symbol: null, direction: undefined, alertEt: 5, label: null })).toEqual({ symbol: '', direction: '', alertEt: '', label: '', precision: 'EXACT' });
  });
});
