import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AVS_DOC_KINDS, AVS_DOC_MAX_BYTES, docKindLabel, docMime, docProblem, docRemovable, newDocsSinceReport,
} from '../../client/src/lib/avs.js';

// Remove a photo before Verify, documents with a set, re-check with them
// (owner's request, 5 Oct 2026; routes/avs-docs.js, components/avs/AvsDocs.jsx).

const src = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const route = (file, start) => { const s = src(file); const i = s.indexOf(start); assert.ok(i >= 0, start); const j = s.indexOf('\nr.', i + 5); return s.slice(i, j < 0 ? undefined : j); };

test('a document is a PO, approval, artwork, e-mail or other; a file or an https link', () => {
  assert.deepEqual(AVS_DOC_KINDS.map(k => k.key), ['po', 'approval', 'artwork', 'email', 'other']);
  assert.equal(docKindLabel('po'), 'Purchase order');
  assert.match(docProblem({ kind: 'invoice', size: 10, type: 'application/pdf' }), /Pick what the document is/);
  assert.equal(docProblem({ kind: 'po', size: 1000, type: 'application/pdf' }), null);
  assert.equal(docProblem({ kind: 'email', url: 'https://mail.google.com/mail/u/1/#inbox/FMfcgz' }), null);
  assert.match(docProblem({ kind: 'email', url: 'mail.google.com/x' }), /https:\/\//);
  assert.match(docProblem({ kind: 'po', size: AVS_DOC_MAX_BYTES + 1, type: 'application/pdf' }), /over 4 MB/);
  assert.match(docProblem({ kind: 'po', size: 10, type: 'application/x-msdownload' }), /PDF, photo, Excel/);
  assert.match(docProblem({ kind: 'po', size: 0, type: 'application/pdf' }), /empty/);
});

test('the file type comes from the browser, else from the name', () => {
  assert.equal(docMime('PO 538.pdf', ''), 'application/pdf');
  assert.equal(docMime('mail.eml', 'application/octet-stream'), 'message/rfc822');
  assert.equal(docMime('x.msg', ''), 'application/vnd.ms-outlook');
  assert.equal(docMime('a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('a document can be removed until a finished check used it; new ones after the report wait for the re-check', () => {
  assert.equal(docRemovable({ id: 1 }), true);
  assert.equal(docRemovable({ id: 1, used_in_report: 'AVS-2026-0024' }), false);
  const set = { docs: [{ id: 1, added_after_report: false }, { id: 2, added_after_report: true },
    { id: 3, added_after_report: true, used_in_report: 'AVS-2026-0024' }] };
  assert.deepEqual(newDocsSinceReport(set).map(d => d.id), [2]);
  assert.deepEqual(newDocsSinceReport({}), []);
});

test('a photo is removed only before Verify, for good, with an audit line, and its Drive file goes to the bin', () => {
  const r = route('./routes/avs-docs.js', "r.post('/avs/uploads/:id/photos/:photoId/delete'");
  assert.match(r, /set\.status !== 'uploading'/);
  assert.match(r, /FOR UPDATE/, 'a Verify at the same moment waits');
  assert.match(r, /DELETE FROM avs\.check_photo_bytes/);
  assert.match(r, /DELETE FROM avs\.check_photos WHERE id = \$1/);
  assert.match(r, /action: 'PHOTO_REMOVED'/);
  assert.match(r, /dropFromDrive\(photo\.drive_file_id\)/);
  const drop = src('./routes/avs-docs.js');
  assert.match(drop, /op: 'trash'/);
  assert.match(drop, /AVS CHECK\/_REMOVED/, 'an older Drive link without trash moves it out of the set');
});

test('a document goes to Drive beside the photos, or is kept in CI Plant; never twice; a cancelled set takes none', () => {
  const r = route('./routes/avs-docs.js', "r.post('/avs/uploads/:id/docs'");
  assert.match(r, /status === 'cancelled'/);
  assert.match(r, /docProblem\(/);
  assert.match(r, /\/Documents`/);
  assert.match(r, /INSERT INTO avs\.check_doc_bytes/);
  assert.match(r, /This file is already with the set/);
  assert.match(r, /added_after_report/);
  assert.match(r, /action: 'DOC_ADDED'/);
});

test('a document used by a finished check stays; removing one is audited', () => {
  const r = route('./routes/avs-docs.js', "r.post('/avs/uploads/:id/docs/:docId/delete'");
  assert.match(r, /docRemovable\(d\)/);
  assert.match(r, /DELETE FROM avs\.check_docs WHERE id = \$1/);
  assert.match(r, /action: 'DOC_REMOVED'/);
});

test('re-check with new documents: next check of the same report, same photos, started at once', () => {
  const r = route('./routes/avs-docs.js', "r.post('/avs/uploads/:id/recheck'");
  assert.match(r, /set\.status !== 'done'/);
  assert.match(r, /newDocsSinceReport\(full\)/);
  assert.match(r, /redo_report_no/);
  assert.match(r, /photos_from_set_id/);
  assert.match(r, /VALUES \('queued'/);
  assert.match(r, /UPDATE avs\.check_docs SET request_id = \$1 WHERE request_id = \$2 AND added_after_report AND used_in_report IS NULL/);
  assert.match(r, /fireUnlessRunning\(/);
  assert.match(r, /action: 'RECHECK_WITH_DOCS'/);
});

test('the check marks the documents it read; the robot fetches a kept one with its key', () => {
  const robot = src('./routes/avs-robot.js');
  assert.match(robot, /r\.get\('\/avs\/robot\/docs\/:id'/);
  assert.match(robot, /docsUsed\(p\.docs_used, p\.report\)/);
  assert.match(src('./avs-file-report.js'), /UPDATE avs\.check_docs SET used_in_report = \$2/);
  const app = src('./app.js');
  assert.ok(app.indexOf("app.use('/api', avsDocs)") > app.indexOf("app.use('/api', requireAuth)"), 'behind the ERP login');
});

test('the Drive link knows trash, only for a file inside the AVS folder', () => {
  const gs = src('../../client/src/lib/avs-robot/drive-link.gs');
  assert.match(gs, /trash: 1/);
  assert.match(gs, /function trash_\(req\) \{\s*var f = byId_\(req\.id\);\s*f\.setTrashed\(true\);/);
});

test('the dialog lets a photo be removed and photos dropped; documents in both places', () => {
  const up = src('../../client/src/components/avs/AvsUpload.jsx');
  assert.match(up, /photos\/\$\{photoId\}\/delete/);
  assert.match(up, /onDrop=\{onDropPhotos\}/);
  assert.match(up, /<AvsDocs set=\{set\} ensureSet=\{ensureSet\}/);
  const sets = src('../../client/src/components/avs/AvsSets.jsx');
  assert.match(sets, /Re-check with new documents/);
  assert.match(sets, /\/recheck`/);
  const docs = src('../../client/src/components/avs/AvsDocs.jsx');
  assert.match(docs, /onDrop=\{onDrop\}/);
  assert.match(docs, /docs\/\$\{d\.id\}\/delete/);
});
