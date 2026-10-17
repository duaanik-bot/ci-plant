// The name and alias guards (hr/names.js, Ruling T3-e) — no database. A fake `qc` stands in for the
// transaction's query function, so these pin the API that routes/hr.js and the importer and loader rely on:
// the lock text, what each guard asks the database, what it compares, and the error it throws. The same two
// codes are proven end to end, against real rows, through the routes in hr-routes-core-pg.test.js (HR_PG=1).
// Every name is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAMES_LOCK, lockNames, assertAliasFree, assertNameFree } from './hr/names.js';

// A qc that answers every statement with `rows` and remembers what it was asked.
const fakeQc = (rows = []) => {
  const calls = [];
  const qc = async (text, params) => { calls.push({ text, params }); return rows; };
  return { qc, calls };
};

const PEOPLE = [
  { code: '1', name: 'Test Person One', display_name: null },
  { code: '2', name: 'Test Person Two', display_name: 'TP  Two' },
  { code: '3', name: 'Test Person Three', display_name: '' },
];

// What app.js sends for a thrown error: {error: message, ...body} and nothing else.
const sent = (e) => ({ error: e.message, ...(e.body || {}) });

test('the lock is the one transaction-scoped advisory lock on hr.names, taken through qc', async () => {
  assert.equal(NAMES_LOCK, "SELECT pg_advisory_xact_lock(hashtext('hr.names'))");
  const { qc, calls } = fakeQc();
  await lockNames(qc);
  assert.deepEqual(calls, [{ text: NAMES_LOCK, params: undefined }]);
  await assert.rejects(lockNames(), TypeError, 'a transaction query function is required');
  await assert.rejects(lockNames('SELECT 1'), TypeError);
});

test('assertAliasFree refuses a spelling that is any person\'s name or display name, however it is written', async () => {
  for (const spelling of ['Test Person One', ' test  person   one ', 'TEST PERSON TWO', 'tp two', 'TP TWO', 'Tp\tTwo']) {
    const { qc } = fakeQc(PEOPLE);
    await assert.rejects(assertAliasFree(qc, spelling), (e) => {
      assert.equal(e.status, 409, spelling);
      assert.deepEqual(e.body, { code: 'ALIAS_IS_A_NAME' }, 'the code rides in body: app.js drops anything else');
      assert.match(e.message, /cannot also be an alias/);
      assert.deepEqual(Object.keys(sent(e)).sort(), ['code', 'error']);
      return true;
    }, JSON.stringify(spelling));
  }
});

test('assertAliasFree names who has the spelling, and lets every other spelling through', async () => {
  const { qc } = fakeQc(PEOPLE);
  await assert.rejects(assertAliasFree(qc, 'tp two'), /Test Person Two \(2\)/);
  for (const spelling of ['T P One', 'Test Person', 'Test Person Onee', 'TP Three', 'Two']) {
    await assertAliasFree(fakeQc(PEOPLE).qc, spelling);
  }
  // A person with no display name, or an empty one, is not named '' (a blank never matches a blank).
  await assertAliasFree(fakeQc(PEOPLE).qc, '   ');
});

test('assertAliasFree reads only hr.people, once, and asks nothing for a blank spelling', async () => {
  const { qc, calls } = fakeQc(PEOPLE);
  await assertAliasFree(qc, 'Somebody Else');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM hr\.people\b/i);
  assert.doesNotMatch(calls[0].text, /\bpublic\./i);
  const blank = fakeQc(PEOPLE);
  for (const spelling of ['', '   ', null, undefined]) await assertAliasFree(blank.qc, spelling);
  assert.equal(blank.calls.length, 0, 'a blank names nobody, so the database is not asked');
});

test('assertNameFree refuses a name or display name that is another person\'s approved alias', async () => {
  const clash = [{ alias_norm: 'T P ONE', code: '1', name: 'Test Person One' }];
  for (const arg of [{ name: 't  p  one' }, { name: 'Fresh Name', displayName: ' T P One ' }, { personId: 9, name: 'T P ONE', displayName: null }]) {
    const { qc } = fakeQc(clash);
    await assert.rejects(assertNameFree(qc, arg), (e) => {
      assert.equal(e.status, 409);
      assert.deepEqual(e.body, { code: 'NAME_IS_AN_ALIAS' });
      assert.match(e.message, /T P ONE is already an approved spelling of Test Person One \(1\)/);
      assert.deepEqual(Object.keys(sent(e)).sort(), ['code', 'error']);
      return true;
    }, JSON.stringify(arg));
  }
  await assertNameFree(fakeQc([]).qc, { personId: 9, name: 'Fresh Name', displayName: 'Fresh' });
});

test('assertNameFree asks for the normalised, de-duplicated names, and excludes the person themself', async () => {
  const { qc, calls } = fakeQc([]);
  await assertNameFree(qc, { personId: 7, name: ' test   person one ', displayName: 'TEST PERSON ONE' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [['TEST PERSON ONE'], 7], 'one spelling, however many ways it was given');
  assert.match(calls[0].text, /FROM hr\.person_aliases a JOIN hr\.people p/i);
  assert.match(calls[0].text, /a\.alias_norm = ANY\(\$1::text\[\]\)/);
  assert.match(calls[0].text, /a\.person_id IS DISTINCT FROM \$2::int/, 'an alias of the person themself never counts against them');

  const created = fakeQc([]);
  await assertNameFree(created.qc, { name: 'New Person', displayName: 'NP' });
  assert.deepEqual(created.calls[0].params, [['NEW PERSON', 'NP'], null], 'no personId: nobody is excluded');
});

test('assertNameFree asks nothing when there is no name to check', async () => {
  const { qc, calls } = fakeQc([{ alias_norm: 'X', code: '1', name: 'Never Asked' }]);
  await assertNameFree(qc, {});
  await assertNameFree(qc);
  await assertNameFree(qc, { personId: 3, name: '  ', displayName: null });
  await assertNameFree(qc, { name: undefined, displayName: '' });
  assert.equal(calls.length, 0);
});
