import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeKey, joinIdentical, mintsNumber, JOIN_WINDOW_MS } from '../../client/src/lib/writeOnce.js';
import { api, setErrorHandler } from '../../client/src/api.js';
import { writesInFlight } from '../../client/src/lib/inFlight.js';

// A double-clicked Save sends the same write twice. With the document-number
// lock in place the server saves both (a second GRN, PO, receipt…), so the
// client joins an identical minting POST to the one already on the wire
// (client/src/lib/writeOnce.js). These pin the rule and drive the real api.js;
// mint-routes-join-once.test.js holds the route list to the server.

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(r => setTimeout(r, 0));

// ── the rule ────────────────────────────────────────────────────────────────
test('a minting POST is keyed on url, body and sign-in', () => {
  const k = writeKey('POST', '/grns', { po_line_id: 7, qty: 5000 }, 't');
  assert.ok(k);
  assert.equal(writeKey('POST', '/grns', { po_line_id: 7, qty: 5000 }, 't'), k);
  assert.notEqual(writeKey('POST', '/grns', { po_line_id: 7, qty: 4000 }, 't'), k, 'another quantity is another write');
  assert.notEqual(writeKey('POST', '/grns', { po_line_id: 8, qty: 5000 }, 't'), k, 'another line is another write');
  assert.notEqual(writeKey('POST', '/grns/direct', { po_line_id: 7, qty: 5000 }, 't'), k);
  assert.notEqual(writeKey('POST', '/grns', { po_line_id: 7, qty: 5000 }, 'another user'), k);
  assert.ok(writeKey('POST', '/order-lines/412/raise-pr', undefined, 't'), 'a body-less minting POST is still keyed');
});

test('only POSTs that mint a number are ever joined', () => {
  assert.ok(mintsNumber('/grns') && mintsNumber('/grns/bulk') && mintsNumber('/payments'));
  assert.ok(mintsNumber('/order-lines/412/raise-pr'), ':id segments match');
  assert.ok(mintsNumber('/tooling/procurement/die/grns'), ':family segments match');
  assert.ok(mintsNumber('/grns?from=dock'), 'the query string is not part of the route');
  assert.ok(!mintsNumber('/grns/105/qc'), 'a longer path is another route');
  assert.ok(!mintsNumber('/order-lines/412/raise-pr/extra'));
  assert.equal(writeKey('GET', '/grns', undefined, 't'), null, 'a read');
  assert.equal(writeKey('PUT', '/grns', { qty: 1 }, 't'), null, 'not a POST');
  // Writes that MEAN it when they repeat inside one round trip — found by the
  // pre-ship sweep of 2026-09-18 — go out every time, as before.
  assert.equal(writeKey('POST', '/floor/queue/move', { job_stage_id: 9, dir: 'up' }, 't'), null, 'each arrow tap is one place');
  assert.equal(writeKey('PATCH', '/status-sheet/line/5', { is_p1: 1 }, 't'), null, 'P1 on-off-on must end on');
  assert.equal(writeKey('POST', '/job-stages/31/runs', { qty_good: 100 }, 't'), null, 'the day count is additive');
  assert.equal(writeKey('POST', '/chat/conversations/2/messages', { body: 'ok' }, 't'), null, '"ok" twice is two messages');
  assert.equal(writeKey('POST', '/notifications/read', { all: true }, 't'), null);
});

test('a body that cannot be serialised is never joined', () => {
  const loop = {}; loop.self = loop;
  assert.equal(writeKey('POST', '/grns', loop, 't'), null);
  assert.equal(writeKey('POST', '/grns', () => 1, 't'), null);
});

test('an identical write while one is in flight shares it; after it settles the next one goes out', async () => {
  const inFlight = new Map();
  let started = 0;
  const d = deferred();
  const start = () => { started++; return d.promise; };
  const a = joinIdentical(inFlight, 'k', start);
  const b = joinIdentical(inFlight, 'k', start);
  assert.equal(started, 1);
  assert.equal(a, b, 'the second caller holds the first call\'s promise');
  d.resolve({ id: 1 });
  assert.deepEqual(await b, { id: 1 });
  await tick();
  assert.equal(inFlight.size, 0, 'the slot clears once the write settles');
  joinIdentical(inFlight, 'k', () => { started++; return Promise.resolve(); });
  assert.equal(started, 2, 'a later identical write is a new write');
});

test('a refusal is shared too, and a retry after it goes out', async () => {
  const inFlight = new Map();
  const d = deferred();
  const a = joinIdentical(inFlight, 'k', () => d.promise);
  const b = joinIdentical(inFlight, 'k', () => assert.fail('joined, not started'));
  d.reject(new Error('refused'));
  await assert.rejects(a, /refused/);
  await assert.rejects(b, /refused/);
  await tick();
  let again = false;
  await joinIdentical(inFlight, 'k', async () => { again = true; });
  assert.ok(again);
});

test('a write still hanging after the window no longer swallows the next press', async () => {
  const inFlight = new Map();
  let started = 0;
  const hung = new Promise(() => {});                       // plant Wi-Fi dropped mid-save
  const retry = deferred();
  const start = () => { started++; return started === 1 ? hung : retry.promise; };
  joinIdentical(inFlight, 'k', start, 1_000);
  joinIdentical(inFlight, 'k', start, 1_000 + JOIN_WINDOW_MS - 1);
  assert.equal(started, 1, 'a press inside the window is joined');
  const second = joinIdentical(inFlight, 'k', start, 1_000 + JOIN_WINDOW_MS);
  assert.equal(started, 2, 'a press after it goes out');
  assert.equal(joinIdentical(inFlight, 'k', start, 1_000 + JOIN_WINDOW_MS + 5), second, 'and a double-click on the retry joins the retry');
  assert.equal(started, 2);
  retry.resolve('sent');
  assert.equal(await second, 'sent');
});

test('a null key always starts its own write', () => {
  let started = 0;
  const inFlight = new Map();
  joinIdentical(inFlight, null, () => { started++; return Promise.resolve(); });
  joinIdentical(inFlight, null, () => { started++; return Promise.resolve(); });
  assert.equal(started, 2);
  assert.equal(inFlight.size, 0);
});

// ── through the real api.js ─────────────────────────────────────────────────
function fakeFetch() {
  const calls = [];
  const fetch = (url, opts) => {
    const d = deferred();
    calls.push({ url, opts, d });
    return d.promise;
  };
  const answer = (i, status, data) => calls[i].d.resolve({ status, ok: status < 400, json: async () => data });
  return { calls, fetch, answer };
}

test('api.post: a double-click sends ONE request and both callers get its answer', async () => {
  const f = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.fetch;
  try {
    const body = { po_line_id: 128, qty: 2000, supplier_invoice_no: '3255' };
    const first = api.post('/grns', body);
    const second = api.post('/grns', { ...body });   // a fresh but identical object, as a re-render builds
    await tick();
    assert.equal(f.calls.length, 1, 'the second click did not reach the network');
    assert.equal(writesInFlight(), 1, 'one write on the wire, counted once');
    f.answer(0, 200, { id: 105, grn_number: 'CI-GRN-0105' });
    assert.deepEqual(await first, { id: 105, grn_number: 'CI-GRN-0105' });
    assert.equal(await second, await first);
    await tick();
    assert.equal(writesInFlight(), 0);

    // The same receipt entered again later is a real second receipt.
    const later = api.post('/grns', body);
    await tick();
    assert.equal(f.calls.length, 2);
    f.answer(1, 200, { id: 106 });
    assert.deepEqual(await later, { id: 106 });
  } finally { globalThis.fetch = realFetch; }
});

test('api.post: different bodies are different writes, both sent', async () => {
  const f = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.fetch;
  try {
    const a = api.post('/grns', { po_line_id: 127, qty: 800 });
    const b = api.post('/grns', { po_line_id: 128, qty: 2000 });
    await tick();
    assert.equal(f.calls.length, 2);
    f.answer(0, 200, { id: 1 }); f.answer(1, 200, { id: 2 });
    assert.deepEqual([await a, await b], [{ id: 1 }, { id: 2 }]);
  } finally { globalThis.fetch = realFetch; }
});

test('api.post: a refused double-click shows ONE error and both callers see the refusal', async () => {
  const f = fakeFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.fetch;
  const toasts = [];
  setErrorHandler(msg => toasts.push(msg));
  try {
    const a = api.post('/payments', { customer_id: 3, amount: 50000 });
    const b = api.post('/payments', { customer_id: 3, amount: 50000 });
    await tick();
    assert.equal(f.calls.length, 1);
    f.answer(0, 409, { error: 'Invoice already paid' });
    await assert.rejects(a, /already paid/);
    await assert.rejects(b, /already paid/);
    assert.deepEqual(toasts, ['Invoice already paid']);
  } finally { globalThis.fetch = realFetch; setErrorHandler(() => {}); }
});
