/**
 * S1 · active-strategy version selection. v1.1 is ACTIVE today; these tests pin that and expose what would be wrong
 * the moment a record is decided by RB v1.2 (records stamped versions.strategy = 'RB v1.2'). [DEFECT] = expected to fail.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVE_LOGIC_VERSION, logicVersionOf } from '../../engine/automation/v12/dispatch';
import { runApp } from './harness';
import { LONG, steps } from './synthetic';

describe('S1 · version selection', () => {
  it('RB v1.1 is the active logic; baseline records are decided by v1.1 with v1.2 as shadow', () => {
    expect(ACTIVE_LOGIC_VERSION).toBe('RB v1.1');
    const rec = LONG();
    expect(logicVersionOf(rec)).toBe('RB v1.1');
    const [p] = runApp([rec], steps('AAA', [[1, 100.95]]));
    expect(p.row(rec.id)!.shadow).not.toBeNull();
  });

  const v12rec = { ...LONG(), versions: { rules: 'RB v1.2', scoring: 'RB v1.2', strategy: 'RB v1.2' } };
  const ps = runApp([v12rec], steps('AAA', [[1, 100.95], [2, 100.95]]));
  it('a v1.2-stamped record is decided by v1.2 (dispatch works)', () => {
    expect(logicVersionOf(v12rec)).toBe('RB v1.2');
    expect(ps[0].row(v12rec.id)!.decision.flags).toContain('LOGIC RB v1.2');
  });
  it('[DEFECT D9] under v1.2 ACTIVE the frozen alert-time snapshot records the v1.2 score', () => {
    expect(ps[1].state.frozen[v12rec.id].v12?.total ?? null).not.toBeNull();
  });
  it('[DEFECT D9] under v1.2 ACTIVE the lifecycle alert-time tier is the v1.2 (Option B) tier, not the v1.1 tier', () => {
    const snap = ps[1].state.frozen[v12rec.id];
    expect(ps[1].row(v12rec.id)!.lifecycle.alertTimeTier).toBe(snap.v12?.tierOptionB ?? '(v1.2 tier missing)');
  });
});
