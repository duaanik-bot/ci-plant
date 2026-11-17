import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeMail } from './artwork-notice.js';

// The "done by the system" notice's words (17 Nov 2026). Invented jobs, files and links.
const item = over => ({
  action: 'received', job_no: 'CI-AW-0001', client_item_code: 'PCS-X001', product_name: 'ALPHA CARTON', customer: 'Example Pharma Ltd',
  label: 'R0.1', fresh: true, to_sort: false, designer_reply_at: null, view_url: 'https://mail.test/m1',
  files: [{ file_name: 'PCS-X001-R0.cdr', drive_url: 'https://drive.test/lib1', saved_by: 'system' }], ...over,
});

test('what the system did, with the saved files and the mail; no designer section when the designer did nothing', () => {
  const m = noticeMail({ items: [item()], at: '2026-11-17T07:35:00Z', link: 'https://plant.test/artwork?tab=register' });
  assert.match(m.subject, /^Artwork done by the system — 1 item \(17 Nov 2026, 1:05 pm\)$/);
  assert.match(m.text, /DONE BY THE SYSTEM\n• CI-AW-0001 PCS-X001 ALPHA CARTON — R0\.1 \(new job\) — Example Pharma Ltd/);
  assert.match(m.text, /PCS-X001-R0\.cdr — saved to CI AVS › ARTWORK LIBRARY: https:\/\/drive\.test\/lib1/);
  assert.match(m.text, /Mail: https:\/\/mail\.test\/m1/);
  assert.doesNotMatch(m.text, /ALREADY DONE BY THE DESIGNER/);
  assert.match(m.text, /never sends mail to clients/);
  assert.match(m.html, /<a href="https:\/\/drive\.test\/lib1">/);
});

test('what the designer already had is named, and is not called the system\'s work', () => {
  const m = noticeMail({ items: [item({
    fresh: false, label: 'R1.1', designer_reply_at: '2026-11-16T05:00:00Z',
    files: [{ file_name: 'a.cdr', drive_url: 'https://drive.test/clients/a', saved_by: 'designer' },
      { file_name: 'a.pdf', drive_url: 'https://drive.test/lib/a', saved_by: 'system' },
      { file_name: null, link_url: 'https://share.test/x', saved_by: 'system' }],
  })] });
  assert.match(m.subject, /1 already done by the designer/);
  assert.match(m.text, /a\.cdr — the designer's copy, not saved again: https:\/\/drive\.test\/clients\/a/);
  assert.match(m.text, /Link to fetch by hand \(not downloaded\): https:\/\/share\.test\/x/);
  assert.match(m.text, /ALREADY DONE BY THE DESIGNER[\s\S]*1 file already in the designer's folders: a\.cdr/);
  assert.match(m.text, /mppchd had already replied in the thread \(16 Nov 2026, 10:30 am\)/);
  assert.match(m.text, /R1\.1 \(new version\)/);
});

test('a file sent again is listed as nothing new; text in a name cannot become markup', () => {
  const m = noticeMail({ items: [item({ action: 'received_again', files: [] }), item({ job_no: 'CI-AW-0002', product_name: '<b>x</b>', to_sort: true, files: [{ file_name: 'f.pdf', saved_by: 'system' }] })] });
  assert.match(m.subject, /2 items/);
  assert.match(m.text, /SENT AGAIN — already in the register, nothing new\n• CI-AW-0001 PCS-X001 ALPHA CARTON R0\.1 — Example Pharma Ltd/);
  assert.match(m.text, /TO SORT/);
  assert.match(m.text, /f\.pdf — NOT saved to Drive/);
  assert.doesNotMatch(m.html, /<b>x<\/b>/);
});
