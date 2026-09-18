// What makes a screen "busy" to the build watch — the readings behind every
// veto in shouldAutoReload (build-watch.test.js pins the decision itself).
//
// A floor tablet now reloads by itself onto a new build once it has sat idle.
// Everything here exists so that reload can never cost an operator anything:
// a dialog still open, a save still on the wire, a caret still in a field, or a
// form holding figures that were typed and never saved.
//
// "Dirty" is defined NARROWLY on purpose. The first design counted every field
// anyone had ever typed into, and a station tablet whose operator once picked a
// machine or a filter would never have qualified again — the fix would never
// have reached the devices it was for. So:
//
//   • only fields inside a FORM SCOPE count — <form>, .ci-form-panel,
//     .ci-form-grid, or anything marked data-ci-form. A filter bar, a search box
//     or a table's selection ticks are not a form.
//   • a field marked data-reload-safe (or inside one) never counts.
//   • dirty means the scope's values DIFFER from what they were before the user
//     first touched it — change a figure and change it back, and nothing is
//     lost.
//   • a scope is clean again once a write started from inside it succeeds, or
//     once it leaves the page (the dialog closed, the panel unmounted).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createReloadSafety, snapshotOf, isTypingField, OVERLAY,
} from '../../client/src/lib/reloadSafety.js';
import { tracked, writesInFlight, onWrite } from '../../client/src/lib/inFlight.js';

// ── A stand-in DOM, just big enough for the selectors the tracker uses ─────
function matchesOne(el, sel) {
  sel = sel.trim();
  if (sel.startsWith('.')) return el.classes.has(sel.slice(1));
  if (sel.startsWith('[')) return sel.slice(1, -1) in el.attrs;
  return el.tagName === sel.toUpperCase();
}
class El {
  constructor(tag, { cls = '', attrs = {}, type, value = '', checked = false, readOnly = false } = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.attrs = attrs;
    this.type = type ?? (this.tagName === 'INPUT' ? 'text' : undefined);
    this.value = value;
    this.checked = checked;
    this.readOnly = readOnly;
    this.disabled = false;
    this.parent = null;
    this.children = [];
    this.isRoot = false;
    for (const c of children) this.append(c);
  }
  append(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.isRoot; }
  matches(sel) { return sel.split(',').some(s => matchesOne(this, s)); }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
const h = (tag, props, ...children) => new El(tag, props, children);

function world() {
  const body = h('body');
  body.isRoot = true;
  const listeners = [];
  const target = () => ({
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => { const i = listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
  });
  const doc = { ...target(), body, hidden: false, activeElement: body,
    querySelector: sel => body.querySelectorAll(sel)[0] || null };
  const win = target();
  let t = 1_000_000;
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const fire = (type, el) => { for (const l of [...listeners]) if (l.type === type) l.fn({ type, target: el }); };
  return { body, doc, win, clock, fire, listeners };
}
const MIN = 60 * 1000;

function tracker(w, extra = {}) {
  return createReloadSafety({ doc: w.doc, win: w.win, now: w.clock.now, inFlightCount: writesInFlight, onWrite, ...extra });
}

// ── Idle ────────────────────────────────────────────────────────────────────
test('the idle clock is reset by any pointer, key, touch or wheel input, and by the screen waking', () => {
  const w = world();
  const s = tracker(w);
  assert.equal(s.state().idleMs, 0, 'a page that just started has not been idle yet');
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']) {
    w.clock.advance(20 * MIN);
    assert.equal(s.state().idleMs, 20 * MIN);
    w.fire(type, w.body);
    assert.equal(s.state().idleMs, 0, `${type} is somebody at the screen`);
  }
  w.clock.advance(20 * MIN);
  w.doc.hidden = false;
  w.fire('visibilitychange', w.doc);
  assert.equal(s.state().idleMs, 0, 'a tablet screen coming back on is an operator about to use it');
  s.stop();
  assert.equal(w.listeners.length, 0, 'stop removes every listener it added');
});

// ── Overlays ────────────────────────────────────────────────────────────────
test('an open overlay is read off the ONE marker', () => {
  const w = world();
  const s = tracker(w);
  assert.equal(OVERLAY, '[data-ci-overlay]');
  assert.equal(s.state().overlayOpen, false);
  const sheet = w.body.append(h('div', { attrs: { 'data-ci-overlay': '' } }));
  assert.equal(s.state().overlayOpen, true);
  sheet.remove();
  assert.equal(s.state().overlayOpen, false, 'closing it frees the page');
});

// ── Requests in flight ──────────────────────────────────────────────────────
test('every write is counted while it is on the wire — a failed one too; a GET is not', async () => {
  const w = world();
  const s = tracker(w);
  let release;
  const pending = tracked(true, () => new Promise(r => { release = r; }));
  assert.equal(s.state().inFlight, 1, 'a save in flight');
  release({});
  await pending;
  assert.equal(s.state().inFlight, 0);
  await assert.rejects(tracked(true, async () => { throw new Error('409'); }));
  assert.equal(writesInFlight(), 0, 'a refused write must not leave the page busy forever');

  let loaded;
  const polling = tracked(false, () => new Promise(r => { loaded = r; }));
  assert.equal(s.state().inFlight, 0, 'a data poll on the wire cannot lose an entry');
  loaded({ rows: [] });
  assert.deepEqual(await polling, { rows: [] }, 'the GET still answers its caller');
  await assert.rejects(tracked(false, async () => { throw new Error('502'); }), /502/, 'and still fails to its caller');
});

// ── Focus ───────────────────────────────────────────────────────────────────
test('a caret in a field is editing; a tick box, a read-only field or a search box is not', () => {
  assert.equal(isTypingField(h('input', { type: 'number' })), true);
  assert.equal(isTypingField(h('textarea')), true);
  assert.equal(isTypingField(h('input', { type: 'checkbox' })), false);
  assert.equal(isTypingField(h('input', { readOnly: true })), false);
  assert.equal(isTypingField(h('input', { attrs: { 'data-reload-safe': '' } })), false,
    'a search box left focused on a wall screen holds nothing a reload can lose');
  assert.equal(isTypingField(h('button')), false);
  assert.equal(isTypingField(null), false);

  const w = world();
  const s = tracker(w);
  const qty = w.body.append(h('input', { type: 'number' }));
  w.doc.activeElement = qty;
  assert.equal(s.state().editingFocused, true);
});

// ── Dirty forms ─────────────────────────────────────────────────────────────
function counterPanel() {
  const good = h('input', { type: 'number', value: '' });
  const scrap = h('input', { type: 'number', value: '' });
  const save = h('button');
  const panel = h('section', { cls: 'ci-form-panel' }, h('div', { cls: 'ci-form-grid' }, good, scrap), save);
  return { panel, good, scrap, save };
}

test('a figure typed into a form panel and not saved makes the page dirty', () => {
  const w = world();
  const s = tracker(w);
  const { panel, good } = counterPanel();
  w.body.append(panel);
  assert.equal(s.state().dirty, false, 'an untouched form holds nothing');
  w.fire('pointerdown', good);
  good.value = '1200';
  w.fire('input', good);
  assert.equal(s.state().dirty, true);
  good.value = '';
  w.fire('input', good);
  assert.equal(s.state().dirty, false, 'typed and taken back out: nothing to lose');
});

test('a form that has left the page is not holding anything', () => {
  const w = world();
  const s = tracker(w);
  const { panel, good } = counterPanel();
  w.body.append(panel);
  w.fire('focusin', good);
  good.value = '40';
  w.fire('input', good);
  assert.equal(s.state().dirty, true);
  panel.remove();
  assert.equal(s.state().dirty, false, 'the dialog closed or the panel unmounted');
});

test('a filter, a search box or a selection tick is never a dirty form', () => {
  const w = world();
  const s = tracker(w);
  // Outside any form scope: the filter bar above a table.
  const from = w.body.append(h('div', { cls: 'flex' }, h('input', { type: 'date' }))).children[0];
  w.fire('pointerdown', from);
  from.value = '2026-09-01';
  w.fire('change', from);
  assert.equal(s.state().dirty, false, 'a date filter outside a form');
  // Inside a form scope, but marked safe: a job card list uses .ci-form-panel as
  // a card style and carries a print-run tick inside it.
  const tick = h('input', { type: 'checkbox', attrs: { 'data-reload-safe': '' } });
  w.body.append(h('div', { cls: 'ci-form-panel' }, tick));
  w.fire('pointerdown', tick);
  tick.checked = true;
  w.fire('change', tick);
  assert.equal(s.state().dirty, false, 'a data-reload-safe control inside a panel');
});

test('a pick from the searchable Select counts, through the hidden input that holds its value', () => {
  // The Select's visible box is only its search query (marked data-reload-safe);
  // the value lives in a hidden input React rewrites without any input event,
  // and the phone sheet the pick is made in is portalled OUTSIDE the form.
  const w = world();
  const s = tracker(w);
  const hidden = h('input', { type: 'hidden', value: '' });
  const query = h('input', { attrs: { 'data-reload-safe': '' } });
  const panel = w.body.append(h('section', { cls: 'ci-form-panel' }, h('div', { cls: 'relative' }, hidden, query)));
  w.fire('pointerdown', query);
  query.value = 'Offset';
  w.fire('input', query);
  assert.equal(s.state().dirty, false, 'typing a search is not choosing anything');
  hidden.value = '7';
  assert.equal(s.state().dirty, true, 'machine 7 was chosen and not saved');
  assert.ok(panel.isConnected);
});

test('an edit whose starting value was never seen is dirty until saved or gone', () => {
  const w = world();
  const s = tracker(w);
  const { panel, good } = counterPanel();
  w.body.append(panel);
  good.value = '90';
  w.fire('input', good);   // no touch first: nothing recorded what it held before
  assert.equal(s.state().dirty, true, 'unknown is not clean');
});

test('a save started from inside the form cleans it; a failed one does not', async () => {
  const w = world();
  const s = tracker(w);
  const { panel, good, save } = counterPanel();
  w.body.append(panel);
  w.fire('pointerdown', good);
  good.value = '500';
  w.fire('input', good);

  w.fire('pointerdown', save);
  await assert.rejects(tracked(true, async () => { throw new Error('Request failed (500)'); }));
  assert.equal(s.state().dirty, true, 'the save was refused — the figure is still only on this screen');

  w.fire('pointerdown', save);
  await tracked(true, async () => ({ ok: true }));
  assert.equal(s.state().dirty, false, 'saved: the server has it now, even though the field still shows it');

  w.fire('pointerdown', good);
  good.value = '520';
  w.fire('input', good);
  assert.equal(s.state().dirty, true, 'the next edit starts a fresh comparison against what was saved');
});

test('a figure keyed while the save is still on the wire is not wiped by that save landing', async () => {
  // Serverless round trips on plant wi-fi take 0.5-2 s. The operator keys 500,
  // taps Save, and keys the next figure (750) before the answer comes back. The
  // save carried 500, not 750 — so 750 is still held only on this screen.
  const w = world();
  const s = tracker(w);
  const { panel, good, scrap, save } = counterPanel();
  w.body.append(panel);
  w.fire('pointerdown', good);
  good.value = '500';
  w.fire('input', good);
  w.fire('pointerdown', save);
  let land;
  const pending = tracked(true, () => new Promise(r => { land = r; }));
  w.fire('keydown', scrap);
  scrap.value = '750';
  w.fire('input', scrap);
  land({ ok: true });
  await pending;
  assert.equal(s.state().dirty, true, 'the 750 keyed during the save was never sent');
  scrap.value = '';
  w.fire('input', scrap);
  assert.equal(s.state().dirty, false, 'taken back out: what is on screen is exactly what the server took');
});

test('a form that clears itself once its save lands is clean', async () => {
  // Most entry panels empty their fields for the next figure when the server
  // says yes. That is not an unsaved edit.
  const w = world();
  const s = tracker(w);
  const { panel, good, save } = counterPanel();
  w.body.append(panel);
  w.fire('pointerdown', good);
  good.value = '500';
  w.fire('input', good);
  w.fire('pointerdown', save);
  await tracked(true, async () => ({ ok: true }));
  good.value = '';   // React resets the panel after the caller's .then()
  assert.equal(s.state().dirty, false);
});

test('a write from somewhere else does not clean a form it did not come from', async () => {
  const w = world();
  const s = tracker(w);
  const { panel, good } = counterPanel();
  w.body.append(panel);
  w.fire('pointerdown', good);
  good.value = '75';
  w.fire('input', good);
  const elsewhere = w.body.append(h('button'));
  w.fire('pointerdown', elsewhere);
  await tracked(true, async () => ({}));
  assert.equal(s.state().dirty, true, 'a chip toggled in the header saved something else');
  // A GET is never a save.
  w.fire('pointerdown', panel);
  await tracked(false, async () => ({}));
  assert.equal(s.state().dirty, true);
});

test('a write long after the last touch is not credited to that form', async () => {
  const w = world();
  const s = tracker(w);
  const { panel, good, save } = counterPanel();
  w.body.append(panel);
  w.fire('pointerdown', good);
  good.value = '10';
  w.fire('input', good);
  w.fire('pointerdown', save);
  w.clock.advance(5 * MIN);   // a background write, minutes later
  await tracked(true, async () => ({}));
  assert.equal(s.state().dirty, true);
});

test('the snapshot reads values and ticks, and skips buttons and safe fields', () => {
  const panel = h('section', { cls: 'ci-form-panel' },
    h('input', { value: 'a' }),
    h('input', { type: 'checkbox', checked: true }),
    h('input', { type: 'submit', value: 'Save' }),
    h('input', { value: 'q', attrs: { 'data-reload-safe': '' } }),
    h('div', { attrs: { 'data-reload-safe': '' } }, h('input', { value: 'inner' })),
    h('select', { value: '3' }),
  );
  const before = snapshotOf(panel);
  panel.children[2].value = 'Saving…';
  panel.children[3].value = 'other search';
  panel.children[4].children[0].value = 'other';
  assert.equal(snapshotOf(panel), before, 'none of those are data the form holds');
  panel.children[1].checked = false;
  assert.notEqual(snapshotOf(panel), before, 'a tick is');
});

// ── Wiring ──────────────────────────────────────────────────────────────────
const read = p => readFileSync(new URL(`../../client/src/${p}`, import.meta.url), 'utf8');

test('both of api.js\'s exits are counted, and only a write can be a save', () => {
  const api = read('api.js');
  assert.match(api, /import \{ tracked \} from '\.\/lib\/inFlight\.js'/);
  // Wrapped in the double-click join (write-once.test.js) — still one count per
  // request that actually goes out.
  assert.match(api, /\(\) => tracked\(method !== 'GET', \(\) => send\(method, url, body\)\)/, 'request()');
  assert.match(api, /upload\(url, file, extra = \{\}\) \{\s*return tracked\(true, async \(\) => \{/, 'upload()');
});

test('the watch feeds the pure decision from these readings, and re-checks every minute', () => {
  const bw = read('lib/buildWatch.js');
  assert.match(bw, /createReloadSafety\(\{ doc: document, win: window, inFlightCount: writesInFlight, onWrite \}\)/);
  assert.match(bw, /\.\.\.safety\.state\(\)/);
  assert.match(bw, /const RECHECK_MS = 60 \* 1000;/);
  assert.match(bw, /setInterval\(decide, RECHECK_MS\)/);
});

test('the filter controls that live inside form-looking markup are marked safe', () => {
  const ui = read('components/ui.jsx');
  const search = ui.slice(ui.indexOf('export function SearchInput('), ui.indexOf('// Deep row search'));
  assert.match(search, /<input\s+data-reload-safe/, 'SearchInput');
  const select = ui.slice(ui.indexOf('function SearchableSelect('), ui.indexOf('export function Select('));
  assert.equal((select.match(/<input\s+data-reload-safe/g) || []).length, 2, 'both Select query boxes; the hidden input stays counted');
  assert.match(read('pages/Production.jsx'), /data-reload-safe type="checkbox" checked=\{picked\.has\(jc\.id\)\}/,
    'the print-run tick inside a .ci-form-panel job card');
});

// ── The watch end to end, with the page stubbed ─────────────────────────────
test('a stale visible page waits out the idle window and an open dialog, then reloads once', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, location: globalThis.location, performance: globalThis.performance };
  try {
    const w = world();
    const script = h('script', { attrs: {} });
    script.getAttribute = n => (n === 'src' ? '/assets/index-OLD.js' : null);
    const doc = Object.assign(w.doc, {
      querySelectorAll: sel => (sel === 'script, link' ? [script] : w.body.querySelectorAll(sel)),
    });
    let reloads = 0;
    globalThis.document = doc;
    globalThis.window = w.win;
    Object.defineProperty(globalThis, 'location', { value: { reload: () => { reloads++; } }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'performance', { value: { getEntriesByType: () => [{ type: 'navigate' }] }, configurable: true, writable: true });
    globalThis.fetch = async () => ({ ok: true, text: async () => '<script type="module" src="/assets/index-NEW.js"></script>' });

    const { startBuildWatch } = await import('../../client/src/lib/buildWatch.js');
    let announced = 0;
    const stop = startBuildWatch({ onNewBuild: () => { announced++; } });
    const flush = () => new Promise(r => setImmediate(r));

    mock.timers.tick(5 * MIN);                   // the poll finds the new build
    await flush(); await flush();
    assert.equal(announced, 1, 'the banner is offered at once');
    assert.equal(reloads, 0, 'but a screen in front of someone waits out the idle window first');

    const dialog = w.body.append(h('div', { attrs: { 'data-ci-overlay': '' } }));
    mock.timers.tick(15 * MIN);
    assert.equal(reloads, 0, 'idle long enough, but a dialog is open');

    dialog.remove();
    mock.timers.tick(1 * MIN);
    assert.equal(reloads, 1, 'dialog closed, still idle: the next minute\'s re-check takes it');

    // The document did not actually go away (this is a stub). Every later poll
    // and re-check must see the attempt already spent on this build.
    mock.timers.tick(10 * MIN);
    await flush(); await flush();
    assert.equal(reloads, 1, 'one attempt per build, however often it looks again');
    stop();
  } finally {
    mock.timers.reset();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
  }
});

test('a screen polling its data (a GET on the wire) still takes the new build once idle', async () => {
  // Floor, Section, Sort & Paste and Print Planning reload their data every 30 s
  // and the chat dock every 60 s — both divide the 1-minute re-check, so every
  // re-check can land in the same load window. A GET cannot lose an entry; only
  // a write on the wire may hold the page.
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, location: globalThis.location, performance: globalThis.performance };
  let finishGet;
  try {
    const w = world();
    const script = h('script', { attrs: {} });
    script.getAttribute = n => (n === 'src' ? '/assets/index-OLD.js' : null);
    const doc = Object.assign(w.doc, {
      querySelectorAll: sel => (sel === 'script, link' ? [script] : w.body.querySelectorAll(sel)),
    });
    let reloads = 0;
    globalThis.document = doc;
    globalThis.window = w.win;
    Object.defineProperty(globalThis, 'location', { value: { reload: () => { reloads++; } }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'performance', { value: { getEntriesByType: () => [{ type: 'navigate' }] }, configurable: true, writable: true });
    globalThis.fetch = async () => ({ ok: true, text: async () => '<script type="module" src="/assets/index-POLLED.js"></script>' });

    const { startBuildWatch } = await import('../../client/src/lib/buildWatch.js');
    const stop = startBuildWatch({});
    const flush = () => new Promise(r => setImmediate(r));
    mock.timers.tick(5 * MIN);
    await flush(); await flush();
    assert.equal(reloads, 0, 'not idle long enough yet');

    const getting = tracked(false, () => new Promise(r => { finishGet = r; }));
    mock.timers.tick(15 * MIN);
    assert.equal(reloads, 1, 'a data poll on the wire at the re-check must not hold the build back');
    finishGet({});
    await getting;
    stop();
  } finally {
    finishGet?.({});
    mock.timers.reset();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
  }
});
