import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  CATEGORIES, CATEGORY_IDS, KINDS_BY_CATEGORY, KNOWN_KINDS, OTHER,
  categoryOf, isCategory, kindsFor,
} from './notify-categories.js';

// The map is checked against the SOURCE, not against a copy of the kind list —
// same trick record-entities.test.js uses to hold a registry to the schema. A
// notification kind that exists in a route but not in the map would otherwise
// ship as a row that is filtered out of every tab while still counting towards
// the unread badge, and nothing would say so until somebody noticed the bell
// lying.
const SRC = new URL('./', import.meta.url);
const ROUTES = fs.readdirSync(new URL('./routes/', SRC))
  .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map(f => `routes/${f}`);
const SCANNED = [...ROUTES, 'helpers.js'];
const read = rel => fs.readFileSync(new URL(`./${rel}`, SRC), 'utf8');

// The expression a `kind:` property is set to, read to the end of that property:
// the next comma or newline at bracket depth zero. Quote-aware, so a comma
// inside a string does not end it, and depth-aware, so `msgKind(mime, secs)`
// survives as one expression. Deliberately NOT a regex — the plant's shade-card
// alerts write `kind: overdue ? 'approval_overdue' : 'pending_customer'`, two
// kinds on one line, and a regex reading up to the first quote would have found
// one of them and left the other unmapped and invisible.
function expressionAfter(src, start) {
  let depth = 0, quote = null, out = '';
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') out += src[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if ('([{'.includes(ch)) { depth++; out += ch; continue; }
    if (')]}'.includes(ch)) { if (depth === 0) break; depth--; out += ch; continue; }
    if ((ch === ',' || ch === '\n') && depth === 0) break;
    out += ch;
  }
  return out;
}

// Every string literal a `kind:` property can be set to, with where it was
// found. A dynamic value (`kind: row.kind`, `kind: msgKind(...)`) yields no
// literal and is simply not a claim this test can check.
function kindLiterals(rel) {
  const src = read(rel);
  const out = [];
  for (const m of src.matchAll(/\bkind:\s*/g)) {
    const expr = expressionAfter(src, m.index + m[0].length);
    for (const lit of expr.matchAll(/'([^']*)'/g)) {
      out.push({ kind: lit[1], where: `${rel}:${src.slice(0, m.index).split('\n').length}` });
    }
  }
  return out;
}

// The kinds that reach the notifications TABLE: helpers.notify(userIds, {kind…})
// is the only writer, so its call sites are the exhaustive list. The payload is
// an object literal opening on the same call, so the first `kind:` inside a
// short window after `notify(` is that call's kind.
const NOTIFY_WINDOW = 300;

function notifyKinds(rel) {
  const src = read(rel);
  const found = [];
  const unresolved = [];
  for (const m of src.matchAll(/\bnotify\(/g)) {
    if (src.slice(m.index - 9, m.index) === 'function ') continue;   // the definition itself
    const line = `${rel}:${src.slice(0, m.index).split('\n').length}`;
    const hit = src.slice(m.index, m.index + NOTIFY_WINDOW).match(/\bkind:\s*'([^']+)'/);
    if (hit) found.push({ kind: hit[1], where: line });
    else unresolved.push(line);
  }
  return { found, unresolved };
}

const ALL_LITERALS = SCANNED.flatMap(kindLiterals);
const NOTIFY = SCANNED.map(notifyKinds)
  .reduce((a, b) => ({ found: [...a.found, ...b.found], unresolved: [...a.unresolved, ...b.unresolved] }),
    { found: [], unresolved: [] });

// `kind:` is not exclusive to notifications. These are the other things in the
// ERP that call a discriminator `kind`, listed by name so that a NEW kind lands
// in neither list and trips the test below — which is the whole point: the next
// session has to decide where its notification belongs, and cannot do it by
// accident.
const NOT_NOTIFICATION_KINDS = new Map([
  ['text', 'messages.kind — a chat message is text/voice/file/system'],
  ['auto', 'logbook + master-history entry kind — a machine run, not a bell'],
  ['manual', 'logbook + master-history entry kind — a hand-written entry'],
  // reverseManifest() item kinds — the itemised list of ledger effects a stage
  // send-back will undo. They name a compensation the confirm dialog prints and
  // the audit line repeats; nothing is ever inserted into notifications with
  // them. The send-back's actual bell is kind 'stage_sent_back' (decisions).
  ['board_return', 'reverseManifest item — sheets going back to the warehouse'],
  ['leftover_unbank', 'reverseManifest item — banked offcut taken back'],
  ['wastage_reversal', 'reverseManifest item — recorded scrap reversed out'],
  ['extra_sheets_return', 'reverseManifest item — issued XS sheets clawed back'],
  ['runs_deleted', 'reverseManifest item — day-wise run rows removed'],
]);

// ── the map is well formed ────────────────────────────────────────────
test('categories are unique, labelled, and end in the fallback', () => {
  assert.equal(new Set(CATEGORY_IDS).size, CATEGORIES.length, 'duplicate category id');
  for (const c of CATEGORIES) {
    assert.equal(typeof c.id, 'string');
    assert.ok(c.label && typeof c.label === 'string', `${c.id} has no label`);
  }
  // Last, because it is where everything unrecognised piles up — a fallback tab
  // sitting between two real ones reads like a category the plant chose.
  assert.equal(CATEGORY_IDS[CATEGORY_IDS.length - 1], OTHER);
});

test('the categories the design names all exist', () => {
  for (const id of ['approvals', 'mentions', 'messages', 'decisions', 'quality', 'alerts', 'other']) {
    assert.ok(isCategory(id), `${id} is missing from CATEGORIES`);
  }
});

test('every known kind resolves to a declared category', () => {
  for (const kind of KNOWN_KINDS) {
    assert.ok(isCategory(categoryOf(kind)), `${kind} → '${categoryOf(kind)}' is not a category`);
    assert.notEqual(categoryOf(kind), OTHER, `${kind} is in the map but files as 'other'`);
  }
});

test('the kinds land where the design put them', () => {
  assert.equal(categoryOf('xs_request'), 'approvals');
  assert.equal(categoryOf('mgt_request'), 'approvals');
  assert.equal(categoryOf('mention'), 'mentions');
  assert.equal(categoryOf('chat'), 'messages');
  assert.equal(categoryOf('xs_decision'), 'decisions');
  assert.equal(categoryOf('mgt_decision'), 'decisions');
  assert.equal(categoryOf('ready_override'), 'decisions');
});

test('the shade-card wave lands in quality, all of it', () => {
  // Six of these are named in the plan; approval_overdue and pending_customer
  // come out of the same ternary in shadecards.js and belong with their siblings.
  for (const kind of ['expiring', 'expired', 'revised', 'pending_internal',
    'pending_customer', 'approval_overdue', 'artwork_changed', 'master_changed']) {
    assert.equal(categoryOf(kind), 'quality', `${kind} should be a quality alert`);
  }
});

// ── the fallback actually catches ─────────────────────────────────────
test('an unknown kind files as other, never nowhere', () => {
  for (const kind of ['', 'brand_new_kind_from_a_future_wave', 'CHAT', 'chat ', 'xs']) {
    assert.equal(categoryOf(kind), OTHER, `'${kind}' escaped the fallback`);
  }
});

test('a non-string kind files as other rather than throwing', () => {
  // A kind arrives from a DB column and could be NULL on a hand-written row;
  // a 500 in the bell would take the whole inbox down with it.
  for (const kind of [null, undefined, 0, 1, {}, [], ['chat']]) {
    assert.equal(categoryOf(kind), OTHER);
  }
});

test('inherited property names are unknown kinds like any other', () => {
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(categoryOf(kind), OTHER, `'${kind}' resolved to something inherited`);
  }
});

// ── kindsFor / KINDS_BY_CATEGORY ──────────────────────────────────────
test('kindsFor returns exactly the kinds that map to it', () => {
  for (const id of CATEGORY_IDS) {
    for (const kind of kindsFor(id)) assert.equal(categoryOf(kind), id);
  }
  assert.deepEqual(kindsFor('approvals'), ['mgt_request', 'xs_request']);
  assert.deepEqual(kindsFor('messages'), ['chat']);
  assert.deepEqual(kindsFor('alerts'), []);   // declared, not yet populated
});

test('every known kind is reachable through exactly one category list', () => {
  const seen = KNOWN_KINDS.map(k => CATEGORY_IDS.filter(id => kindsFor(id).includes(k)));
  KNOWN_KINDS.forEach((kind, i) => {
    assert.equal(seen[i].length, 1, `${kind} is in ${seen[i].length} category lists`);
  });
});

test('other is defined by exclusion, so its kind list is empty', () => {
  // A caller filtering on `other` must negate KNOWN_KINDS. Handing back a list
  // here would quietly mean "no rows", which is the one answer it must not give.
  assert.deepEqual(kindsFor(OTHER), []);
  assert.deepEqual(KINDS_BY_CATEGORY[OTHER], []);
});

test('kindsFor refuses an unknown category instead of guessing', () => {
  for (const bad of ['Approvals', 'approval', '', null, undefined, 42, 'constructor']) {
    assert.deepEqual(kindsFor(bad), []);
  }
});

test('the exported map cannot be edited by a caller', () => {
  // The bell's tabs are built from these at read time; a route mutating them
  // would re-file the plant's notifications for everyone on that instance.
  assert.throws(() => { CATEGORIES.push({ id: 'x', label: 'x' }); });
  assert.throws(() => { CATEGORIES[0].label = 'Nope'; });
  assert.throws(() => { KNOWN_KINDS.push('nope'); });
});

// ── the map describes what the server really emits ────────────────────
test('the source scan actually found the notify() call sites', () => {
  // Guards every assertion below: if a refactor moved the payload away from the
  // call, the scan would come back empty and silently pass.
  assert.equal(NOTIFY.unresolved.length, 0,
    `notify() call sites with no literal kind in view: ${NOTIFY.unresolved.join(', ')}\n`
    + 'Either inline the kind at the call, or teach this test how to find it.');
  assert.ok(NOTIFY.found.length >= 7,
    `only ${NOTIFY.found.length} notify() kinds found — the scanner is broken, not the plant`);
});

test('every kind the server notifies with maps to a named category', () => {
  for (const { kind, where } of NOTIFY.found) {
    assert.notEqual(categoryOf(kind), OTHER,
      `${where} notifies with kind '${kind}', which no category claims.\n`
      + `Add it to OF_KIND in notify-categories.js — it currently shows only under '${OTHER}'.`);
  }
});

test('every kind literal in the routes is either categorised or declared not a notification', () => {
  // The wider tripwire. `kind:` is used for message kinds and logbook entries
  // too, so this cannot simply demand a category for all of them — but a kind
  // that is in NEITHER list is new, and the session that added it has to say
  // which it is.
  assert.ok(ALL_LITERALS.length >= 18,
    `only ${ALL_LITERALS.length} kind literals found — the scanner is broken`);
  for (const { kind, where } of ALL_LITERALS) {
    if (NOT_NOTIFICATION_KINDS.has(kind)) continue;
    assert.notEqual(categoryOf(kind), OTHER,
      `${where} declares kind '${kind}', which is neither in a category nor in `
      + 'NOT_NOTIFICATION_KINDS.\nIf it is a notification, file it in '
      + 'notify-categories.js; if it is not, name it in this test.');
  }
});

test('the not-a-notification list has no stale entries', () => {
  // The other half of the same promise: a kind that stopped existing must not
  // stay whitelisted, or it will excuse a future kind that reuses the word.
  const live = new Set(ALL_LITERALS.map(x => x.kind));
  for (const [kind, why] of NOT_NOTIFICATION_KINDS) {
    assert.ok(live.has(kind), `'${kind}' (${why}) is no longer emitted anywhere — drop it`);
  }
});

test('a categorised kind is never also excused as not-a-notification', () => {
  for (const kind of KNOWN_KINDS) {
    assert.equal(NOT_NOTIFICATION_KINDS.has(kind), false,
      `'${kind}' is both categorised and declared not a notification`);
  }
});

test('the files the scan reads are the files that emit kinds', () => {
  // If routes/ gains a directory or helpers.js is split, the scan must follow —
  // an unread file is an unchecked file.
  for (const rel of SCANNED) {
    assert.ok(fs.existsSync(new URL(`./${rel}`, SRC)), `${rel} is gone — fix SCANNED`);
  }
  assert.ok(ROUTES.includes('routes/chat.js'));
  assert.ok(ROUTES.includes('routes/notifications.js'));
  assert.ok(ROUTES.includes('routes/shadecards.js'));
  assert.equal(path.extname('routes/chat.js'), '.js');
});
