import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { ENTITIES, entityOr400, resolveLabel } from './record-entities.js';
// The module keys are a promise to the client's access map, so they are checked
// against the real list rather than a copy of it (same trick customer-code.test
// uses to reach across the two halves of the repo).
import { MODULES } from '../../client/src/modules.js';

// The registry claims a table and a column on it. Both claims are checked
// against the schema TEXT — db.js is the only place the plant's tables are
// defined, so a rename there has to break this test rather than surface as a
// 500 the first time somebody clicks a comment icon in production.
const SCHEMA = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');

// The CREATE TABLE body, from the opening paren to the closing `);` at the
// start of a line — column ALTERs that come later are searched separately.
function createBlock(table) {
  const start = SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) return null;
  const end = SCHEMA.indexOf('\n);', start);
  return end < 0 ? null : SCHEMA.slice(start, end);
}

function hasColumn(table, col) {
  const block = createBlock(table);
  if (block && new RegExp(`^\\s*${col}\\s`, 'm').test(block)) return true;
  // Half the plant's columns arrived after the fact: materials.code and
  // machines.code are both ALTERs, hundreds of lines below their CREATE.
  return new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col}\\b`).test(SCHEMA);
}

const keys = Object.keys(ENTITIES);

// ── the map describes reality ─────────────────────────────────────────
test('every entity names a table that exists in db.js', () => {
  for (const key of keys) {
    assert.ok(createBlock(ENTITIES[key].table),
      `${key}: no CREATE TABLE for '${ENTITIES[key].table}' in db.js`);
  }
});

test('every declared number is a real column on its own table', () => {
  for (const key of keys) {
    const { table, number } = ENTITIES[key];
    if (!number) continue;
    assert.ok(hasColumn(table, number), `${key}: ${table}.${number} does not exist`);
  }
});

test('number:null means the table really has no human number', () => {
  // The other half of the same promise: a table that grows a code or a
  // *_number column must not keep being titled "Customer #14" forever.
  for (const key of keys) {
    const { table, number } = ENTITIES[key];
    if (number) continue;
    const block = createBlock(table) || '';
    assert.equal(/^\s*(code|[a-z_]*_number)\s/m.test(block), false,
      `${key}: ${table} declares a number column the registry ignores`);
    assert.equal(
      new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS (code|[a-z_]*_number)\\b`).test(SCHEMA),
      false, `${key}: ${table} gained a number column the registry ignores`);
  }
});

test('every entity points at a real module key', () => {
  const known = new Set(MODULES.map(m => m.key));
  for (const key of keys) {
    assert.ok(known.has(ENTITIES[key].module),
      `${key}: module '${ENTITIES[key].module}' is not in MODULES`);
  }
});

test('the entities the design names are all present', () => {
  // Losing one silently would take a whole module's threads with it.
  const required = [
    'order', 'order_line', 'job_card', 'job_stage', 'requisition', 'purchase_order',
    'grn', 'invoice', 'dispatch', 'fg_lot', 'extra_sheet', 'shade_card', 'tool',
    'product', 'material', 'customer', 'vendor', 'machine', 'employee',
  ];
  for (const key of required) assert.ok(ENTITIES[key], `${key} is missing from the registry`);
});

// ── one record, one address ───────────────────────────────────────────
test('no two entity keys share a table', () => {
  // Threads are unique on (entity, entity_id). Two keys on one table would be
  // two addresses for the same row — i.e. two threads for one record, which is
  // the exact split-brain the whole design is written to prevent.
  const seen = new Map();
  for (const key of keys) {
    const t = ENTITIES[key].table;
    assert.equal(seen.has(t), false, `${key} and ${seen.get(t)} both address '${t}'`);
    seen.set(t, key);
  }
});

test('links are in-app paths that carry the id', () => {
  for (const key of keys) {
    const link = ENTITIES[key].link(42);
    assert.match(link, /^\//, `${key}: link must be an in-app path`);
    assert.match(link, /42/, `${key}: link drops the id`);
  }
});

// ── entityOr400 ───────────────────────────────────────────────────────
test('a known key resolves to its entry', () => {
  assert.equal(entityOr400('job_card').table, 'job_cards');
  assert.equal(entityOr400('material').number, 'code');
});

test('an unknown key is a 400, never a lookup', () => {
  for (const bad of ['orders', 'Order', 'job_cards', '', 'users', 'drop table']) {
    assert.throws(() => entityOr400(bad), e => e.status === 400, `'${bad}' was allowed through`);
  }
});

test('inherited property names are refused like any other unknown key', () => {
  // A bare ENTITIES[key] would hand back a function for these, and the caller
  // would interpolate it into a table name.
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.throws(() => entityOr400(bad), e => e.status === 400, `'${bad}' was allowed through`);
  }
});

test('non-strings are refused rather than coerced', () => {
  for (const bad of [null, undefined, 0, 1, {}, [], ['order']]) {
    assert.throws(() => entityOr400(bad), e => e.status === 400);
  }
});

// ── resolveLabel ──────────────────────────────────────────────────────
test('a record with a number is titled with it', () => {
  assert.equal(resolveLabel('job_card', { id: 2, jc_number: 'CI-JC-0002' }), 'CI-JC-0002');
  assert.equal(resolveLabel('purchase_order', { id: 9, po_number: 'PO-889' }), 'PO-889');
  assert.equal(resolveLabel('tool', { id: 4, code: 'DIE-114' }), 'DIE-114');
});

test('a numberless record falls back to label + id', () => {
  assert.equal(resolveLabel('customer', { id: 14 }), 'Customer #14');
  assert.equal(resolveLabel('order_line', { id: 7 }), 'Order Line #7');
  assert.equal(resolveLabel('job_stage', { id: 31 }), 'Stage #31');
});

test('a null or blank number falls back too — a thread is never nameless', () => {
  // machines.code and materials.code are both nullable columns.
  assert.equal(resolveLabel('machine', { id: 3, code: null }), 'Machine #3');
  assert.equal(resolveLabel('machine', { id: 3, code: '   ' }), 'Machine #3');
  assert.equal(resolveLabel('material', { id: 8 }), 'Board #8');
});

test('resolveLabel refuses an unknown entity as hard as entityOr400 does', () => {
  assert.throws(() => resolveLabel('nope', { id: 1 }), e => e.status === 400);
});
