/**
 * GET /.netlify/functions/rb-health — configuration check for setup (booleans only, never secret values).
 * Authenticated with RB_APP_ACCESS_TOKEN.
 */
import { bearerFrom, safeEqual } from '../lib/auth';
import { configStatus, env, json } from '../lib/env';
import { RULES_VERSION, SCORING_VERSION } from '../../src/engine/rules';

export default async (req: Request): Promise<Response> => {
  if (!safeEqual(bearerFrom(req), env('RB_APP_ACCESS_TOKEN'))) return json(401, { error: 'Unauthorized' });
  return json(200, { ok: true, serverTime: new Date().toISOString(), versions: { rules: RULES_VERSION, scoring: SCORING_VERSION }, config: configStatus(), execution: 'NONE — analysis and decision support only' });
};
