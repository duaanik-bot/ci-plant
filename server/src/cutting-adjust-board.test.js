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

// ADJUSTING A COMPLETED CUTTING STAGE MOVES BOARD. It re-derives the parents
// actually cut and trues the warehouse up by the delta, so a keystroke consumes
// or refunds real sheets long after the operator has left the machine. On
// 11 Aug one such adjust restated 5,000 parents as 500 with the reason "Fgh",
// and its 4,500-sheet refund minted a batch on a board that had never had a
// sheet issued.
test('a completed cutting adjust needs the plant head', () => {
  const i = src.indexOf("r.post('/job-stages/:id/adjust'");
  const block = src.slice(i, i + 2600);
  assert.match(block, /st\.stage === 'cutting' && st\.status === 'completed'/,
    'narrow by design: only cutting moves board, and only a completed stage has a draw to true up');
  assert.match(block, /SELECT reverse_approver FROM users WHERE id=\$1/,
    'the same flag a stock-returning reverse uses — the act rewrites physical history');
  assert.match(block, /if \(!u\?\.reverse_approver\)/, 'fail-closed: no flag, no adjust');
  assert.match(block, /ADJUST_NEEDS_APPROVER/);
  // NEVER a role, and never is_management — the JWT carries id/name/role only,
  // so is_management is always undefined and would lock out even the MD. Match
  // the CODE, not the prose: the comment above the gate names it deliberately,
  // and a blunt grep would forbid explaining the trap.
  const code = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /is_management/);
  assert.doesNotMatch(code, /req\.user\.role === /);
});

test('the refusal reaches the operator instead of dying silently', async () => {
  // api.js stays QUIET only for codes with a caller-side dialog. This one has
  // none by design — the server's sentence is the whole message — so it must
  // NOT be in HANDLED_CODES, or the button would just do nothing.
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../../client/src/api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /ADJUST_NEEDS_APPROVER/,
    'listing it would suppress the toast and rebuild the silent-button bug');
  assert.match(api, /if \(!HANDLED_CODES\.has\(data\.code\)\) onError\(msg\)/,
    'so an unlisted code surfaces its message');
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /\.\.\.\(err\.body \|\| \{\}\)/,
    'and the handler spreads err.body, so `code` arrives at the top level');
});
