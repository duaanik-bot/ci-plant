import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ONE name, ONE meaning, for the board verdict.
//
// `components/BoardStatus.jsx` is the plant's single board vocabulary, and it
// exports two DIFFERENT readers on purpose:
//
//   boardStateOf(row)        the verdict for ONE row, as the server resolved it
//                            (the server has already collapsed a gang to its
//                            weakest member before sending it).
//   worstBoardStateOf(rows)  collapse a LIST to its weakest — for the screens
//                            that group gangs client-side, where the server
//                            could not have done it already.
//
// Artwork grouped its own rows and needed the second, so it declared
//
//     const boardStateOf = row => worstBoardStateOf(row._gang || [row]);
//
// — a local binding with the SAME NAME as the export, and a different meaning.
// Nothing broke: the local simply shadowed the import for that module. What
// broke was reading the code. `boardStateOf(` is a documented grep in this
// repo (it is how the board-verdict fixes are found — see the note that
// /planning and /artwork "hold their OWN inline copies"), and a grep that
// returns two functions with one name sends the next fix to the wrong one.
// That is precisely how a board rule gets fixed on four screens and missed on
// the fifth.
//
// So: a page may compose the shared readers however it likes, and must not
// reuse their names to do it.

const PAGES = new URL('../../client/src/pages/', import.meta.url);
const COMPONENTS = new URL('../../client/src/components/', import.meta.url);

const jsxFiles = dir => readdirSync(dir)
  .filter(n => n.endsWith('.jsx') || n.endsWith('.js'))
  .map(n => [n, readFileSync(new URL(n, dir), 'utf8')]);

// Guards read CODE, not the prose that explains them — the comments in these
// files legitimately quote the banned spelling to say why it is banned.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

// What BoardStatus.jsx actually exports — read from the module itself, so this
// guard widens automatically when the shared vocabulary gains a name. BOTH
// forms count: names declared here, and names re-exported from lib/boardState.js
// (the collapse lives there so a node test can execute it). Missing the
// re-export form would quietly drop those names out of every guard below.
const EXPORTS = (() => {
  const src = readFileSync(new URL('BoardStatus.jsx', COMPONENTS), 'utf8');
  const declared = [...src.matchAll(/^export (?:const|function)\s+(\w+)/gm)].map(m => m[1]);
  const reexported = [...src.matchAll(/^export \{([^}]*)\}/gm)]
    .flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()))
    .filter(Boolean);
  return [...new Set([...declared, ...reexported])];
})();

test('the shared board vocabulary still exports the names this guard protects', () => {
  // A guard over an empty list passes forever.
  for (const name of ['boardStateOf', 'worstBoardStateOf', 'BOARD_RANK', 'BOARD_ROW_CLASS'])
    assert.ok(EXPORTS.includes(name), `BoardStatus.jsx must still export ${name}`);
  assert.ok(EXPORTS.length >= 8, `expected the full vocabulary, found ${EXPORTS.length}`);
});

// Renaming the vocabulary AT THE DOOR defeats the same grep a redeclaration
// does, only quietly: `import { boardStateOf as cardStateOf }` leaves a file
// whose every call site is invisible to a search for the shared name. It is
// the inverse of the Artwork collision — there, one name meant two functions;
// here, one function answered to a name nobody would search for. PrintPlanning
// then bound it a SECOND time (`const cardState = cardStateOf`), so one reader
// had three names across the codebase and two inside a single file.
test('no page imports the board vocabulary under an alias', () => {
  for (const dir of [PAGES, COMPONENTS]) {
    for (const [name, raw] of jsxFiles(dir)) {
      const imp = code(raw).match(/import \{([^}]*)\} from '[^']*BoardStatus\.jsx'/);
      if (!imp) continue;
      for (const spec of imp[1].split(',').map(s => s.trim()).filter(Boolean))
        assert.doesNotMatch(spec, /\s+as\s+/,
          `${name}: imports \`${spec}\` — the shared board vocabulary must keep its name, or a `
          + 'grep for that name misses every call site in this file');
    }
  }
});

test('no page or component redeclares a BoardStatus export', () => {
  for (const dir of [PAGES, COMPONENTS]) {
    for (const [name, raw] of jsxFiles(dir)) {
      if (name === 'BoardStatus.jsx') continue;          // the definitions themselves
      const src = code(raw);
      for (const exp of EXPORTS) {
        const decl = new RegExp(`(?:^|[;{}]|\\n)\\s*(?:const|let|var|function)\\s+${exp}\\b`);
        assert.doesNotMatch(src, decl,
          `${name}: declares its own \`${exp}\`, shadowing the shared board vocabulary. `
          + 'Compose the shared readers under a name of their own — a grep for the shared '
          + 'name must not return two different functions');
      }
    }
  }
});

// Both client-grouping queues must collapse a grouped row the SAME way. They
// did not: Artwork called the shared reader, Planning hand-rolled the identical
// map/reduce over BOARD_RANK a second time, differing only in the fallback for
// a member with no verdict. That difference is real and documented — so it is a
// PARAMETER now, and the collapse around it is written once.
test('both grouping queues collapse through the shared reader', () => {
  for (const p of ['Artwork.jsx', 'Planning.jsx']) {
    const src = code(readFileSync(new URL(p, PAGES), 'utf8'));
    assert.match(src, /\browBoardStateOf\b/,
      `${p} groups gangs client-side, so it must use the shared row collapse`);
    assert.match(src, /import \{[^}]*\browBoardStateOf\b[^}]*\} from '\.\.\/components\/BoardStatus\.jsx'/,
      `${p}: take it from the shared vocabulary, not a local copy`);
  }
});

// The collapse is the ranking plus the worst-wins reduce. Anywhere but its own
// module, that reduce is a second spelling — which is exactly what Planning had.
test('nothing outside lib/boardState.js hand-rolls the collapse', () => {
  for (const dir of [PAGES, COMPONENTS]) {
    for (const [name, raw] of jsxFiles(dir)) {
      assert.doesNotMatch(code(raw), /\breduce\(\(worst/,
        `${name}: a hand-rolled BOARD_RANK reduce is a second spelling of the weakest-member `
        + 'rule. Pass a fallback to worstBoardStateOf/rowBoardStateOf instead');
    }
  }
});

// Planning's fallback is the whole reason the parameter exists. If it silently
// became the default, a job short of board would read `covered` on the one
// screen that can fix it — and every test above would still pass.
test("Planning keeps its own fallback, and it is the board gate", () => {
  const src = code(readFileSync(new URL('Planning.jsx', PAGES), 'utf8'));
  assert.match(src, /readiness\?\.material \? 'covered' : 'short'/,
    'a Planning row carries readiness — a payload with no board_state must read its board gate');
  assert.match(src, /rowBoardStateOf\(\s*\w+\s*,\s*\w+\s*\)/,
    'and that fallback must actually be handed to the shared reader');
});
