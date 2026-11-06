/** PHASE C reference-score server flag: default OFF, exposed by configStatus (rb-health), never secret. */
import { afterEach, describe, expect, it } from 'vitest';
import { configStatus } from '../lib/env';

describe('RB_REFERENCE_SCORES_ENABLED', () => {
  const prev = process.env.RB_REFERENCE_SCORES_ENABLED;
  afterEach(() => { if (prev === undefined) delete process.env.RB_REFERENCE_SCORES_ENABLED; else process.env.RB_REFERENCE_SCORES_ENABLED = prev; });
  it('absent → OFF', () => { delete process.env.RB_REFERENCE_SCORES_ENABLED; expect(configStatus().referenceScoresEnabled).toBe(false); });
  it('anything but the exact string "true" → OFF', () => {
    for (const v of ['', 'TRUE', '1', 'yes', 'on', 'false']) { process.env.RB_REFERENCE_SCORES_ENABLED = v; expect(configStatus().referenceScoresEnabled).toBe(false); }
  });
  it('independent of the observation and Policy flags', () => { delete process.env.RB_REFERENCE_SCORES_ENABLED; process.env.RB_RVOL_V1_OBSERVATION_ENABLED = 'true'; try { expect(configStatus().referenceScoresEnabled).toBe(false); } finally { delete process.env.RB_RVOL_V1_OBSERVATION_ENABLED; } });
  it('"true" → ON (display only)', () => { process.env.RB_REFERENCE_SCORES_ENABLED = 'true'; expect(configStatus().referenceScoresEnabled).toBe(true); });
});
