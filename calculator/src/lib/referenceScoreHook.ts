/**
 * PHASE C — reference-only scores: per-session capture. DISPLAY ONLY; never persisted (no browser storage, no
 * snapshot or Journal field). The first reference score seen for an alert in this session is kept and shown, so a
 * later market-data or portfolio change never silently rewrites it. If that first evaluation happened after the
 * alert's 10-minute window (e.g. after a page reload) it is labelled RECONSTRUCTED / DIAGNOSTIC with its timestamp.
 */
import { useMemo, useRef } from 'react';
import type { QueueOutput } from '../engine/automation/liveQueue';
import { mismatchSummary, scoreView, type MismatchSummary, type ScoreView } from '../engine/automation/referenceScore';
import { RB_V1_DEFAULTS } from '../engine/settings';

export interface ReferenceEntry {
  view: ScoreView;
  /** The first REFERENCE score of this session (immutable once captured). */
  captured: { total: number; setup: number; fit: number; atMs: number; reconstructed: boolean } | null;
  mismatch: MismatchSummary;
}

/** Pure capture step (tested): keeps the first REFERENCE view per alert id; never overwrites it. */
export function captureReferences(prev: ReadonlyMap<string, ReferenceEntry['captured']>, rows: QueueOutput['rows'], now: number): Map<string, ReferenceEntry['captured']> {
  const next = new Map(prev);
  for (const r of rows) {
    if (next.has(r.record.id)) continue;
    const v = scoreView(r);
    if (v.kind !== 'REFERENCE') continue;
    const reconstructed = now - r.record.alert.alertTimeMs > RB_V1_DEFAULTS.alertWindowMinutes * 60_000;
    next.set(r.record.id, { total: v.total, setup: v.setup, fit: v.fit, atMs: now, reconstructed });
  }
  return next;
}

export function useReferenceScores(enabled: boolean, queue: QueueOutput | null, now: number): ReadonlyMap<string, ReferenceEntry> | null {
  const captured = useRef<ReadonlyMap<string, ReferenceEntry['captured']>>(new Map());
  return useMemo(() => {
    if (!enabled || !queue) return null;
    try {
      captured.current = captureReferences(captured.current, queue.rows, now);
      return new Map(queue.rows.map((r) => [r.record.id, { view: scoreView(r), captured: captured.current.get(r.record.id) ?? null, mismatch: mismatchSummary(r) }]));
    } catch {
      return null; // diagnostics failure → existing presentation; decisions never depend on this
    }
  }, [enabled, queue, now]);
}
