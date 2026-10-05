import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A direct (trading) invoice bills goods straight off the shelf — board from the
// warehouse, cartons from loose FG — with no order, job card or challan. Proved
// through the REAL app against a real Postgres with the app's own schema:
//   • both kinds of stock leave the book in the same transaction as the bill;
//   • nothing on the production side is written;
//   • over-billing is refused whole (no half-taken stock);
//   • deleting the invoice puts every unit back where it came from.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, with
// PG_POOL_MAX=1 (the Vercel geometry — a pool call inside a transaction hangs).
//
//   DIRECT_INVOICE_PG=1 node --test src/direct-invoice-pg.test.js

const ENABLED = process.env.DIRECT_INVOICE_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('a direct (trading) invoice bills from stock and gives it back on delete — through the real app', {
  skip: ENABLED ? false : 'set DIRECT_INVOICE_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base, token;
  const PRODUCT = 1;
  const LOOSE = 500;
  let BOARD;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-invoice-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {},
    });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    await db.connect();
    await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET } = await import('./auth.js');
    const u = await db.one(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Direct invoice', 'direct-invoice@test.local', 'x', 'admin') RETURNING id, name, role`);
    token = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET);

    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;

    await db.q(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
                ON CONFLICT (product_id) DO UPDATE SET qty=EXCLUDED.qty`, [PRODUCT, LOOSE]);
    // A board of its own, in two piles, so FIFO and the return are both visible.
    BOARD = (await db.one(
      `INSERT INTO materials (name, category, unit) VALUES ('Trading Board 300 GSM', 'board', 'sheets') RETURNING id`)).id;
    await db.q(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, created_at)
                VALUES ($1,'TRD-A',100,100,'sheets','available', now() - interval '2 days'),
                       ($1,'TRD-B',400,400,'sheets','available', now() - interval '1 day')`, [BOARD]);
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const loose = async () => +((await db.one('SELECT qty FROM fg_stock WHERE product_id=$1', [PRODUCT]))?.qty ?? 0);
  const piles = async () => (await db.q(
    `SELECT batch_no, qty, status FROM stock_batches WHERE material_id=$1 ORDER BY batch_no`, [BOARD]))
    .map(b => `${b.batch_no}:${b.qty}:${b.status}`).join(' ');
  const counts = async () => db.one(`
    SELECT (SELECT COUNT(*)::int FROM orders) AS orders, (SELECT COUNT(*)::int FROM order_lines) AS order_lines,
           (SELECT COUNT(*)::int FROM job_cards) AS job_cards, (SELECT COUNT(*)::int FROM dispatches) AS dispatches,
           (SELECT COUNT(*)::int FROM dispatch_lines) AS dispatch_lines, (SELECT COUNT(*)::int FROM invoice_lines) AS invoice_lines`);

  let invoice;

  test('the picker offers what is on the shelf', async () => {
    const r = await call('GET', '/direct-invoices/items');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.boards.find(b => b.material_id === BOARD)?.available, 500);
    assert.equal(r.body.cartons.find(c => c.product_id === PRODUCT)?.available, LOOSE);
  });

  test('billing board and cartons takes both off the book and touches nothing in production', async () => {
    const before = await counts();
    const r = await call('POST', '/direct-invoices', {
      customer_id: 1,
      lines: [
        { item_type: 'board', material_id: BOARD, qty: 250, rate: 20, gst_pct: 12 },
        { item_type: 'carton', product_id: PRODUCT, qty: 120, rate: 5, gst_pct: 18 },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    invoice = r.body;
    assert.equal(invoice.kind, 'direct');
    assert.match(invoice.invoice_number, /^CI-TRD-\d{4}$/, 'its own series, never CI-INV-');
    assert.equal(invoice.subtotal, 250 * 20 + 120 * 5);
    assert.equal(+(invoice.cgst + invoice.sgst + invoice.igst).toFixed(2), 600 + 108);
    assert.equal(await piles(), 'TRD-A:0:exhausted TRD-B:250:available', 'oldest pile first');
    assert.equal(await loose(), LOOSE - 120);
    assert.deepEqual(await counts(), before, 'no order, job card, challan or dispatch-invoice line was written');
  });

  test('it reads back as an invoice — list, detail, payment', async () => {
    const list = await call('GET', '/invoices');
    const row = list.body.find(i => i.id === invoice.id);
    assert.equal(row.line_count, 2);
    const d = await call('GET', `/invoices/${invoice.id}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.lines.map(l => [l.item_type, l.qty, l.unit]), [['board', 250, 'sheets'], ['carton', 120, 'pcs']]);
    assert.ok(d.body.company?.gstin, 'prints under a billing entity');
    const pay = await call('POST', '/payments', { customer_id: 1, invoice_id: invoice.id, amount: 100 });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    const del = await call('DELETE', `/invoices/${invoice.id}`);
    assert.equal(del.status, 409, 'a paid invoice is not deleted');
    await db.q('DELETE FROM payments WHERE invoice_id=$1', [invoice.id]);
  });

  test('more than the shelf holds is refused, and nothing moves', async () => {
    const stock = [await piles(), await loose()];
    const board = await call('POST', '/direct-invoices', {
      customer_id: 1, lines: [{ item_type: 'board', material_id: BOARD, qty: 251, rate: 1, gst_pct: 12 }] });
    assert.equal(board.status, 409);
    assert.match(board.body.error, /Only 250 sheets/);
    const carton = await call('POST', '/direct-invoices', {
      customer_id: 1, lines: [
        { item_type: 'board', material_id: BOARD, qty: 10, rate: 1, gst_pct: 12 },
        { item_type: 'carton', product_id: PRODUCT, qty: LOOSE, rate: 1, gst_pct: 12 }] });
    assert.equal(carton.status, 409);
    assert.match(carton.body.error, /Only 380 pcs/);
    assert.deepEqual([await piles(), await loose()], stock, 'the refused invoice rolled its board line back too');
    assert.equal((await db.one(`SELECT COUNT(*)::int AS n FROM invoices WHERE kind='direct'`)).n, 1);
  });

  test('the CI-INV- series does not see a direct invoice', async () => {
    const r = await call('GET', '/billing/next-invoice-number');
    assert.doesNotMatch(r.body.invoice_number, /TRD/);
    const n = await call('GET', '/direct-invoices/next-number');
    assert.equal(n.body.invoice_number, 'CI-TRD-0002');
  });

  test('a trading item needs only a name: create it, stock it, bill it', async () => {
    const made = await call('POST', '/materials', { name: 'Ripple 200 ml jacket', category: 'trading', unit: 'pcs', gst_rate: 18, std_rate: 4.5 });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.id;
    assert.equal((await call('POST', '/inventory/adjust', { material_id: id, qty: 5000, note: 'Trading opening stock' })).status, 200);
    const master = await call('GET', '/direct-invoices/trading-items');
    assert.deepEqual(master.body.map(m => [m.name, m.in_stock]), [['Ripple 200 ml jacket', 5000]]);
    const picker = await call('GET', '/direct-invoices/items');
    assert.equal(picker.body.boards.find(b => b.material_id === id)?.category, 'trading');
    const inv = await call('POST', '/direct-invoices', {
      customer_id: 1, lines: [{ item_type: 'board', material_id: id, qty: 1200, rate: 4.5, gst_pct: 18 }] });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    assert.equal(inv.body.subtotal, 5400);
    assert.equal((await call('GET', '/direct-invoices/trading-items')).body[0].in_stock, 3800);
    assert.equal((await call('DELETE', `/invoices/${inv.body.id}`)).status, 200);
    assert.equal((await call('GET', '/direct-invoices/trading-items')).body[0].in_stock, 5000);
  });

  test('accounts: a purchase bill lands trading stock and a payable; payment, ledger and cash book follow', async () => {
    const item = (await call('GET', '/direct-invoices/trading-items')).body[0];
    const stock0 = item.in_stock;
    const refused = await call('POST', '/purchase-bills', { vendor_id: 1, lines: [{ material_id: BOARD, qty: 10, rate: 1 }] });
    assert.equal(refused.status, 409, 'board is received through a GRN, never off a bill');
    const bill = await call('POST', '/purchase-bills', {
      vendor_id: 1, vendor_bill_no: 'V-77', bill_date: '2026-10-01',
      lines: [{ material_id: item.id, qty: 1000, rate: 90, gst_pct: 0 }, { description: 'Freight', qty: 1, rate: 5000, gst_pct: 18 }] });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    assert.match(bill.body.bill_number, /^CI-PB-\d{4}$/);
    assert.equal(bill.body.total, 90000 + 5000 + 900);
    const stock = async () => (await call('GET', '/direct-invoices/trading-items')).body[0].in_stock;
    assert.equal(await stock(), stock0 + 1000, 'only the item line lands stock');

    const over = await call('POST', '/vendor-payments', { vendor_id: 1, purchase_bill_id: bill.body.id, amount: 95901 });
    assert.equal(over.status, 409);
    const pay = await call('POST', '/vendor-payments', { vendor_id: 1, purchase_bill_id: bill.body.id, amount: 40000, mode: 'rtgs', paid_on: '2026-10-03' });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.match(pay.body.payment_number, /^CI-PAY-\d{4}$/);

    const payables = (await call('GET', '/accounts/payables')).body;
    assert.deepEqual(payables.map(v => [v.vendor_id, v.billed, v.paid, v.outstanding, v.open_bills]), [[1, 95900, 40000, 55900, 1]]);
    const ledger = (await call('GET', '/accounts/ledger?party=vendor&id=1')).body;
    assert.deepEqual(ledger.entries.map(e => [e.kind, e.debit, e.credit, e.balance]),
      [['Purchase bill', 0, 95900, 95900], ['Payment', 40000, 0, 55900]]);

    const inv = await call('POST', '/direct-invoices', { customer_id: 1, invoice_date: '2026-10-02',
      lines: [{ item_type: 'board', material_id: item.id, qty: 100, rate: 105, gst_pct: 0 }] });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    const rcpt = await call('POST', '/payments', { customer_id: 1, invoice_id: inv.body.id, amount: 10500 });
    assert.equal(rcpt.status, 200, JSON.stringify(rcpt.body));
    const cust = (await call('GET', '/accounts/ledger?party=customer&id=1')).body;
    assert.deepEqual(cust.entries.filter(e => e.number === inv.body.invoice_number || e.kind === 'Receipt')
      .map(e => [e.kind, e.debit, e.credit]), [['Invoice', 10500, 0], ['Receipt', 0, 10500]]);
    assert.equal(cust.balance, cust.entries.reduce((s, e) => s + e.debit - e.credit, 0));

    const book = (await call('GET', '/accounts/cashbook')).body;
    assert.deepEqual(book.entries.map(e => [e.direction, e.money_in, e.money_out]), [['out', 0, 40000], ['in', 10500, 0]]);
    assert.equal(book.closing, -29500);
    const later = (await call('GET', '/accounts/cashbook?from=2026-10-04&to=2026-10-04')).body;
    assert.equal(later.opening, -40000, 'money moved before the period is the opening balance');

    assert.equal((await call('DELETE', `/purchase-bills/${bill.body.id}`)).status, 409, 'a paid bill is not deleted');
    assert.equal((await call('DELETE', `/vendor-payments/${pay.body.id}`)).status, 200);
    assert.equal((await call('DELETE', `/payments/${rcpt.body.id}`)).status, 200);
    assert.equal((await db.one('SELECT status FROM invoices WHERE id=$1', [inv.body.id])).status, 'open', 'the receipt is gone, so the invoice is owed again');
    assert.equal((await call('DELETE', `/invoices/${inv.body.id}`)).status, 200);
    assert.equal((await call('DELETE', `/purchase-bills/${bill.body.id}`)).status, 200);
    assert.equal(await stock(), stock0, 'the bill is gone and so are its goods');
  });

  test('deleting it returns every sheet to its own pile and every carton to FG', async () => {
    const r = await call('DELETE', `/invoices/${invoice.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await piles(), 'TRD-A:100:available TRD-B:400:available');
    assert.equal(await loose(), LOOSE);
    assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM direct_invoice_lines')).n, 0);
    assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM invoices WHERE id=$1', [invoice.id])).n, 0);
  });
});
