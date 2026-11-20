import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lightForJobCards } from './readiness-light.js';
import { printingEligibility } from './shade-flow.js';
import { stampPlateState, loadPlateState } from './helpers.js';
import { blankNoise } from './source-scan.js';

// The traffic light's three lookups (cutting stage, shade card, spec) are keyed by
// the cards alone, so they go together; and plate state is keyed by the cards
// alone, so the boards start it alongside readiness instead of after board state.
// One round trip per wave once the pool can overlap (docs/perf/2026-11-20-pool-size.md).

const keyOf = sql => /stage='cutting'/.test(sql) ? 'cut' : /FROM shade_cards/.test(sql) ? 'shade' : /spec_incomplete/.test(sql) ? 'spec' : '?';
const FIX = {
  cut: { list: [{ job_card_id: 1, status: 'completed' }, { job_card_id: 2, status: 'pending' }] },
  shade: { list: [{ product_id: 10, sc_number: 'SC-1', status: 'approved', creation_date: '2026-11-01', active: 1 }] },
  spec: { list: [{ product_id: 10, spec_incomplete: 0 }, { product_id: 11, spec_incomplete: 1 }] },
};
const CARDS = [{ id: 1, product_id: 10 }, { id: 2, product_id: 11 }, { id: 3, product_id: null }];
function fakeOne({ fail } = {}) {
  const started = []; const seenAtResolve = {};
  const oc = sql => {
    const key = keyOf(sql); started.push(key);
    return new Promise((resolve, reject) => setImmediate(() => {
      seenAtResolve[key] = [...started];
      if (key === fail) reject(new Error(`boom: ${key}`)); else resolve(FIX[key]);
    }));
  };
  return { oc, started, seenAtResolve };
}

test("the light's cut, shade and spec lookups start together", async () => {
  const db = fakeOne();
  await lightForJobCards(CARDS, db.oc);
  assert.deepEqual([...db.seenAtResolve.cut].sort(), ['cut', 'shade', 'spec']);
});

test('lightForJobCards returns the same map as the sequential version', async () => {
  const now = await lightForJobCards(CARDS, fakeOne().oc);
  const ref = await lightReference(CARDS, fakeOne().oc);
  assert.deepEqual([...now], [...ref]);
});

test('lightForJobCards still rejects when a lookup fails', async () => {
  await assert.rejects(lightForJobCards(CARDS, fakeOne({ fail: 'shade' }).oc), /boom: shade/);
});

test('no cards, no statement', async () => {
  const db = fakeOne();
  assert.equal((await lightForJobCards([], db.oc)).size, 0);
  assert.equal(db.started.length, 0);
});

// Safe to run beside readiness and board state only while it writes plate fields
// and nothing else.
test('stampPlateState touches only plate fields', async () => {
  const rows = [{ id: 1, gang_run_id: null, board_state: 'covered', light: 'green' }, { id: 2, gang_run_id: null }];
  const before = rows.map(r => ({ ...r }));
  const qc = async () => [{ job_card_id: 1, status: 'available', component_type: 'cyan', component_label: 'C' }];
  await stampPlateState(rows, { jobCardIdOf: r => r.id, gangIdOf: r => r.gang_run_id, qc });
  for (const [i, row] of rows.entries()) {
    const changed = Object.keys(row).filter(k => JSON.stringify(row[k]) !== JSON.stringify(before[i][k]));
    assert.ok(changed.length > 0, 'it stamps something');
    assert.deepEqual(changed.filter(k => !k.startsWith('plate_')), [], `row ${row.id} changed a non-plate field`);
  }
});

// The boards fetch plate state beside readiness but STAMP it where they always
// did, after board state: a row's keys keep their order, so every answer stays
// byte-identical and no browser's cached copy is invalidated for nothing
// (job-cards-scope.test.js pins the bytes).
test('loadPlateState fetches without touching the rows; apply() stamps them', async () => {
  const rows = [{ id: 1, gang_run_id: null }];
  const qc = async () => [{ job_card_id: 1, status: 'available', component_type: 'cyan', component_label: 'C' }];
  const apply = await loadPlateState(rows, { jobCardIdOf: r => r.id, gangIdOf: r => r.gang_run_id, qc });
  assert.deepEqual(Object.keys(rows[0]), ['id', 'gang_run_id'], 'nothing stamped yet');
  rows[0].board_state = 'covered';
  apply();
  assert.deepEqual(Object.keys(rows[0]).slice(0, 3), ['id', 'gang_run_id', 'board_state'], 'plate fields land after board state');
  const viaStamp = [{ id: 1, gang_run_id: null }];
  await stampPlateState(viaStamp, { jobCardIdOf: r => r.id, gangIdOf: r => r.gang_run_id, qc });
  delete rows[0].board_state;
  assert.deepEqual(rows, viaStamp, 'load + apply is exactly stampPlateState');
});

test('loadPlateState with no job cards runs no statement and apply() is a no-op', async () => {
  let calls = 0;
  const rows = [{ id: null }];
  const apply = await loadPlateState(rows, { jobCardIdOf: r => r.id, qc: async () => { calls++; return []; } });
  apply();
  assert.equal(calls, 0);
  assert.deepEqual(rows, [{ id: null }]);
});

// ── Wiring: each board starts these together ───────────────────────────────────
const route = name => blankNoise(readFileSync(new URL(`./routes/${name}`, import.meta.url), 'utf8'));
function allBlocks(src) {
  const out = []; const re = /Promise\.all\(\[/g; let m;
  while ((m = re.exec(src))) {
    let d = 0, k = m.index + m[0].length - 1;
    for (; k < src.length; k++) { if (src[k] === '[') d++; else if (src[k] === ']') { d--; if (d === 0) break; } }
    out.push(src.slice(m.index, k));
  }
  return out;
}
const hasBlockWith = (name, ...calls) => allBlocks(route(name)).some(b => calls.every(c => b.includes(`${c}(`)));

test('Job Cards starts plate state alongside readiness', () => {
  assert.ok(hasBlockWith('production.js', 'readyBatch', 'loadPlateState'));
});
test('Print Planning starts readiness, the light and plate state together', () => {
  assert.ok(hasBlockWith('production.js', 'readinessBatch', 'lightForJobCards', 'loadPlateState'));
});
test('the Live Floor and the station pages start readiness and the light together', () => {
  const blocks = allBlocks(route('floor.js')).filter(b => b.includes('readinessBatch(') && b.includes('lightForJobCards('));
  assert.equal(blocks.length, 2);
  assert.ok(blocks.some(b => b.includes('loadPlateState(')), 'the station page starts plate state too');
});
test('Planning starts readiness and the light together; Artwork readiness and plate state', () => {
  assert.ok(hasBlockWith('orders.js', 'readinessBatch', 'lightForJobCards'));
  assert.ok(hasBlockWith('orders.js', 'readinessBatch', 'loadPlateState'));
});

// ── Reference: lightForJobCards as it was on main@57653fd4, verbatim ────────────
async function lightReference(cards, oc) {
  const rows = (cards || []).filter(c => c?.id != null);
  const out = new Map();
  if (!rows.length) return out;

  const ids = [...new Set(rows.map(c => +c.id))];
  const productIds = [...new Set(rows.map(c => c.product_id).filter(x => x != null).map(Number))];

  const cut = await oc(`
    SELECT COALESCE(json_agg(json_build_object('job_card_id', js.job_card_id, 'status', js.status)), '[]'::json) AS list
    FROM job_stages js
    WHERE js.job_card_id = ANY($1) AND js.stage='cutting'`, [ids]);

  // The newest live card per product. No requirement columns to join any more —
  // the gate is one rule, so the verdict needs nothing but the card.
  //
  // `s.active` is selected even though the WHERE clause already guarantees it is
  // 1: printingEligibility checks `card.active === 0`, and a row omitting the
  // column would make the verdict depend on a field that isn't there.
  //
  // The old query filtered `status NOT IN ('superseded','archived')` — those
  // statuses no longer exist, and cards that held them were set `active = 0` by
  // the migration, so `active = 1` covers the same ground.
  const shade = productIds.length ? await oc(`
    SELECT COALESCE(json_agg(sc), '[]'::json) AS list FROM (
      SELECT DISTINCT ON (s.product_id) s.product_id, s.sc_number, s.status,
             s.creation_date, s.active
      FROM shade_cards s
      WHERE s.product_id = ANY($1) AND s.active = 1
      ORDER BY s.product_id, s.id DESC
    ) sc`, [productIds]) : null;

  // Whether each product is still half-known. One row per product, same shape
  // as the shade fetch above — never per card, or Print Planning's hundred
  // cards become a hundred round trips.
  const spec = productIds.length ? await oc(`
    SELECT COALESCE(json_agg(json_build_object(
      'product_id', p.id, 'spec_incomplete', COALESCE(p.spec_incomplete, 0))), '[]'::json) AS list
    FROM products p WHERE p.id = ANY($1)`, [productIds]) : null;

  const cutByCard = new Map();
  for (const s of cut?.list ?? []) cutByCard.set(+s.job_card_id, s.status);

  const specByProduct = new Map();
  for (const p of spec?.list ?? []) specByProduct.set(+p.product_id, +p.spec_incomplete || 0);

  const shadeByProduct = new Map();
  for (const card of shade?.list ?? []) {
    shadeByProduct.set(+card.product_id, printingEligibility(card));
  }

  for (const c of rows) {
    out.set(+c.id, {
      // No cutting row means no cutting stage on this route — 'na', not 'late'.
      cuttingStatus: cutByCard.get(+c.id) ?? null,
      shade: shadeByProduct.get(+c.product_id) ?? null,
      specIncomplete: specByProduct.get(+c.product_id) ?? 0,
    });
  }
  return out;
}
