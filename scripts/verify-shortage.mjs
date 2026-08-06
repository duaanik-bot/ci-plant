// Execute BOTH shortage decisions against a database and assert the outcomes.
//
//   node scripts/verify-shortage.mjs          against $DATABASE_URL (default local sandbox)
//
// Why this exists as a script and not a unit test: the shortage path writes —
// it raises a challan, drains FG stock, forces a line status and completes a
// sales order. None of that is provable with pure functions, and the test suite
// deliberately has no database. Until this ran, the riskiest code in Dispatch
// had never once executed: no live line has ever qualified as a shortage.
//
// Everything runs inside the real tx() helper and is ALWAYS rolled back — the
// fixtures it invents (an order, a line, a closed job card, an FG level) never
// survive. It reuses real products so it does not have to satisfy every NOT NULL
// on products/materials.
import { connect, tx } from '../server/src/db.js';
import { resolveShortage } from '../server/src/routes/dispatch.js';

process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:5439/cierp';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) {
  console.error('REFUSING: this writes (challans, FG, order status). Point it at a local sandbox.');
  process.exit(1);
}
await connect();

const ROLLBACK = Symbol('rollback');
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures++; };

const run = async (qc, oc) => {
  const prods = await qc(`SELECT p.id, p.customer_id FROM products p WHERE p.customer_id IS NOT NULL LIMIT 4`);
  if (prods.length < 4) throw new Error('need at least 4 products with a customer');
  let i = 0;
  const build = async (label, { done = 0, fg = 9000 } = {}) => {
    const p = prods[i++];
    const [ord] = await qc(`INSERT INTO orders (po_number, po_date, customer_id, status)
                            VALUES ($1,'2026-01-01',$2,'pending') RETURNING id`, [`ZZ-PO-${label}`, p.customer_id]);
    const [line] = await qc(`INSERT INTO order_lines (order_id, product_id, qty, rate, status, dispatched_qty, tolerance_pct)
                             VALUES ($1,$2,10000,10,'produced',$3,10) RETURNING id`, [ord.id, p.id, done]);
    await qc(`INSERT INTO job_cards (jc_number, order_line_id, product_id, qty_planned, sheets_issued, qty_produced, status, closed_at)
              VALUES ($1,$2,$3,10000,10000,9000,'closed',now())`, [`ZZ-JC-${label}`, line.id, p.id]);
    await qc(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
              ON CONFLICT (product_id) DO UPDATE SET qty=EXCLUDED.qty`, [p.id, fg]);
    return { line: line.id, order: ord.id, product: p.id };
  };
  const state = async x => ({
    line: await oc('SELECT status, qty, dispatched_qty FROM order_lines WHERE id=$1', [x.line]),
    order: await oc('SELECT status FROM orders WHERE id=$1', [x.order]),
    fg: (await oc('SELECT qty FROM fg_stock WHERE product_id=$1', [x.product]))?.qty ?? 0,
  });

  console.log('\nreplan — ordered 10,000, made 9,000, nothing shipped');
  const a = await build('A');
  const r1 = await resolveShortage({ lineId: a.line, action: 'replan', reason: 'high rejection' }, qc, oc, 'verify');
  const sa = await state(a);
  check(sa.line.status === 'planned', "line returns to 'planned' for the planner");
  check(r1.balance_to_produce === 10000, 'balance is the whole order when nothing shipped');
  check(sa.fg === 9000, 'finished goods are left alone');

  console.log('\nclose short');
  const b = await build('B');
  const r2 = await resolveShortage({ lineId: b.line, action: 'close', reason: 'high rejection' }, qc, oc, 'verify');
  const sb = await state(b);
  check(sb.line.status === 'dispatched', 'line closes as dispatched');
  check(sb.line.dispatched_qty === 9000 && r2.short_by === 1000, 'ships the 9,000 on hand, 1,000 short');
  check(!!r2.challan, 'a challan is raised');
  check(sb.fg === 0, 'finished goods leave stock');
  check(sb.order.status === 'completed' && r2.order_completed, 'the sales order completes');

  console.log('\nreplan after a PARTIAL shipment — 7,000 gone, 2,000 on hand');
  const c = await build('C', { done: 7000, fg: 2000 });
  const r3 = await resolveShortage({ lineId: c.line, action: 'replan', reason: 'balance short' }, qc, oc, 'verify');
  check(r3.balance_to_produce === 3000, 'THE 10x TRAP: re-plans the 3,000 balance, not the whole 10,000');

  console.log('\nguard — a job card that has NOT closed');
  const d = await build('D');
  await qc(`UPDATE job_cards SET status='in_progress' WHERE order_line_id=$1`, [d.line]);
  let refused = false;
  try { await resolveShortage({ lineId: d.line, action: 'close', reason: 'x' }, qc, oc, 'verify'); }
  catch (e) { refused = e.status === 409; }
  check(refused, 'a line still in production is refused, not treated as short');

  throw ROLLBACK;
};

try { await tx(run); } catch (e) { if (e !== ROLLBACK) throw e; }
console.log(`\nrolled back — nothing persisted.\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
