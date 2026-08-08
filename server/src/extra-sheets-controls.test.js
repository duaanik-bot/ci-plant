import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const route = read('./routes/extrasheets.js');
const returns = read('./extra-sheet-returns.js');
const inventoryRoute = read('./routes/inventory.js');
const replenishment = read('./replenishment.js');
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

test('Cutting completion automatically issues generated extra sheets to Printing', () => {
  assert.match(route, /async function issueExtraSheetsToStage/);
  assert.match(route, /r\.post\('\/extra-sheets\/:id\/cutting\/complete'/);
  assert.match(route, /await issueExtraSheetsToStage\(\{\s*qc, oc, x: \{ \.\.\.x, cuts_per_parent: cuts \}, jc, st, req,/);
  assert.match(route, /UPDATE job_cards SET sheets_issued = sheets_issued \+ \$1 WHERE id=\$2/);
  assert.match(route, /SET status='issued', issued_by=\$1, issued_at=now\(\),/);
  assert.match(route, /kind: 'xs_received'/);
  assert.match(route, /link: `\/floor\/\$\{st\.stage\}\?q=\$\{encodeURIComponent\(jc\.jc_number\)\}`/);
  assert.match(sectionPage, /Complete & Issue/);
  assert.match(sectionPage, /Completing this counter will issue the generated sheets to Printing and update the Printing job balance/);
  assert.match(sectionPage, /confirm_completed_printing: xsCompleting\?\.stage === 'printing'/);
  assert.match(sectionPage, /extra sheets received by Printing/);
});

test('cancelled or reversed extra-sheet approvals release warehouse stock back to uncommitted', () => {
  assert.match(replenishment, /WHERE x\.status IN \('approved','sent_to_cutting','cutting_in_progress','cutting_completed','ready_for_printing'\)/);
  assert.doesNotMatch(replenishment, /WHERE x\.status IN \([^)]*cancelled[^)]*\)/);
  assert.doesNotMatch(replenishment, /WHERE x\.status IN \([^)]*reversed[^)]*\)/);
  assert.match(route, /releaseExtraSheetReservation/);
  assert.match(returns, /export async function releaseExtraSheetReservation/);
  assert.match(returns, /audit\('materials', materialId, 'extra_sheet_stock_uncommitted'/);
  assert.match(returns, /extra_sheet_stock_uncommitted/);
  assert.match(returns, /released to warehouse uncommitted/);
  assert.match(route, /const reservedQty = Math\.max\(0, Math\.round\(\+x\.qty \|\| 0\)\)/);
  assert.match(route, /parentQty: reservedQty, reason: `approval reversed - \$\{reason\}`/);
  assert.match(route, /const users = await qc\('SELECT id, role, active, sections FROM users'\)/);
});

test('legacy issued extra-sheet cancellations repair the missing physical stock return exactly once', () => {
  assert.match(returns, /writeOnMissing = true/);
  assert.match(returns, /writeOnMissing: false/);
  assert.match(returns, /ref_type='job_card' AND sm\.ref_id=x\.job_card_id/);
  assert.match(returns, /sm\.note ILIKE '%' \|\| x\.xs_number \|\| '%'/);
  assert.match(returns, /sm\.note ILIKE '%' \|\| \$1 \|\| '%'/);
  assert.match(returns, /FOR UPDATE OF x SKIP LOCKED/);
  assert.match(returns, /UPDATE job_cards SET sheets_issued=GREATEST\(0, sheets_issued - \$1\)/);
  assert.match(returns, /audit\('materials', x\.board_material_id, 'extra_sheet_stock_uncommitted'/);
  assert.match(returns, /jc\.id AS jc_id/);
  assert.match(route, /repairMissingExtraSheetReturnsQuiet\(\)/);
  assert.match(inventoryRoute, /repairMissingExtraSheetReturnsQuiet\(\)/);
});
