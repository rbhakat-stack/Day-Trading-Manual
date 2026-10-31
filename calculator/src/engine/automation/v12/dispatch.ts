/**
 * RB v1.1 / RB v1.2 version dispatch (RB_V1_2_ARCHITECTURE.md §16).
 *
 * Every record is decided by the logic version it was created under (`versions.strategy`); nothing is re-scored or
 * reinterpreted. The server stamps new records with ACTIVE_LOGIC_VERSION — RB v1.1 while v1.2 runs in SHADOW — so
 * today every record is a v1.1 record and its active decision is the unchanged v1.1 `decideAlert`. Records that also
 * carry a v1.2 audit get a SHADOW v1.2 decision next to it, for comparison only.
 */
import { decideAlert, type AlertDecision, type DecideArgs } from '../alertDecision';
import { FROZEN_VERSION } from '../../strategyVersion';
import { RB_V1_2, type AutoAlertRecordV12 } from './audit';
import { decideAlertV12, v12AsAlertDecision, type V12DecideArgs, type V12Decision } from './decideAlertV12';

/** The active production logic. Promotion to RB v1.2 is a separate, explicitly approved change. */
export const ACTIVE_LOGIC_VERSION: string = FROZEN_VERSION; // 'RB v1.1'

export const logicVersionOf = (rec: Pick<AutoAlertRecordV12, 'versions'>): string => rec.versions?.strategy ?? FROZEN_VERSION;

export type V12Inputs = Omit<V12DecideArgs, 'record' | 'mode'>;

/** Active decision for a record: its own logic version decides it. */
export function decideActive(v11: DecideArgs, v12: V12Inputs): { logicVersion: string; decision: AlertDecision } {
  const rec = v11.record as AutoAlertRecordV12;
  if (logicVersionOf(rec) === RB_V1_2) return { logicVersion: RB_V1_2, decision: v12AsAlertDecision(decideAlertV12({ ...v12, record: rec, mode: 'ACTIVE' })) };
  return { logicVersion: logicVersionOf(rec), decision: decideAlert(v11) };
}

/** SHADOW v1.2 decision for a non-v1.2 record that carries a v1.2 audit; null otherwise. Never affects the active path. */
export function decideShadow(rec: AutoAlertRecordV12, v12: V12Inputs): V12Decision | null {
  if (!rec.v12 || logicVersionOf(rec) === RB_V1_2) return null;
  return decideAlertV12({ ...v12, record: rec, mode: 'SHADOW' });
}
