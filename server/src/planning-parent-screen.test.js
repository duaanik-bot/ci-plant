// Source pins for the planning screens: .jsx cannot be imported by node --test,
// so the RULES live in client/src/lib/cutFit.js (tested directly — see
// run-sheet-parent.test.js and parent-on-screen-client.test.js) and these pins
// hold the screens to calling them. CI-MRG-0028 is the reason: the run screen
// counted the board while the lock counted the parent on file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const P = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
const between = (a, b) => { const i = P.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); return P.slice(i, P.indexOf(b, i)); };

test('Planning imports the parent twins from cutFit.js', () => {
  assert.match(P, /import \{ clientStrips, chosenCutsValid, chosenStrips, cutParentOf, parentLosesCuts, parentFollowsBoard, parentTooBig, runSheetParent, runMemberCut, engineParent, engineParentError, boardSheetFill, boardSwitch, boardUndo, sameSheet \} from '\.\.\/lib\/cutFit\.js';/);
});

// Task 10: the per-member cut moved to cutFit.js (runMemberCut — cutParentOf
// on the member's OWN board, run-member-cut.test.js holds it to the server's
// memberParentSheets). This pins gangCalc to calling it.
test('gangCalc counts each member on the parent its lock cuts on, on its own board (runMemberCut)', () => {
  const block = between('const gangCalc = useMemo', 'const position = useMemo');
  assert.match(block, /const \{ cpp \} = runMemberCut\(\{ member: m, coPrinted, childFallback: \{ child_l: anchor\?\.child_l, child_w: anchor\?\.child_w \} \}\);/);
  assert.doesNotMatch(block, /clientFit\(anchor\?\.sheet_l, anchor\?\.sheet_w, \+m\.child_l/);
  // the lead's board never stands in for a member's: an unsized one is 1:1, as the server clamps it
  assert.doesNotMatch(block, /m\.sheet_l \?\? anchor/);
});

test('the Run Sheet form holds the parent, seeded from the saved one — also on the way back from a member', () => {
  assert.match(P, /useState\(\{ child_l: '', child_w: '', coating: '', parent_l: '', parent_w: '' \}\)/);
  assert.match(between('const seedGangSheet', 'const seedGangNumbers'), /parent_l: d\.members\?\.\[0\]\?\.parent_l != null/);
  assert.match(between('const returnToGang', 'const dismissEngine'), /seedGangSheet\(d\)/);
});

test('Lock sheet and the button\'s lit state ask ONE rule; the one-click sends the parent only, for its own orders', () => {
  const block = between('const lockGangSheet', 'const applyGangSheet');
  assert.match(block, /const lockGangSheet = \(over = null, scope = null\) => \{/);
  assert.match(block, /runSheetParent\(\{/);
  assert.match(block, /form: gangSheetForm, over, scope, members,/);
  assert.match(block, /if \(d\.error\) \{ toast\.error\(d\.error\); return false; \}/);
  // the parent alone — no board, child or coating — and the row's orders as line_ids
  assert.match(block, /payload: over\s*\? \{ \.\.\.d\.parent, \.\.\.\(scoped \? \{ line_ids: scoped\.map\(m => m\.id\) \} : \{\}\) \}/);
  assert.match(block, /const scoped = over && scope \? members\.filter\(m => scope\.includes\(m\.id\)\) : null;/);
  assert.match(P, /const parentDirty = runSheetParent\(\{ form: gangSheetForm, members: gangView\.members, isMerge: mergeMode, coPrinted \}\)\.changed;/);
  assert.match(P, /<span className="font-semibold text-slate-700">Parent sheet<\/span>/);
});

test('the Run Sheet warns once per product when the saved parent costs cuts or is larger than its board, with the one-click fix', () => {
  const sheet = between('const flagged = coPrinted', 'Lock sheet →');
  assert.match(sheet, /parentLosesCuts\(args\)/);
  assert.match(sheet, /parentTooBig\(args\)/);
  assert.match(sheet, /orders: acc\[k\]\.orders \+ 1/);
  assert.match(sheet, /is larger than the/);
  assert.match(sheet, /Use the board's full sheet/);
});

// Task 10: the one-click on ONE product's red row re-stamped EVERY member's
// parent with the LEAD's board sheet — on a gang of different products that
// overwrote deliberate trims and wrote board-sheet copies into other masters.
test('each red row carries the line ids it covers, and its one-click passes them with its own member', () => {
  const sheet = between('const flagged = coPrinted', 'Lock sheet →');
  assert.match(sheet, /orders: acc\[k\]\.orders \+ 1, ids: \[\.\.\.acc\[k\]\.ids, m\.id\] \}/);
  assert.match(sheet, /\{ m, lossy, tooBig, orders: 1, ids: \[m\.id\] \}/);
  assert.match(sheet, /flagged\.map\(\(\{ m, lossy, tooBig, orders, ids \}\) =>/);
  assert.match(sheet, /onClick=\{\(\) => fillBoardSheet\(\{ m, ids \}\)\}>Use the board's full sheet</);
});

test('the one-click fills from ITS row\'s board sheet and sends it to that row\'s orders alone', () => {
  const fill = between('const fillBoardSheet = row', 'lockGangSheet(over, row.ids)');
  assert.match(fill, /const over = \{ parent_l: String\(row\.m\.sheet_l\), parent_w: String\(row\.m\.sheet_w\) \};/);
  assert.doesNotMatch(fill, /anchor\.sheet_[lw]/);
});

test('the Lock sheet prompt names a scoped one-click\'s orders, and shows and judges THEIR board', () => {
  const block = between('const lockGangSheet', 'const applyGangSheet');
  assert.match(block, /scope: scoped \? \{ n: scoped\.length, codes: \[\.\.\.new Set\(scoped\.map\(m => m\.product_code\)\)\], board: scoped\[0\] \} : null,/);
  assert.match(P, /const sheetPromptBoard = gangSheetPrompt\?\.scope\?\.board \?\? gangView\?\.members\?\.\[0\];/);
  const prompt = between('title={gangSheetPrompt ? `Lock the sheet for', '</Modal>');
  assert.match(prompt, /<>Only the parent sheet below changes, for <b>\{gangSheetPrompt\.scope\.n < gangSheetPrompt\.count \? `\$\{gangSheetPrompt\.scope\.n\} of the \$\{gangSheetPrompt\.count\}` : `all \$\{gangSheetPrompt\.count\}`\}<\/b> jobs in \{gangSheetPrompt\.gang_number\} — \{gangSheetPrompt\.scope\.codes\.join\(', '\)\}\.<\/>/);
  assert.match(prompt, /\{sheetPromptBoard\?\.board_grade\} · \{sheetPromptBoard\?\.board_name\}/);
  assert.match(prompt, /boardL: sheetPromptBoard\?\.sheet_l, boardW: sheetPromptBoard\?\.sheet_w \}\)/);
  assert.doesNotMatch(prompt, /gangView\?\.members\?\.\[0\]\?\.(board_grade|board_name|sheet_l|sheet_w)/);
  // the buttons count the orders it changes
  assert.match(prompt, /Save for \{gangSheetPrompt\?\.scope\?\.n === 1 \? 'this job' : `these \$\{gangSheetPrompt\?\.scope\?\.n \?\? gangSheetPrompt\?\.count\} jobs`\} only/);
  assert.match(prompt, /Update Product Master\{\(gangSheetPrompt\?\.scope\?\.codes\.length \?\? gangSheetPrompt\?\.count\) > 1 \? 's' : ''\}/);
});

test('the toasts say a parent was kept on the job because the master\'s own board can\'t yield it', () => {
  const sheet = between('const applyGangSheet = async', '\n  const ');
  assert.match(sheet, /const kept = d\.parent_kept_job_only\?\.length\s*\? ` · parent kept for these jobs only on \$\{d\.parent_kept_job_only\.join\(', '\)\} — the product master's own board can't yield it` : '';/);
  assert.match(sheet, /\$\{card\}\$\{kept\}\$\{cleared\}\$\{reDeriveNote\(d\)\}/);
  const save = between('const savePlan = async', 'const reversePlan = async');
  assert.match(save, /const keptNote = updated\.parent_kept_job_only \? ` · parent kept for this job — the product master's own board can't yield it` : '';/);
  assert.match(save, /still in To Plan\$\{masterNote\}\$\{keptNote\}/);
  assert.match(save, /assign a press in Print Planning\$\{masterNote\}\$\{keptNote\}/);
});

test('a scoped one-click\'s toast names the orders it changed', () => {
  const sheet = between('const applyGangSheet = async', '\n  const ');
  assert.match(sheet, /const some = sc && sc\.n < d\.members\.length \? `\$\{sc\.n\} of the \$\{d\.members\.length\} jobs \(\$\{sc\.codes\.join\(', '\)\}\)` : null;/);
  assert.match(sheet, /applied to \$\{some \?\? `all \$\{d\.members\.length\} jobs`\}/);
  assert.match(sheet, /sheet locked for \$\{some \?\? `these \$\{d\.members\.length\} jobs`\}/);
});

test('a typed parent the board cannot yield is said in the preview, not previewed as the board', () => {
  assert.match(P, /const typedTooBig = !coPrinted && parentTooBig\(\{ parentL: gangSheetForm\.parent_l, parentW: gangSheetForm\.parent_w,/);
});

test('a run board change carries a parent that cannot stay — never on a co-printed run', () => {
  const block = between('const setGangBoard', 'const lockGangSheet');
  assert.match(block, /parentFollowsBoard\(/);
  assert.match(block, /d\.kind !== 'merge' && d\.layout_mode === 'shared' \? null/);
});

test('the one-click needs a sized board — its row\'s own', () => {
  assert.match(between('const fillBoardSheet = row', 'lockGangSheet(over, row.ids)'), /if \(!\(\+row\.m\.sheet_l > 0 && \+row\.m\.sheet_w > 0\)\)/);
});

// Task 10, round 2: the one-click fills NOTHING in the Run Sheet form. It used
// to pre-fill it when its row covered the lead; Cancel then left that fill
// behind, and a later, unrelated Lock sheet (a coating change) sent it
// RUN-WIDE — the final review's probe p4 overwrote SW-258's 22×36 master that
// way. The prompt shows the parent from its payload, and applyGangSheet
// re-seeds the form from the run after the save.
test('the one-click never fills the Run Sheet form — Cancel leaves nothing behind for a later lock to spread', () => {
  const fill = between('const fillBoardSheet = row', 'return (');
  assert.match(fill, /lockGangSheet\(over, row\.ids\);/);
  assert.doesNotMatch(fill, /setGangSheetForm/);
  assert.match(between('const applyGangSheet = async', '\n  const '), /seedGangSheet\(d\)/);
  const prompt = between('title={gangSheetPrompt ? `Lock the sheet for', '</Modal>');
  assert.match(prompt, /\{gangSheetPrompt\.payload\.parent_l\}×\{gangSheetPrompt\.payload\.parent_w\}"/);
});

test('the Lock sheet prompt says so when the parent it would save is larger than the board', () => {
  const prompt = between('title={gangSheetPrompt ? `Lock the sheet for', '</Modal>');
  assert.match(prompt, /parentTooBig\(\{ parentL: gangSheetPrompt\.payload\.parent_l, parentW: gangSheetPrompt\.payload\.parent_w,/);
  assert.match(prompt, /will refuse it until it changes/);
});

// ── Single engine (Task 7, review round 2): the engine knows the REAL board ──
// LINE_VIEW's sheet_l/_w are the FOLDED parent, and seeding boardSel with them
// made the saved parent the engine's "board": SW-544's fossil never warned, the
// one-click could write it back, picks carried genuine trims away, and Undo
// re-derived instead of restoring. The rules are in cutFit.js
// (single-engine-parent.test.js); these hold the screen to them.

test('single engine: openPlan seeds boardSel with the board\'s OWN sheet — on the column\'s PRESENCE, so an unsized board stays unsized', () => {
  const open = between('const openPlan = async l', 'setForm({');
  assert.match(open,
    /setBoardSel\(\{ id: l\.board_material_id, name: l\.board_name,\s*sheet_l: 'board_sheet_l' in l \? l\.board_sheet_l : l\.sheet_l,\s*sheet_w: 'board_sheet_w' in l \? l\.board_sheet_w : l\.sheet_w \}\)/);
  // `??` also fell back on a NULL board sheet, seating the folded parent as
  // the board of every unsized board ("Unspecified board", #278).
  assert.doesNotMatch(open, /l\.board_sheet_l \?\? l\.sheet_l/);
});

test('single engine: calc cuts on engineParent (typed, else on file, else the board) and judges it against the real board', () => {
  const block = between('const calc = useMemo', 'const loStrips = useMemo');
  assert.match(block, /engineParent\(\{/);
  assert.match(block, /saved: \{ l: planLine\.parent_l, w: planLine\.parent_w \}/);
  assert.match(block, /const parentL = parent\.l, parentW = parent\.w;/);
  // a trim needs a board with a sheet to be trimmed from
  assert.match(block, /const boardSized = \+board\.l > 0 && \+board\.w > 0;/);
  assert.match(block, /const parentTrimmed = !!declared && boardSized && !sameSheet\(declared, board\);/);
  assert.match(block, /const parentOversize = !!declared && parentTooBig\(\{ parentL: declared\.l, parentW: declared\.w, boardL: boardSel\.sheet_l, boardW: boardSel\.sheet_w \}\);/);
  assert.match(block, /parentTrimmed, parentOversize, declared,/);
  assert.doesNotMatch(block, /\+form\.parent_l \|\| boardSel\.sheet_l/);
});

test('single engine: a board change asks boardSwitch, and its history entry records what it wrote', () => {
  const carry = between('const carryParent', 'const pickBoard');
  assert.match(carry, /boardSwitch\(\{/);
  assert.match(carry, /if \(sw\.fill\) setForm\(f => \(\{ \.\.\.f, \.\.\.sw\.fill \}\)\);/);
  assert.doesNotMatch(carry, /parentFollowsBoard\(/);
  const pick = between('const pickBoard = async row', '// ── Commit / uncommit');
  assert.match(pick, /const sw = carryParent\(boardSel, next\);/);
  assert.match(pick, /setBoardHist\(h => \[\.\.\.h, \{ board: boardSel, parentBefore: sw\.parentBefore, fill: sw\.fill \}\]\);/);
});

test('single engine: Undo restores what the switch wrote (boardUndo), never re-derives a carry', () => {
  const undo = between('const undoBoard = async', 'const resetBoard = async');
  assert.match(undo, /const back = boardUndo\(\{ form, entry \}\);/);
  assert.match(undo, /if \(back\) setForm\(f => \(\{ \.\.\.f, \.\.\.back \}\)\);/);
  assert.match(undo, /setBoardSel\(entry\.board\);/);
  assert.doesNotMatch(undo, /carryParent\(/);
});

test('single engine: Reset carries on the form as it is after the reload, from a placeholder that is never the folded parent', () => {
  assert.match(P, /const formRef = useRef\(form\); formRef\.current = form;/);
  const reset = between('const resetBoard = async', 'Board reset to the product master');
  assert.match(reset, /boardMasterFor\(planLine\.master_board_material_id\)/);
  assert.doesNotMatch(reset, /planLine\.sheet_l/);
  assert.match(reset, /const sw = carryParent\(from, board, formRef\.current\);/);
  assert.match(reset, /setBoardHist\(h => h\.map\(e => \(e === entry \? \{ board: from, parentBefore: sw\.parentBefore, fill: sw\.fill \} : e\)\)\);/);
});

test('single engine: every boardHist reader takes the entry\'s board', () => {
  assert.match(P, /title=\{`Undo — back to \$\{boardHist\[boardHist\.length - 1\]\?\.board\?\.name\}`\}/);
  assert.doesNotMatch(P, /boardHist\[boardHist\.length - 1\]\?\.name/);
});

test('single engine: the toasts name both sides of a carry, and what Undo put back', () => {
  const note = between('const followNote', 'const pickBoard');
  assert.match(note, /` · parent \$\{d\.l\}×\$\{d\.w\}" → the board's full sheet`/);
  assert.match(note, /` · parent \$\{d\.l\}×\$\{d\.w\}" → \$\{c\.l\}×\$\{c\.w\}"`/);
  assert.match(between('const undoBoard = async', 'const resetBoard = async'), /· parent back to \$\{parentWords\(back\)\}/);
});

test('single engine: the Cut Plan warns on calc.declared against the real board; the one-click fills boardSheetFill', () => {
  assert.match(P, /const lossy = calc\.declared && parentLosesCuts\(\{ parentL: calc\.declared\.l, parentW: calc\.declared\.w,/);
  const warn = between('const lossy = calc.declared && parentLosesCuts(', '</Card>');
  assert.match(warn, /setForm\(f => \(\{ \.\.\.f, \.\.\.boardSheetFill\(\{ saved: \{ l: planLine\.parent_l, w: planLine\.parent_w \}, board: \{ l: boardSel\.sheet_l, w: boardSel\.sheet_w \} \}\) \}\)\)/);
  assert.doesNotMatch(warn, /parent_l: String\(boardSel\.sheet_l\)/);
  assert.match(warn, /Use the board's full sheet/);
});

// Task 10 D: on a member of a CO-PRINTED run the lock cuts the board's full
// sheet and never reads the parent (gangs.js shared arm), so "This plan uses X"
// would claim a sheet the run never cuts. ctx.gang is gangDetail's run.
test('single engine: on a member of a co-printed run the Cut Plan warning never claims the plan uses the parent', () => {
  const warn = between('const lossy = calc.declared && parentLosesCuts(', '</Card>');
  assert.match(warn, /const coPrintedRun = ctx\?\.gang\?\.kind !== 'merge' && ctx\?\.gang\?\.layout_mode === 'shared';/);
  assert.match(warn, /\{coPrintedRun\s*\? <>Its co-printed run cuts the board's full sheet\.<\/>\s*: <>This plan uses \{lossy\.declared\.l\}×\{lossy\.declared\.w\}"\.<\/>\}/);
});

test('single engine: the master question ties Parent L and W — a master is never sent half a parent', () => {
  const prompt = between('title="Save master-driven changes"', '</Modal>');
  assert.match(prompt, /const twin = \{ parent_l: 'parent_w', parent_w: 'parent_l' \}\[k\];/);
  assert.match(prompt, /\.\.\.\(twin && twin in p\.changed \? \{ \[twin\]: on \} : \{\}\)/);
});

test('applyGangBoard keeps LINE_VIEW\'s shape: board_sheet_l/_w the board, sheet_l/_w the parent folded PER SIDE', () => {
  const block = between('const applyGangBoard = async', 'const openAddJobs');
  assert.match(block, /board_sheet_l: boardSel\.sheet_l, board_sheet_w: boardSel\.sheet_w,/);
  assert.match(block, /sheet_l: planLine\.parent_l \?\? boardSel\.sheet_l, sheet_w: planLine\.parent_w \?\? boardSel\.sheet_w/);
});

test('single engine: a blank Parent field names what it stands for — the side on file, else the board, never "null"', () => {
  const fn = between('const parentBlank = side', 'const colourFormHas');
  assert.match(fn, /const onFile = planLine\?\.\[`parent_\$\{side\}`\];/);
  assert.match(fn, /hint: `on file \$\{onFile\}"`/);
  assert.match(fn, /return \+b > 0 \? \{ placeholder: String\(b\), hint: `board \$\{b\}"` \} : \{ placeholder: '', hint: undefined \};/);
  const cut = between('<Card icon={Scissors} title="Cut Plan"', 'Ups / print sheet');
  assert.match(cut, /hint=\{parentBlank\('l'\)\.hint\}/);
  assert.match(cut, /placeholder=\{parentBlank\('l'\)\.placeholder\}/);
  assert.match(cut, /hint=\{parentBlank\('w'\)\.hint\}/);
  assert.match(cut, /placeholder=\{parentBlank\('w'\)\.placeholder\}/);
  assert.doesNotMatch(cut, /boardSel\.sheet_[lw]/);
});

test('single engine: Save and Lock say a TYPED parent no cut can use instead of saving it (engineParentError)', () => {
  const fn = between('const parentRefused = ()', 'const onLock = () =>');
  assert.match(fn, /const err = engineParentError\(\{ form, saved: \{ l: planLine\.parent_l, w: planLine\.parent_w \} \}\);/);
  assert.match(fn, /if \(err\) toast\.error\(err\);/);
  // the FIRST thing each does — before the leftover, short, mix or master questions
  assert.match(P, /const onLock = \(\) => \{\s*if \(parentRefused\(\)\) return;/);
  assert.match(P, /const onSave = \(\) => \{\s*if \(parentRefused\(\)\) return;/);
});

// ── Task 6b, client half: the toast says what a re-derive undid ────────────
// The server (gangs.js) now answers mix_cleared / leftover_unbanked (bool) on
// every route that can re-price a cut plan — a saved board mix priced on the
// old cut is cleared, and a planned leftover strip goes back off the shelf.
// Unsaid, the planner finds the mix gone and the strip missing with no clue
// why. reDeriveNote turns those two booleans into the toast's own words.

test('reDeriveNote exists and says both what a re-derive undoes', () => {
  assert.match(P, /const reDeriveNote = d => \[/);
  assert.match(P, /d\?\.mix_cleared \?/);
  assert.match(P, /d\?\.leftover_unbanked \?/);
  assert.match(P, /saved board mix cleared — it was priced on the old cut, rebuild it/);
  assert.match(P, /planned leftover taken back off the shelf/);
});

test('the four handlers that touch the cut plan say what a re-derive undid, in their success toast', () => {
  // saveGangMember (PATCH .../lines/:lineId) — response variable `detail`.
  assert.match(between('const saveGangMember = async', '\n  const '), /reDeriveNote\(detail\)/);
  // setGangBoard (POST .../board, from the engine's board picker) — `d`.
  assert.match(between('const setGangBoard = async', '\n  const '), /reDeriveNote\(d\)/);
  // applyGangBoard (POST .../board, "set as the gang's board") — `d`.
  assert.match(between('const applyGangBoard = async', '\n  const '), /reDeriveNote\(d\)/);
  // applyGangSheet (POST .../shared) — `d`, in BOTH toast branches (the
  // update-master save and the job-only lock read different messages, but
  // both must say what a re-derive undid).
  const sheet = between('const applyGangSheet = async', '\n  const ');
  const hits = sheet.match(/reDeriveNote\(d\)/g) || [];
  assert.ok(hits.length >= 2,
    `applyGangSheet must call reDeriveNote(d) in both toast branches (found ${hits.length})`);
});

// ── Task 10, round 2 ────────────────────────────────────────────────────────
// A master write that moves a master's BOARD clears a parent that cannot stay
// on it (masterParentCannotStay); both toasts say so, one note per product.
test('the toasts say a master parent was cleared because it can\'t stay on the new board', () => {
  const sheet = between('const applyGangSheet = async', '\n  const ');
  assert.match(sheet, /const cleared = \(d\.master_parent_cleared \|\| \[\]\)\s*\.map\(c => ` · master parent \$\{c\.from\} cleared on \$\{c\.code\} — it can't stay on the new board; the master now cuts the board's full sheet`\)\.join\(''\);/);
  const save = between('const savePlan = async', 'const reversePlan = async');
  assert.match(save, /const clearedNote = updated\.master_parent_cleared\s*\? ` · master parent \$\{updated\.master_parent_cleared\} cleared on \$\{planLine\.product_code\} — it can't stay on the new board; the master now cuts the board's full sheet`/);
  assert.match(save, /still in To Plan\$\{masterNote\}\$\{keptNote\}\$\{clearedNote\}/);
  assert.match(save, /assign a press in Print Planning\$\{masterNote\}\$\{keptNote\}\$\{clearedNote\}/);
});

// Minor 2: "saved to the product master(s)" only when a master was written —
// a one-click whose parent every master kept off wrote none — and the single
// engine counts the fields the Product Master took, not the ticks.
test('the toasts say what reached a master, not what was asked', () => {
  const sheet = between('const applyGangSheet = async', '\n  const ');
  assert.match(sheet, /const wrote = \(d\.masters_updated\?\.length \?\? 0\) > 0;/);
  assert.match(sheet, /toast\.success\(wrote\s*\? `\$\{d\.gang_number\} — sheet saved to the product master\(s\)/);
  assert.doesNotMatch(sheet, /toast\.success\(updateMaster/);
  const save = between('const savePlan = async', 'const reversePlan = async');
  assert.match(save, /const wrote = updated\.master_written \|\| \[\];/);
  assert.match(save, /` · \$\{wrote\.length\} field\$\{wrote\.length === 1 \? '' : 's'\} to the Product Master`/);
  assert.doesNotMatch(save, /master_fields\.length/);
});

// Round 3: a plan whose master parent this save cleared keeps the parent it was
// made on — the one the engine showed — and the toast says so.
test('the single engine\'s toast says what this job keeps when its master\'s parent is cleared', () => {
  const save = between('const savePlan = async', 'const reversePlan = async');
  assert.match(save, /const clearedNote = updated\.master_parent_cleared\s*\? ` · master parent \$\{updated\.master_parent_cleared\} cleared on \$\{planLine\.product_code\} — it can't stay on the new board; the master now cuts the board's full sheet`\s*\+ \(updated\.job_parent_kept \? ` · this job keeps \$\{updated\.job_parent_kept\}` : ''\) : '';/);
});
