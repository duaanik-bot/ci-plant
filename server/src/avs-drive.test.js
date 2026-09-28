import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DRIVE_GET_PAGE, postDrive, readDriveReply } from './avs-drive.js';

// Google loses a Drive link answer now and then (28 Sep 2026: about one call in
// six): the redirect bounces back to /exec as a GET and gives the link's GET page,
// or Google's "Page Not Found". These pin that such an answer is never taken as
// the answer, and what is tried again and what is not.

const GET_PAGE = JSON.stringify({ ok: true, service: DRIVE_GET_PAGE });
const NOT_FOUND = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body>Sorry, unable to open the file at this time.</body></html>';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A fake Drive link: answers in turn; records every body it was sent.
function fakeLink(...answers) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const a = answers[Math.min(bodies.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { text: async () => (typeof a === 'string' ? a : JSON.stringify(a)) };
  };
  return bodies;
}

test('the GET page and Google\'s "Page Not Found" are never the answer; a refusal is', () => {
  assert.match(readDriveReply(GET_PAGE).lost, /lost the Drive link's answer/);
  assert.match(readDriveReply(NOT_FOUND).lost, /web page/);
  assert.match(readDriveReply('[1]').lost, /cannot read/);
  assert.deepEqual(readDriveReply(JSON.stringify({ ok: false, error: 'Wrong secret' })), { refused: 'Wrong secret' });
  assert.deepEqual(readDriveReply(JSON.stringify({ ok: true, root: { name: 'CI AVS' } })), { data: { ok: true, root: { name: 'CI AVS' } } });
  // The link's own GET page is what doGet() answers, word for word.
  const gs = readFileSync(new URL('../../client/src/lib/avs-robot/drive-link.gs', import.meta.url), 'utf8');
  assert.match(gs, new RegExp(`return out_\\(\\{ ok: true, service: '${DRIVE_GET_PAGE}' \\}\\);`));
});

test('a lost answer is tried again, and a photo\'s second try takes the file the first one filed', async () => {
  const put = { ok: true, existed: true, id: 'f1', size: 7, url: 'https://drive/f1' };
  const bodies = fakeLink(GET_PAGE, put);
  const out = await postDrive('https://link/exec', { op: 'put', name: '01 a.jpg', base64: 'x' }, { again: { ifExists: 'reuse' } });
  assert.deepEqual(out, put);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].ifExists, undefined, 'the first try asks for a new file');
  assert.equal(bodies[1].ifExists, 'reuse');
  assert.equal(bodies[1].base64, 'x', 'the same photo');
});

test('"Page Not Found" and a dropped connection are tried again too', async () => {
  const ping = { ok: true, root: { name: 'CI AVS' } };
  let bodies = fakeLink(NOT_FOUND, ping);
  assert.deepEqual(await postDrive('https://link/exec', { op: 'ping' }), ping);
  assert.equal(bodies.length, 2);
  bodies = fakeLink(new TypeError('fetch failed'), ping);
  assert.deepEqual(await postDrive('https://link/exec', { op: 'ping' }), ping);
  assert.equal(bodies.length, 2);
});

test('a refusal is final, and answers lost every time fail instead of passing', async () => {
  let bodies = fakeLink({ ok: false, error: 'A file with this name is already there: 01 a.jpg' });
  await assert.rejects(postDrive('https://link/exec', { op: 'put' }), e => e.status === 502 && /refused: A file/.test(e.message));
  assert.equal(bodies.length, 1);
  bodies = fakeLink(GET_PAGE);
  await assert.rejects(postDrive('https://link/exec', { op: 'put' }, { tries: 3 }),
    e => e.status === 502 && /lost/.test(e.message) && e.reason === 'Google lost the Drive link\'s answer on the way back');
  assert.equal(bodies.length, 3);
});

test('pairing and a new secret are tried once: a second try would carry a secret already replaced', async () => {
  const bodies = fakeLink(GET_PAGE, { ok: true, secret: 'b'.repeat(64) });
  await assert.rejects(postDrive('https://link/exec', { op: 'rotate' }, { tries: 1 }), /lost/);
  assert.equal(bodies.length, 1);
  const src = readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8');
  assert.match(src, /postDrive\(url, \{ op: 'pair' \}, \{ tries: 1 \}\)/);
  assert.match(src, /callDrive\(cfg, \{ op: 'rotate' \}, \{ tries: 1 \}\)/);
  // A new secret whose answer was lost: CI Plant finds out with a ping and
  // unlinks, so Setup offers "Pair again" instead of a link that no longer opens.
  const route = src.slice(src.indexOf("r.post('/avs/setup/new-secret'"), src.indexOf("r.post('/avs/setup/test-drive'"));
  assert.match(route, /if \(stillWorks === false\) \{\s*await saveSetting\('drive_bridge_secret', ''/);
});

test('an upload records a Drive file only with its id and this photo\'s size', () => {
  const src = readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("r.post('/avs/uploads/:id/photos'"), src.indexOf("r.post('/avs/uploads/:id/verify'"));
  assert.match(route, /\{ again: \{ ifExists: 'reuse' \} \}/);
  assert.match(route, /if \(!put\?\.id\) \{ driveError = [^;]+; put = null; \}/);
  assert.match(route, /else if \(Number\(put\.size\) !== file\.size\) \{ driveError = [^;]+; put = null; \}/);
});

test('time runs out: the call stops, with no half answer', async () => {
  const bodies = [];
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    bodies.push(init.body);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(postDrive('https://link/exec', { op: 'ping' }, { timeoutMs: 30 }),
    e => e.status === 504 && e.reason === 'Google Drive took too long to answer');
  assert.equal(bodies.length, 1, 'no second try without time left');
});
