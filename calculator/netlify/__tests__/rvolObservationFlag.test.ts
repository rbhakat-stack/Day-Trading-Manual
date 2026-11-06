/** RVOL POLICY V1 observation server flag: default OFF, exposed by configStatus (rb-health), never secret. */
import { afterEach, describe, expect, it } from 'vitest';
import { configStatus } from '../lib/env';

describe('RB_RVOL_V1_OBSERVATION_ENABLED', () => {
  const prev = process.env.RB_RVOL_V1_OBSERVATION_ENABLED;
  afterEach(() => { if (prev === undefined) delete process.env.RB_RVOL_V1_OBSERVATION_ENABLED; else process.env.RB_RVOL_V1_OBSERVATION_ENABLED = prev; });
  it('absent → OFF', () => { delete process.env.RB_RVOL_V1_OBSERVATION_ENABLED; expect(configStatus().rvolV1ObservationEnabled).toBe(false); });
  it('anything but the exact string "true" → OFF', () => {
    for (const v of ['', 'TRUE', '1', 'yes', 'on', 'false']) { process.env.RB_RVOL_V1_OBSERVATION_ENABLED = v; expect(configStatus().rvolV1ObservationEnabled).toBe(false); }
  });
  it('"true" → ON (display only)', () => { process.env.RB_RVOL_V1_OBSERVATION_ENABLED = 'true'; expect(configStatus().rvolV1ObservationEnabled).toBe(true); });
});
