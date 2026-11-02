/** CR-02 — classification management: view/count, CSV export, edit one, delete one; the existing import is preserved. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_KEYS, classificationError, classificationsCsv, initialClassifications, parseClassificationCsv, removeClassification, upsertClassification, type ClassMap } from '../automationClient';
import { KNOWN_CLASSIFICATIONS } from '../../engine/ranker/correlationRules';
import { save } from '../storage';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } };
});
afterEach(() => void delete (globalThis as { window?: unknown }).window);

const base: ClassMap = { GM: { sector: 'Consumer Discretionary', industry: 'Automobiles', theme: 'Autos' }, NVDA: { sector: 'Information Technology', industry: 'Semiconductors', theme: 'AI' } };

describe('CR-02 classification management', () => {
  it('export round-trips through the existing CSV import (sorted, header included)', () => {
    const csv = classificationsCsv({ ...base, ZZ: { sector: 'Has, comma', industry: 'Quote "x"', theme: '' } });
    expect(csv.split('\n')[0]).toBe('Ticker,Sector,Industry,Theme');
    expect(csv.split('\n')[1].startsWith('GM,')).toBe(true);
    const back = parseClassificationCsv(classificationsCsv(base));
    expect(back).toEqual({ rows: base, errors: [] });
  });
  it('edit one ticker: validated, upper-cased, trimmed; other tickers untouched', () => {
    expect(classificationError('gm', { sector: '', industry: '', theme: '' })).toMatch(/Sector/);
    expect(classificationError('TOOLONG', { sector: 'X', industry: '', theme: '' })).toMatch(/Ticker/);
    const next = upsertClassification(base, ' gm ', { sector: ' Autos ', industry: 'Cars', theme: '' });
    expect(next.GM).toEqual({ sector: 'Autos', industry: 'Cars', theme: '' });
    expect(next.NVDA).toBe(base.NVDA);
    expect(base.GM.sector).toBe('Consumer Discretionary');
  });
  it('delete one ticker: removed from the map and stays deleted after reload, even for a built-in default', () => {
    const known = Object.keys(KNOWN_CLASSIFICATIONS)[0];
    expect(known).toBeDefined();
    const start = initialClassifications();
    expect(start[known]).toBeDefined();
    const next = removeClassification(start, known);
    expect(next[known]).toBeUndefined();
    expect(Object.keys(next).length).toBe(Object.keys(start).length - 1);
    save(AUTO_KEYS.classifications, next);
    expect(initialClassifications()[known]).toBeUndefined();
  });
  it('a deleted ticker can be re-imported or re-added', () => {
    const known = Object.keys(KNOWN_CLASSIFICATIONS)[0];
    const deleted = removeClassification(initialClassifications(), known);
    const { rows } = parseClassificationCsv(`${known},Re-added,Ind,`);
    save(AUTO_KEYS.classifications, { ...deleted, ...rows });
    expect(initialClassifications()[known]).toEqual({ sector: 'Re-added', industry: 'Ind', theme: '' });
    const again = upsertClassification(deleted, known, { sector: 'S2', industry: '', theme: '' });
    save(AUTO_KEYS.classifications, again);
    expect(initialClassifications()[known].sector).toBe('S2');
  });
});
