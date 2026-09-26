import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

// The Drive link runs in Google Apps Script, where nothing here can reach it.
// So it is run against a small in-memory Drive with the same calls it makes
// (DriveApp, Utilities, ContentService, LockService, PropertiesService, the Drive
// API service): every answer CI Plant and the AVS routine depend on is checked here.
const SRC = readFileSync(new URL('../../client/src/lib/avs-robot/drive-link.gs', import.meta.url), 'utf8');

function fakeDrive() {
  let n = 0;
  const id = () => `id${++n}`;
  const items = new Map();
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  function makeFolder(name, parent) {
    const f = {
      kind: 'folder', _id: id(), _name: name, _parents: parent ? [parent] : [], trashed: false,
      getId() { return this._id; }, getName() { return this._name; }, getUrl() { return `https://drive/${this._id}`; },
      getLastUpdated() { return new Date('2026-09-26T10:00:00Z'); }, isTrashed() { return this.trashed; },
      getParents() { return iter(this._parents); },
      children() { return [...items.values()].filter(x => x._parents.includes(this)); },
      getFoldersByName(nm) { return iter(this.children().filter(x => x.kind === 'folder' && x._name === nm)); },
      getFilesByName(nm) { return iter(this.children().filter(x => x.kind === 'file' && x._name === nm)); },
      getFolders() { return iter(this.children().filter(x => x.kind === 'folder')); },
      getFiles() { return iter(this.children().filter(x => x.kind === 'file')); },
      createFolder(nm) { return makeFolder(nm, this); },
      createFile(a, text, mime) {
        const blob = typeof a === 'string' ? { bytes: Buffer.from(text, 'utf8'), mime, name: a } : a;
        return makeFile(blob.name, blob.bytes, blob.mime, this);
      },
    };
    items.set(f._id, f);
    return f;
  }
  function makeFile(name, bytes, mime, parent) {
    const f = {
      kind: 'file', _id: id(), _name: name, _parents: [parent], bytes, mime, trashed: false,
      getId() { return this._id; }, getName() { return this._name; }, getUrl() { return `https://drive/file/${this._id}`; },
      getMimeType() { return this.mime; }, getSize() { return this.bytes.length; },
      getLastUpdated() { return new Date('2026-09-26T10:00:00Z'); }, isTrashed() { return this.trashed; },
      getParents() { return iter(this._parents); },
      getBlob() { const b = this.bytes; return { getBytes: () => [...b], getDataAsString: () => b.toString('utf8') }; },
      setContent(text) { this.bytes = Buffer.from(text, 'utf8'); },
      moveTo(folder) { this._parents = [folder]; },
    };
    items.set(f._id, f);
    return f;
  }
  const root = makeFolder('My Drive', null);
  const business = makeFolder('01_Business', root);
  const avs = makeFolder('AVS', business);
  const outside = makeFile('private.pdf', Buffer.from('secret stuff'), 'application/pdf', business);
  const DriveApp = {
    getRootFolder: () => root,
    getFileById: fid => { const f = items.get(fid); if (!f || f.kind !== 'file') throw new Error('No item with the given ID'); return f; },
  };
  const Utilities = {
    getUuid: () => randomUUID(),
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    base64Decode: s => [...Buffer.from(s, 'base64')],
    newBlob: (bytes, mime, name) => ({ bytes: Buffer.from(bytes), mime, name }),
  };
  const ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } }),
  };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const props = new Map();
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => { props.set(k, String(v)); },
  }) };
  const Drive = { Files: { update: (_res, fid, blob) => { items.get(fid).bytes = Buffer.from(blob.bytes); } } };
  return { DriveApp, Utilities, ContentService, LockService, PropertiesService, Drive, avs, outside, items, props };
}

// A deployed link, paired the way CI Plant pairs it (unless pair: false).
function load({ withDriveApi = true, pair = true } = {}) {
  const fake = fakeDrive();
  const ctx = { ...fake, JSON, String, Error, Date };
  if (!withDriveApi) delete ctx.Drive;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const secret = pair ? call({ op: 'pair' }).secret : null;
  return { ...fake, call, ctx, secret };
}

test('no secret in the code: the first pairing makes one, hands it out once, and every call needs it', () => {
  assert.doesNotMatch(SRC, /__SECRET__|var SECRET/, 'nothing secret is pasted into Apps Script');
  const d = load({ pair: false });
  assert.match(d.call({ op: 'ping', secret: 'anything' }).error, /Not paired yet/);
  const paired = d.call({ op: 'pair' });
  assert.equal(paired.ok, true);
  assert.match(paired.secret, /^[0-9a-f]{64}$/);
  assert.equal(paired.root.name, 'AVS', 'pairing proves the AVS folder is there');
  const again = d.call({ op: 'pair' });
  assert.equal(again.ok, false, 'pairing is closed once done');
  assert.match(again.error, /Already paired/);
  assert.equal(again.secret, undefined);
  assert.deepEqual(d.call({ op: 'ping' }), { ok: false, error: 'Wrong secret' });
  assert.deepEqual(d.call({ secret: 'nope', op: 'ping' }), { ok: false, error: 'Wrong secret' });
  const ping = d.call({ secret: paired.secret, op: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.root.name, 'AVS');
  // A new secret only for a caller that has the current one; the old one stops working.
  assert.equal(d.call({ op: 'rotate' }).ok, false);
  const rotated = d.call({ op: 'rotate', secret: paired.secret });
  assert.match(rotated.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(rotated.secret, paired.secret);
  assert.equal(d.call({ op: 'ping', secret: paired.secret }).ok, false);
  assert.equal(d.call({ op: 'ping', secret: rotated.secret }).ok, true);
  // GET answers only that the link is alive.
  assert.equal(JSON.parse(d.ctx.doGet().text).ok, true);
});

test('pairing refuses when the AVS folder is not where the link looks, and pairs nothing', () => {
  const d = load({ pair: false });
  d.avs._name = 'AVS old';
  const p = d.call({ op: 'pair' });
  assert.equal(p.ok, false);
  assert.match(p.error, /AVS folder not found/);
  assert.equal(d.props.get('AVS_SECRET'), undefined);
});

test('a photo lands in a new dated folder, and the answer names the file and its folder', () => {
  const d = load();
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const put = d.call({ secret: d.secret, op: 'put', path: 'AVS CHECK/26-09-2026/Set 0001 CI-JC-0399', name: '01 IMG_1.jpg',
    mime: 'image/jpeg', base64: photo.toString('base64') });
  assert.equal(put.ok, true);
  assert.equal(put.created, true);
  assert.equal(put.size, photo.length);
  assert.equal(put.parent.name, 'Set 0001 CI-JC-0399');
  // A second photo in the same set reuses the folder, never a twin of it.
  d.call({ secret: d.secret, op: 'put', path: 'AVS CHECK/26-09-2026/Set 0001 CI-JC-0399', name: '02 IMG_2.jpg',
    mime: 'image/jpeg', base64: photo.toString('base64') });
  const list = d.call({ secret: d.secret, op: 'list', path: 'AVS CHECK/26-09-2026' });
  assert.equal(list.entries.filter(e => e.folder).length, 1);
  const inSet = d.call({ secret: d.secret, op: 'list', path: 'AVS CHECK/26-09-2026/Set 0001 CI-JC-0399' });
  assert.deepEqual(inSet.entries.map(e => e.name).sort(), ['01 IMG_1.jpg', '02 IMG_2.jpg']);
  // The bytes come back exactly.
  const got = d.call({ secret: d.secret, op: 'get', id: put.id });
  assert.deepEqual(Buffer.from(got.base64, 'base64'), photo);
});

test('nothing is ever overwritten by accident, and text is replaced only when asked', () => {
  const d = load();
  const csv = '"a","b"\r\n"1","2"\r\n';
  d.call({ secret: d.secret, op: 'put', path: '_SYSTEM', name: 'AVS_Register.csv', text: csv, mime: 'text/csv' });
  const again = d.call({ secret: d.secret, op: 'put', path: '_SYSTEM', name: 'AVS_Register.csv', text: 'x' });
  assert.equal(again.ok, false);
  assert.match(again.error, /already there/);
  const grown = csv + '"3","4"\r\n';
  const rep = d.call({ secret: d.secret, op: 'put', path: '_SYSTEM', name: 'AVS_Register.csv', text: grown, replace: true });
  assert.equal(rep.replaced, true);
  const back = d.call({ secret: d.secret, op: 'get', path: '_SYSTEM/AVS_Register.csv', as: 'text' });
  assert.equal(back.text, grown, 'CRLF and quoting kept byte for byte');
  // A photo of the same name is refused, or handed back with ifExists 'reuse'.
  const b64 = Buffer.from('jpeg').toString('base64');
  d.call({ secret: d.secret, op: 'put', path: 'P', name: 'x.jpg', base64: b64 });
  assert.equal(d.call({ secret: d.secret, op: 'put', path: 'P', name: 'x.jpg', base64: b64 }).ok, false);
  assert.equal(d.call({ secret: d.secret, op: 'put', path: 'P', name: 'x.jpg', base64: b64, ifExists: 'reuse' }).existed, true);
});

test('a PDF is replaced in place only with the Drive API service added', () => {
  const pdf = Buffer.from('%PDF-1 old').toString('base64');
  const newer = Buffer.from('%PDF-1 new').toString('base64');
  const without = load({ withDriveApi: false });
  without.call({ secret: without.secret, op: 'put', path: 'D', name: 'DAILY SUMMARY 26-09-2026.pdf', base64: pdf, mime: 'application/pdf' });
  const refused = without.call({ secret: without.secret, op: 'put', path: 'D', name: 'DAILY SUMMARY 26-09-2026.pdf', base64: newer, replace: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Drive API service/);
  const withApi = load();
  const first = withApi.call({ secret: withApi.secret, op: 'put', path: 'D', name: 'S.pdf', base64: pdf });
  const rep = withApi.call({ secret: withApi.secret, op: 'put', path: 'D', name: 'S.pdf', base64: newer, replace: true });
  assert.equal(rep.replaced, true);
  assert.equal(rep.id, first.id, 'same file, so its link in CI Plant keeps working');
  assert.equal(Buffer.from(withApi.call({ secret: withApi.secret, op: 'get', id: first.id }).base64, 'base64').toString(), '%PDF-1 new');
});

test('files outside the AVS folder cannot be read or moved, and paths cannot climb out', () => {
  const d = load();
  const get = d.call({ secret: d.secret, op: 'get', id: d.outside.getId() });
  assert.equal(get.ok, false);
  assert.match(get.error, /not in the AVS folder/);
  const move = d.call({ secret: d.secret, op: 'move', id: d.outside.getId(), to: 'x' });
  assert.equal(move.ok, false);
  const climb = d.call({ secret: d.secret, op: 'list', path: '../..' });
  assert.equal(climb.ok, false);
  assert.match(climb.error, /Bad path/);
});

test('a photo moves into its case folder and keeps its id', () => {
  const d = load();
  const put = d.call({ secret: d.secret, op: 'put', path: 'AVS CHECK/26-09-2026/Set 0002', name: '01 a.jpg',
    base64: Buffer.from('j').toString('base64') });
  const moved = d.call({ secret: d.secret, op: 'move', id: put.id,
    to: '2026-09 SEPTEMBER/26-09-2026/PMCA1088R0 ONAPRIL 10/Photos AVS-2026-0005 Check 2' });
  assert.equal(moved.ok, true);
  assert.equal(moved.id, put.id);
  assert.equal(moved.parent.name, 'Photos AVS-2026-0005 Check 2');
});
