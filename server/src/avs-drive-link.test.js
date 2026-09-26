import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The Drive link runs in Google Apps Script, where nothing here can reach it.
// So it is run against a small in-memory Drive with the same calls it makes
// (DriveApp, Utilities, ContentService, LockService, the Drive API service):
// every answer CI Plant and the AVS routine depend on is checked here.
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
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    base64Decode: s => [...Buffer.from(s, 'base64')],
    newBlob: (bytes, mime, name) => ({ bytes: Buffer.from(bytes), mime, name }),
  };
  const ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } }),
  };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const Drive = { Files: { update: (_res, fid, blob) => { items.get(fid).bytes = Buffer.from(blob.bytes); } } };
  return { DriveApp, Utilities, ContentService, LockService, Drive, avs, outside, items };
}

function load({ withDriveApi = true } = {}) {
  const fake = fakeDrive();
  const ctx = { ...fake, JSON, String, Error, Date };
  if (!withDriveApi) delete ctx.Drive;
  vm.createContext(ctx);
  vm.runInContext(SRC.replace("'__SECRET__'", "'s3cret'"), ctx);
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ...fake, call, ctx };
}

test('the secret is required, and a wrong one reads nothing', () => {
  const d = load();
  assert.deepEqual(d.call({ op: 'ping' }), { ok: false, error: 'Wrong secret' });
  assert.deepEqual(d.call({ secret: 'nope', op: 'ping' }), { ok: false, error: 'Wrong secret' });
  const ping = d.call({ secret: 's3cret', op: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.root.name, 'AVS');
  // GET answers only that the link is alive.
  assert.equal(JSON.parse(d.ctx.doGet().text).ok, true);
});

test('a photo lands in a new dated folder, and the answer names the file and its folder', () => {
  const d = load();
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const put = d.call({ secret: 's3cret', op: 'put', path: 'AVS CHECK/26-09-2026/Set 0001 CI-JC-0399', name: '01 IMG_1.jpg',
    mime: 'image/jpeg', base64: photo.toString('base64') });
  assert.equal(put.ok, true);
  assert.equal(put.created, true);
  assert.equal(put.size, photo.length);
  assert.equal(put.parent.name, 'Set 0001 CI-JC-0399');
  // A second photo in the same set reuses the folder, never a twin of it.
  d.call({ secret: 's3cret', op: 'put', path: 'AVS CHECK/26-09-2026/Set 0001 CI-JC-0399', name: '02 IMG_2.jpg',
    mime: 'image/jpeg', base64: photo.toString('base64') });
  const list = d.call({ secret: 's3cret', op: 'list', path: 'AVS CHECK/26-09-2026' });
  assert.equal(list.entries.filter(e => e.folder).length, 1);
  const inSet = d.call({ secret: 's3cret', op: 'list', path: 'AVS CHECK/26-09-2026/Set 0001 CI-JC-0399' });
  assert.deepEqual(inSet.entries.map(e => e.name).sort(), ['01 IMG_1.jpg', '02 IMG_2.jpg']);
  // The bytes come back exactly.
  const got = d.call({ secret: 's3cret', op: 'get', id: put.id });
  assert.deepEqual(Buffer.from(got.base64, 'base64'), photo);
});

test('nothing is ever overwritten by accident, and text is replaced only when asked', () => {
  const d = load();
  const csv = '"a","b"\r\n"1","2"\r\n';
  d.call({ secret: 's3cret', op: 'put', path: '_SYSTEM', name: 'AVS_Register.csv', text: csv, mime: 'text/csv' });
  const again = d.call({ secret: 's3cret', op: 'put', path: '_SYSTEM', name: 'AVS_Register.csv', text: 'x' });
  assert.equal(again.ok, false);
  assert.match(again.error, /already there/);
  const grown = csv + '"3","4"\r\n';
  const rep = d.call({ secret: 's3cret', op: 'put', path: '_SYSTEM', name: 'AVS_Register.csv', text: grown, replace: true });
  assert.equal(rep.replaced, true);
  const back = d.call({ secret: 's3cret', op: 'get', path: '_SYSTEM/AVS_Register.csv', as: 'text' });
  assert.equal(back.text, grown, 'CRLF and quoting kept byte for byte');
  // A photo of the same name is refused, or handed back with ifExists 'reuse'.
  const b64 = Buffer.from('jpeg').toString('base64');
  d.call({ secret: 's3cret', op: 'put', path: 'P', name: 'x.jpg', base64: b64 });
  assert.equal(d.call({ secret: 's3cret', op: 'put', path: 'P', name: 'x.jpg', base64: b64 }).ok, false);
  assert.equal(d.call({ secret: 's3cret', op: 'put', path: 'P', name: 'x.jpg', base64: b64, ifExists: 'reuse' }).existed, true);
});

test('a PDF is replaced in place only with the Drive API service added', () => {
  const pdf = Buffer.from('%PDF-1 old').toString('base64');
  const newer = Buffer.from('%PDF-1 new').toString('base64');
  const without = load({ withDriveApi: false });
  without.call({ secret: 's3cret', op: 'put', path: 'D', name: 'DAILY SUMMARY 26-09-2026.pdf', base64: pdf, mime: 'application/pdf' });
  const refused = without.call({ secret: 's3cret', op: 'put', path: 'D', name: 'DAILY SUMMARY 26-09-2026.pdf', base64: newer, replace: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Drive API service/);
  const withApi = load();
  const first = withApi.call({ secret: 's3cret', op: 'put', path: 'D', name: 'S.pdf', base64: pdf });
  const rep = withApi.call({ secret: 's3cret', op: 'put', path: 'D', name: 'S.pdf', base64: newer, replace: true });
  assert.equal(rep.replaced, true);
  assert.equal(rep.id, first.id, 'same file, so its link in CI Plant keeps working');
  assert.equal(Buffer.from(withApi.call({ secret: 's3cret', op: 'get', id: first.id }).base64, 'base64').toString(), '%PDF-1 new');
});

test('files outside the AVS folder cannot be read or moved, and paths cannot climb out', () => {
  const d = load();
  const get = d.call({ secret: 's3cret', op: 'get', id: d.outside.getId() });
  assert.equal(get.ok, false);
  assert.match(get.error, /not in the AVS folder/);
  const move = d.call({ secret: 's3cret', op: 'move', id: d.outside.getId(), to: 'x' });
  assert.equal(move.ok, false);
  const climb = d.call({ secret: 's3cret', op: 'list', path: '../..' });
  assert.equal(climb.ok, false);
  assert.match(climb.error, /Bad path/);
});

test('a photo moves into its case folder and keeps its id', () => {
  const d = load();
  const put = d.call({ secret: 's3cret', op: 'put', path: 'AVS CHECK/26-09-2026/Set 0002', name: '01 a.jpg',
    base64: Buffer.from('j').toString('base64') });
  const moved = d.call({ secret: 's3cret', op: 'move', id: put.id,
    to: '2026-09 SEPTEMBER/26-09-2026/PMCA1088R0 ONAPRIL 10/Photos AVS-2026-0005 Check 2' });
  assert.equal(moved.ok, true);
  assert.equal(moved.id, put.id);
  assert.equal(moved.parent.name, 'Photos AVS-2026-0005 Check 2');
});
