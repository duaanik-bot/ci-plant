import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ONE writer for the loose column, and ONE spelling of the rule that moves it.
//
// `stock_batches.loose_sheets` is only trustworthy while every path that moves
// a pile's qty moves its loose figure by the same arithmetic. There are 35
// places in server/src that write stock_batches, and the rule is four terms
// long — looseBefore + opened·P − issued — which is exactly the shape of thing
// that gets re-derived by hand somewhere and then quietly disagrees.
//
// The precedent is already paid for: GANG_ANCHOR_LINE was hand-rolled in
// twelve places in three spellings, all agreeing until one of them was missed,
// and the plant got a raw 500 on every gang parent card. A rule with one
// spelling can be fixed once. A rule with five gets fixed four times and stays
// broken in the fifth.
//
// So: helpers.js owns the column. packet-plan.js owns the arithmetic. Anything
// else touching either is a second spelling waiting to drift.

const HERE = new URL('./', import.meta.url);

function sourceFiles(dir = HERE, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) sourceFiles(u, out);
    // Test files are excluded because this one necessarily quotes the very
    // patterns it bans.
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
      out.push([e.name, readFileSync(u, 'utf8')]);
    }
  }
  return out;
}

const FILES = sourceFiles();

test('nothing writes loose_sheets except through helpers.js', () => {
  // Reads are free — a SELECT carrying the column to the planning panel or a
  // job card is exactly what it is for. Only writes are policed, and a write
  // is fine anywhere so long as the VALUE came from one of the two helpers
  // that own the rule. procurement.js writes it on every GRN; it is compliant
  // because the figure is `await grnLooseSheets(...)` and not an inline mod.
  //
  // inventory.js is the ONE named exception, and it is an exception to the
  // MOVEMENT rule rather than a second spelling of it: the recount route sets
  // the figure absolutely because a human has physically counted the pile. It
  // is loose's stocktake, exactly as /inventory/adjust is qty's, and a stocktake
  // that had to be expressed as a delta from a figure it disbelieves would be
  // absurd. Any OTHER file appearing here is a drift bug in waiting.
  const writes = /(UPDATE\s+stock_batches[\s\S]{0,200}?SET[\s\S]{0,200}?loose_sheets|INSERT\s+INTO\s+stock_batches[^)]*loose_sheets)/i;
  const owners = new Set(['helpers.js', 'inventory.js']);
  const offenders = FILES.filter(([name, src]) =>
    !owners.has(name) && writes.test(src) && !/grnLooseSheets\(|applyLoose\(/.test(src));
  assert.deepEqual(offenders.map(([n]) => n), [],
    'loose_sheets written without applyLoose or grnLooseSheets — that is a second spelling of the rule');
});

test('packet-plan.js is the only module that SPELLS the loose rule', () => {
  // The rule is `looseBefore + packetsOpened·P − issued`. Any other file
  // multiplying a packet count by a packet size, or taking a sheet count modulo
  // one, has re-derived it.
  const rule = /(sheets_per_packet|packetSize|packet_size)\s*[*%]|[*%]\s*(sheets_per_packet|packetSize|packet_size)/;
  const allowed = new Set(['packet-plan.js', 'boardMath.js', 'board-math.js', 'replenishment.js']);
  const offenders = FILES.filter(([name, src]) => !allowed.has(name) && rule.test(src));
  assert.deepEqual(offenders.map(([n]) => n), [],
    'packet arithmetic outside packet-plan.js — call looseAfter or grnLooseSheets');
});

test('every GRN receipt seeds loose through the one helper', () => {
  const proc = FILES.find(([n]) => n === 'procurement.js')?.[1];
  assert.ok(proc, 'procurement.js not found');
  // Four receipt shapes — against a PO, a substitution, a direct receipt and a
  // multi-line PO. All four create a batch, so all four must seed its loose.
  const inserts = proc.match(/INSERT INTO stock_batches[^`]*/g) || [];
  const withGrn = inserts.filter(s => /grn_id/.test(s));
  assert.equal(withGrn.length, 4, 'expected four GRN batch inserts');
  for (const s of withGrn) {
    assert.match(s, /loose_sheets/, `a GRN receipt that does not seed loose_sheets: ${s.slice(0, 90)}`);
  }
  assert.equal((proc.match(/grnLooseSheets\(/g) || []).length, 4);
});

test('the issue paths move loose in the same breath as qty', () => {
  const helpers = FILES.find(([n]) => n === 'helpers.js')?.[1];
  assert.ok(helpers, 'helpers.js not found');
  // consumeFifo (cutting start), issueWithWriteOn (over-cut true-up) and
  // adjustBoardStock's refund branch (the under-cut return that pushed the
  // derivation wrong in the first place) must each call applyLoose.
  for (const fn of ['consumeFifo', 'issueWithWriteOn', 'adjustBoardStock']) {
    const at = helpers.indexOf(`export async function ${fn}(`);
    assert.ok(at > 0, `${fn} not found`);
    // To the next top-level export — the body of this function alone.
    const end = helpers.indexOf('\nexport ', at + 10);
    const body = helpers.slice(at, end === -1 ? helpers.length : end);
    assert.match(body, /applyLoose\(|issueWithWriteOn\(/,
      `${fn} moves stock without moving loose`);
  }
});
