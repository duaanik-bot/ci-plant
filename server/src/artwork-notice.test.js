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

// The Fluence section (owner, 20 Nov 2026: "Yes, add it"; design 2026-11-18 §4.3): what the system did with Fluence's
// mails, in the same notice. Invented kits, codes and MRPs.
const fr = over => ({ source: 'mrp_sheet', status: 'saved', kit: 'NOVA CALM KIT', kit_name: 'NOVA CALM KIT', product_code: 'FPT-501',
  created_product_code: null, hold_reason: null, changes: { components_changed: true, kit_total: { old: 1000, new: 1100 } },
  reading: { mrp: { kit_total: 1100 } }, sure: true, unsure: [], received_at: '2026-11-20T05:30:00Z', ...over });

test('Fluence alone: what was saved (do not enter again), held and why, not matched, PO lines to check, and what was already the same', () => {
  const m = noticeMail({ items: [], at: '2026-11-20T07:35:00Z', fluenceLink: 'https://plant.test/fluence?tab=mail', fluence: [
    fr(),
    fr({ status: 'held', kit: 'ORBIT KIT', product_code: 'FPT-502', changes: null, hold_reason: 'kit MRP 1100 → 700 is more than 25 % lower' }),
    fr({ status: 'not_matched', kit: null, kit_name: 'NO SUCH KIT', product_code: null, changes: null, hold_reason: 'no kit of that name or code in our masters' }),
    fr({ source: 'po', status: 'compared', changes: { differs: ['carton MRP: master 1100, PO 1050'] } }),
    fr({ source: 'po', status: 'compared', kit: null, kit_name: 'GHOST KIT', product_code: null, changes: null, hold_reason: 'no kit of that name or code' }),
    fr({ status: 'same', kit: 'CALM KIT', product_code: 'FPT-503', changes: {} }),
    fr({ source: 'po', status: 'compared', kit: 'REST KIT', product_code: 'FPT-504', changes: { differs: [] } }),
  ] });
  assert.equal(m.subject, 'Fluence masters done by the system — 1 saved, 1 held, 1 not matched, 2 PO lines to check, 2 already the same (20 Nov 2026, 1:05 pm)');
  assert.match(m.text, /^Fluence masters the system has already handled — please do not do these again\./);
  assert.match(m.text, /FLUENCE MASTER — SAVED FROM FLUENCE'S MAIL — do not enter these again\n• NOVA CALM KIT \(FPT-501\) — items \/ item MRPs changed · kit MRP ₹1,000 → ₹1,100 \(carton too\) — MRP sheet of 20 Nov\n/);
  assert.match(m.text, /FLUENCE MASTER — HELD, NOT SAVED[^\n]*\n• ORBIT KIT \(FPT-502\) — kit MRP 1100 → 700 is more than 25 % lower — MRP sheet of 20 Nov\n/);
  assert.match(m.text, /FLUENCE MASTER — NOT MATCHED[^\n]*\n• NO SUCH KIT — no kit of that name or code in our masters — MRP sheet of 20 Nov\n\n/);
  assert.match(m.text, /FLUENCE MASTER — PO LINES TO CHECK[^\n]*\n• NOVA CALM KIT \(FPT-501\) — carton MRP: master 1100, PO 1050 — PO of 20 Nov\n• GHOST KIT — no kit of that name or code — PO of 20 Nov\n/);
  assert.match(m.text, /FLUENCE MASTER — CHECKED, ALREADY THE SAME[^\n]*\n• 2 kits — CALM KIT \(FPT-503\), REST KIT \(FPT-504\)\n/);
  assert.doesNotMatch(m.text, /matches the master|DONE BY THE SYSTEM|Open the register/);
  assert.match(m.text, /Fluence › From Fluence mail[^\n]*: https:\/\/plant\.test\/fluence\?tab=mail/);
  assert.match(m.text, /never sends mail to clients/);
  assert.match(m.html, /<b>FLUENCE MASTER — SAVED FROM FLUENCE'S MAIL — do not enter these again<\/b>/);
});

test('artwork and Fluence from one run: one notice, one subject, both sections', () => {
  const m = noticeMail({ items: [item()], fluence: [fr()], at: '2026-11-17T07:35:00Z' });
  assert.equal(m.subject, 'Artwork done by the system — 1 item; Fluence masters — 1 saved (17 Nov 2026, 1:05 pm)');
  assert.match(m.text, /^Artwork and Fluence masters the system has already handled — please do not do these again\./);
  assert.match(m.text, /DONE BY THE SYSTEM[\s\S]*FLUENCE MASTER — SAVED FROM FLUENCE'S MAIL/);
  assert.match(m.text, /Open the register: /);
  assert.match(m.text, /https:\/\/\S+\/fluence\?tab=mail/);
});

test('a new kit is told with its draft carton once; long lists are cut with a pointer to the tab; a name cannot become markup', () => {
  const many = Array.from({ length: 45 }, (_, i) => fr({ kit: `KIT ${i + 1}`, product_code: null }));
  const same = Array.from({ length: 25 }, (_, i) => fr({ status: 'same', kit: `SAME ${i + 1}`, product_code: null, changes: {} }));
  const m = noticeMail({ items: [], fluence: [fr({ kit: '<b>x</b> KIT', product_code: 'FPT-0900', created_product_code: 'FPT-0900',
    changes: { rx_changed: true, revision: 1, kit_total: { old: null, new: 950 } } }), ...many, ...same] });
  assert.match(m.subject, /— 46 saved \(1 new kit\), 25 already the same \(/);
  assert.match(m.text, /• <b>x<\/b> KIT — new kit — draft carton FPT-0900 made · prescription → revision 1 · kit MRP set to ₹950 \(carton too\) — MRP sheet of 20 Nov\n/);
  assert.match(m.text, /• KIT 39 — /);
  assert.doesNotMatch(m.text, /• KIT 40 — /);
  assert.match(m.text, /…and 6 more — all in Fluence › From Fluence mail/);
  assert.match(m.text, /• 25 kits — SAME 1, [^\n]*SAME 20 and 5 more\n/);
  assert.doesNotMatch(m.html, /<b>x<\/b>/);
});

// Review I1 + I2 (20 Nov 2026): a PO's MRPs are only compared, never saved (design §7.1). A PO line is "already the same"
// only when its kit MRP was read, sure, and compared; one naming no kit is checked on the PO, never "put in by hand".
test('a PO line is "already the same" only when its MRP was read and compared — and is never to be put in by hand', () => {
  const m = noticeMail({ items: [], at: '2026-11-20T07:35:00Z', fluence: [
    fr({ source: 'po', status: 'compared', kit: 'UNREAD KIT', product_code: 'FPT-505', changes: { differs: [] }, reading: { mrp: { kit_total: null, items: [] } } }),
    fr({ source: 'po', status: 'compared', kit: 'UNSURE KIT', product_code: 'FPT-506', changes: { differs: [] }, reading: { mrp: { kit_total: 1050 } }, sure: false, unsure: ['mrp.kit_total'] }),
    fr({ source: 'po', status: 'compared', kit: null, kit_name: 'GHOST KIT', product_code: null, changes: null, hold_reason: 'no kit of that name or code' }),
    fr({ source: 'po', status: 'compared', kit: 'REST KIT', product_code: 'FPT-504', changes: { differs: [] } }),
  ] });
  assert.equal(m.subject, 'Fluence masters done by the system — 3 PO lines to check, 1 already the same (20 Nov 2026, 1:05 pm)');
  assert.match(m.text, /FLUENCE MASTER — PO LINES TO CHECK[^\n]*\n• UNREAD KIT \(FPT-505\) — not compared — no kit MRP read on the PO — PO of 20 Nov\n• UNSURE KIT \(FPT-506\) — not compared — the robot was not sure of: mrp\.kit_total — PO of 20 Nov\n• GHOST KIT — no kit of that name or code — PO of 20 Nov\n/);
  assert.match(m.text, /CHECKED, ALREADY THE SAME[^\n]*\n• 1 kit — REST KIT \(FPT-504\)\n/);
  assert.doesNotMatch(m.text, /NOT MATCHED|put it in by hand|Keep the master|matches the master/);
});

// Review M3, M4, M6, M12 (20 Nov 2026). Invented kits.
test('the opening line names the Fluence groups that need a person; the not-matched heading fits every reason', () => {
  const m = noticeMail({ items: [], fluence: [
    fr({ status: 'held', changes: null, hold_reason: 'kit MRP 1100 → 700 is more than 25 % lower' }),
    fr({ status: 'not_matched', kit: null, kit_name: 'TWIN KIT', product_code: null, changes: null, hold_reason: 'two kits are named TWIN KIT — put the MRP in the right one by hand' }),
  ] });
  assert.match(m.text, /^Fluence masters the system has already handled — please do not do these again\. The Fluence lines under HELD or NOT MATCHED need a person\.\n/);
  assert.match(m.text, /FLUENCE MASTER — NOT MATCHED TO ONE KIT — put the MRP in by hand, or press Keep the master\n• TWIN KIT — two kits are named TWIN KIT/);
  assert.match(noticeMail({ items: [], fluence: [fr({ source: 'po', status: 'compared', changes: { differs: ['carton MRP: master 1100, PO 1050'] } })] }).text,
    /^Fluence masters the system has already handled — please do not do these again\. The Fluence lines under PO LINES TO CHECK need a person\.\n/);
  assert.match(noticeMail({ items: [item()], fluence: [fr()] }).text, /^Artwork and Fluence masters the system has already handled — please do not do these again\.\n/);
});

test('a kit made for a job\'s carton is counted as new and called new in its line', () => {
  const m = noticeMail({ items: [], fluence: [fr({ created_kit_id: 7, changes: { rx_changed: true, revision: 1 } })] });
  assert.match(m.subject, /— 1 saved \(1 new kit\) \(/);
  assert.match(m.text, /• NOVA CALM KIT \(FPT-501\) — new kit made for its carton · prescription → revision 1 — MRP sheet of 20 Nov\n/);
});

test('a reading with malformed changes is still told, and never stops the notice', () => {
  const m = noticeMail({ items: [item()], fluence: [
    fr({ changes: { differs: 'not a list', inner_added: 'F-X CAPS', kit_total: 'x' } }),
    fr({ source: 'po', status: 'compared', kit: 'ODD KIT', changes: { differs: 'bad' } }),
  ] });
  assert.match(m.text, /DONE BY THE SYSTEM/);
  assert.match(m.text, /• NOVA CALM KIT \(FPT-501\) — /);
  assert.match(m.text, /ODD KIT/);
});
