// Is anything on this screen that a reload would destroy?
//
// buildWatch may now reload a VISIBLE page onto a new build — plant tablets are
// installed PWAs that stay in front all shift, and "reload only while hidden"
// left them on old bundles for days. That is only acceptable if the reload can
// never cost an operator anything, so these are the readings it must pass. The
// decision itself stays pure in buildWatch.shouldAutoReload; this module only
// measures.
//
//   idleMs         — time since the last pointer, key, touch or wheel input, or
//                    since the screen came back on.
//   overlayOpen    — a dialog, sheet or popover is open. ONE mechanism: every
//                    such layer carries `data-ci-overlay` (the shared Modal, the
//                    Select phone sheet, every portal). reload-overlay-markers
//                    .test.js fails on a portal or fixed layer that forgets it.
//   inFlight       — API WRITES on the wire (lib/inFlight.js). A GET is not
//                    counted: it cannot lose an entry.
//   editingFocused — the caret is in a field that takes typing.
//   dirty          — a form holds edits it has not saved. Defined NARROWLY:
//
//     • only fields inside a form scope count: <form>, .ci-form-panel,
//       .ci-form-grid, or [data-ci-form]. A filter bar, a search box or a
//       table's selection ticks are not a form. Counting every field anyone ever
//       typed into kept a station tablet busy forever the first time its
//       operator picked a filter — the reload would never have reached the
//       devices it exists for.
//     • a field marked data-reload-safe, or inside one, never counts.
//     • the scope's values are compared with what they were just BEFORE the user
//       first touched it (a pointer, key, touch or focus inside the scope). A
//       figure changed and changed back holds nothing. An edit that arrives with
//       no touch seen first has no known starting point and counts as dirty.
//     • the searchable Select's value lives in a hidden input React rewrites
//       without an input event, and its pick is made in a sheet portalled
//       outside the form — the snapshot reads that hidden input, so the pick
//       still counts.
//     • a scope is clean again once a write that STARTED from inside it (the
//       last touch before the request, within ORIGIN_MS) succeeds, or once the
//       scope leaves the page (the dialog closed, the panel unmounted). Only
//       what the write CARRIED is cleaned: a figure keyed into the same scope
//       while the save was on the wire still counts.
//
// Known gaps, accepted: a controlled field React re-mounts under a new node
// loses its tracking; a save sent from a confirm dialog over an inline form does
// not clean that form (it stays "dirty" until it unmounts — the safe direction);
// a panel that empties itself after a save during which more was keyed stays
// "dirty" until its next save or unmount (the safe direction again).
export const OVERLAY = '[data-ci-overlay]';
const FORM_SCOPE = 'form, .ci-form-panel, [data-ci-form]';
const FORM_GRID = '.ci-form-grid';
const RELOAD_SAFE = '[data-reload-safe]';
const FIELDS = 'input, select, textarea';
const NOT_DATA = new Set(['button', 'submit', 'reset', 'image']);
const NOT_TYPING = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden']);
const UNKNOWN = Symbol('unknown baseline');
const ORIGIN_MS = 10 * 1000;

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'];
const TOUCHES = ['pointerdown', 'touchstart', 'keydown', 'focusin'];
const EDITS = ['input', 'change'];

// The outermost form-ish container: a panel wins over the grid inside it, so a
// Save button in the panel header and the fields in its grid share one scope.
function formScopeOf(el) {
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(FORM_SCOPE) || el.closest(FORM_GRID);
}

const isSafe = el => !!el?.closest?.(RELOAD_SAFE);

export function snapshotOf(scope) {
  const parts = [];
  for (const f of scope.querySelectorAll(FIELDS)) {
    if (NOT_DATA.has(f.type) || isSafe(f)) continue;
    parts.push(f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? '1' : '0') : String(f.value ?? ''));
  }
  return parts.join('');
}

export function isTypingField(el) {
  if (!el || isSafe(el)) return false;
  if (el.isContentEditable) return true;
  if (el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !NOT_TYPING.has(String(el.type || 'text').toLowerCase());
}

export function createReloadSafety({ doc, win, now = Date.now, inFlightCount = () => 0, onWrite } = {}) {
  let lastInput = now();
  let lastTouch = null;
  let lastTouchAt = -Infinity;
  const scopes = new Map();   // scope element → snapshot before the first touch

  const onActivity = () => { lastInput = now(); };
  const onTouch = e => {
    lastTouch = e.target;
    lastTouchAt = now();
    const scope = formScopeOf(e.target);
    if (scope && !scopes.has(scope)) scopes.set(scope, snapshotOf(scope));
  };
  const onEdit = e => {
    if (isSafe(e.target)) return;
    const scope = formScopeOf(e.target);
    if (scope && !scopes.has(scope)) scopes.set(scope, UNKNOWN);
  };
  const onVisibility = () => { if (!doc.hidden) lastInput = now(); };

  const opts = { capture: true, passive: true };
  for (const type of ACTIVITY) win.addEventListener(type, onActivity, opts);
  for (const type of TOUCHES) doc.addEventListener(type, onTouch, opts);
  for (const type of EDITS) doc.addEventListener(type, onEdit, opts);
  doc.addEventListener('visibilitychange', onVisibility);

  // What a save carried is what the form held when it was SENT, not when the
  // answer came back. An operator keys 500, taps Save, and keys the next figure
  // (750) while the round trip is still out — 0.5-2 s on plant wi-fi. Forgetting
  // the scope on success would throw the 750 away with the 500. So the scope's
  // values are read as the write starts, and on success:
  //   • the screen still shows exactly that → forget the scope. The server holds
  //     everything on it, and a panel that empties itself for the next figure
  //     (after this runs) is not an unsaved edit.
  //   • the screen shows something else → keep tracking, measured against what
  //     the server now holds, so anything keyed during the save still counts.
  const unsubscribe = onWrite?.(() => {
    if (now() - lastTouchAt > ORIGIN_MS || !lastTouch) return null;
    const origin = lastTouch;
    const sent = [...scopes.keys()]
      .filter(scope => scope.contains(origin))
      .map(scope => [scope, snapshotOf(scope)]);
    if (!sent.length) return null;
    return () => {
      for (const [scope, carried] of sent) {
        if (!scopes.has(scope)) continue;             // gone from the page already
        if (snapshotOf(scope) === carried) scopes.delete(scope);
        else scopes.set(scope, carried);
      }
    };
  });

  function state() {
    let dirty = false;
    for (const [scope, baseline] of scopes) {
      if (!scope.isConnected) { scopes.delete(scope); continue; }
      if (baseline === UNKNOWN || snapshotOf(scope) !== baseline) dirty = true;
    }
    return {
      idleMs: now() - lastInput,
      overlayOpen: !!doc.querySelector(OVERLAY),
      inFlight: inFlightCount(),
      editingFocused: isTypingField(doc.activeElement),
      dirty,
    };
  }

  function stop() {
    for (const type of ACTIVITY) win.removeEventListener(type, onActivity, opts);
    for (const type of TOUCHES) doc.removeEventListener(type, onTouch, opts);
    for (const type of EDITS) doc.removeEventListener(type, onEdit, opts);
    doc.removeEventListener('visibilitychange', onVisibility);
    unsubscribe?.();
  }

  return { state, stop };
}
