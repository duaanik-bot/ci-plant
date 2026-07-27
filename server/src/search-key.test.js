import test from 'node:test';
import assert from 'node:assert/strict';
import { squash, matchesTerm, squashSql, PG_SEPARATOR } from './search-key.js';

// ── squash ────────────────────────────────────────────────────────────
test('squash: the floor shorthand 2038 keys the same as the stored board name', () => {
  assert.equal(squash('Duplex GB · 296 GSM · 20 x 38'), 'duplexgb296gsm2038');
  assert.equal(squash('2038'), '2038');
});

test('squash: every spelling of the same size collapses to one key', () => {
  const keys = ['20 x 38', '20x38', '20 × 38', '20×38', '20*38', '20  X  38'].map(squash);
  assert.deepEqual(new Set(keys), new Set(['2038']));
});

test('squash: decimal sizes keep their digits, drop the punctuation', () => {
  assert.equal(squash('31.5 x 41.5'), '315415');
  assert.equal(squash('Duplex GB · 330 GSM · 24.6 x 31.2'), 'duplexgb330gsm246312');
});

test('squash: a spec code survives as itself', () => {
  assert.equal(squash('2037DPGB230'), '2037dpgb230');
  assert.equal(squash('2228SAFF280-1'), '2228saff2801');
});

test('squash: a lone x is not a separator — only one between two digits is', () => {
  // 'x' carries meaning outside a dimension (a grade, a code); collapsing it
  // everywhere would merge unrelated tokens.
  assert.equal(squash('Box x Board'), 'boxxboard');
  assert.equal(squash('x38'), 'x38');
  assert.equal(squash('20x'), '20x');
});

test('squash: empty and nullish inputs give an empty key, never a crash', () => {
  for (const v of [null, undefined, '', '   ', '· · ·']) assert.equal(squash(v), '');
});

test('squash: is idempotent — squashing a key again changes nothing', () => {
  for (const v of ['Duplex GB · 296 GSM · 20 x 38', '31.5 x 41.5', '2037DPGB230']) {
    assert.equal(squash(squash(v)), squash(v));
  }
});

// ── matchesTerm ───────────────────────────────────────────────────────
// `raw` is the lowercased haystack, `squashed` its squash() — exactly how
// rowMatches builds them once per row.
const hay = text => [text.toLowerCase(), squash(text)];

test('matchesTerm: 2038 finds the board that stores 20 x 38', () => {
  const [raw, sq] = hay('Duplex GB · 296 GSM · 20 x 38');
  assert.equal(matchesTerm(raw, sq, '2038'), true);
});

test('matchesTerm: every spelling of the size still finds it', () => {
  const [raw, sq] = hay('Duplex GB · 296 GSM · 20 x 38');
  for (const t of ['2038', '20x38', '20 x 38', '20×38']) {
    assert.equal(matchesTerm(raw, sq, t), true, `expected "${t}" to match`);
  }
});

test('matchesTerm: punctuation-dependent terms keep matching via the raw side', () => {
  // The regression this OR exists to prevent — squashing alone would lose these.
  const [raw, sq] = hay('31.5 x 41.5');
  assert.equal(matchesTerm(raw, sq, '31.5'), true);
  const [raw2, sq2] = hay('CI-BOX-0007 · ₹1,240.50');
  assert.equal(matchesTerm(raw2, sq2, 'ci-box'), true);
  assert.equal(matchesTerm(raw2, sq2, '1,240.50'), true);
});

test('matchesTerm: a squashed decimal size is findable as bare digits', () => {
  const [raw, sq] = hay('Saffire · 300 GSM · 31.5 x 41.5');
  assert.equal(matchesTerm(raw, sq, '315415'), true);
});

test('matchesTerm: a genuine miss is still a miss', () => {
  const [raw, sq] = hay('Duplex GB · 296 GSM · 20 x 38');
  for (const t of ['2039', 'saffire', '9999']) {
    assert.equal(matchesTerm(raw, sq, t), false, `expected "${t}" not to match`);
  }
});

test('matchesTerm: a term of pure punctuation does not match everything', () => {
  // squash('···') is '', and ''.includes('') is true — so an unguarded
  // implementation would return true for every row.
  const [raw, sq] = hay('Duplex GB · 296 GSM · 20 x 38');
  assert.equal(matchesTerm(raw, sq, '@@@'), false);
});

// ── squashSql ─────────────────────────────────────────────────────────
test('squashSql: emits both steps, in order, against the given column', () => {
  const sql = squashSql('m.name');
  assert.match(sql, /lower\(m\.name\)/);
  // dimension collapse is nested inside, so it runs before punctuation stripping
  assert.match(sql, /\[\^a-z0-9\]\+.*'',\s*'g'\)$/);
  assert.ok(sql.indexOf(PG_SEPARATOR) < sql.indexOf('[^a-z0-9]'),
    'the dimension collapse must be the inner regexp_replace');
});

test('squashSql: the separator is an alternation, never a bracket expression', () => {
  // Load-bearing. '×' is two bytes in UTF-8 and the local database is SQL_ASCII,
  // where a bracket expression matches single BYTES — '[x×*]' matches half of '×'
  // and the surrounding pattern never completes, so the same SQL would behave
  // differently on local (SQL_ASCII) and Supabase (UTF8). A regression here is
  // invisible in JS-only tests, hence this assertion on the emitted SQL.
  assert.equal(PG_SEPARATOR, '(?:x|X|×|\\*)');
  const sql = squashSql('m.name');
  assert.ok(!/\[[^\]]*×[^\]]*\]/.test(sql),
    'a bracket expression containing × silently no-ops under SQL_ASCII');
});

// ── client twin ───────────────────────────────────────────────────────
// The browser filters rows with the client copy and the server filters the same
// data in SQL; a drift between them means the same query returns different rows
// depending on which side ran it.
test('client twin: exports the same surface and produces identical output', async () => {
  const client = await import('../../client/src/lib/searchKey.js');
  const server = await import('./search-key.js');
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());

  const samples = [
    'Duplex GB · 296 GSM · 20 x 38',
    'Saffire · 300 GSM · 23 × 36',
    'Chromo Paper · 205 GSM · 22.567 x 28',
    '2037DPGB230',
    'CI-BOX-0007',
    '₹1,240.50',
    '', '   ', null, undefined,
  ];
  for (const s of samples) assert.equal(client.squash(s), server.squash(s), `squash(${s})`);
  for (const s of samples) {
    const [raw, sq] = [String(s ?? '').toLowerCase(), server.squash(s)];
    for (const t of ['2038', '20x38', '31.5', 'ci-box', '@@@', '']) {
      assert.equal(client.matchesTerm(raw, sq, t), server.matchesTerm(raw, sq, t),
        `matchesTerm(${s}, ${t})`);
    }
  }
  assert.equal(client.squashSql('m.name'), server.squashSql('m.name'));
});
