import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A cutting ADJUST must true up the board that was physically CUT — the same
// rule completion settled and wrote down: "the mix row names the board that was
// physically cut, and for a substitute-only mix that is NOT
// eff.board_material_id — the legacy write block would true up the PLANNED
// board's stock for a pile that was never touched."
//
// Adjust did exactly that on the live plant. JC-0098 (line 261) cut its whole
// job on material 89 through a substitute mix; the master's board is 104, of
// which not one sheet has ever been issued. A -4,500 adjust ran
// adjustBoardStock(104, -4500), found no batch, and minted stock_batches 171
// 'CUT-RETURN-788' — 4,500 phantom sheets on a board that has never held any.
// cutting_discrepancies recorded the two paths disagreeing on ONE stage:
// id 24 (completion) board 89, id 25 (adjust) board 104.
const src = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
const adjust = (() => {
  const i = src.indexOf("if (st.stage === 'cutting') {", src.indexOf("r.post('/job-stages/:id/adjust'"));
  return src.slice(i, i + 6000);
})();

test('the adjust block resolves the board from the MIX, not the master', () => {
  assert.match(adjust, /mixFor\(jcv\.order_line_id, phase, qc\)/,
    'it reads the job\'s own mix');
  assert.match(adjust, /mixRows\.length === 1 \? mixRows\[0\] : null/,
    'a one-row mix names the board that was cut');
  assert.match(adjust, /material_id: single \? single\.material_id : eff\?\.board_material_id/,
    'eff.board_material_id survives ONLY as the no-mix case');
});

test('a one-board mix supplies its own cuts, not the card\'s aggregate', () => {
  assert.match(adjust, /children_per_parent: single \? single\.ups : jcv\.children_per_parent/,
    "the mix row's ups is that board's cuts — the card's figure is the planned board's");
  assert.match(adjust, /sheets_issued: single \? Number\(single\.sheets\) : jcv\.sheets_issued/);
});

test('a run card reaches its mix through its members', () => {
  assert.match(adjust, /!jcv\.order_line_id && jcv\.gang_run_id/,
    'a RUN card carries no order_line_id — its mix lives on the members');
  assert.match(adjust, /runMixFromMembers\(flat\)/, 'and re-adds per board');
});

test('a multi-board mix touches every board it cut and only those', () => {
  assert.match(adjust, /parts\.filter\(p => p\.delta !== 0\)/,
    'a board with no share of the delta is never written');
  assert.match(adjust, /parts\[biggest\]\.delta \+= drift/,
    'apportionment conserves the total — rounding lands on the largest pile');
  // one register row per board trued up, mirroring completion
  assert.match(adjust, /for \(const t of targets\)[\s\S]{0,900}INSERT INTO cutting_discrepancies/,
    'each board trued up gets its own discrepancy row');
});
