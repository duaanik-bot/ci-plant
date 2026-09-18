import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBusyGuard, SPIN_AFTER_MS, BUSY_MAX_MS } from '../../client/src/lib/busyClick.js';

// A save button must not save twice. components/ui.jsx Button runs every press
// through lib/busyClick.js: while the promise its onClick returned is pending,
// the button is busy — disabled, aria-busy, a spinner if it is slow — and a
// press does nothing. These pin the rule with fake timers.

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));
function fakeTimers() {
  let now = 0; const due = [];
  return {
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; due.push(t); return t; },
    clearTimer: t => { const i = due.indexOf(t); if (i >= 0) due.splice(i, 1); },
    advance: ms => { now += ms; for (const t of [...due].sort((a, b) => a.at - b.at)) if (t.at <= now) { due.splice(due.indexOf(t), 1); t.fn(); } },
    pending: () => due.length,
  };
}

test('a second press while the save is on its way does nothing; the next one after it settles goes', async () => {
  const log = []; const t = fakeTimers();
  const g = createBusyGuard({ onBusy: b => log.push(`busy:${b}`), onSpin: s => log.push(`spin:${s}`), ...t });
  const d = deferred(); let saves = 0;
  const save = () => { saves++; return d.promise; };
  g.press(save); g.press(save); g.press(save);            // a triple-click, same instant
  assert.equal(saves, 1, 'only the first press saved');
  assert.equal(g.busy, true);
  d.resolve('ok'); await tick();
  assert.equal(g.busy, false);
  assert.deepEqual(log, ['busy:true', 'spin:false', 'busy:false']);
  g.press(() => { saves++; return Promise.resolve(); });
  assert.equal(saves, 2, 'a press after the save settled is a new save');
  assert.equal(t.pending(), 2, 'its own two timers — and none left from the first');
});

test('a slow save shows a spinner; a quick one never does', async () => {
  const spins = []; const t = fakeTimers();
  const g = createBusyGuard({ onSpin: s => spins.push(s), ...t });
  const slow = deferred();
  g.press(() => slow.promise);
  t.advance(SPIN_AFTER_MS - 1); assert.deepEqual(spins, []);
  t.advance(1); assert.deepEqual(spins, [true]);
  slow.resolve(); await tick();
  assert.deepEqual(spins, [true, false]);
  const quick = deferred();
  g.press(() => quick.promise); quick.resolve(); await tick();
  t.advance(SPIN_AFTER_MS * 2);
  assert.deepEqual(spins, [true, false, false], 'no spinner after a quick save');
});

test('a refused save frees the button, so the user can correct and press again', async () => {
  const t = fakeTimers(); const g = createBusyGuard(t);
  const d = deferred();
  const out = g.press(() => d.promise);
  d.reject(new Error('Quantity must be greater than zero'));
  await assert.rejects(out, /greater than zero/, 'the caller still sees the refusal');
  await tick();
  assert.equal(g.busy, false);
});

test('a press whose handler returns nothing is untouched — no busy, no swallowing', () => {
  const t = fakeTimers(); let n = 0;
  const g = createBusyGuard(t);
  g.press(() => { n++; }); g.press(() => { n++; });
  assert.equal(n, 2);
  assert.equal(g.busy, false);
  assert.equal(t.pending(), 0);
});

test('a promise that never settles cannot leave the button dead', async () => {
  const t = fakeTimers(); let n = 0;
  const g = createBusyGuard(t);
  g.press(() => { n++; return new Promise(() => {}); });   // a dialog closed without answering
  t.advance(BUSY_MAX_MS - 1); g.press(() => { n++; return Promise.resolve(); });
  assert.equal(n, 1, 'still busy just before the limit');
  t.advance(1);
  assert.equal(g.busy, false);
  g.press(() => { n++; return Promise.resolve(); });
  assert.equal(n, 2, 'pressable again after the limit');
});

test('the swallowed press is cancelled, and a disposed guard reports nothing', async () => {
  const t = fakeTimers(); const calls = [];
  const g = createBusyGuard({ onBusy: b => calls.push(b), ...t });
  const d = deferred();
  g.press(() => d.promise);
  let prevented = false;
  g.press(() => assert.fail('must not run'), { preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'the second click event is cancelled (a form does not submit it)');
  g.dispose();
  d.resolve(); await tick(); t.advance(BUSY_MAX_MS);
  assert.deepEqual(calls, [true], 'no state updates after the button unmounted');
});

// ── wiring ──────────────────────────────────────────────────────────────────
test('the shared Button runs every press through the guard unless it opts out', () => {
  const ui = fs.readFileSync(new URL('../../client/src/components/ui.jsx', import.meta.url), 'utf8');
  const hook = ui.slice(ui.indexOf('export function usePressGuard('), ui.indexOf('// Button'));
  // The guard is built in the effect (StrictMode remounts), never at render.
  assert.match(hook, /useEffect\(\(\) => \{\s*guard\.current = createBusyGuard\(\{ onBusy: setBusy, onSpin: setSpin \}\);\s*return \(\) => \{ guard\.current\.dispose\(\); guard\.current = null; \};/);
  const body = ui.slice(ui.indexOf('export function Button('), ui.indexOf('export function PressButton('));
  assert.match(body, /repeatable = false/);
  assert.match(body, /const \{ busy, spin, press \} = usePressGuard\(\);/);
  assert.match(body, /const handleClick = onClick && !repeatable \? e => press\(onClick, e\) : onClick;/);
  assert.match(body, /onClick=\{handleClick\}/);
  assert.match(body, /disabled=\{disabled \|\| busy\}/);
  assert.match(body, /aria-busy=\{busy \|\| undefined\}/);
  // {...props} before the guarded props: a caller cannot override them.
  assert.ok(body.indexOf('{...props}') < body.indexOf('onClick={handleClick}'), 'props spread first');
  // The spinner overlays the label (no width change) and yields to a caller
  // that shows its own busy state.
  assert.match(body, /const drawsOwnSpinner = Children\.toArray\(children\)\.some\(c => c\?\.type === Loader2\);/);
  assert.match(body, /const showSpin = spin && !drawsOwnSpinner;/, 'every busy button spins unless it draws its own');
  assert.match(body, /<span id=\{labelId\} className="invisible contents">\{children\}<\/span>\s*<span className="absolute inset-0 flex items-center justify-center"/);
  assert.match(body, /aria-labelledby=\{namedBy\}/, 'the hidden label still names the busy button');
  assert.match(body, /busy \? '!cursor-wait' : ''/);
});

// The dialog and the row menu wait for what they start, and a plain button that
// writes has the same guard (PressButton).
const read = p => fs.readFileSync(new URL(`../../client/src/${p}`, import.meta.url), 'utf8');
test('ConfirmDialog waits for its action; ActionMenu guards its items; PressButton exists', () => {
  const ui = read('components/ui.jsx');
  const confirm = ui.slice(ui.indexOf('export function ConfirmDialog('), ui.indexOf('// Status badge'));
  // One guard for the whole dialog, so Cancel / Esc and the confirm button all
  // come back together — never "only the write is live" after a stall.
  assert.match(confirm, /const \{ busy, press \} = usePressGuard\(\);/);
  assert.match(confirm, /const confirm = \(\) => press\(\(\) => \{\s*const out = onConfirm\(\);\s*if \(!out \|\| typeof out\.then !== 'function'\) \{ onClose\(\); return undefined; \}/,
    'an onConfirm that returns nothing closes at once, as before');
  assert.match(confirm, /return out\.then\(\(\) => \{ onClose\(\); \}, \(\) => \{\}\);/,
    'a promise keeps the dialog up until it settles; success closes it, a refusal leaves it');
  assert.match(confirm, /onClose=\{busy \? \(\) => \{\} : onClose\}/, 'backdrop / X held while busy');
  assert.match(confirm, /onClick=\{onClose\} disabled=\{busy\}/, 'Cancel held while busy');
  assert.match(confirm, /window\.addEventListener\('keydown', hold, true\);\s*return \(\) => window\.removeEventListener\('keydown', hold, true\);/, 'Esc swallowed before a modal underneath sees it, and released after');
  assert.match(confirm, /if \(top && msgRef\.current && !top\.contains\(msgRef\.current\)\) return;/, 'only while this dialog is on top — an alarm opened above keeps its own Esc');
  assert.match(confirm, /if \(!busy \|\| !open\) return undefined;/);
  const menu = ui.slice(ui.indexOf('export function ActionMenu('), ui.indexOf('const KPI_TONES'));
  assert.match(menu, /press\(\(\) => item\.onClick\?\.\(\)\)/);
  assert.match(menu, /const toggle = \(\) => \{\s*if \(busy\) return;/, 'no reopening while an item\'s action runs');
  assert.match(ui, /export function PressButton\(\{ onClick, disabled, repeatable = false, \.\.\.props \}\)/);
  assert.match(read('index.css'), /button\[aria-busy="true"\],\s*span\[aria-busy="true"\] \{\s*opacity: 0\.55;\s*cursor: wait;/);
});

// A second press of these mid-flight IS a second action (each arrow tap moves a
// job one place; each chat send is a message; the P1 star is an optimistic
// toggle) — found by the pre-change sweep of 2026-09-18. They stay plain
// buttons, never guarded.
test('the controls meant to be pressed again mid-flight stay unguarded', () => {
  const rawButton = (src, needle) => {
    const at = src.indexOf(needle);
    assert.ok(at > 0, `cannot find ${needle}`);
    const open = src.lastIndexOf('<', at);
    return src.slice(open, open + 13);
  };
  const jobRow = read('components/floor/JobRow.jsx');
  for (const t of ['title="Move up the queue"', 'title="Move down the queue"'])
    assert.ok(rawButton(jobRow, t).startsWith('<button'), `JobRow ${t}`);
  const pp = read('pages/PrintPlanning.jsx');
  for (const t of ['title="Move up"', 'title="Move down"'])
    assert.ok(rawButton(pp, t).startsWith('<button'), `Print Planning ${t}`);
  assert.doesNotMatch(read('components/Chat.jsx'), /<PressButton[^>]*onClick=\{send\}/, 'chat Send stays unguarded');
  assert.doesNotMatch(read('pages/StatusSheet.jsx'), /<PressButton[^>]*is_p1/, 'the P1 star stays unguarded');
});

// Three page fixes the review asked for, each pinned.
test('the pages around the dialogs keep their fixes', () => {
  // A late close from a settled confirm clears only its own question.
  assert.match(read('pages/Procurement.jsx'), /setConfirm\(cur => \(cur === confirm \? null : cur\)\)/);
  // Order status buttons are built by a plain function, never a component
  // defined in render (a new type each render would remount the Button and drop
  // its guard mid-save).
  const orders = read('pages/Orders.jsx');
  assert.doesNotMatch(orders, /const B = \(\{ to, children, variant/);
  assert.match(orders, /const b = \(to, label, variant = 'secondary'\) => \(/);
  // The WIP-clear confirm names what Confirm clears: live until the press,
  // frozen while the save runs.
  const ss = read('pages/StatusSheet.jsx');
  assert.match(ss, /if \(!bulkBusy\) clearShownRef\.current = \{ n: clearable\.length, scope: clearScope \};/);
  assert.match(ss, /confirmLabel=\{`Clear \$\{clearShown\.n\} line/);
});
