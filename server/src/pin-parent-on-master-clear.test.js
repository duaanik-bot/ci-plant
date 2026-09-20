// When a master write clears a product master's parent (masterParentCannotStay),
// every OTHER open plan of the product keeps the parent it was made on
// (pinParentOnMasterClear, helpers.js). Without the pin, a planned line with no
// parent of its own silently cut the board's full sheet from then on, and its
// stored parent_sheets_required no longer matched the cuts readiness() gives at
// card push — the CI-JC-0335 shape: a card issuing far more board than the plan
// needs (final review, round 3, 19 Sep 2026). Only future orders follow the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pinParentOnMasterClear } from './helpers.js';

// A stub qc over an in-memory order book. It answers the helper's SELECT by
// the SQL's own narrowing — this product, not excluded, an open status — and
// records every write and audit; anything else lands in `unknown`.
function book(lines, runs = []) {
  const log = { writes: [], audits: [], unknown: [] };
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const qc = async (sql, p = []) => {
    const S = norm(sql);
    if (/^SELECT ol\.id, ol\.status, ol\.parent_sheets_required, ol\.spec_override, gr\.kind AS run_kind, gr\.layout_mode FROM order_lines ol LEFT JOIN gang_runs gr ON gr\.id = ol\.gang_run_id WHERE ol\.product_id = \$1 AND NOT \(ol\.id = ANY\(\$2::int\[\]\)\) AND ol\.status IN \('pending', 'planned', 'ready', 'in_production'\) ORDER BY ol\.id FOR NO KEY UPDATE OF ol$/.test(S)) {
      return lines
        .filter(l => l.product_id === p[0] && !p[1].includes(l.id) && ['pending', 'planned', 'ready', 'in_production'].includes(l.status))
        .sort((a, b) => a.id - b.id)
        .map(l => {
          const run = runs.find(r => r.id === l.gang_run_id);
          return { id: l.id, status: l.status, parent_sheets_required: l.parent_sheets_required ?? null,
                   spec_override: l.spec_override ?? null, run_kind: run?.kind ?? null, layout_mode: run?.layout_mode ?? null };
        });
    }
    if (/^UPDATE order_lines SET spec_override=\$1 WHERE id=\$2$/.test(S)) {
      const l = lines.find(x => x.id === p[1]); l.spec_override = JSON.parse(p[0]); log.writes.push(p[1]); return [];
    }
    if (/^INSERT INTO audit_log/.test(S)) { log.audits.push({ entity: p[0], id: p[1], action: p[2], detail: p[3] }); return []; }
    log.unknown.push(S.slice(0, 120));
    return [];
  };
  return { qc, log };
}
const OLD = { parent_l: 22, parent_w: 28 };
const pin = (qc, x = {}) => pinParentOnMasterClear({ productId: 251, oldParent: OLD, excludeLineIds: [], user: 'test', why: 'from planning', ...x }, qc);

test('only the sides a plan does not hold are filled; a plan holding both is left alone', async () => {
  const lines = [
    { id: 1, product_id: 251, status: 'planned', spec_override: null },
    { id: 2, product_id: 251, status: 'ready', spec_override: { parent_l: 30, board_material_id: 399 } },
    { id: 3, product_id: 251, status: 'in_production', spec_override: { parent_l: 23, parent_w: 38 } },
  ];
  const { qc, log } = book(lines);
  const pinned = await pin(qc);
  assert.deepEqual(log.unknown, []);
  assert.deepEqual(pinned, [1, 2]);
  assert.deepEqual(lines[0].spec_override, { parent_l: 22, parent_w: 28 });
  assert.deepEqual(lines[1].spec_override, { parent_l: 30, board_material_id: 399, parent_w: 28 }, 'its own side stays its own');
  assert.deepEqual(lines[2].spec_override, { parent_l: 23, parent_w: 38 });
  assert.deepEqual(log.writes, [1, 2]);
});

test('a plan is planned, ready, in production, or a saved draft — a pending line with no figures follows the board', async () => {
  const lines = [
    { id: 1, product_id: 251, status: 'planned' },
    { id: 2, product_id: 251, status: 'ready' },
    { id: 3, product_id: 251, status: 'in_production' },
    { id: 4, product_id: 251, status: 'pending', parent_sheets_required: 2600 },
    { id: 5, product_id: 251, status: 'pending', parent_sheets_required: null },
    { id: 6, product_id: 251, status: 'dispatched' },
    { id: 7, product_id: 251, status: 'cancelled' },
  ];
  const { qc, log } = book(lines);
  assert.deepEqual(await pin(qc), [1, 2, 3, 4]);
  assert.deepEqual(log.unknown, []);
  assert.equal(lines[4].spec_override, undefined, 'no plan yet: untouched');
});

test('the request\'s own lines, other products, and co-printed runs are never pinned', async () => {
  const runs = [{ id: 19, kind: 'gang', layout_mode: 'shared' }, { id: 28, kind: 'merge', layout_mode: 'shared' },
                { id: 40, kind: 'gang', layout_mode: 'separate' }];
  const lines = [
    { id: 1, product_id: 251, status: 'planned' },                     // excluded: the request's own
    { id: 2, product_id: 999, status: 'planned' },                     // another product
    { id: 3, product_id: 251, status: 'planned', gang_run_id: 19 },    // co-printed: its lock never reads a parent
    { id: 4, product_id: 251, status: 'planned', gang_run_id: 28 },    // a combined run is not co-printed
    { id: 5, product_id: 251, status: 'planned', gang_run_id: 40 },    // a separate-layout gang
  ];
  const { qc, log } = book(lines, runs);
  assert.deepEqual(await pin(qc, { excludeLineIds: [1] }), [4, 5]);
  assert.deepEqual(log.unknown, []);
});

test('each pin is audited on its line: the parent it keeps and why', async () => {
  const lines = [{ id: 1, product_id: 251, status: 'planned' },
                 { id: 2, product_id: 251, status: 'planned', spec_override: { parent_l: 30 } }];
  const { qc, log } = book(lines);
  await pin(qc);
  assert.deepEqual(log.audits.map(a => [a.entity, a.id, a.action]), [['order_line', 1, 'parent_pinned'], ['order_line', 2, 'parent_pinned']]);
  assert.equal(log.audits[0].detail,
    'parent 22×28 pinned — the product master\'s parent was cleared; this plan keeps the sheet it was made on (from planning)');
  assert.equal(log.audits[1].detail,
    'parent_w 28 pinned — the product master\'s parent was cleared; this plan keeps the sheet it was made on (from planning)');
});

test('nothing open, nothing written', async () => {
  const { qc, log } = book([]);
  assert.deepEqual(await pin(qc), []);
  assert.deepEqual(log.writes, []);
  assert.deepEqual(log.audits, []);
});

// The narrowing is SQL; the stub above answers it by the same rule, and this
// pins the SQL so the two cannot drift.
const HELPERS = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');
test('the candidates are this product\'s open lines, the request\'s own excluded, locked for the write', () => {
  const fn = HELPERS.slice(HELPERS.indexOf('export async function pinParentOnMasterClear'));
  // NO KEY UPDATE, the codebase's rule for sweeps over member lines (the gang
  // lock order work): enough for the read-merge-write of spec_override, and it
  // leaves the FK share locks PR, cover and job-card inserts take on those lines.
  assert.match(fn, /WHERE ol\.product_id = \$1\s+AND NOT \(ol\.id = ANY\(\$2::int\[\]\)\)\s+AND ol\.status IN \('pending', 'planned', 'ready', 'in_production'\)\s+ORDER BY ol\.id\s+FOR NO KEY UPDATE OF ol`/);
  assert.match(fn, /const hasPlan = r => r\.status !== 'pending' \|\| r\.parent_sheets_required != null;/);
  assert.match(fn, /const coPrinted = r => r\.run_kind != null && r\.run_kind !== 'merge' && r\.layout_mode === 'shared';/);
});
