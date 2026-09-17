// What every plant tablet downloads, parses and compiles before the shell paints
// is the entry chunk — anything statically imported from main.jsx, AppLayout and
// ui.jsx. Two things rode in there for no reason at boot:
//   - lib/exporter.js (14.5 KB), used only inside the Export button's click;
//   - components/Chat.jsx (42 KB with its icons), the messenger dock, which can
//     arrive one chunk later without the top bar moving.
// A `.jsx` cannot be `node --test`'d, so the wiring is pinned from source and the
// one piece of real logic (the open-request queue) lives in client/src/lib/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createChatOpenQueue, CHAT_OPEN_EVENT } from '../../client/src/lib/chatOpenQueue.js';

const src = new URL('../../client/src/', import.meta.url);
const read = path => readFileSync(new URL(path, src), 'utf8');

function clientFiles() {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = new URL(name, dir);
      if (statSync(p).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(jsx?|mjs)$/.test(name)) out.push(p);
    }
  };
  walk(src);
  return out;
}

// A static `import … from '…'` (single- or multi-line), never a dynamic import().
const staticImportOf = (source, re) =>
  [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].some(m => re.test(m[1]));

test('no client file statically imports the exporter — it loads on the export click', () => {
  const hits = clientFiles().filter(f => staticImportOf(readFileSync(f, 'utf8'), /(^|\/)lib\/exporter(\.js)?$/));
  assert.deepEqual(hits.map(f => f.pathname), []);
});

test('the export click imports the exporter inside its try, after the spinner is on', () => {
  const ui = read('components/ui.jsx');
  const run = ui.slice(ui.indexOf('const run = async kind =>'), ui.indexOf("const items = [\n    { kind: 'pdf'"));
  assert.ok(run.length > 0, 'export run handler found');
  const busy = run.indexOf('setBusy(kind)');
  const tryAt = run.indexOf('try {');
  const imp = run.search(/const \{ exportPDF, exportXLSX, specRowCount \} = await import\('\.\.\/lib\/exporter'\)/);
  assert.ok(imp > 0, 'dynamic import of ../lib/exporter in the run handler');
  assert.ok(busy < tryAt && tryAt < imp, 'spinner first, then inside try — a failed fetch toasts "Export failed" and clears busy');
  assert.ok(imp < run.indexOf('specRowCount(spec)'), 'imported before first use');
});

test('no client file statically imports Chat.jsx — the dock is a lazy chunk', () => {
  const hits = clientFiles().filter(f => staticImportOf(readFileSync(f, 'utf8'), /(^|\/)Chat(\.jsx)?$/));
  assert.deepEqual(hits.map(f => f.pathname), []);
  assert.match(read('components/AppLayout.jsx'), /^import ChatDock from '\.\/ChatDockLoader\.jsx';$/m);
});

test('the lazy dock is fenced: Suspense, an error boundary with a retry, and the open queue', () => {
  const loader = read('components/ChatDockLoader.jsx');
  assert.match(loader, /lazy\(\(\) => import\('\.\/Chat\.jsx'\)\)/);
  assert.match(loader, /<Suspense key=\{attempt\} fallback=\{<DockPlaceholder/);
  assert.match(loader, /<Dock \/>\s*<DockReady \/>/, 'the replay effect runs after the dock\'s listener effect');
  // Without a boundary a rejected chunk throws out of AppLayout and blanks the
  // whole shell — top bar, nav and the station screen — on every route.
  assert.match(loader, /static getDerivedStateFromError/);
  assert.match(loader, /createChatOpenQueue\(/);
  // The placeholder is the dock's own trigger, so the top bar never shifts.
  assert.match(loader, /<CountButton/);
  assert.match(loader, /label="Messages"/);
});

// ── the queue: an open request fired before the chunk lands is replayed once ──

const collect = target => {
  const seen = [];
  const h = e => seen.push(e.detail);
  target.addEventListener(CHAT_OPEN_EVENT, h);
  return { seen, stop: () => target.removeEventListener(CHAT_OPEN_EVENT, h) };
};
const fire = (target, detail) => target.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail }));

test('the event name is the one every module dispatches', () => {
  assert.equal(CHAT_OPEN_EVENT, 'ci-chat-open');
  for (const f of ['components/TopBar.jsx', 'components/ThreadCell.jsx', 'components/AppLayout.jsx', 'pages/Production.jsx', 'components/Chat.jsx']) {
    assert.match(read(f), /'ci-chat-open'/, f);
  }
});

test('a request made while the dock is loading is replayed to the dock when it mounts', () => {
  const target = new EventTarget();
  const q = createChatOpenQueue(target);
  const unwatch = q.watch();
  fire(target, { jobCardId: 42 });                 // Production "Discuss", chunk still in flight
  const dock = collect(target);                    // Chat.jsx's own listener
  const unmount = q.dockMounted();
  assert.deepEqual(dock.seen, [{ jobCardId: 42 }]);
  fire(target, { conversationId: 7 });             // once mounted, the dock hears it directly
  assert.deepEqual(dock.seen, [{ jobCardId: 42 }, { conversationId: 7 }], 'no double delivery');
  unmount(); unwatch(); dock.stop();
});

test('only the LAST request is kept — the g m chord with no detail included', () => {
  const target = new EventTarget();
  const q = createChatOpenQueue(target);
  const unwatch = q.watch();
  fire(target, { entity: 'order_line', entityId: 3 });
  fire(target, undefined);                         // TopBar's chord sends {} — a bare event must still count
  const dock = collect(target);
  q.dockMounted();
  assert.deepEqual(dock.seen, [{}]);
  unwatch(); dock.stop();
});

test('nothing queued means nothing replayed, and a replay happens once', () => {
  const target = new EventTarget();
  const q = createChatOpenQueue(target);
  const unwatch = q.watch();
  const dock = collect(target);
  const unmountFirst = q.dockMounted();
  assert.deepEqual(dock.seen, [], 'nothing queued, nothing replayed');
  unmountFirst();                                  // tier switch: phone → tablet shell
  dock.stop();

  fire(target, { conversationId: 1 });             // lands in the gap between the two docks
  const next = collect(target);
  const unmountSecond = q.dockMounted();
  q.dockMounted();                                 // a later mount must not replay it again
  assert.deepEqual(next.seen, [{ conversationId: 1 }]);
  unmountSecond(); unwatch(); next.stop();
});

test('a request with no loader watching (no shell mounted) is not saved for later', () => {
  const target = new EventTarget();
  const q = createChatOpenQueue(target);
  fire(target, { conversationId: 9 });
  const dock = collect(target);
  q.dockMounted();
  assert.deepEqual(dock.seen, []);
  dock.stop();
});

// A dock that FAILED to load is still a dock nobody hears. Production "Discuss", a
// ThreadCell, the bell and the g m chord must each retry the load — not only a tap on
// the placeholder — and the retry must not replace the thread they asked for with
// the inbox.
test('while the dock is down, a held request tells the loader, and a retry keeps the thread asked for', () => {
  const target = new EventTarget();
  const q = createChatOpenQueue(target);
  const unwatch = q.watch();
  const heard = [];
  const stopHeld = q.onHeld(detail => heard.push(detail));
  assert.equal(q.hasPending(), false);
  fire(target, { jobCardId: 42 });
  assert.deepEqual(heard, [{ jobCardId: 42 }], 'the loader hears a held request');
  assert.equal(q.hasPending(), true, 'so a tap-to-retry must not overwrite it with {}');
  stopHeld();
  fire(target, { conversationId: 5 });
  assert.equal(heard.length, 1, 'unsubscribed');
  const dock = collect(target);
  q.dockMounted();
  assert.deepEqual(dock.seen, [{ conversationId: 5 }]);
  assert.equal(q.hasPending(), false);
  unwatch(); dock.stop();
});

test('the failed dock retries on any held open request, and only asks for the inbox when nothing is held', () => {
  const loader = read('components/ChatDockLoader.jsx');
  assert.match(loader, /queue\?\.onHeld\(/, 'a held request retries a failed load');
  assert.match(loader, /if \(!queue\?\.hasPending\(\)\) requestOpen\(\)/, 'retry never overwrites a specific request');
});

// A boundary can MOUNT already failed: `Dock` is a module-level lazy that stays
// rejected, so a tier switch (phone ↔ tablet shell) or an AppLayout remount renders a
// fresh boundary straight into the error state. componentDidUpdate never sees a
// false → true change there, so the subscription must also be made on mount.
test('a boundary that mounts already failed still retries on held open requests', () => {
  const loader = read('components/ChatDockLoader.jsx');
  const mount = /componentDidMount\(\)\s*\{([\s\S]*?)\n  \}/.exec(loader);
  assert.ok(mount, 'DockBoundary has a componentDidMount');
  assert.match(mount[1], /if \(this\.state\.failed\)[\s\S]*queue\?\.onHeld\(\(\) => this\.retry\(\)\)/);
});
