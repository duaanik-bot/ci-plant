// Safe matching of monthly-Excel rows to people (spec §7, step 4). Pure: no I/O, no database.
//
// The workbook this module replaces linked a person to their monthly figures by the START of the
// name, so a short name could pick up a longer name's overtime or advance. Here a row is given to a
// person only on firm evidence, tried strictly in this order:
//
//   1. A code that exists. The name must not clearly differ: it is blank, equals the person's name or
//      display name, is one of their approved aliases, or is a whole-word prefix of their name or has
//      their name as one ('RAJ' for 'RAJ KUMAR', 'ARUN PRESS' for 'ARUN'). A partial word never counts
//      ('ARU' is not 'ARUN'), and a prefix counts only when the typed name exactly names nobody else:
//      'ARUN' under code 129 is person 1's own name, so it is a 'conflict' although it starts 'ARUN
//      PRESS TARA'. Anything else that differs is a 'conflict' too, held for review.
//   2. No code: whoever the typed name exactly names, by name, display name or approved alias. One
//      person is a match ('exact_name', or 'alias' when only an approved alias names them). Several
//      are 'ambiguous', and so is a name on file that is also another person's approved alias:
//      neither claim may win silently. No prefix matching of any kind here.
//   3. Nobody is named: 'unmatched'.
//
// A code nobody has is 'unknown_code'. person_id is set only for code | exact_name | alias; for every
// other status it is null and `candidates` lists the people a reviewer may click. Suggestions (a
// prefix either way, then shared words) never assign anyone.
//
// Ids are used exactly as given, never coerced. Every array returned is a fresh copy, so a caller may
// sort or edit it without touching the index.

// ── Normalising ───────────────────────────────────────────────────────

// \s matches the non-breaking space, tabs and line breaks, so one replace does both "NBSP to space"
// and "collapse". toUpperCase() does not depend on locale: the server's locale must not change what
// matches.
export function normName(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\s+/g, ' ').trim().toUpperCase();
}

// Zeros are dropped as text, never through a number, so a long numeric code cannot lose digits to a
// float. A lone '0' stays '0'.
export function normCode(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const digits = /^(\d+)(?:\.0)?$/.exec(t);
  return digits ? digits[1].replace(/^0+(?=\d)/, '') : t.toUpperCase();
}

// ── The index ─────────────────────────────────────────────────────────

const wordsOf = (norm) => (norm === '' ? [] : norm.split(' '));

// Adds id under key, once. A blank key is never indexed, so a blank can never match a blank.
function addTo(map, key, id) {
  if (!key) return;
  const ids = map.get(key);
  if (!ids) map.set(key, [id]);
  else if (!ids.includes(id)) ids.push(id);
}

// A spelling the person can be compared with when suggesting.
function addLabel(person, norm) {
  if (norm === '' || person.labels.some((l) => l.norm === norm)) return;
  person.labels.push({ norm, words: new Set(wordsOf(norm)) });
}

// Build the lookup for matchRow() and suggest() once per upload; treat the result as opaque.
//   people   [{id, code, name, display_name}]: everyone the file may name, exited people included
//   aliases  [{person_id, alias_norm}]: the spellings Anik has approved
export function buildIndex(people, aliases = []) {
  const index = { people: [], byId: new Map(), byCode: new Map(), byName: new Map(), byAlias: new Map() };
  for (const p of people ?? []) {
    if (!p || p.id === null || p.id === undefined || index.byId.has(p.id)) continue;
    const nameNorm = normName(p.name);
    const displayNorm = normName(p.display_name);
    const person = {
      id: p.id,
      pos: index.people.length,
      shownAs: String(p.name ?? '').trim() || String(p.display_name ?? '').trim(),
      nameNorm,
      displayNorm,
      nameWords: wordsOf(nameNorm),
      aliases: new Set(),
      labels: [],
    };
    addLabel(person, nameNorm);
    addLabel(person, displayNorm);
    index.people.push(person);
    index.byId.set(person.id, person);
    addTo(index.byCode, normCode(p.code), person.id);
    addTo(index.byName, nameNorm, person.id);        // name and display name share one map; a person
    addTo(index.byName, displayNorm, person.id);     // whose two are equal is still one hit, not two
  }
  for (const a of aliases ?? []) {
    const person = a && index.byId.get(a.person_id);
    const alias = normName(a?.alias_norm);
    if (!person || alias === '') continue;           // an alias for someone not in the list can't be used
    person.aliases.add(alias);
    addTo(index.byAlias, alias, person.id);
    addLabel(person, alias);
  }
  return index;
}

// ── Matching ──────────────────────────────────────────────────────────

const result = (status, personId, candidates, note) => ({ status, person_id: personId, candidates, note });
const unique = (ids) => [...new Set(ids)];
const exactHits = (n, index) => [...(index.byName.get(n) ?? [])];
const aliasHits = (n, index) => [...(index.byAlias.get(n) ?? [])];
// Everyone whose name, display name or approved alias is exactly n.
const namedBy = (n, index) => unique([...exactHits(n, index), ...aliasHits(n, index)]);

// True when `short` is a non-empty run of whole words at the start of `long`. Compared word by word,
// so 'ARU' never starts 'ARUN'.
function startsWithWords(long, short) {
  return short.length > 0 && short.length <= long.length && short.every((w, i) => w === long[i]);
}

// How a row's name stands with the person its code points at: 'blank', 'same' or 'prefix' when it
// agrees, null when it clearly differs.
//
// The display name counts only when equal. It is often a short label several people share ('KIRAN'),
// and as a prefix it would let one person's code take another person's full name.
//
// The person's own exact names agree first, so a display name two people share is still settled by
// the code. A whole-word prefix agrees only when the typed name exactly names nobody else: a row that
// carries another person's exact name, display name or approved alias is that person's row whatever
// its code says, even when the name also starts or extends this person's name ('ARUN' under code 129).
function agreement(person, n, index) {
  if (n === '') return 'blank';
  if (n === person.nameNorm || n === person.displayNorm || person.aliases.has(n)) return 'same';
  if (namedBy(n, index).length) return null;      // not one of this person's own names, so someone else's
  const words = wordsOf(n);
  if (startsWithWords(words, person.nameWords) || startsWithWords(person.nameWords, words)) return 'prefix';
  return null;
}

const CODE_NOTE = {
  blank: 'Matched by code; the row has no name.',
  same: 'Matched by code.',
  prefix: 'Matched by code; the name on the row is a shorter or longer form of the name on file.',
};

// The people a name points at, for a reviewer to click: whoever has exactly that name, display name
// or approved alias; failing that, the likenesses suggest() finds.
function nameCandidates(n, index) {
  const hits = namedBy(n, index);
  return hits.length ? hits : suggest(n, index);
}

// Match one row ({code, name}, as read from the sheet) against an index. See the header for the order.
export function matchRow(row, index) {
  const { code, name } = row ?? {};
  const c = normCode(code);
  const n = normName(name);

  if (c !== null) {
    const owners = index.byCode.get(c) ?? [];
    if (owners.length > 1) {
      return result('ambiguous', null, [...owners], `More than one person has code ${c}.`);
    }
    if (owners.length === 1) {
      const person = index.byId.get(owners[0]);
      const how = agreement(person, n, index);
      if (how) return result('code', person.id, [person.id], CODE_NOTE[how]);
      const elsewhere = namedBy(n, index).length > 0;       // the typed name is exactly someone else's
      return result('conflict', null, unique([person.id, ...nameCandidates(n, index)]),
        `Code ${c} is ${person.shownAs || 'another person'}, but the row says ${n}` +
        (elsewhere ? ", which is exactly another person's name." : '.'));
    }
    return result('unknown_code', null, nameCandidates(n, index), `Code ${c} is not in the people list.`);
  }

  // No code. Everyone the typed name exactly names, exact-name people first and alias people after
  // them, each once. One person is a match; several are ambiguous, and so is a name on file that is
  // also another person's approved alias: neither claim is allowed to win silently.
  const exact = exactHits(n, index);
  const named = namedBy(n, index);
  if (named.length === 1) {
    return exact.length
      ? result('exact_name', named[0], named, 'Matched by exact name.')
      : result('alias', named[0], named, 'Matched by approved alias.');
  }
  if (named.length > 1) {
    const aliasOnly = named.filter((id) => !exact.includes(id));    // named by an approved alias alone
    const note = exact.length === 0 ? `${n} is an approved alias of more than one person.`
      : aliasOnly.length ? `${n} is on file as a name and also as another person's approved alias.`
      : `More than one person is called ${n}.`;
    return result('ambiguous', null, named, note);
  }

  return result('unmatched', null, suggest(n, index),
    n === '' ? 'The row has no code and no name.' : `No person is called ${n}.`);
}

// ── Suggestions ───────────────────────────────────────────────────────

// How alike one spelling is to the row's name, or null. A prefix either way is the strongest (partial
// words count here: this only suggests); sharing whole words comes next. `score` ranks within a tier:
// how much of the longer string a prefix covers, or shared words over all the words in play.
function likeness(n, words, label) {
  if (n.startsWith(label.norm) || label.norm.startsWith(n)) {
    return { tier: 2, score: Math.min(n.length, label.norm.length) / Math.max(n.length, label.norm.length) };
  }
  let shared = 0;
  for (const w of words) if (label.words.has(w)) shared += 1;
  if (shared === 0) return null;
  return { tier: 1, score: shared / (words.size + label.words.size - shared) };
}

// People the name might mean, strongest first, at most `limit`: a prefix either way, then shared
// words; ties keep the order of the people list. Suggestions only, nothing here assigns anyone.
export function suggest(name, index, limit = 5) {
  const n = normName(name);
  if (n === '') return [];
  const words = new Set(wordsOf(n));
  const ranked = [];
  for (const person of index.people) {
    let best = null;
    for (const label of person.labels) {
      const found = likeness(n, words, label);
      if (found && (!best || found.tier > best.tier || (found.tier === best.tier && found.score > best.score))) {
        best = found;
      }
    }
    if (best) ranked.push({ id: person.id, pos: person.pos, ...best });
  }
  ranked.sort((a, b) => b.tier - a.tier || b.score - a.score || a.pos - b.pos);
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.id);
}

// ── Duplicates ────────────────────────────────────────────────────────

// Groups of two or more rows that resolved to the same person, as lists of row_id, in the order the
// people first appear. A row with no person (null or missing) is never part of a group.
export function findDuplicates(results) {
  const groups = new Map();
  for (const r of results ?? []) {
    if (!r || r.person_id === null || r.person_id === undefined) continue;
    const group = groups.get(r.person_id);
    if (group) group.push(r.row_id);
    else groups.set(r.person_id, [r.row_id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
