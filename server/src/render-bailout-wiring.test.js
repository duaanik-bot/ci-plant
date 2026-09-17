// A refetch that changed nothing must not re-render the screen.
//
// cachedGet hands back the SAME object when a GET returns the same bytes
// (cached-get.test.js), and React skips a render when setState is given the value
// it already holds. Both only pay off if the screen does not wrap the response in
// something new on every load. Two ways a screen used to defeat it are pinned here:
// a thread-summary helper that merged its chunks into a fresh object each time,
// and Live Floor stamping "board seen at" into state on every 30 s poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createThreadSummary } from '../../client/src/lib/threadSummary.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(SRC, '../../client/src');
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const read = p => stripComments(readFileSync(join(CLIENT, p), 'utf8'));

// A stand-in for api.get with cachedGet's memo: the same URL answered with the
// same bytes is the same object; `bump(url)` changes that URL's answer.
function fakeApi() {
  const answers = new Map();
  const urls = [];
  return {
    urls,
    get: async url => {
      urls.push(url);
      if (!answers.has(url)) answers.set(url, { [urls.length]: { unread: 0 } });
      return answers.get(url);
    },
    bump: url => answers.set(url, { changed: { unread: 1 } }),
  };
}

test('thread summary: every chunk unchanged returns the previous merged object', async () => {
  const api = fakeApi();
  const summary = createThreadSummary(api.get, 2);
  const first = await summary('grn', [1, 2, 3]);
  const again = await summary('grn', [1, 2, 3]);
  assert.deepEqual(api.urls, [
    '/threads/summary?entity=grn&ids=1,2', '/threads/summary?entity=grn&ids=3',
    '/threads/summary?entity=grn&ids=1,2', '/threads/summary?entity=grn&ids=3',
  ], 'chunked exactly as the pages always asked');
  assert.equal(again, first, 'nothing changed: the screen gets the object it already holds');
});

test('thread summary: one changed chunk, a different id list, or another entity is a new object', async () => {
  const api = fakeApi();
  const summary = createThreadSummary(api.get, 2);
  const first = await summary('grn', [1, 2, 3]);
  api.bump('/threads/summary?entity=grn&ids=3');
  const bumped = await summary('grn', [1, 2, 3]);
  assert.notEqual(bumped, first);
  assert.deepEqual(bumped, { ...(await api.get('/threads/summary?entity=grn&ids=1,2')), changed: { unread: 1 } });
  const fewer = await summary('grn', [1, 2]);
  assert.notEqual(fewer, bumped);
  const po = await summary('purchase_order', [1, 2]);
  assert.notEqual(po, fewer);
  assert.equal(await summary('grn', [1, 2]), fewer, 'entities are remembered apart');
});

test('thread summary: no ids is one stable empty object, not a new {} per load', async () => {
  const summary = createThreadSummary(fakeApi().get, 200);
  const a = await summary('grn', []);
  assert.deepEqual(a, {});
  assert.equal(await summary('grn', []), a);
});

test('Artwork and Procurement use the shared helper, not a local merge that is new every load', () => {
  for (const page of ['pages/Artwork.jsx', 'pages/Procurement.jsx']) {
    const src = read(page);
    assert.match(src, /createThreadSummary\(/, `${page} builds its summary with createThreadSummary`);
    assert.doesNotMatch(src, /Object\.assign\(\{\},\s*\.\.\.parts\)/, `${page} still merges chunks into a fresh object`);
  }
});

test('Live Floor puts nothing into state that differs when the board did not change', () => {
  const src = read('pages/Floor.jsx');
  assert.doesNotMatch(src, /\bset\w+\(\s*(new Date\(|Date\.now\()/,
    'a clock stamp set into state re-renders the whole floor on every poll');
});
