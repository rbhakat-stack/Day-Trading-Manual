/**
 * Step 3 · D — which SIP trade prints may serve as an EXECUTABLE current price (live scoring, chase, missed-trigger and
 * execution checks all read the same price, so they can never disagree).
 *
 * Source (provider evidence, not inference): Alpaca's market-data FAQ, "How are bars aggregated?" — the per-tape table of
 * conditions that update the open/close and high/low of a MINUTE bar (CTS rules for tapes A/B, UTP for tape C), and
 * Alpaca's condition dictionary GET /v2/stocks/meta/conditions/trade?tape=A|B|C. A trade is eligible only when EVERY one
 * of its conditions updates both open/close and high/low of a minute bar on its own tape ("the strictest rule is
 * applied"). Codes are tape-specific: on tape A/B "B" is an Average Price Trade (not eligible); on tape C "B" is a Bunched
 * Trade (eligible) and "W" is the Average Price Trade.
 *
 * Not eligible (examples): I odd lot, 4 derivatively priced, B/W average price, Z / U out of sequence, T / U extended
 * hours, C cash, N next day, R seller, H price variation, P prior reference price, V contingent, 7 QCT, G bunched sold,
 * Q / M official open / close (informational), 9 corrected close. Conservative choices: T (Form T) is excluded although
 * Alpaca's minute rule includes it (the CTS/UTP last-sale rules and Alpaca's close-price list exclude it); any code Alpaca
 * does not document for that tape is excluded; a trade without conditions, or with an unknown tape, is judged by the
 * codes eligible on EVERY tape (so a tape-ambiguous "B" is never accepted).
 */
export const ELIGIBLE_CONDITIONS: Record<'AB' | 'C', ReadonlySet<string>> = {
  AB: new Set([' ', '@', 'F', 'L', 'X', 'O', '5', '6', 'K', 'E']),
  C: new Set([' ', '@', 'F', 'L', 'X', 'O', '5', '6', 'K', 'B', 'Y', 'A', 'D']),
};
const EVERY_TAPE: ReadonlySet<string> = new Set([...ELIGIBLE_CONDITIONS.AB].filter((c) => ELIGIBLE_CONDITIONS.C.has(c)));

export interface ConditionedTrade {
  /** Trade conditions as Alpaca reports them (e.g. [" ", "F"]). */
  c?: string[] | null;
  /** SIP tape: "A" | "B" (CTS) | "C" (UTP). */
  z?: string | null;
}

/** True when the print may be used as an executable current price (see module comment). */
export function isEligibleTrade(t: ConditionedTrade): boolean {
  const conds = t.c;
  if (!Array.isArray(conds) || !conds.length) return false; // no evidence of a regular sale → not executable
  const allowed = t.z === 'A' || t.z === 'B' ? ELIGIBLE_CONDITIONS.AB : t.z === 'C' ? ELIGIBLE_CONDITIONS.C : EVERY_TAPE;
  return conds.every((c) => allowed.has(c === '' ? ' ' : c));
}

/**
 * Conservative TRIGGER evidence: a genuine market print at a real price — eligible, or an odd lot ("I") whose other
 * conditions are all eligible. Odd lots never set the executable price (they do not update the consolidated last sale),
 * but whether a broker's stop order triggers on them is not established, so an odd lot at / through the entry counts as
 * the trigger having been reached (it can only withhold a ticket, never create one). Average-price, derivatively priced,
 * out-of-sequence, prior-reference, contingent, extended-hours and informational prints are never evidence.
 */
export function isTriggerEvidence(t: ConditionedTrade): boolean {
  if (isEligibleTrade(t)) return true;
  const conds = t.c;
  if (!Array.isArray(conds) || !conds.includes('I')) return false;
  return isEligibleTrade({ ...t, c: conds.filter((c) => c !== 'I').concat(conds.every((c) => c === 'I') ? [' '] : []) });
}

/** The ineligible conditions of a print (for the audit trail). */
export const ineligibleConditions = (t: ConditionedTrade): string[] => {
  const allowed = t.z === 'A' || t.z === 'B' ? ELIGIBLE_CONDITIONS.AB : t.z === 'C' ? ELIGIBLE_CONDITIONS.C : EVERY_TAPE;
  return (t.c ?? []).filter((c) => !allowed.has(c === '' ? ' ' : c));
};
