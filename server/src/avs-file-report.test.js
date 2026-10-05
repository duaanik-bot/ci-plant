import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filingProblems, reportUpsert, problemUpsert, photoFiled, setDone, REPORT_COLUMNS,
} from './avs-file-report.js';

// The check's report in ONE post (5 Oct 2026): the payload is checked before
// anything is written, and every statement is safe to post again.

const good = () => ({
  set_id: 27,
  report: {
    report_no: 'AVS-2026-0024', report_rev: 0, check_no: 1, status: 'HOLD', checked_on: '2026-10-05',
    product: 'Overzyme Syrup 200 ml', po_qty: 100000, po_open_qty: '', photos: ['01.jpg'],
    photo_sha256: ['ab'], findings: { problems: [] }, recommendation: ['Check board'],
  },
  problems: [{ ref: 'R-1', result: 'HOLD', title: 'Board 340 vs 350 GSM', severity: 'MAJOR' },
    { ref: 'A-1', result: 'VERIFY', title: 'Flap text' }],
  photos: [{ id: 101, drive_file_id: 'f1' }],
  set: { result: 'HOLD', robot_note: 'HOLD - Overzyme', drive_folder_id: 'd1' },
});

test('a complete report passes the payload check', () => {
  assert.deepEqual(filingProblems(good()), []);
});

test('a wrong payload is refused with every reason, before anything is written', () => {
  const p = good();
  p.set_id = 0;
  p.report.status = 'OK';
  p.report.bogus = 1;
  p.report.check_no = -1;
  p.problems.push({ ref: 'R-1', result: 'NO', extra: 1 });
  p.photos.push({ id: 5 });
  p.set.result = 'PASS';
  const out = filingProblems(p).join('\n');
  for (const want of [/set_id/, /bogus/, /PASS, HOLD or REJECT/, /check_no/, /R-1 is listed twice/,
    /result must be PASS, HOLD, REJECT, VERIFY or INFO/, /unknown fields: extra/, /photo 5 needs its drive_file_id/,
    /set\.result must equal report\.status/]) {
    assert.match(out, want);
  }
  assert.match(filingProblems({ set_id: 1, report: { report_no: 'X', status: 'HOLD', report_rev: 0, check_no: 1 } }).join(), /AVS-2026-0024/);
  assert.match(filingProblems({ ...good(), report: { ...good().report, row_type: 'CLOSE' } }).join(), /CLOSE row/);
});

test('the report row is an upsert on its key, typed, with blanks as NULL and JSON as text', () => {
  const { text, params } = reportUpsert(good().report);
  assert.match(text, /^INSERT INTO avs\.reports \(/);
  assert.match(text, /ON CONFLICT \(report_no, check_no, report_rev, row_type\) DO UPDATE SET/);
  assert.doesNotMatch(text, /report_no = EXCLUDED|check_no = EXCLUDED|report_rev = EXCLUDED|row_type = EXCLUDED/,
    'the key of the issue is never rewritten');
  const cols = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(', ');
  const at = c => params[cols.indexOf(c)];
  assert.equal(at('row_type'), 'REPORT');
  assert.equal(at('station'), 'C');
  assert.equal(at('po_open_qty'), null, 'a blank number is NULL, not a cast error');
  assert.equal(at('findings'), '{"problems":[]}');
  assert.equal(at('recommendation'), '["Check board"]');
  assert.deepEqual(at('photos'), ['01.jpg']);
  assert.ok(at('issued_at'), 'issued now when the check gives no time');
  assert.match(text, new RegExp(`\\$${cols.indexOf('checked_on') + 1}::date`));
  assert.match(text, new RegExp(`\\$${cols.indexOf('photos') + 1}::text\\[\\]`));
  for (const c of cols) assert.ok(c in REPORT_COLUMNS, c);
});

test('problems upsert on (report_id, ref); photos and the set are updated by id only', () => {
  const pr = problemUpsert(9, 'AVS-2026-0024', good().problems[1]);
  assert.match(pr.text, /ON CONFLICT \(report_id, ref\) DO UPDATE/);
  assert.deepEqual(pr.params, [9, 'AVS-2026-0024', 'A-1', 'VERIFY', 'Flap text', null, null, null, null]);
  const ph = photoFiled(27, { id: 101, drive_file_id: 'f1' });
  assert.match(ph.text, /WHERE id = \$1 AND request_id = \$2 RETURNING id/, 'a photo of another set is never touched');
  assert.equal(ph.params[3], 'https://drive.google.com/file/d/f1/view');
  const sd = setDone(27, good().report, good().set);
  assert.match(sd.text, /deleted_at IS NULL/);
  assert.match(sd.text, /status = 'checking' OR \(status = 'done' AND report_no = \$2\)/, 'posting again is harmless; another report is refused');
  assert.match(sd.text, /progress = 'Report ready'/);
  assert.equal(sd.params[8], 'https://drive.google.com/drive/folders/d1');
});

test('the route checks the key, writes in one transaction and stops on a cancelled set', () => {
  const src = readFileSync(new URL('./routes/avs-robot.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("r.post('/avs/robot/file-report'"));
  assert.ok(route.indexOf('keyOk(req)') < route.indexOf('filingProblems(p)'), 'the key comes first');
  assert.ok(route.indexOf('filingProblems(p)') < route.indexOf('await tx('), 'checked before anything is written');
  assert.match(route, /AVS_\(CANCELLED\|DELETED\)/);
  assert.match(route, /stop: true/);
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /AVS_FILE_PATH = '\/api\/avs\/robot\/file-report'/);
  assert.match(app, /avsFileJson = express\.json\(\{ limit: '4mb' \}\)/);
});
