import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const route = read('./routes/extrasheets.js');
const extraSheetsPage = read('../../client/src/pages/ExtraSheets.jsx');
const sectionPage = read('../../client/src/pages/Section.jsx');
const jobRow = read('../../client/src/components/floor/JobRow.jsx');

test('extra-sheet cancellation is limited to the pre-cutting flow and checks ownership or plant-head authority', () => {
  assert.match(route, /const CANCELLABLE_XS_STATUSES = \['pending', 'approved', 'sent_to_cutting'\]/);
  assert.match(route, /const isOwner = Number\(x\.requested_by_id\) === Number\(req\.user\.id\)/);
  assert.match(route, /canApproveExtraSheets\(actor\)/);
  assert.match(route, /Only a request before Cutting starts can be cancelled/);
  assert.match(extraSheetsPage, /const canCancel = r => CANCELLABLE_STATUSES\.includes\(r\.status\)/);
  assert.match(extraSheetsPage, /Cancel Request/);
});

test('sending extra sheets after completed Printing requires an explicit confirmation', () => {
  assert.match(route, /const printingCompleted = st\.stage === 'printing' && st\.status === 'completed'/);
  assert.match(route, /confirm_completed_printing !== true/);
  assert.match(route, /PRINTING_COMPLETED_CONFIRMATION_REQUIRED/);
  assert.match(sectionPage, /Printing is already completed for this job\. Do you still want to issue these extra sheets\?/);
  assert.match(sectionPage, /confirm_completed_printing: printingCompleted && completedPrintingConfirmed/);
});

test('Printing receives a row-level receipt indicator and the team notification remains wired', () => {
  assert.match(route, /title: `Extra Sheets Received — \$\{jc\.jc_number\}`/);
  assert.match(route, /printingRecipients\(users, x\.requested_by_id\)/);
  assert.match(sectionPage, /Extra Sheets Received \+\$\{fmt\.num\(r\.latest_xs_stage_qty\)\}/);
  assert.match(jobRow, /Extra Sheets Received \+\$\{fmt\.num\(job\.latest_xs_stage_qty\)\}/);
});
