/** RVOL eligibility policy server flags: default OFF, exact "true" only, exposed by configStatus (rb-health), never secret. */
import { afterEach, describe, expect, it } from 'vitest';
import { configStatus } from '../lib/env';

const KEY = 'RB_RVOL_POLICY_A_ENABLED';
describe(KEY, () => {
  const prev = process.env[KEY];
  afterEach(() => { if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev; });
  it('absent → OFF', () => { delete process.env[KEY]; expect(configStatus().rvolPolicyAEnabled).toBe(false); });
  it('anything but exactly "true" → OFF', () => { for (const v of ['', 'TRUE', '1', 'yes', 'on', 'false']) { process.env[KEY] = v; expect(configStatus().rvolPolicyAEnabled).toBe(false); } });
  it('"true" → ON', () => { process.env[KEY] = 'true'; expect(configStatus().rvolPolicyAEnabled).toBe(true); });
  it('independent of the observation flag', () => { process.env[KEY] = 'true'; process.env.RB_RVOL_V1_OBSERVATION_ENABLED = 'false'; expect(configStatus()).toMatchObject({ rvolPolicyAEnabled: true, rvolV1ObservationEnabled: false }); delete process.env.RB_RVOL_V1_OBSERVATION_ENABLED; });
});

describe('RB_RVOL_POLICY_B_ENABLED', () => {
  const K = 'RB_RVOL_POLICY_B_ENABLED';
  const prev = process.env[K];
  afterEach(() => { if (prev === undefined) delete process.env[K]; else process.env[K] = prev; });
  it('absent → OFF; only exactly "true" → ON; reported independently of A (the client enforces B ⇒ A)', () => {
    delete process.env[K]; expect(configStatus().rvolPolicyBEnabled).toBe(false);
    for (const v of ['', 'TRUE', '1', 'yes']) { process.env[K] = v; expect(configStatus().rvolPolicyBEnabled).toBe(false); }
    process.env[K] = 'true'; expect(configStatus().rvolPolicyBEnabled).toBe(true);
  });
});
