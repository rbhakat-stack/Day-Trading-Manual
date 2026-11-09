// Builds Defect 2 fixtures: REAL broker states (archived PAPER orders, reconstructed as of an instant) + labelled SYNTHETIC variants.
import { readFileSync, writeFileSync } from 'node:fs';
const ORDERS = JSON.parse(readFileSync(process.argv[3] ?? 'data/broker-orders-paper.json', 'utf8'));
const ms = (x) => (x ? Date.parse(x) : null);
const OPEN = new Set(['new', 'held', 'accepted', 'pending_new', 'partially_filled']);
const keep = (o) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, order_class: o.order_class, status: o.status, qty: o.qty, filled_qty: o.filled_qty, filled_avg_price: o.filled_avg_price, stop_price: o.stop_price, limit_price: o.limit_price, time_in_force: o.time_in_force, submitted_at: o.submitted_at, filled_at: o.filled_at, canceled_at: o.canceled_at, legs: (o.legs ?? []).map(keep) });
/** Legs exist from their creation (with the parent); a leg not yet routed (submitted later) is reported 'held' — as Alpaca does for the waiting OCO leg. */
function orderAsOf(o, t, parentFilled = true, isLeg = false) {
  const sub = isLeg ? (ms(o.created_at) ?? ms(o.submitted_at)) : (ms(o.submitted_at) ?? ms(o.created_at)); if (sub !== null && sub > t) return null;
  const filled = ms(o.filled_at), canceled = ms(o.canceled_at), expired = ms(o.expired_at);
  let status = parentFilled ? 'new' : 'held', filledQty = '0', avg = null;
  if (filled !== null && filled <= t) { status = 'filled'; filledQty = o.filled_qty; avg = o.filled_avg_price; } else if (canceled !== null && canceled <= t) status = 'canceled'; else if (expired !== null && expired <= t) status = 'expired';
  else if (isLeg && parentFilled && ms(o.submitted_at) !== null && ms(o.submitted_at) > t) status = 'held';
  const legs = (o.legs ?? []).map((l) => orderAsOf({ ...l, submitted_at: l.submitted_at ?? o.submitted_at }, t, status === 'filled', true)).filter(Boolean);
  return { ...keep(o), status, filled_qty: filledQty, filled_avg_price: avg, filled_at: status === 'filled' ? o.filled_at : null, canceled_at: status === 'canceled' ? o.canceled_at : null, legs };
}
function brokerAsOf(t) {
  const asOf = ORDERS.map((o) => orderAsOf(o, t)).filter(Boolean);
  const et = (x) => new Date(x - 5 * 3600e3).toISOString().slice(0, 10);
  const today = asOf.filter((o) => et(ms(o.submitted_at)) === et(t));
  const openOrders = [];
  for (const o of asOf) { if (OPEN.has(o.status)) openOrders.push(o); else if (o.status === 'filled') for (const l of o.legs) if (OPEN.has(l.status)) openOrders.push({ ...l, legs: [] }); } // includes 'held' OCO legs of filled parents
  const pos = new Map(), cost = new Map(), lots = new Map();
  const fills = asOf.flatMap((o) => [o, ...o.legs]).filter((x) => x.status === 'filled').sort((a, b) => ms(a.filled_at) - ms(b.filled_at)); // chronological
  for (const x of fills) {
    const q = (x.side === 'buy' ? 1 : -1) * Number(x.filled_qty);
    const prev = pos.get(x.symbol) ?? 0;
    if (prev === 0 || Math.sign(prev) === Math.sign(q)) { // opening / adding → weighted average entry
      const c0 = cost.get(x.symbol) ?? 0; cost.set(x.symbol, (c0 * Math.abs(prev) + Number(x.filled_avg_price) * Math.abs(q)) / (Math.abs(prev) + Math.abs(q)));
    }
    pos.set(x.symbol, prev + q);
  }
  const positions = [...pos].filter(([, q]) => q !== 0).map(([symbol, q]) => ({ symbol, qty: String(q), side: q > 0 ? 'long' : 'short', avg_entry_price: String(+cost.get(symbol).toFixed(6)), market_value: String(+(q * cost.get(symbol)).toFixed(2)) }));
  return { verified: true, orders: today, positions, openOrders };
}
const at = (iso) => Date.parse(iso);
const real = [
  { name: 'FIS LONG held overnight (2 → 3 Nov), GTC bracket stop 39.84 open at the 09:31 pre-open', asOf: '2026-11-03T14:31:00Z', ticker: 'FIS', expected: { basis: 'CONFIRMED_STOP', qty: 499, entry: 40.05, stop: 39.84, plannedRisk: 104.79 } },
  { name: 'MCD LONG held overnight (3 → 4 Nov), GTC bracket stop 261.01 open at the 09:31 pre-open', asOf: '2026-11-04T14:31:00Z', ticker: 'MCD', expected: { basis: 'CONFIRMED_STOP', qty: 75, entry: 263.55, stop: 261.01, plannedRisk: 190.5 } },
  { name: 'GM LONG intraday 2 Nov 15:10 ET, bracket stop 89.22 open', asOf: '2026-11-02T20:10:00Z', ticker: 'GM', expected: { basis: 'CONFIRMED_STOP', qty: 223, entry: 89.49, stop: 89.22, plannedRisk: 60.21 } },
  { name: 'NVDA SHORT intraday 4 Nov 15:10 ET, bracket buy-stop 203.35 open', asOf: '2026-11-04T20:10:00Z', ticker: 'NVDA', expected: { basis: 'CONFIRMED_STOP', qty: -98, entry: 202.524898, stop: 203.35, plannedRisk: 80.86 } },
  { name: 'CTVA SHORT intraday 5 Nov 14:30 ET, bracket buy-stop 11.96 open', asOf: '2026-11-05T19:30:00Z', ticker: 'CTVA', expected: { basis: 'CONFIRMED_STOP', qty: -1683, entry: 11.88, stop: 11.96, plannedRisk: 134.64 } },
  { name: 'AAPL LONG 29 Oct 12:00 ET, bracket stop 349.24 open (risk close to the $250 limit)', asOf: '2026-10-29T17:00:00Z', ticker: 'AAPL', expected: { basis: 'CONFIRMED_STOP', qty: 360, entry: 349.91, stop: 349.24, plannedRisk: 241.2 } },
  { name: 'TRMB LONG 29 Oct 13:20 ET: two brackets on one symbol (730 sh stop 64.82, 300 sh stop 65.15) — risk per stop leg against the average entry', asOf: '2026-10-29T18:20:00Z', ticker: 'TRMB', expected: { basis: 'CONFIRMED_STOP', qty: 1030, plannedRisk: 'per stop leg: Σ legQty × (avgEntry − legStop)', note: 'the broker reports one aggregate position (average entry); lot-level entries are not available from /v2/positions' } },
].map((f) => ({ source: 'PAPER_HISTORY', ...f, broker: brokerAsOf(at(f.asOf)) }));

// SYNTHETIC variants derived from the FIS overnight state (labelled; every other field unchanged)
const base = real[0];
const clone = (x) => JSON.parse(JSON.stringify(x));
const fisStop = (b) => b.openOrders.find((o) => o.symbol === 'FIS' && /stop/.test(o.type));
const synth = [];
{ const b = clone(base.broker); b.openOrders = b.openOrders.filter((o) => !(o.symbol === 'FIS' && /stop/.test(o.type))); synth.push({ name: 'SYNTHETIC: protective stop CANCELED — no stop at the broker', expected: { basis: 'UNKNOWN_NO_STOP', qty: 499, plannedRisk: 'CONSERVATIVE' }, broker: b }); }
{ const b = clone(base.broker); fisStop(b).qty = '300'; synth.push({ name: 'SYNTHETIC: stop covers only 300 of 499 shares (partial protection)', expected: { basis: 'PARTIAL_STOP', qty: 499, confirmedRisk: 63, uncoveredQty: 199, plannedRisk: 'confirmed 63 + CONSERVATIVE for 199 sh' }, broker: b }); }
{ const b = clone(base.broker); const s = fisStop(b); s.stop_price = '39.95'; s.id = `${s.id}-replacement`; synth.push({ name: 'SYNTHETIC: stop REPLACED (raised to 39.95; only the replacement is open)', expected: { basis: 'CONFIRMED_STOP', qty: 499, stop: 39.95, plannedRisk: 49.9 }, broker: b }); }
{ const b = clone(base.broker); const s = fisStop(b); b.openOrders.push({ ...clone(s), id: `${s.id}-second`, stop_price: '39.50' }); synth.push({ name: 'SYNTHETIC: two open stops at different prices each covering 499 shares (ambiguous)', expected: { basis: 'CONFIRMED_STOP_WORST', qty: 499, stop: 39.5, plannedRisk: 274.45, flags: ['AMBIGUOUS_STOPS'] }, broker: b }); }
{ const b = clone(base.broker); fisStop(b).stop_price = '40.10'; synth.push({ name: 'SYNTHETIC: stop trailed above the entry (profit locked) → risk 0, never negative', expected: { basis: 'CONFIRMED_STOP', qty: 499, stop: 40.1, plannedRisk: 0 }, broker: b }); }
{ const b = clone(base.broker); const p = b.positions.find((x) => x.symbol === 'FIS'); p.qty = '250'; p.market_value = String(250 * 40.05); fisStop(b).qty = '250'; synth.push({ name: 'SYNTHETIC: PARTIAL FILL — 250 of 499 filled, stop leg sized to the filled 250', expected: { basis: 'CONFIRMED_STOP', qty: 250, plannedRisk: 52.5 }, broker: b }); }
{ const b = clone(base.broker); const s = fisStop(b); s.type = 'trailing_stop'; s.trail_price = '0.25'; synth.push({ name: 'SYNTHETIC: trailing stop reporting a current stop price', expected: { basis: 'CONFIRMED_STOP', qty: 499, stop: 39.84, plannedRisk: 104.79 }, broker: b }); }
{ const b = clone(base.broker); fisStop(b).side = 'buy'; synth.push({ name: 'SYNTHETIC: only a same-side stop (an entry, not protection) — not a protective exit', expected: { basis: 'UNKNOWN_NO_STOP', qty: 499, plannedRisk: 'CONSERVATIVE' }, broker: b }); }
{ const b = clone(base.broker); b.verified = false; synth.push({ name: 'SYNTHETIC: broker response UNVERIFIED (stale)', expected: { basis: 'LAST_KNOWN', note: 'unchanged path: last verified snapshot + PORTFOLIO UNVERIFIED gate' }, broker: b }); }

const out = {
  generated: new Date().toISOString(),
  source: 'Archived Alpaca PAPER orders (GET-only; d3replay2/data/broker-orders-paper.json, SHA-256 in DATASET_SHA256.txt). Positions reconstructed from fills; market_value at the fill price.',
  conservativeRiskToday: 250,
  fixtures: [...real, ...synth.map((s) => ({ source: 'SYNTHETIC', asOf: base.asOf, ticker: 'FIS', ...s }))],
};
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
for (const f of out.fixtures) {
  const p = f.broker.positions.find((x) => x.symbol === f.ticker);
  const st = f.broker.openOrders.filter((o) => o.symbol === f.ticker && /stop/.test(o.type)).map((o) => `${o.side} ${o.type} ${o.qty}@${o.stop_price} ${o.status}`);
  console.log(f.source.padEnd(13), f.ticker.padEnd(5), 'pos', p ? `${p.qty}@${p.avg_entry_price}` : 'NONE', '| stops', st.join('; ') || 'none', '| expected', f.expected.basis, JSON.stringify(f.expected.plannedRisk));
}
