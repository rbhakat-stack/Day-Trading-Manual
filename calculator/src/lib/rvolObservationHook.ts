/**
 * RVOL POLICY V1 — OBSERVATION ONLY. Runs AFTER the authoritative queue has been computed and committed:
 *   • never inside the render path of the authoritative queue (useEffect + setTimeout → deferred to a later task);
 *   • throttled (at most once per RVOL_OBSERVATION_MIN_INTERVAL_MS, immediately when a new alert id appears);
 *   • failure-isolated (runRvolObservation never throws) and bounded (RVOL_V1_OBSERVATION_MAX_RECORDS);
 *   • holds its result in component state only — no browser storage, no Journal, no candidate state, no network.
 * Disabled (server flag OFF / unknown) → nothing is computed and the empty DISABLED result is returned.
 */
import { useEffect, useRef, useState } from 'react';
import type { QueueInput, QueueOutput } from '../engine/automation/liveQueue';
import { runRvolObservation, type RvolObservationRun } from '../engine/automation/rvolObservation';

export const RVOL_OBSERVATION_MIN_INTERVAL_MS = 15_000;
const DISABLED: RvolObservationRun = Object.freeze({ status: 'DISABLED', observations: Object.freeze([]), ms: 0, records: 0, error: null, computedAtMs: 0 });

/** Pure throttle rule (tested): recompute when enabled and (a new alert id appeared, or the interval elapsed). */
export function shouldRecompute(enabled: boolean, lastAtMs: number, lastIds: string, ids: string, now: number, minIntervalMs = RVOL_OBSERVATION_MIN_INTERVAL_MS): boolean {
  if (!enabled) return false;
  return ids !== lastIds || now - lastAtMs >= minIntervalMs;
}

export function useRvolObservation(enabled: boolean, input: QueueInput | null, queue: QueueOutput | null): RvolObservationRun {
  const [run, setRun] = useState<RvolObservationRun>(DISABLED);
  const last = useRef<{ at: number; ids: string }>({ at: 0, ids: '' });
  useEffect(() => {
    if (!enabled || !input || !queue) {
      last.current = { at: 0, ids: '' };
      setRun(DISABLED);
      return;
    }
    const ids = input.records.map((r) => r.id).join(',');
    if (!shouldRecompute(enabled, last.current.at, last.current.ids, ids, Date.now())) return;
    const t = setTimeout(() => {
      const r = runRvolObservation(true, input, queue);
      last.current = { at: Date.now(), ids };
      setRun(r);
    }, 0);
    return () => clearTimeout(t);
  }, [enabled, input, queue]);
  return run;
}
