// Orders: the product master (/products, ~1,847 KB) is no longer fetched on mount.
//
// Every reader of it is inside a form — New Order, Edit Order, Import PO and the
// product quick-create — yet every visit to the order list downloaded and parsed
// it before first paint. It now loads when the browser is idle after the list
// has painted, and on demand when a form opens.
//
// Arriving late is only safe if nothing ever judges an EMPTY list as a real one:
//   - quick-create's Internal Code suggestion over [] proposes a code another
//     product already owns (a products_code_key 409 at best);
//   - the import wizard over [] shows every line unmatched and offers the
//     create-master door — duplicate masters;
//   - the pickers over [] read as "this customer has no products".
// So the list carries a status (idle/loading/ready/error), and each of those
// readers waits for `ready`. These tests pin the loader and that wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lib = await import('../../client/src/lib/onDemandList.js').catch(() => null);
const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

function need(name) {
  assert.ok(lib?.[name], `client/src/lib/onDemandList.js must export ${name}`);
  return lib[name];
}

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── The loader ─────────────────────────────────────────────────────────────

test('idle → loading → ready, and one fetch however many forms ask', async () => {
  const createOnDemandList = need('createOnDemandList');
  const d = deferred();
  let fetches = 0;
  const list = createOnDemandList(() => { fetches++; return d.promise; });
  const seen = [];
  list.subscribe(s => seen.push(s.status));
  assert.equal(list.state.status, 'idle');
  assert.deepEqual(list.state.rows, []);
  const a = list.ensure();
  const b = list.ensure();
  assert.equal(list.state.status, 'loading');
  d.resolve([{ id: 1 }]);
  assert.deepEqual(await a, [{ id: 1 }]);
  assert.deepEqual(await b, [{ id: 1 }]);
  assert.equal(list.state.status, 'ready');
  await list.ensure();
  assert.equal(fetches, 1, 'a ready list is memoised');
  assert.deepEqual(seen, ['loading', 'ready']);
});

test('a failed load is an ERROR, never an empty ready list — and the next ask retries', async () => {
  const createOnDemandList = need('createOnDemandList');
  let fail = true;
  let fetches = 0;
  const list = createOnDemandList(async () => { fetches++; if (fail) throw new Error('offline'); return [{ id: 2 }]; });
  await assert.rejects(list.ensure(), /offline/);
  assert.equal(list.state.status, 'error');
  assert.deepEqual(list.state.rows, []);
  fail = false;
  assert.deepEqual(await list.ensure(), [{ id: 2 }]);
  assert.equal(list.state.status, 'ready');
  assert.equal(fetches, 2);
});

test('a response that is not a list is an error, not zero products', async () => {
  const createOnDemandList = need('createOnDemandList');
  const list = createOnDemandList(async () => ({ error: 'nope' }));
  await assert.rejects(list.ensure());
  assert.equal(list.state.status, 'error');
});

test('stale: the next ask refetches, keeping the old rows on screen meanwhile', async () => {
  const createOnDemandList = need('createOnDemandList');
  let n = 0;
  const gates = [deferred(), deferred()];
  const list = createOnDemandList(() => gates[n++].promise);
  const first = list.ensure();
  gates[0].resolve([{ id: 1 }]);
  await first;
  list.markStale();
  assert.equal(list.state.status, 'ready', 'marking stale must not blank the pickers');
  const again = list.ensure();
  assert.equal(n, 2, 'a stale list is fetched again when a form asks');
  assert.equal(list.state.status, 'ready');
  assert.equal(list.state.refreshing, true);
  assert.deepEqual(list.state.rows, [{ id: 1 }]);
  gates[1].resolve([{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await again, [{ id: 1 }, { id: 2 }]);
  assert.equal(list.state.refreshing, false);
  assert.equal(list.state.stale, false);
});

test('a failed refresh keeps the last good list and stays stale', async () => {
  const createOnDemandList = need('createOnDemandList');
  let fail = false;
  const list = createOnDemandList(async () => { if (fail) throw new Error('offline'); return [{ id: 1 }]; });
  await list.ensure();
  list.markStale();
  fail = true;
  assert.deepEqual(await list.ensure(), [{ id: 1 }]);
  assert.equal(list.state.status, 'ready');
  assert.equal(list.state.stale, true, 'the next form open tries again');
});

test('a change announced while the fetch is out leaves the answer stale', async () => {
  const createOnDemandList = need('createOnDemandList');
  const d = deferred();
  const list = createOnDemandList(() => d.promise);
  const p = list.ensure();
  list.markStale();
  d.resolve([{ id: 1 }]);
  await p;
  assert.equal(list.state.status, 'ready');
  assert.equal(list.state.stale, true, 'the response may predate the change');
});

test('refresh() always refetches (after a quick-create or an import)', async () => {
  const createOnDemandList = need('createOnDemandList');
  let fetches = 0;
  const list = createOnDemandList(async () => { fetches++; return [{ id: fetches }]; });
  await list.ensure();
  assert.deepEqual(await list.refresh(), [{ id: 2 }]);
  assert.equal(fetches, 2);
});

// A quick-create or an import can finish while the FIRST load is still out. If
// that load then fails, the refresh they asked for must still fetch — otherwise
// the list stays in error and the product just created cannot be picked.
test('refresh() still fetches when the load it queued behind fails', async () => {
  const createOnDemandList = need('createOnDemandList');
  const first = deferred();
  let fetches = 0;
  const list = createOnDemandList(() => { fetches++; return fetches === 1 ? first.promise : Promise.resolve([{ id: 5 }]); });
  const loading = list.ensure().catch(() => {});
  const refreshed = list.refresh();
  first.reject(new Error('offline'));
  await loading;
  assert.deepEqual(await refreshed, [{ id: 5 }]);
  assert.equal(fetches, 2);
  assert.equal(list.state.status, 'ready');
});

test('scheduleIdle uses requestIdleCallback when the browser has it', () => {
  const scheduleIdle = need('scheduleIdle');
  const calls = [];
  const env = {
    requestIdleCallback: (fn, opts) => { calls.push(['ric', opts]); fn(); return 7; },
    cancelIdleCallback: h => calls.push(['cancel', h]),
    setTimeout: () => { throw new Error('must not fall back'); },
  };
  let ran = 0;
  const cancel = scheduleIdle(() => { ran++; }, { timeout: 2000, env });
  assert.equal(ran, 1);
  assert.deepEqual(calls[0], ['ric', { timeout: 2000 }]);
  cancel();
  assert.deepEqual(calls[1], ['cancel', 7]);
});

test('scheduleIdle falls back to setTimeout (older tablet Safari has no requestIdleCallback)', () => {
  const scheduleIdle = need('scheduleIdle');
  const calls = [];
  const env = {
    setTimeout: (fn, ms) => { calls.push(['timeout', ms]); fn(); return 9; },
    clearTimeout: h => calls.push(['clear', h]),
  };
  let ran = 0;
  const cancel = scheduleIdle(() => { ran++; }, { fallbackMs: 800, env });
  assert.equal(ran, 1);
  assert.deepEqual(calls[0], ['timeout', 800]);
  cancel();
  assert.deepEqual(calls[1], ['clear', 9]);
});

// ── The wiring in Orders.jsx ───────────────────────────────────────────────

const orders = () => read('client/src/pages/Orders.jsx');

test('the order list no longer fetches /products on mount', () => {
  const src = orders();
  const mount = src.slice(src.indexOf('useEffect(() => {\n    load();'));
  const effect = mount.slice(0, mount.indexOf('}, []);'));
  assert.ok(effect.includes('load();'), 'mount effect not found');
  assert.equal(effect.includes("'/products'"), false, '/products must not be fetched before the list paints');
  assert.equal(src.includes('useState([]);\n  const [showNew') && /const \[products, setProducts\] = useState\(\[\]\)/.test(src), false,
    'products must come from the on-demand list, not a bare useState([])');
  assert.match(src, /createOnDemandList\(\(\) => api\.get\('\/products'\)\)/);
});

test('it prefetches when idle after the list has painted', () => {
  const src = orders();
  assert.match(src, /scheduleIdle\(/, 'idle prefetch');
  assert.match(src, /if \(!ordersLoaded\) return/, 'the prefetch waits for the list');
});

test('opening any form asks for the list', () => {
  const src = orders();
  assert.match(src, /setShowNew\(true\);\s*ensureProducts\(\);/, 'New Order');
  assert.match(src, /setShowImport\(true\);\s*ensureProducts\(\);/, 'Import PO');
  const startEdit = src.slice(src.indexOf('const startEdit = () => {'));
  assert.ok(startEdit.slice(0, startEdit.indexOf('};')).includes('ensureProducts()'), 'Edit Order');
});

test('a product change elsewhere marks the list stale', () => {
  assert.match(orders(), /useRealtimeRefresh\(\(\) => productsList\.markStale\(\), \['products'\]/);
});

test('quick-create cannot open, or suggest a code, from an unloaded list', () => {
  const src = orders();
  const plus = src.match(/disabled=\{![a-zA-Z]+\.customer_id \|\| !canQuickCreate\}/g) || [];
  assert.equal(plus.length, 2, "both '+' buttons (new and edit) wait for the product list");
  assert.match(src, /suggestedCode=\{quickCustomerId && productsReady \? nextCodeForRows\(/,
    'the Internal Code suggestion is never computed from an empty list');
});

test("the pickers say 'Loading products…' until the list is ready", () => {
  const src = orders();
  assert.equal((src.match(/productPlaceholder\(/g) || []).length >= 2, true, 'both line pickers');
  assert.ok(src.includes("'Loading products…'"));
});

test('the import wizard is told the list status, and reloads through the list', () => {
  const src = orders();
  assert.match(src, /productsStatus=\{productsState\.status\}/);
  assert.match(src, /onRetryProducts=\{ensureProducts\}/);
  assert.equal(src.includes("api.get('/products').then(setProducts)"), false);
});

test('the wizard will not read or match a PO until the product list is ready', () => {
  const src = read('client/src/components/ImportPOWizard.jsx');
  assert.match(src, /productsStatus = 'ready'/, 'defaults to ready so any other caller is unchanged');
  assert.match(src, /if \(!file \|\| productsStatus !== 'ready'\) return;/,
    'handleFile must refuse to match against an unloaded list');
  assert.ok(src.includes('Loading products…'), 'the upload step says why it is waiting');
});
