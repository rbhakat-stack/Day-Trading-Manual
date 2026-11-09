// Defect 2 fixtures: REAL broker states reconstructed from archived Alpaca PAPER orders + labelled SYNTHETIC variants.
// Usage: node buildFixtures.mjs <out.json> <broker-orders-paper.json>
// Open orders follow the shape of GET /v2/orders?status=open&nested=true: a filled bracket parent is listed with its
// still-open legs nested (held OCO leg included). The ORPHAN variant shows a held leg returned without its parent.
import { readFileSync, writeFileSync } from 'node:fs';

const ORDERS = JSON.parse(readFileSync(process.argv[3] ?? 'data/broker-orders-paper.json', 'utf8'));
const ms = (x) => (x ? Date.parse(x) : null);
const OPEN = new Set(['new', 'held', 'accepted', 'pending_new', 'partially_filled']);
const keep = (o) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, order_class: o.order_class, status: o.status, qty: o.qty, filled_qty: o.filled_qty, filled_avg_price: o.filled_avg_price, stop_price: o.stop_price, limit_price: o.limit_price, time_in_force: o.time_in_force, submitted_at: o.submitted_at, filled_at: o.filled_at, canceled_at: o.canceled_at, legs: (o.legs ?? []).map(keep) });

/** Order as of t. Legs exist from creation; a leg not yet routed is 'held' (Alpaca's waiting OCO leg). */
function orderAsOf(o, t, parentFilled = true, isLeg = false) {
  const born = isLeg ? (ms(o.created_at) ?? ms(o.submitted_at)) : (ms(o.submitted_at) ?? ms(o.created_at));
  if (born !== null && born > t) return null;
  const filled = ms(o.filled_at), canceled = ms(o.canceled_at), expired = ms(o.expired_at);
  let status = parentFilled ? 'new' : 'held', filledQty = '0', avg = null;
  if (filled !== null && filled <= t) { status = 'filled'; filledQty = o.filled_qty; avg = o.filled_avg_price; }
  else if (canceled !== null && canceled <= t) status = 'canceled';
  else if (expired !== null && expired <= t) status = 'expired';
  else if (isLeg && parentFilled && ms(o.submitted_at) !== null && ms(o.submitted_at) > t) status = 'held';
  const legs = (o.legs ?? []).map((l) => orderAsOf({ ...l, submitted_at: l.submitted_at ?? o.submitted_at }, t, status === 'filled', true)).filter(Boolean);
  return { ...keep(o), status, filled_qty: filledQty, filled_avg_price: avg, filled_at: status === 'filled' ? o.filled_at : null, canceled_at: status === 'canceled' ? o.canceled_at : null, legs };
}

function brokerAsOf(t) {
  const asOf = ORDERS.map((o) => orderAsOf(o, t)).filter(Boolean);
  const et = (x) => new Date(x - 5 * 3600e3).toISOString().slice(0, 10);
  const today = asOf.filter((o) => et(ms(o.submitted_at)) === et(t));
  // nested=true shape: open parents, and filled parents that still have open legs (legs nested, only the open ones).
  const openOrders = [];
  for (const o of asOf) {
    if (OPEN.has(o.status)) openOrders.push(o);
    else if (o.status === 'filled') { const live = o.legs.filter((l) => OPEN.has(l.status)); if (live.length) openOrders.push({ ...o, legs: live }); }
  }
  const pos = new Map(), cost = new Map();
  const fills = asOf.flatMap((o) => [o, ...o.legs]).filter((x) => x.status === 'filled').sort((a, b) => ms(a.filled_at) - ms(b.filled_at));
  for (const x of fills) {
    const q = (x.side === 'buy' ? 1 : -1) * Number(x.filled_qty);
    const prev = pos.get(x.symbol) ?? 0;
    if (prev === 0 || Math.sign(prev) === Math.sign(q)) { const c0 = cost.get(x.symbol) ?? 0; cost.set(x.symbol, (c0 * Math.abs(prev) + Number(x.filled_avg_price) * Math.abs(q)) / (Math.abs(prev) + Math.abs(q))); }
    pos.set(x.symbol, prev + q);
  }
  const positions = [...pos].filter(([, q]) => q !== 0).map(([symbol, q]) => ({ symbol, qty: String(q), side: q > 0 ? 'long' : 'short', avg_entry_price: String(+cost.get(symbol).toFixed(6)), market_value: String(+(q * cost.get(symbol)).toFixed(2)) }));
  return { verified: true, orders: today, positions, openOrders };
}

const at = (iso) => Date.parse(iso);
const C = (basis, plannedRisk, extra = {}) => ({ basis, plannedRisk, ...extra });
const real = [
  { name: 'FIS LONG held overnight (2 → 3 Nov) at the 09:31 pre-open: GTC bracket stop 39.84 (held OCO leg of the filled 2 Nov parent)', asOf: '2026-11-03T14:31:00Z', ticker: 'FIS', expected: C('CONFIRMED_STOP', 104.79, { confirmedRisk: 104.79, coveredQty: 499, uncoveredQty: 0, linkage: ['BRACKET_LEG'], previous: 250 }) },
  { name: 'MCD LONG held overnight (3 → 4 Nov) at the 09:31 pre-open: GTC bracket stop 261.01 (routed leg)', asOf: '2026-11-04T14:31:00Z', ticker: 'MCD', expected: C('CONFIRMED_STOP', 190.5, { confirmedRisk: 190.5, coveredQty: 75, uncoveredQty: 0, linkage: ['BRACKET_LEG'], previous: 250 }) },
  { name: 'GM LONG intraday 2 Nov 15:10 ET: bracket stop 89.22 (held leg)', asOf: '2026-11-02T20:10:00Z', ticker: 'GM', expected: C('CONFIRMED_STOP', 60.21, { confirmedRisk: 60.21, coveredQty: 223, uncoveredQty: 0, linkage: ['BRACKET_LEG'], previous: 250 }) },
  { name: 'NVDA SHORT intraday 4 Nov 15:10 ET: bracket buy-stop 203.35', asOf: '2026-11-04T20:10:00Z', ticker: 'NVDA', expected: C('CONFIRMED_STOP', 80.86, { confirmedRisk: 80.86, coveredQty: 98, uncoveredQty: 0, linkage: ['BRACKET_LEG'], previous: 250 }) },
  { name: 'CTVA SHORT intraday 5 Nov 14:30 ET: bracket buy-stop 11.96 (held leg)', asOf: '2026-11-05T19:30:00Z', ticker: 'CTVA', expected: C('CONFIRMED_STOP', 134.64, { confirmedRisk: 134.64, coveredQty: 1683, uncoveredQty: 0, linkage: ['BRACKET_LEG'], previous: 250 }) },
  { name: 'AAPL LONG 29 Oct 12:00 ET: bracket stop 349.24 (held leg), risk close to the $250 limit', asOf: '2026-10-29T17:00:00Z', ticker: 'AAPL', expected: C('CONFIRMED_STOP', 241.2, { confirmedRisk: 241.2, coveredQty: 360, uncoveredQty: 0, linkage: ['BRACKET_LEG'], previous: 250 }) },
  { name: 'TRMB LONG 29 Oct 13:20 ET: two lots, two bracket stops (730 sh @ 64.82, 300 sh @ 65.15) vs the broker average entry 65.138223', asOf: '2026-10-29T18:20:00Z', ticker: 'TRMB', expected: C('CONFIRMED_STOP', 232.3, { confirmedRisk: 232.3, coveredQty: 1030, uncoveredQty: 0, linkage: ['BRACKET_LEG', 'BRACKET_LEG'], previous: 250, note: '730 × 0.318223 + 300 × max(0, 65.138223 − 65.15) = 232.30; lot-level truth 183.77 + 45.00 = 228.77 (the broker reports one average entry)' }) },
].map((f) => ({ source: 'PAPER_HISTORY', ...f, broker: brokerAsOf(at(f.asOf)) }));

const fis = real[0];
const clone = (x) => JSON.parse(JSON.stringify(x));
const parentOf = (b) => b.openOrders.find((o) => o.symbol === 'FIS' && o.status === 'filled');
const leg = (b) => parentOf(b).legs.find((l) => /stop/.test(l.type));
const standalone = (id, extra) => ({ id, symbol: 'FIS', side: 'sell', type: 'stop', order_class: 'simple', status: 'new', qty: '499', filled_qty: '0', filled_avg_price: null, stop_price: '39.84', limit_price: null, time_in_force: 'gtc', submitted_at: '2026-11-02T21:00:00Z', filled_at: null, canceled_at: null, legs: [], ...extra });
const S = [];
const add = (name, mutate, expected) => { const b = clone(fis.broker); mutate(b); S.push({ name: `SYNTHETIC: ${name}`, expected, broker: b }); };
add('protective stop CANCELED (leg status canceled)', (b) => { leg(b).status = 'canceled'; }, C('UNKNOWN_NO_STOP', 250, { confirmedRisk: 0, coveredQty: 0, uncoveredQty: 499, gated: true, previous: 250 }));
add('stop covers only 300 of 499 shares (partial protection)', (b) => { leg(b).qty = '300'; }, C('PARTIAL_STOP', 250, { confirmedRisk: 63, coveredQty: 300, uncoveredQty: 199, gated: true, previous: 250 }));
add('stop REPLACED: the leg is replaced, the new standalone stop 499 @ 39.95 is open', (b) => { leg(b).status = 'replaced'; b.openOrders.push(standalone('fis-replacement-stop', { stop_price: '39.95' })); }, C('CONFIRMED_STOP', 49.9, { confirmedRisk: 49.9, coveredQty: 499, uncoveredQty: 0, linkage: ['STANDALONE'], previous: 250 }));
add('two open stops at different prices (leg 499 @ 39.84 + standalone 499 @ 39.50): ambiguous', (b) => { b.openOrders.push(standalone('fis-second-stop', { stop_price: '39.50' })); }, C('AMBIGUOUS_STOPS', 274.45, { confirmedRisk: 274.45, coveredQty: 499, uncoveredQty: 0, gated: true, previous: 250 }));
add('two open stops at the SAME price (leg + standalone, both 39.84): unambiguous', (b) => { b.openOrders.push(standalone('fis-same-price-stop', {})); }, C('CONFIRMED_STOP', 104.79, { confirmedRisk: 104.79, coveredQty: 499, uncoveredQty: 0, flags: ['OVERLAPPING_STOPS_SAME_PRICE'], previous: 250 }));
add('stop trailed above the entry (profit locked): risk 0, never negative', (b) => { leg(b).stop_price = '40.10'; }, C('CONFIRMED_STOP', 0, { confirmedRisk: 0, coveredQty: 499, uncoveredQty: 0, previous: 250 }));
add('PARTIAL FILL: entry filled 250 of 499 (parent partially_filled); Alpaca keeps the exit legs inactive until the entry fills completely', (b) => { const p = parentOf(b); p.status = 'partially_filled'; p.filled_qty = '250'; const pos = b.positions.find((x) => x.symbol === 'FIS'); pos.qty = '250'; pos.market_value = String(250 * 40.05); }, C('UNKNOWN_NO_STOP', 250, { confirmedRisk: 0, coveredQty: 0, uncoveredQty: 250, gated: true, previous: 250 }));
add('PARTIAL FILL protected by a standalone stop sized to the 250 filled shares', (b) => { const p = parentOf(b); p.status = 'partially_filled'; p.filled_qty = '250'; const pos = b.positions.find((x) => x.symbol === 'FIS'); pos.qty = '250'; pos.market_value = String(250 * 40.05); b.openOrders.push(standalone('fis-partial-stop', { qty: '250' })); }, C('CONFIRMED_STOP', 52.5, { confirmedRisk: 52.5, coveredQty: 250, uncoveredQty: 0, linkage: ['STANDALONE'], previous: 250 }));
add('standalone TRAILING STOP (Alpaca: not available as a bracket leg) reporting its current stop_price 39.84', (b) => { leg(b).status = 'canceled'; b.openOrders.push(standalone('fis-trailing', { type: 'trailing_stop', trail_price: '0.25', hwm: '40.09' })); }, C('CONFIRMED_STOP', 104.79, { confirmedRisk: 104.79, coveredQty: 499, uncoveredQty: 0, linkage: ['STANDALONE'], previous: 250 }));
add('standalone trailing stop WITHOUT a reported stop price: not verifiable', (b) => { leg(b).status = 'canceled'; b.openOrders.push(standalone('fis-trailing-noprice', { type: 'trailing_stop', trail_price: '0.25', stop_price: null })); }, C('UNKNOWN_NO_STOP', 250, { confirmedRisk: 0, coveredQty: 0, uncoveredQty: 499, gated: true, previous: 250 }));
add('only a same-side stop (a buy stop on a LONG is an entry, not protection)', (b) => { leg(b).side = 'buy'; }, C('UNKNOWN_NO_STOP', 250, { confirmedRisk: 0, coveredQty: 0, uncoveredQty: 499, gated: true, previous: 250 }));
add('STOP-LIMIT standalone exit (stop 39.84, limit 39.70) instead of the leg: risk to the limit, never assumed filled at the stop', (b) => { leg(b).status = 'canceled'; b.openOrders.push(standalone('fis-stop-limit', { type: 'stop_limit', limit_price: '39.70' })); }, C('CONFIRMED_STOP', 174.65, { confirmedRisk: 174.65, coveredQty: 499, uncoveredQty: 0, flags: ['STOP_LIMIT_NOT_GUARANTEED'], linkage: ['STANDALONE'], previous: 250 }));
add('ORPHAN held leg: the held stop is returned top-level WITHOUT its parent (not verifiable)', (b) => { const l = leg(b); b.openOrders = b.openOrders.filter((o) => o.symbol !== 'FIS'); b.openOrders.push({ ...l, legs: [] }); }, C('UNKNOWN_NO_STOP', 250, { confirmedRisk: 0, coveredQty: 0, uncoveredQty: 499, gated: true, previous: 250 }));
add('DUPLICATE id: the same leg also listed top-level (counted once)', (b) => { b.openOrders.push({ ...clone(leg(b)), legs: [] }); }, C('CONFIRMED_STOP', 104.79, { confirmedRisk: 104.79, coveredQty: 499, uncoveredQty: 0, previous: 250 }));
add('SHORT position with no protective buy stop', (b) => { const pos = b.positions.find((x) => x.symbol === 'FIS'); pos.qty = '-499'; pos.side = 'short'; pos.market_value = String(-499 * 40.05); }, C('UNKNOWN_NO_STOP', 250, { confirmedRisk: 0, coveredQty: 0, uncoveredQty: 499, gated: true, previous: 250 }));
add('broker response UNVERIFIED (stale): the existing last-known path, unchanged', (b) => { b.verified = false; }, { basis: 'UNVERIFIED_PATH', note: 'no Defect 2 evaluation; PORTFOLIO UNVERIFIED gate and last-known snapshot as before' });
add('open orders INCOMPLETE (null): the existing unverified path, unchanged', (b) => { b.openOrders = null; }, { basis: 'UNVERIFIED_PATH', note: 'no Defect 2 evaluation' });

const out = {
  generated: new Date().toISOString(),
  source: 'Archived Alpaca PAPER orders (GET-only; SHA-256 recorded with the replay dataset). Positions reconstructed from fills (average entry); open orders in the nested=true shape.',
  conservativeRiskToday: 250,
  fixtures: [...real, ...S.map((s) => ({ source: 'SYNTHETIC', asOf: fis.asOf, ticker: 'FIS', ...s }))],
};
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(out.fixtures.length, 'fixtures');
for (const f of out.fixtures) console.log(f.source.padEnd(13), f.ticker.padEnd(5), String(f.expected.basis).padEnd(16), f.expected.plannedRisk ?? '', '|', f.name.slice(0, 90));
