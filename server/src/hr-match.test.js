// Safe matching of monthly-Excel rows to people (hr/match.js).
//
// The factory's workbook linked a person to their month's figures by the START of the name, so a
// short name could quietly pick up a longer name's overtime or advance. match.js assigns a row on
// firm evidence only: a code that exists, an exact (normalised) name, or a spelling Anik approved
// once. A prefix or a likeness only ever produces a suggestion that needs a click.
// Expected values below are hand-derived from the fixture, never copied from the module's output.
// Every name here is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normName, normCode, buildIndex, matchRow, suggest, findDuplicates } from './hr/match.js';

// ── The task brief's tests, verbatim ──────────────────────────────────
const people = [{id:1, code:'101', name:'Arun'}, {id:2, code:'129', name:'Arun Press Tara'},
  {id:3, code:'130', name:'Bhola', display_name:'BHOLA PASTING'}, {id:4, code:'140', name:'Kiran Admin', display_name:'KIRAN'},
  {id:5, code:'141', name:'Kiran Sorting', display_name:'KIRAN'}, {id:6, code:'50', name:'Raj Kumar'}];
const ix = buildIndex(people, [{person_id:6, alias_norm:'RAJKUMAR'}]);
test('prefix collisions never cross', () => {
  assert.equal(matchRow({name:'ARUN'}, ix).person_id, 1);
  assert.equal(matchRow({name:'ARUN PRESS TARA'}, ix).person_id, 2);
  const r = matchRow({name:'ARU'}, ix); assert.equal(r.status, 'unmatched'); assert.equal(r.person_id, null);
  assert.deepEqual(r.candidates.sort(), [1, 2]); });
// The name below ends in a non-breaking space (U+00A0), exactly as the brief has it.
test('NBSP and case', () => assert.equal(matchRow({name:'bhola '}, ix).person_id, 3));
test('display name matches', () => assert.equal(matchRow({name:'BHOLA PASTING'}, ix).person_id, 3));
test('code wins when the name agrees; leading zeros ignored', () => {
  const r = matchRow({code:'0130', name:'BHOLA'}, ix); assert.equal(r.status, 'code'); assert.equal(r.person_id, 3); });
test('code with a different person\'s name is a conflict', () => {
  const r = matchRow({code:'130', name:'ARUN'}, ix); assert.equal(r.status, 'conflict'); assert.equal(r.person_id, null); });
test('unknown code', () => assert.equal(matchRow({code:'99', name:'X'}, ix).status, 'unknown_code'));
test('two people share a display name: ambiguous', () => {
  const r = matchRow({name:'KIRAN'}, ix); assert.equal(r.status, 'ambiguous'); assert.equal(r.person_id, null); });
test('approved alias', () => {
  const r = matchRow({name:'Rajkumar'}, ix); assert.equal(r.status, 'alias'); assert.equal(r.person_id, 6); });
test('duplicates', () => assert.deepEqual(findDuplicates([{row_id:10, person_id:1}, {row_id:11, person_id:1}, {row_id:12, person_id:2}]), [[10, 11]]));
test('normCode', () => { assert.equal(normCode(' 0130 '), '130'); assert.equal(normCode('130.0'), '130');
  assert.equal(normCode('ci101'), 'CI101'); assert.equal(normCode('  '), null); });

// ── The ruling: a found code only needs a name that does not clearly differ ──
// Agreement is: blank, the person's name or display name, one of their approved aliases, or a
// whole-word prefix of their name (either side shorter). A partial word never counts, and a prefix
// agrees only when the typed name exactly names nobody else (see the refinement tests below).
test('ruling: code 140 with the short name KIRAN is the code, person 4', () => {
  const r = matchRow({ code:'140', name:'KIRAN' }, ix);
  assert.equal(r.status, 'code'); assert.equal(r.person_id, 4); });
test('ruling: code 101 with a longer ARUN PRESS is the code, person 1', () => {
  const r = matchRow({ code:'101', name:'ARUN PRESS' }, ix);        // ['ARUN'] is a prefix of ['ARUN','PRESS']
  assert.equal(r.status, 'code'); assert.equal(r.person_id, 1); });
test('ruling: the row name may be the shorter side too', () => {
  const r = matchRow({ code:'129', name:'ARUN PRESS' }, ix);        // a prefix of ['ARUN','PRESS','TARA']
  assert.equal(r.status, 'code'); assert.equal(r.person_id, 2); });
test('ruling: code 130 with ARU or ARUN is a conflict', () => {
  const partial = matchRow({ code:'130', name:'ARU' }, ix);
  assert.equal(partial.status, 'conflict'); assert.equal(partial.person_id, null);
  const other = matchRow({ code:'130', name:'ARUN' }, ix);          // the brief's case still holds
  assert.equal(other.status, 'conflict'); assert.equal(other.person_id, null);
  assert.deepEqual(other.candidates, [3, 1]); });                   // the code's person, then who the name is
test('ruling: a partial word never counts as a prefix', () => {
  const aru = matchRow({ code:'101', name:'ARU' }, ix);             // ARU starts ARUN but is not a whole word
  assert.equal(aru.status, 'conflict'); assert.equal(aru.person_id, null);
  const glued = matchRow({ code:'101', name:'ARUNKUMAR' }, ix);     // ARUN plus letters, no word break
  assert.equal(glued.status, 'conflict'); assert.equal(glued.person_id, null);
  assert.deepEqual(glued.candidates, [1]); });                      // person 1 is the code's and a likeness: once
test('ruling: a short display name is not a prefix label for someone else\'s full name', () => {
  // KIRAN SORTING is person 5's whole name. Person 4's display name KIRAN must not wave it through.
  const r = matchRow({ code:'140', name:'KIRAN SORTING' }, ix);
  assert.equal(r.status, 'conflict'); assert.equal(r.person_id, null);
  assert.deepEqual(r.candidates, [4, 5]);
  // Also when the name is nobody's exact name, so only reading KIRAN as a prefix label could agree.
  const longer = matchRow({ code:'140', name:'KIRAN SORTING EXTRA' }, ix);
  assert.equal(longer.status, 'conflict'); assert.equal(longer.person_id, null);
  assert.deepEqual(longer.candidates, [4, 5]); });
test('ruling: an alias agrees with its own person only', () => {
  const own = matchRow({ code:'50', name:'Rajkumar' }, ix);
  assert.equal(own.status, 'code'); assert.equal(own.person_id, 6);
  const other = matchRow({ code:'130', name:'Rajkumar' }, ix);
  assert.equal(other.status, 'conflict'); assert.equal(other.person_id, null);
  assert.deepEqual(other.candidates, [3, 6]); });
// ── The refinement: a whole-word prefix agrees only when the typed name exactly names nobody else ──
// A row that carries another person's exact name, display name or approved alias is that person's
// row, whatever its code says, even when the name also starts or extends the code person's own name.
// The code person's OWN exact names are checked first and still agree.
test('refinement: person 2\'s exact full name under code 101 is a conflict, though person 1\'s name starts it', () => {
  const r = matchRow({ code:'101', name:'ARUN PRESS TARA' }, ix);
  assert.equal(r.status, 'conflict'); assert.equal(r.person_id, null);
  assert.deepEqual(r.candidates, [1, 2]);                              // the code's person, then who the name is
  assert.match(r.note, /another person's name/); });
test('refinement: person 1\'s exact name under code 129 is a conflict, though it starts person 2\'s name', () => {
  const r = matchRow({ code:'129', name:'ARUN' }, ix);
  assert.equal(r.status, 'conflict'); assert.equal(r.person_id, null);
  assert.deepEqual(r.candidates, [2, 1]); });
test('refinement: another person\'s display name or approved alias is a conflict too', () => {
  const dev = buildIndex([{ id:31, code:'31', name:'Deepak Sharma' },
    { id:32, code:'32', name:'Deepak Verma', display_name:'DEEPAK' }]);
  const display = matchRow({ code:'31', name:'DEEPAK' }, dev);        // starts DEEPAK SHARMA; is 32's display name
  assert.equal(display.status, 'conflict'); assert.equal(display.person_id, null);
  assert.deepEqual(display.candidates, [31, 32]);
  const aliased = buildIndex(people, [{ person_id:3, alias_norm:'RAJ' }]);
  const alias = matchRow({ code:'50', name:'Raj' }, aliased);         // starts RAJ KUMAR; is person 3's approved alias
  assert.equal(alias.status, 'conflict'); assert.equal(alias.person_id, null);
  assert.deepEqual(alias.candidates, [6, 3]); });
test('refinement: a shortened or extended name that exactly names nobody else still agrees', () => {
  const short = matchRow({ code:'50', name:'RAJ' }, ix);              // nobody's exact name, display name or alias
  assert.equal(short.status, 'code'); assert.equal(short.person_id, 6);
  const longer = matchRow({ code:'50', name:'RAJ KUMAR SINGH' }, ix); // extends RAJ KUMAR; nobody's exact name either
  assert.equal(longer.status, 'code'); assert.equal(longer.person_id, 6);
  const plain = matchRow({ code:'101', name:'ARU' }, ix);               // a plain conflict does not blame anyone else
  assert.doesNotMatch(plain.note, /another person/); });
test('refinement: a display name two people share is still resolved by the code', () => {
  // KIRAN is the exact display name of persons 4 AND 5. Under code 140 it is the code person's OWN
  // display name, so it agrees exactly, before the prefix rule and its "names nobody else" test.
  const four = matchRow({ code:'140', name:'KIRAN' }, ix);
  assert.equal(four.status, 'code'); assert.equal(four.person_id, 4);
  const five = matchRow({ code:'141', name:'KIRAN' }, ix);
  assert.equal(five.status, 'code'); assert.equal(five.person_id, 5); });
test('a code with no name is the code', () => {
  for (const name of [undefined, null, '', '   ', '\u00a0']) {
    const r = matchRow({ code:'141', name }, ix);
    assert.equal(r.status, 'code', JSON.stringify(name)); assert.equal(r.person_id, 5, JSON.stringify(name)); }
  assert.equal(matchRow({ code:'141' }, ix).person_id, 5); });
test('without a code the match stays exact: a prefix never assigns anyone', () => {
  for (const name of ['ARUN PRESS', 'ARUN PRESS TARA KUMAR', 'KIRAN ADMIN X', 'BHOLA PASTING EXTRA']) {
    const r = matchRow({ name }, ix);
    assert.equal(r.status, 'unmatched', name); assert.equal(r.person_id, null, name); }
  assert.deepEqual(matchRow({ name:'ARUN PRESS' }, ix).candidates, [2, 1]); });   // suggestions, closest first

// ── No code: a name on file that is also another person's approved alias ──
// 'Asha' is person 1's name and an approved alias of person 2 ('Asha Devi'). Neither claim may win
// silently, so the row waits for a person: exact-name people first, then alias people, each once.
const ashas = [{ id:1, code:'11', name:'Asha' }, { id:2, code:'12', name:'Asha Devi' }];
test('no code: a name that is one person\'s and another\'s approved alias is ambiguous', () => {
  const crossed = buildIndex(ashas, [{ person_id:2, alias_norm:'ASHA' }]);
  const r = matchRow({ name:'ASHA' }, crossed);
  assert.equal(r.status, 'ambiguous'); assert.equal(r.person_id, null);
  assert.deepEqual(r.candidates, [1, 2]);                              // the exact-name person, then the alias person
  assert.match(r.note, /alias/);
  assert.equal(matchRow({ name:'Asha Devi' }, crossed).person_id, 2);  // a spelling with one claimant still matches
  assert.equal(matchRow({ code:'11', name:'ASHA' }, crossed).person_id, 1);   // a code settles it: their own name
  assert.equal(matchRow({ code:'12', name:'ASHA' }, crossed).person_id, 2);   // or their own approved alias
  assert.deepEqual(matchRow({ code:'99', name:'ASHA' }, crossed).candidates, [1, 2]); });
test('no code: the same alias on the one exact-name person changes nothing', () => {
  const same = buildIndex(ashas, [{ person_id:1, alias_norm:'ASHA' }]);
  const r = matchRow({ name:'ASHA' }, same);
  assert.equal(r.status, 'exact_name'); assert.equal(r.person_id, 1); assert.deepEqual(r.candidates, [1]); });
test('no code: display names and shared names follow the same rule, with no repeats', () => {
  // A display name carried by person 3, approved as person 6's alias.
  const d = matchRow({ name:'bhola pasting' }, buildIndex(people, [{ person_id:6, alias_norm:'BHOLA PASTING' }]));
  assert.equal(d.status, 'ambiguous'); assert.equal(d.person_id, null); assert.deepEqual(d.candidates, [3, 6]);
  // KIRAN is persons 4 and 5's display name. Approved for person 6 too, it adds a third candidate;
  // approved for person 4 itself, it adds nobody (and 4 is not listed twice).
  const outsider = matchRow({ name:'KIRAN' }, buildIndex(people, [{ person_id:6, alias_norm:'KIRAN' }]));
  assert.equal(outsider.status, 'ambiguous'); assert.equal(outsider.person_id, null);
  assert.deepEqual(outsider.candidates, [4, 5, 6]);
  const inside = matchRow({ name:'KIRAN' }, buildIndex(people, [{ person_id:4, alias_norm:'KIRAN' }]));
  assert.equal(inside.status, 'ambiguous'); assert.equal(inside.person_id, null);
  assert.deepEqual(inside.candidates, [4, 5]);
  // A person whose name and display name are the same is one claimant, not two.
  const twin = buildIndex([{ id:7, code:'7', name:'Dev', display_name:'DEV' }, { id:8, code:'8', name:'Dev Raj' }],
    [{ person_id:8, alias_norm:'DEV' }]);
  const t = matchRow({ name:'dev' }, twin);
  assert.equal(t.status, 'ambiguous'); assert.equal(t.person_id, null);
  assert.deepEqual(t.candidates, [7, 8]); assert.match(t.note, /alias/); });

// ── Candidates ────────────────────────────────────────────────────────
test('unknown code: candidates come from the name and nobody is assigned', () => {
  const none = matchRow({ code:'99', name:'X' }, ix);
  assert.equal(none.person_id, null); assert.deepEqual(none.candidates, []);
  const exact = matchRow({ code:'99', name:'Bhola pasting' }, ix);     // person 3's display name
  assert.equal(exact.person_id, null); assert.deepEqual(exact.candidates, [3]);
  const alike = matchRow({ code:'99', name:'ARU' }, ix);               // no exact hit: likenesses
  assert.equal(alike.person_id, null); assert.deepEqual(alike.candidates, [1, 2]); });
test('ambiguous lists every person it could be, each once', () => {
  const r = matchRow({ name:'KIRAN' }, ix);
  assert.deepEqual(r.candidates, [4, 5]);
  assert.doesNotMatch(r.note, /alias/); });                            // a plain shared name does not blame an alias
test('a matched row lists just the person it matched', () => {
  assert.deepEqual(matchRow({ code:'130', name:'Bhola' }, ix).candidates, [3]);
  assert.deepEqual(matchRow({ name:'Arun' }, ix).candidates, [1]);
  assert.deepEqual(matchRow({ name:'Rajkumar' }, ix).candidates, [6]); });
test('the arrays returned are the caller\'s to change', () => {
  const a = matchRow({ name:'KIRAN' }, ix); a.candidates.reverse(); a.candidates.push(99);
  assert.deepEqual(matchRow({ name:'KIRAN' }, ix).candidates, [4, 5]);
  const s = suggest('ARU', ix); s.reverse(); s.push(99);
  assert.deepEqual(suggest('ARU', ix), [1, 2]); });
test('invariants: person_id only for code | exact_name | alias; candidates unique; note is text', () => {
  const rows = [
    {}, { code:'101' }, { code:'0130', name:'BHOLA' }, { code:'130', name:'ARUN' }, { code:'99', name:'ARU' },
    { name:'ARUN' }, { name:'ARU' }, { name:'KIRAN' }, { name:'Rajkumar' }, { code:'140', name:'KIRAN' },
    { code:'101', name:'ARUNKUMAR' }, { code:'129', name:'ARUN PRESS' }, { name:'' }, { code:' ', name:' ' },
    { code:'101', name:'ARUN PRESS TARA' }, { code:'129', name:'ARUN' }, { code:'50', name:'RAJ' },
  ];
  // The Asha pair, with ASHA approved as person 2's alias (the "name on file and someone else's
  // alias" branch) and as person 1's own alias (the same-person branch).
  const crossed = buildIndex(ashas, [{ person_id:2, alias_norm:'ASHA' }]);
  const own = buildIndex(ashas, [{ person_id:1, alias_norm:'ASHA' }]);
  const cases = [
    ...rows.map((row) => ['brief', ix, row]),
    ...[{ name:'ASHA' }, { name:'asha devi' }, { code:'11', name:'ASHA' }, { code:'12', name:'ASHA' },
      { code:'99', name:'ASHA' }].map((row) => ['crossed', crossed, row]),
    ...[{ name:'ASHA' }, { code:'12', name:'ASHA' }].map((row) => ['own', own, row]),
  ];
  const assigned = new Set(['code', 'exact_name', 'alias']);
  const seen = new Set();
  for (const [which, index, row] of cases) {
    const r = matchRow(row, index); const label = `${which} ${JSON.stringify(row)}`;
    seen.add(r.status);
    assert.equal(r.person_id !== null, assigned.has(r.status), label);
    assert.equal(new Set(r.candidates).size, r.candidates.length, label);
    assert.equal(typeof r.note, 'string', label);
    if (r.person_id !== null) assert.deepEqual(r.candidates, [r.person_id], label); }
  assert.deepEqual([...seen].sort(),
    ['alias', 'ambiguous', 'code', 'conflict', 'exact_name', 'unknown_code', 'unmatched']); });

// ── suggest(): prefix either way first, then shared words, strongest first ──
test('suggest: a prefix beats shared words; closer beats further; ties keep the list order', () => {
  assert.deepEqual(suggest('ARU', ix), [1, 2]);                      // both start ARU; ARUN is the closer length
  assert.deepEqual(suggest('ARUN PRESS TARA KUMAR', ix), [2, 1, 6]);   // both Aruns start the row, the longer is closer; KUMAR is shared
  assert.deepEqual(suggest('ARUN KUMAR', ix), [1, 6, 2]);            // ARUN is a prefix; then KUMAR 1/3 beats ARUN 1/4
  assert.deepEqual(suggest('TARA PRESS', ix), [2]);                  // same words in another order: shared words only
  assert.deepEqual(suggest('KIRAN', ix), [4, 5]);                    // each once, though two of their labels qualify
  assert.deepEqual(suggest('NOBODY', ix), []); });
test('suggest: limit, blank names and a default of five', () => {
  assert.deepEqual(suggest('ARU', ix, 1), [1]);
  assert.deepEqual(suggest('ARU', ix, 0), []); assert.deepEqual(suggest('ARU', ix, -1), []);
  assert.deepEqual(suggest('', ix), []); assert.deepEqual(suggest(null, ix), []);
  const many = buildIndex(Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, code: String(100 + i), name: `Sita ${i}` })));
  assert.deepEqual(suggest('SITA', many), [100, 101, 102, 103, 104]);
  assert.deepEqual(suggest('SITA', many, 7), [100, 101, 102, 103, 104, 105, 106]); });
test('suggest: an approved alias is a spelling to compare against', () => {
  assert.deepEqual(suggest('RAJKUMA', ix), [6]); });                  // not a prefix of RAJ KUMAR, but of the alias

// ── The index ─────────────────────────────────────────────────────────
test('a person whose name equals their display name is not ambiguous with themselves', () => {
  const one = buildIndex([{ id:7, code:'7', name:'Dev', display_name:'DEV' }]);   // aliases left out
  const r = matchRow({ name:'dev' }, one);
  assert.equal(r.status, 'exact_name'); assert.equal(r.person_id, 7); });
test('a blank name or code never matches a person who has none', () => {
  const blank = buildIndex([{ id:8, code:null, name:'', display_name:null }, { id:9, code:'', name:'  ', display_name:'\u00a0' }], []);
  for (const row of [{ name:'' }, { name:'  ' }, { name:null }, {}, { code:'', name:'' }, { code:null }]) {
    const r = matchRow(row, blank);
    assert.equal(r.status, 'unmatched', JSON.stringify(row)); assert.equal(r.person_id, null, JSON.stringify(row)); } });
test('two people sharing a code: ambiguous, never the first or the last', () => {
  const dup = buildIndex([{ id:11, code:'070', name:'Asha' }, { id:12, code:'70', name:'Asha Devi' }], []);   // both are 70
  const r = matchRow({ code:'70', name:'ASHA' }, dup);
  assert.equal(r.status, 'ambiguous'); assert.equal(r.person_id, null); assert.deepEqual(r.candidates, [11, 12]); });
test('an alias for someone not in the list is ignored; a loosely typed alias still matches', () => {
  const lone = buildIndex([{ id:1, code:'101', name:'Arun' }], [{ person_id:99, alias_norm:'GHOST' }]);
  assert.equal(matchRow({ name:'ghost' }, lone).status, 'unmatched');
  const loose = buildIndex(people, [{ person_id:6, alias_norm:'  raj  k ' }]);
  const r = matchRow({ name:'Raj K' }, loose);
  assert.equal(r.status, 'alias'); assert.equal(r.person_id, 6); });
test('matching reads ids as given: strings stay strings', () => {
  const s = buildIndex([{ id:'a-1', code:'5', name:'Meena' }], [{ person_id:'a-1', alias_norm:'MEENA K' }]);
  assert.equal(matchRow({ name:'meena' }, s).person_id, 'a-1');
  assert.equal(matchRow({ name:'Meena K' }, s).person_id, 'a-1');
  assert.equal(matchRow({ code:'05' }, s).person_id, 'a-1'); });

// ── normName / normCode / findDuplicates ──────────────────────────────
test('normName: NBSP to space, collapse, trim, upper-case; blank for null', () => {
  assert.equal(normName('  Arun\u00a0 Press\t\nTara  '), 'ARUN PRESS TARA');
  assert.equal(normName('\u00a0bhola\u00a0'), 'BHOLA');
  assert.equal(normName(null), ''); assert.equal(normName(undefined), '');
  assert.equal(normName(''), ''); assert.equal(normName('   \u00a0 '), '');
  assert.equal(normName(7), '7'); });
test('an NBSP inside a name still matches the person', () => {
  const nb = String.fromCharCode(0xa0);
  assert.equal(matchRow({ name: `Arun${nb}Press${nb} Tara` }, ix).person_id, 2);
  assert.equal(matchRow({ code: '129', name: `arun${nb}press` }, ix).status, 'code'); });
test('a conflict note names the code, the person on file and the name on the row', () => {
  const r = matchRow({ code:'130', name:'ARUN' }, ix);
  assert.match(r.note, /130/); assert.match(r.note, /Bhola/); assert.match(r.note, /ARUN/); });
test('odd input is tolerated and never guessed at', () => {
  assert.equal(matchRow(undefined, ix).status, 'unmatched');
  assert.equal(matchRow({ code: 130, name: 'BHOLA' }, ix).person_id, 3);              // a number straight from a cell
  const empty = buildIndex(null, null);
  assert.equal(matchRow({ name:'Arun' }, empty).status, 'unmatched');
  assert.equal(matchRow({ code:'101' }, empty).status, 'unknown_code');
  const twice = buildIndex([{ id:1, code:'101', name:'Arun' }, { id:1, code:'101', name:'Arun' },
    { id:null, code:'5', name:'Ghost' }]);
  assert.deepEqual(suggest('ARU', twice), [1]);                                        // one person, listed once
  assert.equal(matchRow({ code:'5', name:'Ghost' }, twice).status, 'unknown_code');    // no id: cannot be matched
  const shared = buildIndex(people, [{ person_id:1, alias_norm:'JOE' }, { person_id:2, alias_norm:'JOE' }]);
  const r = matchRow({ name:'joe' }, shared);                                          // one spelling, two people
  assert.equal(r.status, 'ambiguous'); assert.equal(r.person_id, null); assert.deepEqual(r.candidates, [1, 2]); });
test('normCode: zeros and .0 go as text, other text is upper-cased, blanks are null', () => {
  assert.equal(normCode('0'), '0'); assert.equal(normCode('000'), '0'); assert.equal(normCode('0.0'), '0');
  assert.equal(normCode('007.0'), '7'); assert.equal(normCode('\u00a00130\u00a0'), '130');
  assert.equal(normCode(130), '130'); assert.equal(normCode(null), null); assert.equal(normCode(undefined), null);
  assert.equal(normCode(''), null); assert.equal(normCode('\u00a0'), null);
  assert.equal(normCode('1.5'), '1.5'); assert.equal(normCode('30.05'), '30.05');
  assert.equal(normCode('0030 a'), '0030 A'); assert.equal(normCode(' ci 101 '), 'CI 101');
  assert.equal(normCode('00012345678901234567890'), '12345678901234567890'); });   // never through a float
test('findDuplicates: rows with no person are never duplicates of each other', () => {
  assert.deepEqual(findDuplicates([{ row_id:1, person_id:null }, { row_id:2, person_id:null }, { row_id:3 }]), []);
  assert.deepEqual(findDuplicates([]), []);
  assert.deepEqual(findDuplicates([{ row_id:5, person_id:2 }, { row_id:6, person_id:1 }, { row_id:7, person_id:2 },
    { row_id:8, person_id:1 }, { row_id:9, person_id:2 }, { row_id:10, person_id:3 }]), [[5, 7, 9], [6, 8]]); });
