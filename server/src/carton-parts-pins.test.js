import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitGangReverseBlock } from './helpers.js';
import { partChipText, cartonBoardSummary } from '../../client/src/lib/cartonParts.js';
import { mergePlanningScopes } from '../../client/src/lib/planningScope.js';
import * as partsLib from '../../client/src/lib/cartonParts.js';
import { planningResponse } from './planning-scope.js';
import { clashes } from './product-family.js';

// Source pins for the carton-made-in-parts wiring (plan 2026-09-29): each test
// guards one wiring point the unit tests cannot see. Local databases never have
// the realtime ping function, so the migration's trigger block is pinned here
// or nothing would notice it going missing.
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('carton-parts migration: plain FK, short lock, realtime ping, replayed by init()', () => {
  const sql = src('../../supabase/migrations/20260929120000_carton_parts.sql');
  assert.match(sql, /set local lock_timeout = '1s';/);
  const col = sql.match(/ADD COLUMN IF NOT EXISTS part_of_line_id[^;]*;/)[0];
  assert.match(col, /REFERENCES order_lines\(id\)/);
  assert.doesNotMatch(col, /ON DELETE/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS order_lines_one_line_per_part/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS part_label TEXT;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS part_per_carton INTEGER;/);
  assert.match(sql, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.product_parts for each row/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on public\.product_parts for each statement/);
  assert.doesNotMatch(sql, /drop trigger/i);
  assert.match(src('./db.js'), /await pool\.query\(migration\('20260929120000_carton_parts\.sql'\)\);/);
});

const helpers = src('./helpers.js');

test('the reverse block covers a finished part and the pasting card', () => {
  assert.match(splitGangReverseBlock({ jc_number: 'CI-JC-1', status: 'split', part_of_line_id: 950 }),
    /CI-JC-1 is a finished part/);
  assert.match(splitGangReverseBlock({ jc_number: 'CI-JC-2', status: 'in_progress', is_assembly: true }),
    /pastes parts made on other job cards/);
  // the gang wording is untouched
  assert.match(splitGangReverseBlock({ jc_number: 'CI-JC-3', status: 'split' }), /was split into one card per job/);
});

test('cardForLine carries part_of_line_id; part cards take the part route; a carton never gets a plain card', () => {
  assert.match(helpers, /jol\.part_of_line_id/);
  assert.match(helpers, /line\.part_of_line_id \? partStages\(routingFor\(product\)\) : routingFor\(product\)/);
  assert.match(helpers, /is made in parts — push its parts/);
});

test('rollbackLine: a part never moves alone; a carton takes each part through rollbackLine first', () => {
  assert.match(helpers, /scopeLineIds = null, viaCarton = false \}/);
  assert.match(helpers, /if \(peek\?\.part_of_line_id && !viaCarton\)/);
  assert.match(helpers, /const out = await rollbackLine\(\{ lineId: peek\.part_of_line_id, mode, note: /);
  assert.match(helpers, /Rolling back a part rolls back its whole carton — /);
  // a carton is locked NO KEY UPDATE — its parts' foreign keys share-lock it
  assert.match(helpers, /line: peek\?\.has_parts \? 'NO KEY UPDATE' : 'UPDATE'/);
  assert.match(helpers, /for \(const part of \[\.\.\.parts\]\.sort\(\(a, b\) => a\.id - b\.id\)\) \{[\s\S]{0,80}await rollbackLine\(\{[^}]*viaCarton: true \}, qc, oc, user\);[\s\S]{0,400}\$\{part\.label\}: \$\{b\}/);
  assert.match(helpers, /if \(mode === 'rollback' && parts\.length\)/);
});

test('carton-parts-db holds the three DB doors, removes through rollbackLine, never credits FG', () => {
  const db = src('./carton-parts-db.js');
  for (const fn of ['syncPartLines', 'closePartCard', 'maybeCreateAssemblyCard'])
    assert.match(db, new RegExp(`export async function ${fn}\\(`));
  assert.doesNotMatch(db, /fgReceipt/);
  assert.doesNotMatch(db, /DELETE FROM order_lines/);
  // rollbackLine's lock rule: NO KEY UPDATE once a line has parts, FOR UPDATE before
  assert.match(db, /FROM order_lines WHERE id=\$1 FOR \$\{peek\.has_parts \? 'NO KEY UPDATE' : 'UPDATE'\}/);
  // the pasting join only ever runs on a carton that has parts
  assert.match(db, /FROM order_lines WHERE id=\$1 FOR NO KEY UPDATE', \[outerLineId\]\);\s*\n\s*if \(!outer\) return null;/);
  assert.match(db, /rollbackLine\(\{ lineId: rm\.id, mode: 'delete'[^}]*viaCarton: true \}/);
  assert.match(db, /rollbackLine\(\{ lineId: outer\.id, mode: 'rollback'/);
  assert.match(db, /sheets_required=NULL, parent_sheets_required=NULL, wastage_sheets=NULL WHERE id=\$1/);
  assert.match(db, /status='split'/);
  assert.match(db, /is_assembly\)\s*\n?\s*VALUES/);
  // the pasting card is decided by the carton's own part lines, never the live master
  assert.match(db, /FROM order_lines pl\s*\n\s*JOIN products p ON p\.id = pl\.product_id\s*\n\s*LEFT JOIN product_parts pp/);
  // an ordinary line leaves after one unlocked look
  assert.match(db, /if \(!peek \|\| peek\.part_of_line_id \|\| \(!peek\.has_parts && !peek\.listed\)\) return out;/);
  // FG reserved or a shipped balance also converts through rollbackLine
  assert.match(db, /\+outer\.fg_consumed_qty > 0 \|\| \+outer\.dispatched_qty > 0/);
  assert.match(db, /SAVEPOINT carton_parts_convert/);
  // the LIST changes all-or-nothing per carton line — never half an old list and half a new one
  assert.match(db, /SAVEPOINT carton_parts_list/);
  // a part line remembers what it is (and takes its carton's P1 star); the pasting join reads the line first
  assert.match(db, /line_remark, part_of_line_id, part_label, part_per_carton, is_p1\)/);
  assert.match(db, /outer\.line_remark \?\? null, outer\.id, ins\.label, ins\.per_carton, outer\.is_p1 \? 1 : 0\]\);/);
  assert.match(db, /COALESCE\(pl\.part_per_carton, pp\.per_carton, 1\) AS per_carton/);
  assert.match(db, /The parts list stays as it was on this order — /);
  // pasting card: the order and the product before the carton
  assert.match(db, /FOR KEY SHARE', \[ref\.order_id\]\);\s*\n\s*await oc\('SELECT id FROM products WHERE id=\$1 FOR KEY SHARE', \[ref\.product_id\]\);\s*\n\s*const outer = await oc\('SELECT \* FROM order_lines WHERE id=\$1 FOR NO KEY UPDATE'/);
  assert.doesNotMatch(db, /FROM product_parts pp\s*\n\s*LEFT JOIN order_lines/);
  // the sync locks the carton's part lines (id order) and decides AGAIN under
  // the lock — but only when it is about to write a part or change the list:
  // an order edit holds its order FOR UPDATE through the sync (lock-order (vii))
  const sync = db.slice(db.indexOf('export async function syncPartLines('), db.indexOf('export async function closePartCard('));
  // Only the parts still in planning are locked (the ones that can go under way
  // beneath the sync); a part already past planning keeps its first reading.
  assert.match(sync, /let plan = partLineSyncPlan\(\{ outer, parts, existing \}\);[\s\S]{0,2600}\n\s*const inPlanning = existing\.filter\(p => EDITABLE_PART\.includes\(p\.status\)\)\.map\(p => p\.id\);\s*\n\s*if \(inPlanning\.length && \(plan\.update\.length \|\| plan\.insert\.length \|\| plan\.remove\.length\)\) \{\s*\n\s*await qc\('SELECT id FROM order_lines WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR NO KEY UPDATE', \[inPlanning\]\);[\s\S]{0,300}?existing = \(await partLinesOf\(outer\.id, qc\)\)\.map\(p => \(locked\.has\(p\.id\) \? p : \(first\.get\(p\.id\) \?\? p\)\)\);\s*\n\s*plan = partLineSyncPlan\(\{ outer, parts, existing \}\);\s*\n\s*\}/);
  assert.equal((sync.match(/ORDER BY id FOR NO KEY UPDATE', \[inPlanning\]/g) || []).length, 1, 'the part lock is taken in one place, the conditional one, on the parts still in planning');
  assert.doesNotMatch(sync, /part_of_line_id=\$1 ORDER BY id FOR NO KEY UPDATE/, 'never every part of the carton — that waits on parts past planning (lock-order (viii))');
  // a part a record still points at (a shade card: 23503 on its DELETE) is
  // contained like a blocker — the list stays, with a warning — and no other code is
  assert.match(sync, /if \(e\.code === '23503'\) \{\s*\n\s*const refused = new Error\(partStillReferenced\(label, e\.table\)\);\s*\n\s*refused\.status = 409;\s*\n\s*refused\.blockers = \[refused\.message\];\s*\n\s*throw refused;\s*\n\s*\}\s*\n\s*throw e;/);
  assert.match(sync, /\} catch \(e\) \{\s*\n\s*if \(!e\.blockers\) throw e;\s*\n\s*await qc\('ROLLBACK TO SAVEPOINT carton_parts_list'\);/);
  // the die-cut operator's refusal is one sentence naming the carton
  assert.match(db, /e\.message = pastingCantStart\(\{ code: master\.code, po: po\?\.po_number \?\? outer\.order_id, status: outer\.status \}\);/);
});

test('production.js: parts join at die cut, the pasting card never draws board', () => {
  const prod = src('./routes/production.js');
  assert.match(prod, /import \{ closePartCard, maybeCreateAssemblyCard \} from '\.\.\/carton-parts-db\.js'/);
  // the join branch sits between the gang split and the ordinary close
  assert.match(prod, /splitGangParentJob\(jc\.id[\s\S]{0,400}shouldJoinAtDieCut\([\s\S]{0,400}closePartCard\(jc, qty_out[\s\S]{0,200}maybeCreateAssemblyCard\(partOf[\s\S]{0,200}else if \(st\.seq === last\.mx\)/);
  assert.match(prod, /if \(!prev && \(jc\.parent_job_card_id \|\| jc\.is_assembly\)\)/);
  assert.match(prod, /if \(jc\.parent_job_card_id \|\| jc\.is_assembly \|\| \(!jc\.order_line_id && !jc\.gang_run_id\)\) return null;/);
  assert.match(prod, /await attachCartonParts\(jc\)/);
  assert.match(prod, /NOT jc\.is_assembly AND/);
  assert.match(src('./routes/floor.js'), /NOT jc\.is_assembly AND/);
  // the printed bands read the order's own part lines, never an inner join on the master
  assert.match(prod, /FROM order_lines x WHERE x\.part_of_line_id = pl\.part_of_line_id\) AS of_parts/);
  assert.doesNotMatch(prod, /\n\s*JOIN product_parts pp/);
  // (i) the older routes know the pasting card and the part cards
  assert.match(prod, /CASE WHEN jc\.is_assembly THEN 0\s*\n\s*WHEN bmp\.n > 0 THEN bmp\.short::int ELSE GREATEST\(0, jc\.sheets_issued - stk\.avail\)::int END AS board_short_sheets/);
  // amend: a carton's quantity changes only with the carton; a pasting card never auto-follows board sheets
  assert.match(prod, /if \(jc\.is_assembly \|\| partOf\) \{\s*throw Object\.assign\(new Error\([\s\S]{0,200}change the carton in Orders → Edit'\), \{ status: 409 \}\);/);
  assert.match(prod, /derived && cuttingPending && !jc\.gang_run_id && !jc\.is_assembly \? derived\.parentSheets : undefined/);
  // adjust: the finished-part refusal lives in stageImpact, so the preview and the POST agree
  assert.match(prod, /async function stageImpact[\s\S]{0,1500}if \(st\.part_of_line_id && st\.jc_status === 'split'\) \{\s*out\.blocked = splitGangReverseBlock\(/);
  assert.doesNotMatch(prod, /SELECT jc\.jc_number, jc\.status, jol\.part_of_line_id/);
  // live register and plate picker: a finished part card is history, a split gang parent is not
  assert.match(prod, /const LIVE_JOB_CARD = `jc\.status <> 'closed' AND \(jc\.gang_run_id IS NOT NULL OR jc\.status IN \('open', 'in_progress'\)\)`;/);
  assert.match(prod, /\$\{JC_VIEW\} WHERE \$\{LIVE_JOB_CARD\} ORDER BY/);
  assert.match(prod, /WHERE NOT \(\$\{LIVE_JOB_CARD\}\)`/);
  assert.match(prod, /WHERE \$\{LIVE_JOB_CARD\}\s*\n\s*ORDER BY jc\.id DESC`;/);
  // the part_of_line_id lookup runs only on a route's last die-cut stage
  assert.match(prod, /const partOf = jc\.order_line_id && st\.seq === last\.mx && st\.stage === 'die_cutting'/);
  // pull-back names a pasting card for what it is
  assert.match(prod, /plan\.st\.is_assembly\s*\n?\s*\? pastingCardPullBackRefusal\(plan\.st\.jc_number\)/);
  // the carton's artwork locks with its parts, in the same write that zeroes its board
  assert.match(src('./carton-parts-db.js'), /UPDATE order_lines SET sheets_required=0, parent_sheets_required=0, wastage_sheets=0,\s*artwork_customer_ok=1, artwork_qa_ok=1, artwork_locked=1 WHERE id=\$1`, \[outer\.id\]\);/);
  // send back / pull back treat a pasting card like the split child it mirrors
  assert.match(helpers, /jc\.order_line_id, jc\.parent_job_card_id, jc\.is_assembly, pj\.jc_number AS parent_jc_number`/);
  assert.match(helpers, /const child = isSplitChild\(m\) \|\| m\.is_assembly;/);
  assert.match(helpers, /const isFirstStage = !results\[0\]\.prev && !isSplitChild\(st\) && !st\.is_assembly;/);
  assert.match(helpers, /if \(child\?\.is_assembly\) \{\s*throw Object\.assign\(new Error\(pastingCardPullBackRefusal\(child\.jc_number\)\), \{ status: 409 \}\);/);
  // the operator reads what a part's last stage does
  assert.match(prod, /^\s+ol\.part_of_line_id,$/m);
  const page = src('../../client/src/pages/Production.jsx');
  assert.match(page, /Final stage for this part — its pieces go to the carton's pasting card/);
  assert.match(page, /Part die-cut — pieces handed to the carton's pasting card/);
});

test('parts route is mounted, validates through partsSetError and re-syncs open lines', () => {
  const route = src('./routes/product-parts.js');
  assert.match(src('./app.js'), /app\.use\('\/api', productParts\)/);
  assert.match(route, /r\.get\('\/products\/:id\/parts'/);
  assert.match(route, /r\.put\('\/products\/:id\/parts', canEdit/);
  assert.match(route, /partsSetError\(/);
  assert.match(route, /pg_advisory_xact_lock\(hashtext\('product_parts'\)\)/);
  // KEY SHARE, never stronger: plan-save, artwork approval and the gang master
  // write lock a line and then update the product row (40P01 reproduced)
  assert.match(route, /FROM products WHERE id=\$1 FOR KEY SHARE/);
  assert.doesNotMatch(route, /FROM products WHERE[^'`]*FOR (NO KEY )?UPDATE/);
  assert.match(route, /syncPartLines\(l\.id, qc, oc, req\.user\.name\)/);
  // each line's ORDER directly before the line — an order edit takes them in that order
  assert.match(route, /ORDER BY ol\.order_id, ol\.id/);
  assert.match(route, /await oc\('SELECT id FROM orders WHERE id=\$1 FOR KEY SHARE', \[l\.order_id\]\);\s*\n\s*const s = await syncPartLines\(l\.id, qc, oc, req\.user\.name\);/);
  // …and names each line it leaves as one carton (C2): past planning, with no
  // parts of its own — on a real save only, never on a clear. Warned, never refused.
  assert.match(route, /if \(parts\.length\) \{[\s\S]{0,600}ol\.status IN \('ready','in_production'\)\s*AND NOT EXISTS \(SELECT 1 FROM order_lines x WHERE x\.part_of_line_id = ol\.id\)[\s\S]{0,400}warnings\.push\(`PO \$\{l\.po_number\} \(\$\{which\(l\)\}\): \$\{lineSays\(l\.status\)\} — it runs as one carton this time`\);/);
  assert.match(src('./routes/masters.js'), /EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.part_product_id = p\.id\) AS is_part/);
});

test('C1 at the customer-move doors: a carton in parts, or a part, never changes customer', () => {
  const m = src('./routes/masters.js');
  // read under the product row lock, taken after the series lock — the order a move writes in
  assert.match(m, /async function partsMoveBlock\(productId, qc, oc\) \{\s*const p = await oc\('SELECT code FROM products WHERE id=\$1 FOR UPDATE', \[productId\]\);/);
  assert.match(m, /is made in parts — clear its parts list first/);
  assert.match(m, /is a part of \$\{[^}]+\} — take it off /);
  // PUT /products/:id changing the customer
  assert.match(m, /req\.body\.code = await nextProductCode\(\+req\.body\.customer_id, qc, oc\);[\s\S]{0,200}?const inParts = await partsMoveBlock\(req\.params\.id, qc, oc\);\s*\n\s*if \(inParts\) throw Object\.assign\(new Error\(inParts\), \{ status: 409 \}\);/);
  // POST /products/:id/migrate-customer (the PO import's "Move & use" calls it)
  assert.match(m, /const code = await nextProductCode\(target, qc, oc\);\s*\n\s*const inParts = await partsMoveBlock\(req\.params\.id, qc, oc\);\s*\n\s*if \(inParts\) throw Object\.assign\(new Error\(inParts\), \{ status: 409 \}\);/);
});

test('every door that makes, edits, cancels or deletes a carton line handles its parts', () => {
  const orders = src('./routes/orders.js');
  const dispatch = src('./routes/dispatch.js');
  assert.match(orders, /import \{ syncPartLines \} from '\.\.\/carton-parts-db\.js'/);
  assert.match(orders, /INSERT INTO order_lines \(order_id, product_id, qty, rate, gst_pct, tolerance_pct, line_remark\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7\) RETURNING id',\s*\n\s*\[o\.id/);
  // POST syncs each line it makes; PUT syncs every kept line after the removals
  assert.match(orders, /await syncPartLines\(made\.id, qc, oc, req\.user\.name\);/);
  assert.match(orders, /for \(const id of keepIds\) \{\s*const s = await syncPartLines\(id, qc, oc, req\.user\.name\);/);
  assert.match(orders, /SELECT \* FROM order_lines WHERE order_id=\$1 AND part_of_line_id IS NULL ORDER BY id/);
  assert.match(orders, /rollbackLine\(\{ lineId: line\.id, mode: 'delete'/);                        // edit removes a carton
  assert.match(orders, /\+product\.id !== \+current\.product_id && \(await partLinesOf\(current\.id, qc\)\)\.length/); // a carton never changes product
  assert.match(orders, /const partBlock = line && partsChangeBlock\(line, partLines\);/);                 // a part never cancels alone
  assert.match(orders, /for \(const p of partLines\) await setLineStatus\(p\.id, 'cancelled'/);          // cancel a carton
  assert.match(orders, /for \(const l of lines\.filter\(x => !x\.part_of_line_id\)\)/);                   // delete an order
  assert.match(orders, /with \$\{lines\.filter\(l => !l\.part_of_line_id\)\.length\} item\(s\)/);          // …and its preview counts cartons
  assert.match(dispatch, /syncPartLines\(newLine\.id, qc, oc, user\)/);
  assert.match(src('../../client/src/pages/Orders.jsx'), /o\.lines\.filter\(l => !l\.part_of_line_id\)\.map\(/);
  // (a2) a new line waits for a parts save in flight: the shared lock is the
  // FIRST statement of each transaction — taken after a row lock it deadlocks
  // against the save, which locks each order after this lock.
  const LOCK = "pg_advisory_xact_lock_shared(hashtext('product_parts'))";
  // 2 for order entry (POST, PUT) + 3 single-line Planning doors (Task 8:
  // plan, plan/discard, raise-pr — each pinned lock-first below). AT LEAST:
  // a new door that takes the same guard must never fail this pin.
  assert.ok(orders.split(LOCK).length - 1 >= 5, 'POST and PUT /orders, plan, plan/discard, raise-pr');
  const lockedFirst = (s, anchor, firstStatement) => {
    const body = s.slice(s.indexOf(anchor));
    const at = body.indexOf(LOCK);
    return at > 0 && at < body.indexOf(firstStatement);
  };
  assert.ok(lockedFirst(orders, "r.post('/orders', canPlan", 'INSERT INTO orders'), 'POST /orders');
  assert.ok(lockedFirst(orders, "r.put('/orders/:id', canPlan", 'FOR UPDATE'), 'PUT /orders/:id');
  assert.ok(lockedFirst(dispatch, 'export async function resolveShortage(', 'FOR UPDATE OF ol'), 'shortage re-raise');
});

test('no order door offers a part; the PO import names a part row and warns on a doubled carton', () => {
  // GET /products (the order form's product list) flags a part and a carton made
  // in parts — EXISTS columns in the SELECT list, which add or drop no row
  const list = src('./routes/masters.js').split("if (table === 'products') {")[1].split('} else if')[0];
  assert.match(list, /AS effective_gst,\s*EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.part_product_id = p\.id\) AS is_part,\s*EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.outer_product_id = p\.id\) AS has_parts\s*FROM products p JOIN customers c/);
  const page = src('../../client/src/pages/Orders.jsx');
  assert.match(page, /const custProducts = products\.filter\(p => String\(p\.customer_id\) === String\(form\.customer_id\) && p\.active && !p\.is_part\);/);
  // the edit keeps a line's own product showing, even a part booked before its carton was split
  assert.match(page, /\{editProducts\.filter\(p => !p\.is_part \|\| String\(p\.id\) === String\(l\.product_id\)\)\.map\(p => <option/);
  // the Import PO wizard neither offers a part nor keeps a match onto one
  const wizard = src('../../client/src/components/ImportPOWizard.jsx');
  assert.match(wizard, /const custProducts = allProducts\.filter\(p => String\(p\.customer_id\) === String\(form\?\.customer_id\) && p\.active && !p\.is_part\);/);
  assert.match(wizard, /const best = orderable\(l\.match\?\.best\) \? l\.match\.best : null;/);
  // …shows the matcher's part note, and warns (never refuses) when a carton made in parts is on several rows
  assert.match(wizard, /part_note: l\.match\?\.part_note \|\| null/);
  assert.match(wizard, /\{l\.part_note && \(/);
  assert.match(wizard, /\{prod\.code\} is made in parts and is on \{dupRows\} rows of this PO — order it once unless the customer really ordered it twice/);
  assert.match(wizard, /<Button onClick=\{createOrder\} disabled=\{!ready \|\| busy\}>/);
  // …and a row that names a part teaches no master: no alias, no item/artwork code onto the carton
  assert.match(wizard, /const teach = kept\.filter\(l => !l\.part_note\);/);
  // The server's PO matcher recognises a part instead of offering it: parts stay in the
  // customer's own candidates (so a part row is known for what it is), out of the sister list
  const imp = src('./routes/import.js');
  const own = imp.slice(imp.indexOf('async function matchAll('), imp.indexOf('async function attachForeignMatches('));
  assert.match(own, /WHERE p\.customer_id=\$1 AND p\.active=1\s*\n\s*ORDER BY EXISTS/);   // no exclusion: parts stay candidates
  assert.match(own, /status: cartons\.length \? 'suggested' : 'none', best: null,/);
  assert.match(own, / — a carton made in parts is ordered once, as the carton`/);
  assert.match(imp, /WHERE p\.customer_id <> \$1 AND p\.active=1\s+AND NOT EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.part_product_id = p\.id\)/);
  // an edit's part-line warnings name their carton
  assert.match(src('./routes/orders.js'), /warnings\.push\(\.\.\.s\.warnings\.map\(w => `\$\{codeOf\.get\(id\)\}: \$\{w\}`\)\);/);
});

test('Task 7 review fixes (h): rate, audit, doubled cartons, cancel lock, stale tabs, lone parts, import edges, named messages', () => {
  const orders = src('./routes/orders.js');
  const wizard = src('../../client/src/components/ImportPOWizard.jsx');
  const page = src('../../client/src/pages/Orders.jsx');
  const imp = src('./routes/import.js');
  // 1. a part row never seeds the part's PDF price: picking its carton books the carton's master rate, said read-only
  assert.match(wizard, /rate: l\.match\?\.part_note \? '' : \(l\.rate \?\? best\?\.rate \?\? ''\),/);
  assert.match(wizard, /rate: carton \? \(p\?\.rate \?\? ''\) : \(cur\.pdf_rate \?\? p\?\.rate \?\? ''\),/);
  assert.match(wizard, /PDF ₹\{l\.pdf_rate\} is \{l\.part_label \|\| 'the part'\}'s price — \{prod\.code\} master ₹\{masterRate\} used/);
  assert.match(imp, /suggestions: cartons\.map\(o => \(\{ \.\.\.enrich\(\{ product_id: o\.outer_id, confidence: hit\.confidence \}\), part_label: o\.label \}\)\),/);
  // 2. a carton removed in an edit is audited like a plain line
  assert.match(orders, /await rollbackLine\(\{ lineId: line\.id, mode: 'delete', note: removedLineDetail\(line, removed\) \}, qc, oc, req\.user\.name\);/);
  // 3 + 6. POST and PUT warn — never refuse — on a doubled carton and on a part ordered alone
  assert.ok((orders.match(/await orderPartsWarnings\((o\.id|orderId), qc\)/g) || []).length === 2, 'POST and PUT');
  assert.match(orders, /\$\{r\.code\} is made in parts and is on \$\{r\.n\} lines of this order — order it once unless the customer really ordered it twice/);
  assert.match(orders, /\$\{r\.code\} is a part of \$\{r\.cartons\} — order the carton/);
  assert.match(page, /\{p\.code\} is made in parts and is on \{n\} lines of this order — order it once unless the customer really ordered it twice/);
  assert.ok((page.match(/doubledCartons\((form|editForm)\.lines, products\)/g) || []).length === 2, 'new-order and edit forms');
  assert.match(page, /if \(!p\?\.has_parts\) continue;/);
  assert.match(page, /for \(const w of created\.warnings \|\| \[\]\) toast\.info\(w\);/);
  // 4. cancel locks the carton's part lines, in id order, before reading their statuses
  const cancel = orders.slice(orders.indexOf("r.post('/order-lines/:id/cancel'"), orders.indexOf("r.post('/order-lines/:id/rollback'"));
  // …and the carton itself NO KEY UPDATE, never FOR UPDATE: a part's second
  // update share-locks its carton, and FOR UPDATE would deadlock against it.
  assert.match(cancel, /const line = await oc\('SELECT \* FROM order_lines WHERE id=\$1 FOR NO KEY UPDATE', \[lineId\]\);/);
  assert.match(cancel, /await qc\('SELECT id FROM order_lines WHERE part_of_line_id=\$1 ORDER BY id FOR NO KEY UPDATE', \[line\.id\]\);\s*\n\s*const partLines = line \? await partLinesOf\(line\.id, qc\) : \[\];/);
  // 5. a stale tab's part lines are skipped, never a 404
  assert.match(orders, /if \(l\.id && ownParts\.has\(\+l\.id\)\) continue;/);
  // 7. import edges
  assert.match(wizard, /part_note: !productId \|\| carton \? cur\.pdf_part_note : null,/);
  assert.match(imp, /WHERE p\.customer_id=\$1 AND p\.active=1\s*\n\s*ORDER BY EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.part_product_id = p\.id\), p\.id`/);
  assert.match(imp, /WHERE p\.customer_id <> \$1 AND p\.active=1\s+AND NOT EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.part_product_id = p\.id\)\s+AND NOT EXISTS \(SELECT 1 FROM product_parts pp WHERE pp\.outer_product_id = p\.id\)/);
  assert.match(wizard, /\{!l\.product_id && !l\.pdf_part_note && \(/);
  assert.match(wizard, /const p = l\.product_id && l\.qty && custProducts\.find\(/);
  // 8. messages name the carton
  assert.match(orders, /if \(e\.blockers\) e\.message = `\$\{removed\?\.code \?\? line\.product_id\}: \$\{e\.message\}`;/);
  assert.match(orders, /is made in parts — it cannot change product in an edit; remove the line and add/);
  assert.ok((orders.match(/const cartonBlock = await cartonCancelBlock\(o\.id, qc\);/g) || []).length === 2, 'Close Order and status → cancelled');
});

// ── Task 8: Planning hides the carton and shows each part on its own board ──

test('planning: carton hidden, parts adjacent, part fields on LINE_VIEW', () => {
  const orders = src('./routes/orders.js');
  // The line's own remembered label / pieces first (C9), the master's for a
  // line that predates that memory.
  assert.match(orders, /COALESCE\(ol\.part_label, pp\.label\) AS part_label/);
  assert.match(orders, /COALESCE\(ol\.part_per_carton, pp\.per_carton\) AS part_per_carton/);
  assert.match(orders, /LEFT JOIN order_lines olo ON olo\.id = ol\.part_of_line_id/);
  // Hidden only while it has no job card of its own: once its pasting card
  // exists it shows (Completed) like any pushed job.
  assert.match(orders, /AND \(NOT EXISTS \(SELECT 1 FROM order_lines xl WHERE xl\.part_of_line_id = ol\.id\)\s*\n\s*OR EXISTS \(SELECT 1 FROM job_cards xj WHERE xj\.order_line_id = ol\.id\)\)\s*\n\s*ORDER BY ol\.order_id DESC, COALESCE\(ol\.part_of_line_id, ol\.id\), ol\.id/);
  // On LINE_VIEW itself: raise-pr answers a carton off line.has_parts, and the
  // chip names the carton by its CODE (SW-715), never its name.
  const viewAt = orders.indexOf('const LINE_VIEW = `');
  const lineView = orders.slice(viewAt, orders.indexOf('`;', viewAt));
  assert.match(lineView, /EXISTS \(SELECT 1 FROM order_lines xl WHERE xl\.part_of_line_id = ol\.id\) AS has_parts,/);
  assert.match(lineView, /po\.code AS outer_code, po\.name AS outer_name,/);
  assert.match(lineView, /LEFT JOIN products po ON po\.id = olo\.product_id/);
});

test('gangs: a part line can never join a gang or a combined run', () => {
  const gangs = src('./routes/gangs.js');
  assert.match(gangs, /ol\.id, ol\.order_id, ol\.qty, ol\.status, ol\.gang_run_id, ol\.part_of_line_id,/);
  // POST /gang-runs, POST /merge-runs, add-lines, and a template's create-run
  assert.equal((gangs.match(/partLineGangBlock\(members\)/g) || []).length, 4);
  assert.match(gangs, /AS has_parts/);
});

test('every Planning / FG door that acts on one line refuses a carton made in parts', () => {
  const orders = src('./routes/orders.js');
  const fg = src('./routes/fg.js');
  assert.match(src('./helpers.js'), /export const hasPartLines = /);
  assert.ok((orders.match(/cartonLineBlock\(\{ hasParts: await hasPartLines\(/g) || []).length >= 3, 'plan, plan/discard, raise-pr');
  assert.ok((fg.match(/cartonLineBlock\(\{ hasParts: await hasPartLines\([^)]*\), isPart: /g) || []).length >= 2, 'consume-fg, fulfil-from-stock refuse a part too');
  // Artwork queue and plan_draft never treat a carton's zeros as a saved plan
  assert.match(orders, /AND NOT EXISTS \(SELECT 1 FROM order_lines xa WHERE xa\.part_of_line_id = ol\.id\)\s*\n\s*ORDER BY ol\.artwork_locked, o\.delivery_date NULLS LAST, ol\.id/);
  // …ANDed onto the WHOLE gate: AND binds tighter than OR, so unwrapped it would
  // guard the pending clause alone and list every planned carton again.
  assert.match(orders, /WHERE \(ol\.status IN \('planned','ready','in_production'\)\s*\n\s*OR \(ol\.status = 'pending'\s*\n\s*AND \(ol\.parent_sheets_required IS NOT NULL OR ol\.artwork_locked = 1\)\)\)\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM order_lines xa/);
  assert.match(orders, /AND NOT EXISTS \(SELECT 1 FROM order_lines xd WHERE xd\.part_of_line_id = ol\.id\)\) AS plan_draft/);
});

// A parts save committing between an unlocked hasPartLines read and the door's
// write would leave a converted carton planned with board figures (C2). So the
// shared lock is each door's FIRST statement — before any row lock, which would
// deadlock against the save (it takes the exclusive lock, then the rows) — and
// the carton guard comes after it and before the door writes anything.
test('the five single-line doors take the shared parts lock first, then refuse a carton', () => {
  const LOCK = "await qc(`SELECT pg_advisory_xact_lock_shared(hashtext('product_parts'))`);";
  const OPEN = 'await tx(async (qc, oc) => {';
  const code = s => s.replace(/^[ \t]*\/\/.*$/gm, '');
  const route = (s, anchor) => {
    const at = s.indexOf(anchor);
    assert.ok(at >= 0, `cannot find ${anchor}`);
    const end = s.indexOf('\nr.', at + 1);
    return code(s.slice(at, end < 0 ? undefined : end));
  };
  const doors = [
    ['./routes/orders.js', "r.post('/order-lines/:id/plan',"],
    ['./routes/orders.js', "r.post('/order-lines/:id/plan/discard',"],
    ['./routes/orders.js', "r.post('/order-lines/:id/raise-pr',"],
    ['./routes/fg.js', "r.post('/order-lines/:id/consume-fg',"],
    ['./routes/fg.js', "r.post('/order-lines/:id/fulfil-from-stock',"],
  ];
  for (const [file, anchor] of doors) {
    const body = route(src(file), anchor);
    assert.ok(body.includes(OPEN), `${anchor}: no transaction`);
    const inTx = body.slice(body.indexOf(OPEN) + OPEN.length);
    assert.ok(inTx.trimStart().startsWith(LOCK), `${anchor}: the shared parts lock is not the transaction's first statement`);
    const guard = inTx.indexOf('cartonLineBlock({ hasParts: await hasPartLines(');
    assert.ok(guard > 0, `${anchor}: no carton guard inside the transaction`);
    const firstWrite = inTx.search(/INSERT INTO|UPDATE order_lines|DELETE FROM|consumeFgLot\(|clearMixPlan\(|audit\(/);
    assert.ok(firstWrite < 0 || guard < firstWrite, `${anchor}: the carton guard comes after a write`);
  }
  // The FG doors refuse a PART as well, off the line row the door already loaded.
  const fg = src('./routes/fg.js');
  assert.equal((fg.match(/isPart: !!line\.part_of_line_id \}\)/g) || []).length, 2);
  // raise-pr answers a carton in its own words before its shortage test — a
  // carton's zeros would otherwise read "No shortage for this line".
  const pr = route(src('./routes/orders.js'), "r.post('/order-lines/:id/raise-pr',");
  assert.ok(pr.indexOf('cartonLineBlock({ hasParts: line.has_parts })') > 0
    && pr.indexOf('cartonLineBlock({ hasParts: line.has_parts })') < pr.indexOf("'No shortage for this line'"));
  // Each door asks the carton question while HOLDING the line, in a fresh
  // statement: an order edit converts a line under the same SHARED parts lock,
  // holding that line FOR UPDATE — a door that only read the line missed it.
  const plan = route(src('./routes/orders.js'), "r.post('/order-lines/:id/plan',");
  assert.ok(plan.indexOf('This line moved to another gang just now') > 0
    && plan.indexOf('This line moved to another gang just now') < plan.indexOf("FOR KEY SHARE', [req.params.id]"), 'plan-save: the run first, then the line');
  assert.match(plan, /await oc\('SELECT id FROM order_lines WHERE id=\$1 FOR KEY SHARE', \[req\.params\.id\]\);\s*\n\s*const cartonBlock = cartonLineBlock\(\{ hasParts: await hasPartLines\(req\.params\.id, oc\) \}\);/);
  const discard = route(src('./routes/orders.js'), "r.post('/order-lines/:id/plan/discard',");
  assert.match(discard, /const line = await oc\('SELECT \* FROM order_lines WHERE id=\$1 FOR UPDATE', \[req\.params\.id\]\);\s*\n\s*if \(!line\)[^\n]*\n\s*const cartonBlock = cartonLineBlock\(\{ hasParts: await hasPartLines\(req\.params\.id, oc\) \}\);/);
  // raise-pr mints: its number lock comes before any row lock (a board move
  // takes CI-PR- and then order lines FOR UPDATE — doc-number-lock-order.test.js)
  assert.match(pr, /const pr_number = await nextNumber\('CI-PR-', 'requisitions', 'pr_number', oc\);\s*\n\s*await oc\('SELECT id FROM order_lines WHERE id=\$1 FOR KEY SHARE', \[line\.id\]\);\s*\n\s*const cartonBlock = cartonLineBlock\(\{ hasParts: await hasPartLines\(line\.id, oc\) \}\);/);
});

test('chip + one carton-wide board verdict', () => {
  assert.equal(partChipText({ part_of_line_id: 950, part_label: 'Part 1', outer_code: 'SW-715' }), 'Part 1 · for SW-715');
  assert.equal(partChipText({ part_of_line_id: null }), null);
  const rows = [
    { id: 1, part_of_line_id: 950, board_state: 'covered' },
    { id: 2, part_of_line_id: 950, board_state: 'short' },
    { id: 3, part_of_line_id: null, board_state: 'short' },
  ];
  assert.deepEqual(cartonBoardSummary(rows).get(950), { covered: 1, total: 2, state: 'short' });
  assert.equal(cartonBoardSummary(rows).has(3), false);
  // A row served without board_state reads its board gate — the SAME fallback
  // Planning's board column uses — so the count and the colour agree.
  const gate = m => (m.readiness?.material ? 'covered' : 'short');
  const stale = [
    { id: 4, part_of_line_id: 951, readiness: { material: false } },
    { id: 5, part_of_line_id: 951, board_state: 'covered' },
    { id: 6, part_of_line_id: 952, readiness: { material: true } },
  ];
  assert.deepEqual(cartonBoardSummary(stale, gate).get(951), { covered: 1, total: 2, state: 'short' });
  assert.deepEqual(cartonBoardSummary(stale, gate).get(952), { covered: 1, total: 1, state: 'covered' });
});

test('Planning: the part chip sits on the plain row, fed by every loaded line', () => {
  const page = src('../../client/src/pages/Planning.jsx');
  assert.match(page, /import PartChip from '\.\.\/components\/PartChip\.jsx';/);
  assert.match(page, /const boardGate = m => \(m\.readiness\?\.material \? 'covered' : 'short'\);[\s\S]{0,1200}const cartonBoards = useMemo\(\(\) => cartonBoardSummary\(lines, boardGate\), \[lines\]\);/);
  assert.match(page, /<PartChip row=\{l\} summary=\{cartonBoards\} \/>\s*\n\s*<FluenceButton productId=\{l\.product_id\} context="planning" className="mt-1" \/>/);
});

test('rollback dialog on a part row: the whole carton goes, and Delete is not offered', () => {
  const wc = src('../../client/src/components/WorkflowControls.jsx');
  assert.match(wc, /rolls back the <b>whole carton<\/b>/);
  assert.match(wc, /Remove the carton in Orders → Edit/);
  // the part row's delete item never opens the delete dialog
  assert.match(wc, /partOf\s*\n\s*\? \{ key: 'delete', label: PART_DELETE_REASON,/);
  // a successful rollback still speaks the server's message (it names the parts)
  assert.match(wc, /toast\.success\(r\.message \|\| 'Done'\);/);
  // a job card carries its carton where attachCartonParts puts it (production.js)
  assert.match(wc, /jobCard\?\.carton_parts\?\.outer_code/);
  assert.doesNotMatch(wc, /jobCard\?\.outer_code/);
  // M14: the inline (button) DangerZone shows the reason — never a Delete — on a part
  assert.match(wc, /\{partOf\s*\n\s*\? <span className="self-center text-\[10px\] text-slate-500">\{PART_DELETE_REASON\}<\/span>\s*\n\s*: <Button size="sm" variant="ghost" title="Delete entirely from all stations"/);
  // M15: open('delete') on a part only says why — no caller reaches the delete dialog
  assert.match(wc, /const open = m => \{\s*\n\s*if \(m === 'delete' && partOf\) \{ partDeleteSaid\(\); return; \}/);
  // M16: the part's wording is chosen BY the part
  assert.match(wc, /: part\s*\n\s*\? <><b>\{label\}<\/b> is one part of \{part\.outerCode \|\| 'its carton'\} — rolling it back rolls back the <b>whole carton<\/b>/);
});

test('Print Planning: a part card rolls back its whole carton and offers no Delete', () => {
  const prod = src('./routes/production.js');
  const at = prod.indexOf("r.get('/print-planning',");
  const sql = prod.slice(at, prod.indexOf("WHERE jc.status IN ('open','in_progress') AND js.status != 'completed'", at));
  assert.match(sql, /ol\.part_of_line_id, pco\.code AS outer_code,/);
  assert.match(sql, /LEFT JOIN order_lines pc ON pc\.id = ol\.part_of_line_id\s*\n\s*LEFT JOIN products pco ON pco\.id = pc\.product_id/);
  const page = src('../../client/src/pages/PrintPlanning.jsx');
  // the card's flat fields, handed to the menu in the shape WorkflowControls reads
  assert.match(page, /const dangerCardOf = card => \(card\.part_of_line_id\s*\n\s*\? \{ \.\.\.card, carton_parts: \{ role: 'part', outer_code: card\.outer_code \} \}\s*\n\s*: card\);/);
  assert.equal((page.match(/<DangerZone jobCard=\{dangerCardOf\(card\)\}/g) || []).length, 3);
  assert.doesNotMatch(page, /<DangerZone jobCard=\{card\}/);
});

// ── Task 8 follow-up: every door and every list that makes or offers a run ──

test('a template run refuses a part or a carton, straight after its members are read', () => {
  const gangs = src('./routes/gangs.js');
  const run = gangs.slice(gangs.indexOf("r.post('/gang-templates/:id/create-run'"));
  assert.match(run, /const members = await qc\(`\$\{MEMBER_VIEW\} WHERE ol\.id = ANY\(\$1\) FOR UPDATE OF ol`, \[lineIds\]\);\s*\n\s*if \(members\.length !== lineIds\.length\)[^\n]*\n(\s*\/\/[^\n]*\n)*\s*await markCartonsNow\(members, qc\);\s*\n\s*const partBlock = partLineGangBlock\(members\);\s*\n\s*if \(partBlock\) throw Object\.assign\(new Error\(partBlock\), \{ status: 409 \}\);/);
});

test('no list that offers jobs for a run shows a part or a carton made in parts', () => {
  const gangs = src('./routes/gangs.js');
  // One spelling, so the three lists cannot drift apart.
  assert.match(gangs, /const NOT_IN_PARTS = `ol\.part_of_line_id IS NULL\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM order_lines xp WHERE xp\.part_of_line_id = ol\.id\)`;/);
  const route = anchor => {
    const at = gangs.indexOf(anchor);
    assert.ok(at >= 0, `cannot find ${anchor}`);
    return gangs.slice(at, gangs.indexOf('\nr.', at + 1));
  };
  for (const anchor of ["r.get('/gang-suggestions'", "r.get('/gang-runs/:id/addable'", "r.get('/gang-templates/:id/candidates'"]) {
    assert.match(route(anchor), /WHERE ol\.status IN \('pending','planned'\) AND ol\.gang_run_id IS NULL AND jc\.id IS NULL\s*\n\s*AND \$\{NOT_IN_PARTS\}/, anchor);
  }
});

test('Planning: merging the Completed half keeps a carton\'s parts at the carton\'s place', () => {
  const L = (id, order_id, status, part_of_line_id = null) => ({ id, order_id, status, part_of_line_id });
  // Order 20: plain #5, carton #7 (hidden) made in parts #9 + #10 after plain #8
  // was booked; Part 2 is already on the floor, so it rides the Completed half.
  const queue = [L(30, 21, 'pending'), L(5, 20, 'pending'), L(9, 20, 'pending', 7), L(8, 20, 'pending')];
  const completed = [L(10, 20, 'in_production', 7), L(4, 20, 'in_production')];
  const merged = mergePlanningScopes(queue, completed).map(l => l.id);
  // The server's ORDER BY ol.order_id DESC, COALESCE(ol.part_of_line_id, ol.id), ol.id
  assert.deepEqual(merged, [30, 4, 5, 9, 10, 8]);
});

// ── Task 8 review fixes (j) ──────────────────────────────────────────────────

test('(j) a carton\'s parts travel between the two halves together, so the To Plan chip counts them all', async () => {
  const L = (id, status, part_of_line_id = null) => ({ id, order_id: 20, status, part_of_line_id, gang_run_id: null });
  // Part 1 (#9) is on the floor, Part 2 (#10) still To Plan, #12 a plain pushed job.
  const rows = [L(9, 'in_production', 7), L(10, 'pending', 7), L(12, 'in_production')];
  const queue = await planningResponse('queue', rows, async rs => rs);
  const done = await planningResponse('completed', rows, async rs => rs);
  assert.deepEqual(queue.lines.map(l => l.id), [9, 10]);
  assert.deepEqual(done.lines.map(l => l.id), [12]);
  const stamped = queue.lines.map(l => ({ ...l, board_state: l.id === 9 ? 'covered' : 'short' }));
  assert.deepEqual(cartonBoardSummary(mergePlanningScopes(stamped, null)).get(7), { covered: 1, total: 2, state: 'short' });
});

test('(j) gang doors: the carton question is asked again once the members are held', () => {
  const gangs = src('./routes/gangs.js');
  assert.match(gangs, /async function markCartonsNow\(members, qc\) \{\s*const cartons = new Set\(\(await qc\(\s*'SELECT DISTINCT part_of_line_id AS id FROM order_lines WHERE part_of_line_id = ANY\(\$1\)',\s*\[members\.map\(m => m\.id\)\]\)\)\.map\(r => r\.id\)\);\s*for \(const m of members\) if \(cartons\.has\(m\.id\)\) m\.has_parts = true;/);
  // POST /gang-runs, POST /merge-runs, add-lines and a template's create-run
  assert.equal((gangs.match(/await markCartonsNow\(members, qc\);\s*\n\s*const partBlock = partLineGangBlock\(members\);/g) || []).length, 4);
});

test('(j) a part\'s quantity follows its carton: read-only in the engine, kept — never refused — by /plan', () => {
  const orders = src('./routes/orders.js');
  const plan = orders.slice(orders.indexOf("r.post('/order-lines/:id/plan',"), orders.indexOf("r.post('/order-lines/:id/plan/discard',"));
  // a figure sent for a part is kept as it was, on the record, and the plan saves
  assert.match(plan, /if \(nq !== line\.qty && line\.part_of_line_id\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*partQtyKept = true;\s*\n\s*await audit\('order_line', line\.id, 'part_qty_kept',/);
  assert.match(plan, /\} else if \(nq !== line\.qty\) \{\s*\n\s*await qc\('UPDATE order_lines SET qty=\$1 WHERE id=\$2', \[nq, line\.id\]\);/);
  assert.doesNotMatch(plan, /quantity follows its carton[^\n]*status: 409/);
  assert.match(plan, /part_qty_kept: partQtyKept \}\);/);
  const page = src('../../client/src/pages/Planning.jsx');
  assert.match(page, /<input type="number" min="1" value=\{form\.qty\} readOnly=\{!!planLine\.part_of_line_id\}/);
  // …and the save's toast says so
  assert.match(page, /const partNote = updated\.part_qty_kept \? " · a part's quantity follows its carton — change the carton in Orders → Edit" : '';/);
  assert.equal((page.match(/\$\{clearedNote\}\$\{partNote\}`/g) || []).length, 2, 'the draft and the lock toast');
});

test('(j) no FG action is offered on a part row, or in its engine', () => {
  assert.match(src('./routes/orders.js'), /fg_available: l\.part_of_line_id \? 0 : fgAvailableFromCtx\(l, ctx\),/);
  assert.match(src('../../client/src/pages/Planning.jsx'), /\{!planLine\.part_of_line_id && ctx\.fg\.verified_available > 0 && ctx\.fg\.balance_to_produce > 0 && \(\(\) => \{/);
});

test('(j) the Product column search finds a part by its carton\'s code', () => {
  const page = src('../../client/src/pages/Planning.jsx');
  const col = page.slice(page.indexOf("{ key: 'product_name', label: 'Product'"), page.indexOf('export: l => l._gang ? l._gang.map(productExport)'));
  assert.match(col, /searchValue: l => \[[\s\S]*\(l\._gang \|\| \[l\]\)\.map\(m => m\.outer_code \|\| ''\)\.join\(' '\),[\s\S]*\]\.join\(' '\)/);
});

test('(j) a deep link naming a carton lands on its first part', () => {
  assert.equal(typeof partsLib.focusLineOf, 'function', 'lib/cartonParts.js focusLineOf');
  const lines = [{ id: 5 }, { id: 9, part_of_line_id: 7 }, { id: 10, part_of_line_id: 7 }];
  assert.equal(partsLib.focusLineOf(lines, 7), 9);
  assert.equal(partsLib.focusLineOf(lines, 5), 5);
  assert.equal(partsLib.focusLineOf(lines, 99), 99, 'nothing to map to yet: unchanged, so the page can still wait for the other half');
  assert.equal(partsLib.focusLineOf(lines, null), null);
  assert.equal(partsLib.focusLineOf([...lines, { id: 7 }], 7), 7, 'a carton on the page (its pasting card exists) is its own row');
  assert.match(src('../../client/src/pages/Planning.jsx'),
    /const focusLineId = focusLineOf\(lines, Number\(focusAr\?\.order_line_id \?\? lineParam\) \|\| null\);/);
});

// The planning ENGINE's own board buttons never call the guarded Planning
// doors: its Raise PR posts /requisitions, its Commit posts /board/commit, and
// Board Commitments re-points a PR with /requisitions/:id/reassign. Each asks
// the carton question while HOLDING the line, in a fresh statement.
test('(j2) the engine\'s board doors refuse a carton made in parts, under the line\'s own lock', () => {
  const route = (s, anchor) => {
    const at = s.indexOf(anchor);
    assert.ok(at >= 0, `cannot find ${anchor}`);
    return s.slice(at, s.indexOf('\nr.', at + 1));
  };
  const proc = src('./routes/procurement.js');
  // POST /requisitions: the number lock first (doc-number-lock-order.test.js), then the line, then the question
  const raise = route(proc, "r.post('/requisitions', canRaisePr,");
  assert.match(raise, /const pr_number = await nextNumber\('CI-PR-', 'requisitions', 'pr_number', oc\);\s*\n(\s*\/\/[^\n]*\n)*\s*if \(req\.body\.order_line_id\) \{\s*\n\s*await oc\('SELECT id FROM order_lines WHERE id=\$1 FOR KEY SHARE', \[req\.body\.order_line_id\]\);\s*\n\s*const cartonBlock = cartonLineBlock\(\{ hasParts: await hasPartLines\(req\.body\.order_line_id, oc\) \}\);\s*\n\s*if \(cartonBlock\) throw Object\.assign\(new Error\(cartonBlock\), \{ status: 409 \}\);/);
  // POST /requisitions/:id/reassign: the target line held, then asked
  const reassign = route(proc, "r.post('/requisitions/:id/reassign',");
  assert.match(reassign, /JOIN products p ON p\.id=ol\.product_id WHERE ol\.id=\$1 FOR KEY SHARE OF ol`, \[orderLineId\]\);\s*\n\s*if \(!line\)[^\n]*\n(\s*\/\/[^\n]*\n)*\s*const cartonBlock = cartonLineBlock\(\{ hasParts: await hasPartLines\(orderLineId, oc\) \}\);\s*\n\s*if \(cartonBlock\) throw Object\.assign\(new Error\(cartonBlock\), \{ status: 409 \}\);/);
  // POST /board/commit: after its own FOR UPDATE on the line
  const commit = route(src('./routes/board.js'), "r.post('/board/commit',");
  assert.match(commit, /await qc\('SELECT id FROM order_lines WHERE id=\$1 FOR UPDATE', \[lineId\]\);\s*\n(\s*\/\/[^\n]*\n)*\s*const cartonBlock = cartonLineBlock\(\{ hasParts: await hasPartLines\(lineId, oc\) \}\);\s*\n\s*if \(cartonBlock\) throw Object\.assign\(new Error\(cartonBlock\), \{ status: 409 \}\);/);
  // A PART stays allowed at all three: its own board is the point.
  for (const body of [raise, reassign, commit]) assert.doesNotMatch(body, /isPart/);
});

// ── Task 9: sales-facing views never count a part ────────────────────────────

test('sales views exclude part lines; status-based completion counts do not; the two non-status ones do', () => {
  const orders = src('./routes/orders.js');
  assert.match(orders, /status<>'cancelled' AND completed_at IS NULL AND part_of_line_id IS NULL/);
  assert.match(orders, /status<>'cancelled' AND dispatched_qty < qty AND part_of_line_id IS NULL/);
  assert.match(orders, /AND ol\.qty > ol\.dispatched_qty AND ol\.completed_at IS NULL\s*\n\s*AND ol\.part_of_line_id IS NULL/);
  assert.match(orders, /FROM order_lines ol WHERE ol\.order_id=o\.id AND ol\.part_of_line_id IS NULL\) AS line_count/);
  assert.match(orders, /WHERE pl\.part_of_line_id = ol\.id\) AS parts,/);
  const dispatch = src('./routes/dispatch.js');
  assert.doesNotMatch(dispatch, /status NOT IN \('dispatched','cancelled'\) AND part_of_line_id/);
  // Status Sheet + WIP match: no part rows; a carton reads printed once every part printed
  assert.equal((orders.match(/WHERE \$\{STATUS_SHEET_SCOPE_SQL\} AND ol\.part_of_line_id IS NULL/g) || []).length, 2);
  assert.match(orders, /A carton made in parts is printed once EVERY part is/);
  assert.match(orders, /WHERE part_of_line_id=\$\$\{fvals\.length\}/);
});

test('Task 9: every orders-list total, the dispatch picks, the sales KPIs, tracking and shade-card work skip a part', () => {
  const orders = src('./routes/orders.js');
  const route = (s, anchor) => {
    const at = s.indexOf(anchor);
    assert.ok(at >= 0, `cannot find ${anchor}`);
    const end = s.indexOf('\nr.', at + 1);
    return s.slice(at, end < 0 ? undefined : end);
  };
  // GET /orders: all four totals count the carton once, never its parts
  const list = route(orders, "r.get('/orders',");
  for (const col of ['value', 'ordered_qty', 'fulfilled_qty'])
    assert.match(list, new RegExp(`ol\\.status!='cancelled' AND ol\\.part_of_line_id IS NULL\\) AS ${col},`), col);
  // the status-based completion counts in orders.js stay as they are
  assert.doesNotMatch(orders, /status NOT IN \('dispatched','cancelled'\) AND part_of_line_id/);
  // printed_derived: the line's own printing OR, for a carton, EVERY part's printing
  const sheet = route(orders, "r.get('/status-sheet',");
  assert.match(sheet, /OR \(EXISTS \(SELECT 1 FROM order_lines pl WHERE pl\.part_of_line_id = ol\.id\)\s*\n\s*AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM order_lines pl WHERE pl\.part_of_line_id = ol\.id\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM job_cards pj JOIN job_stages ps ON ps\.job_card_id = pj\.id\s*\n\s*WHERE pj\.order_line_id = pl\.id AND ps\.stage = 'printing' AND ps\.status = 'completed'\)\)\)\s*\n\s*\) AS printed_derived/);
  // the line edit: EDD and P1 follow onto the carton's parts, only once the carton's own row was found
  const edit = route(orders, "r.patch('/status-sheet/line/:id',");
  assert.ok(edit.indexOf('if (!row) return null;') > 0
    && edit.indexOf('if (!row) return null;') < edit.indexOf('WHERE part_of_line_id=$${fvals.length}'), 'after the row is found');
  assert.match(edit, /if \('delivery_date' in req\.body\) \{ fvals\.push\(req\.body\.delivery_date \|\| null\); follow\.push\(`delivery_date=\$\$\{fvals\.length\}`\); \}/);
  assert.match(edit, /if \('is_p1' in req\.body\) \{ fvals\.push\(req\.body\.is_p1 \? 1 : 0\); follow\.push\(`is_p1=\$\$\{fvals\.length\}`\); \}/);
  // dispatch: the three LISTS a pick reads skip a part; the per-id reads are left alone
  const dispatch = src('./routes/dispatch.js');
  assert.match(dispatch, /WHERE ol\.product_id=\$1 AND ol\.status='produced' AND ol\.part_of_line_id IS NULL\s*\n\s*ORDER BY o\.delivery_date NULLS LAST, ol\.id`;/);
  assert.match(route(dispatch, "r.get('/dispatch/ready',"), /WHERE ol\.status='produced' AND COALESCE\(f\.qty,0\) > 0 AND ol\.part_of_line_id IS NULL/);
  assert.match(route(dispatch, "r.get('/dispatch/shortages',"), /WHERE ol\.status='produced' AND ol\.part_of_line_id IS NULL/);
  // AT LEAST the three named above: a new list that adds the same filter must never fail this pin.
  assert.ok((dispatch.match(/part_of_line_id IS NULL/g) || []).length >= 3, 'the three lists above');
  // dashboard: orders in hand and the sales report
  const dash = src('./routes/dashboard.js');
  assert.match(dash, /FROM order_lines WHERE status NOT IN \('dispatched','cancelled'\) AND part_of_line_id IS NULL`\),/);
  assert.match(route(dash, "r.get('/reports/sales',"), /WHERE ol\.status != 'cancelled' AND ol\.part_of_line_id IS NULL/);
  // tracking: the list shows no part; a part answers for its carton; a carton shows its parts
  const floor = src('./routes/floor.js');
  assert.match(route(floor, "r.get('/track',"), /WHERE ol\.status != 'cancelled' AND ol\.part_of_line_id IS NULL/);
  const one = route(floor, "r.get('/track/:id',");
  assert.match(one, /WHERE ol\.id = \(SELECT COALESCE\(x\.part_of_line_id, x\.id\) FROM order_lines x WHERE x\.id = \$1\)/);
  assert.match(one, /WHERE pl\.part_of_line_id = \$1/);
  assert.match(one, /if \(parts\.length\) \{/);
  assert.match(one, /'Waiting for plan lock'/);
  // shade cards: a finished part card is not live work; a gang parent never joins this lateral
  assert.match(src('./routes/shadecards.js'), /AND wol\.status IN \('pending','planned','ready','in_production'\)\s*\n(\s*--[^\n]*\n)*\s*AND NOT EXISTS \(SELECT 1 FROM job_cards pj WHERE pj\.order_line_id = wol\.id\s*\n\s*AND pj\.status = 'split' AND pj\.gang_run_id IS NULL\)/);
  // the pendency page: one "Parts:" line under a carton's status
  const page = src('../../client/src/pages/Orders.jsx');
  assert.match(page, /\{line\.parts\?\.length > 0 && \(/);
  assert.match(page, /p\.jc_status === 'split' \? 'die-cut ✓'\s*: p\.stage \? p\.stage\.replace\(\/_\/g, ' '\)\s*: String\(p\.status \|\| ''\)\.replace\(\/_\/g, ' '\)/);
  assert.match(page, /Parts: \{partsProgress\(line\.parts\)\}/);
});

// ── Task 9 follow-ups (r) ────────────────────────────────────────────────────

const routeOf = (s, anchor) => {
  const at = s.indexOf(anchor);
  assert.ok(at >= 0, `cannot find ${anchor}`);
  const end = s.indexOf('\nr.', at + 1);
  return s.slice(at, end < 0 ? undefined : end);
};

test('(r1) a carton\'s parts carry their line ids, and the shade card form offers each part as a line', () => {
  const orders = src('./routes/orders.js');
  assert.match(orders, /json_build_object\('line_id', pl\.id, 'product_id', pl\.product_id, 'code', pp2\.code,\s*\n\s*'label', COALESCE\(pl\.part_label, pp\.label, pp2\.name\), 'qty', pl\.qty,/);
  const form = src('../../client/src/pages/shade-cards/ShadeCardForm.jsx');
  // an ordinary line is offered exactly as before…
  assert.match(form, /\{ id: l\.line_id, po_number: l\.po_number, customer_name: l\.customer_name,\s*product_name: l\.product_name, product_code: l\.product_code, qty: l\.qty \},/);
  // …and each part of a carton after it, named by its carton ("SW-715 → Part 1")
  assert.match(form, /\.\.\.\(l\.parts \|\| \[\]\)\.filter\(p => p\.line_id && p\.status !== 'dispatched'\)\.map\(p => \(\{\s*id: p\.line_id, po_number: l\.po_number, customer_name: l\.customer_name,\s*product_name: `\$\{l\.product_code\} → \$\{p\.label\}`, product_code: p\.code, qty: p\.qty,\s*\}\)\),/);
  // the create door reads the line by id — no pendency or status test a part line could fail
  const create = routeOf(src('./routes/shadecards.js'), "r.post('/shade-cards', canManage,");
  assert.doesNotMatch(create, /part_of_line_id|ol\.status|pendency/);
});

test('(r2) the dashboard\'s ready-to-dispatch tile never counts a part', () => {
  assert.match(src('./routes/dashboard.js'), /FROM order_lines ol WHERE ol\.status='produced' AND ol\.part_of_line_id IS NULL`\),/);
});

test('(r3) a carton is on the floor with its production-required qty once EVERY part has a card, until its pasting card', async () => {
  const { pendencyFloor } = await import('./routes/orders.js');
  assert.equal(typeof pendencyFloor, 'function', 'orders.js exports pendencyFloor');
  // an ordinary line: its own card decides, exactly as before
  assert.deepEqual(pendencyFloor({ jc_status: 'open', qty_planned: 900, production_required_qty: 1000, parts: null }), { on_floor: true, wip_qty: 900 });
  assert.deepEqual(pendencyFloor({ jc_status: 'closed', qty_planned: 900, production_required_qty: 100, parts: null }), { on_floor: false, wip_qty: 0 });
  assert.deepEqual(pendencyFloor({ jc_status: null, qty_planned: null, production_required_qty: 1000, parts: null }), { on_floor: false, wip_qty: 0 });
  const parts = (...cards) => cards.map((jc_status, i) => ({ label: `Part ${i + 1}`, status: jc_status ? 'in_production' : 'planned', jc_status }));
  // no part carded, or only some (open or die-cut and split): still to plan — a part still needs planning
  assert.deepEqual(pendencyFloor({ jc_status: null, production_required_qty: 5000, parts: parts(null, null) }), { on_floor: false, wip_qty: 0 });
  assert.deepEqual(pendencyFloor({ jc_status: null, production_required_qty: 5000, parts: parts('open', null) }), { on_floor: false, wip_qty: 0 });
  assert.deepEqual(pendencyFloor({ jc_status: null, production_required_qty: 5000, parts: parts('split', null) }), { on_floor: false, wip_qty: 0 });
  // EVERY part carded — open, or die-cut and split — puts it on the floor with its production-required qty
  assert.deepEqual(pendencyFloor({ jc_status: null, production_required_qty: 5000, parts: parts('open', 'split') }), { on_floor: true, wip_qty: 5000 });
  assert.deepEqual(pendencyFloor({ jc_status: null, production_required_qty: 5000, parts: parts('split', 'split') }), { on_floor: true, wip_qty: 5000 });
  // its pasting card made: that card's own rule again
  assert.deepEqual(pendencyFloor({ jc_status: 'open', qty_planned: 4800, production_required_qty: 5000, parts: parts('split', 'split') }), { on_floor: true, wip_qty: 4800 });
  // stamped on every pendency line, and the server's roll-ups read it
  const pend = routeOf(src('./routes/orders.js'), "r.get('/sales/pendency',");
  assert.match(pend, /for \(const l of rows\) Object\.assign\(l, pendencyFloor\(l\)\);\s*\n\s*const wipOf = l => l\.wip_qty;/);
  // the page's bucket cards and roll-ups read the same stamped answer
  const page = src('../../client/src/pages/Orders.jsx');
  assert.match(page, /on_floor: l => !!l\.on_floor,\s*\n\s*to_plan: l => !l\.on_floor,/);
  assert.match(page, /const wip = \+l\.wip_qty \|\| 0;/);
  assert.doesNotMatch(page, /l\.jc_status && l\.jc_status !== 'closed' \? \+l\.qty_planned/);
});

test('(r4) each part carries its live stage; the chip reads it, a die-cut part still reads die-cut ✓', () => {
  const orders = src('./routes/orders.js');
  assert.match(orders, /'status', pl\.status, 'jc_status', pj\.status,\s*\n\s*'stage', COALESCE\(\s*\(SELECT stage FROM job_stages WHERE job_card_id=pj\.id AND status IN \('in_progress','partially_completed'\) ORDER BY seq LIMIT 1\),\s*\(SELECT stage FROM job_stages WHERE job_card_id=pj\.id AND status='pending' ORDER BY seq LIMIT 1\)\)\)/);
  const page = src('../../client/src/pages/Orders.jsx');
  assert.match(page, /\$\{p\.label\} — \$\{p\.jc_status === 'split' \? 'die-cut ✓'\s*: p\.stage \? p\.stage\.replace\(\/_\/g, ' '\)\s*: String\(p\.status \|\| ''\)\.replace\(\/_\/g, ' '\)\}/);
});

test('(r5) Track: before its pasting card a carton reads its parts — list pill, artwork, tooling, job cards', () => {
  const floor = src('./routes/floor.js');
  // ONE spelling of the carton's status, read by both routes (carton-status.js, pinned in s1)
  assert.match(routeOf(floor, "r.get('/track',"), /SELECT ol\.id, ol\.qty, ol\.dispatched_qty, \$\{CARTON_STATUS_SQL\} AS status,/);
  const one = routeOf(floor, "r.get('/track/:id',");
  assert.match(one, /\$\{CARTON_STATUS_SQL\} AS track_status,/);
  assert.match(one, /res\.json\(\{ line: \{ \.\.\.line, status: line\.track_status \}, job_card: jc, events \}\);/);
  // the three gates read every part while the carton has no card of its own
  assert.match(one, /const partsGate = parts\.length > 0 && !ownJc;/);
  assert.match(one, /if \(partsGate\) \{\s*\n\s*const locked = parts\.filter\(p => p\.artwork_locked\);/);
  assert.match(one, /if \(parts\.length\) \{\s*\n\s*const partTools = await q\(/);
  assert.match(one, /return \{ p, d, ok: toolingGateOk\(d, p\.tooling_ok\) \};/);
  assert.match(one, /\} else if \(partsGate\) \{\s*\n\s*const carded = parts\.filter\(p => p\.jc_number\);/);
});

test('(r6) the carton\'s line edit and its parts\' follow are ONE transaction', () => {
  const edit = routeOf(src('./routes/orders.js'), "r.patch('/status-sheet/line/:id',");
  assert.match(edit, /const out = await tx\(async \(qc, oc\) => \{\s*\n\s*const row = await oc\(`UPDATE order_lines SET \$\{sets\.join\(', '\)\} WHERE id=\$\$\{vals\.length\}/);
  assert.match(edit, /if \(!row\) return null;/);
  assert.match(edit, /await qc\(`UPDATE order_lines SET \$\{follow\.join\(', '\)\} WHERE part_of_line_id=\$\$\{fvals\.length\}`, fvals\);/);
  assert.match(edit, /await audit\('order_line', id, 'status-sheet', JSON\.stringify\(req\.body\), qc, req\.user\?\.name\);/);
  assert.match(edit, /if \(!out\) return res\.status\(404\)\.json\(\{ error: 'line not found' \}\);/);
  // no statement of the edit runs outside the transaction
  assert.doesNotMatch(edit, /await (q|one)\(`UPDATE order_lines/);
  assert.doesNotMatch(edit, /JSON\.stringify\(req\.body\), q,/);
});

// ── Task 9 review fixes (s) ──────────────────────────────────────────────────

test('(s1) ONE carton-aware status, read by Track, the Status Sheet and Sales Pendency', async () => {
  const { CARTON_STATUS_SQL } = await import('./carton-status.js');
  // exactly ol.status for a line with no parts, or once a carton has its own (pasting) card
  assert.match(CARTON_STATUS_SQL, /^CASE\s*\n\s*WHEN EXISTS \(SELECT 1 FROM job_cards xc WHERE xc\.order_line_id = ol\.id\)\s*\n\s*OR NOT EXISTS \(SELECT 1 FROM order_lines xp WHERE xp\.part_of_line_id = ol\.id\) THEN ol\.status\s*\n/);
  // in_production only once EVERY part has a card (a die-cut, split one counts)…
  assert.match(CARTON_STATUS_SQL, /WHEN NOT EXISTS \(SELECT 1 FROM order_lines xp WHERE xp\.part_of_line_id = ol\.id\s*\n\s*AND NOT EXISTS \(SELECT 1 FROM job_cards xj WHERE xj\.order_line_id = xp\.id\)\) THEN 'in_production'/);
  // …else its least-advanced part: pending before planned before ready
  const at = s => CARTON_STATUS_SQL.indexOf(s);
  assert.ok(at("xp.status = 'pending') THEN 'pending'") > at("THEN 'in_production'")
    && at("xp.status = 'planned') THEN 'planned'") > at("xp.status = 'pending') THEN 'pending'")
    && at("xp.status = 'ready') THEN 'ready'") > at("xp.status = 'planned') THEN 'planned'"), 'least-advanced first');
  assert.match(CARTON_STATUS_SQL, /\n\s*ELSE ol\.status\s*\n\s*END$/);
  // Track reads it from the shared module — no second spelling left in floor.js
  const floor = src('./routes/floor.js');
  assert.match(floor, /import \{ CARTON_STATUS_SQL \} from '\.\.\/carton-status\.js';/);
  assert.doesNotMatch(floor, /TRACK_STATUS_SQL|const CARTON_STATUS_SQL/);
  // the Status Sheet's planning status and pendency's status read it too
  const orders = src('./routes/orders.js');
  assert.match(orders, /import \{ CARTON_STATUS_SQL \} from '\.\.\/carton-status\.js';/);
  assert.match(routeOf(orders, "r.get('/status-sheet',"), /\$\{CARTON_STATUS_SQL\} AS status,\s*\n\s*\$\{LINE_STATUS_SQL\} AS line_status,/);
  const pend = routeOf(orders, "r.get('/sales/pendency',");
  assert.match(pend, /\$\{CARTON_STATUS_SQL\} AS status, ol\.gang_run_id, gg\.gang_number, gg\.kind AS run_kind,/);
  // the demand filter still reads the line's OWN status
  assert.match(pend, /WHERE o\.status IN \('pending','hold'\) AND ol\.status NOT IN \('cancelled','dispatched'\)/);
});

test('(s2) Track with the pasting card: tooling still from the parts, the card as cartons to paste, artwork locked with the parts', () => {
  const one = routeOf(src('./routes/floor.js'), "r.get('/track/:id',");
  // tooling follows "has parts", not "no pasting card yet"
  assert.match(one, /if \(parts\.length\) \{\s*\n\s*const partTools = await q\(/);
  // a pasting card issues no sheets: it pastes the pieces of its parts' cards
  assert.match(one, /detail: releaseJc\.is_assembly\s*\n\s*\? `\$\{\(\+releaseJc\.qty_planned \|\| 0\)\.toLocaleString\('en-IN'\)\} cartons to paste · joins \$\{parts\.map\(p => `\$\{p\.label\} \$\{p\.jc_number\}`\)\.join\(' \+ '\)\}`/);
  // the carton's artwork locks with its parts under its own audit action
  assert.match(one, /trail\.filter\(t => t\.action === 'artwork_locked' \|\| t\.action === 'artwork_locked_with_parts'\)\.pop\(\)/);
});

test('(s3) Master 360: a pasted part is 0 pending and not an open line, in the rows and in the position', () => {
  const mh = src('./routes/master-history.js');
  assert.match(mh, /const PASTED_PART = `ol\.part_of_line_id IS NOT NULL AND ol\.status = 'dispatched'`;/);
  assert.match(mh, /CASE WHEN \$\{PASTED_PART\} THEN 0 ELSE GREATEST\(0, ol\.qty - ol\.dispatched_qty - COALESCE\(ol\.fg_consumed_qty,0\)\) END AS to_make_qty,/);
  assert.match(mh, /CASE WHEN \$\{PASTED_PART\} THEN 0 ELSE GREATEST\(0, ol\.qty - ol\.dispatched_qty\) END AS pending_qty,/);
  assert.match(mh, /COALESCE\(SUM\(CASE WHEN \$\{PASTED_PART\} THEN 0 ELSE GREATEST\(0, ol\.qty - ol\.dispatched_qty\) END\),0\)::bigint AS orders_pending,/);
  assert.match(mh, /COUNT\(\*\) FILTER \(WHERE GREATEST\(0, ol\.qty - ol\.dispatched_qty\) > 0 AND NOT \(\$\{PASTED_PART\}\)\)::int AS open_lines/);
});

test('(s4) the WIP import\'s EDD follows onto a carton\'s parts, in its own transaction', () => {
  const apply = routeOf(src('./routes/orders.js'), "r.post('/status-sheet/wip-apply',");
  assert.match(apply, /const out = await tx\(async \(qc\) => \{/);
  assert.match(apply, /if \(!row\[0\]\) continue;\s*\n(\s*\/\/[^\n]*\n)*\s*if \(it\.edd\) await qc\('UPDATE order_lines SET delivery_date=\$1 WHERE part_of_line_id=\$2', \[it\.edd, it\.line_id\]\);/);
});

test('(s6) the pendency CSV carries the carton\'s Parts; the shade card form skips a part already pasted', () => {
  const page = src('../../client/src/pages/Orders.jsx');
  assert.match(page, /const PENDENCY_CSV_HEADER = \[[^\]]*'Status', 'Parts',[^\]]*\];/);
  assert.match(page, /function pendencyCsvRow\(l\) \{[\s\S]*?pendencyStage\(l\)\.label, l\.parts\?\.length \? partsProgress\(l\.parts\) : '',/);
  assert.match(page, /exportCsv\(\s*`sales-pendency-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.csv`,\s*PENDENCY_CSV_HEADER, pdLines\.map\(pendencyCsvRow\),?\s*\)/);
  // the chip and the column are one function
  assert.match(page, /function partsProgress\(parts\) \{/);
  assert.match(page, /Parts: \{partsProgress\(line\.parts\)\}/);
  const form = src('../../client/src/pages/shade-cards/ShadeCardForm.jsx');
  assert.match(form, /\.\.\.\(l\.parts \|\| \[\]\)\.filter\(p => p\.line_id && p\.status !== 'dispatched'\)\.map\(p => \(\{/);
});

// ── Task 10: the printed job card says what it is ────────────────────────────

test('job card sheet renders the parts band', () => {
  const sheet = src('../../client/src/components/JobCardSheet.jsx');
  assert.match(sheet, /import JobCardPartsBand from '\.\/JobCardPartsBand\.jsx'/);
  assert.match(sheet, /<h1[^>]*>\{jc\.jc_number\}<\/h1>\s*\n\s*<JobCardPartsBand jc=\{jc\} \/>/);
});

test('the band names a part card\'s carton and a pasting card\'s parts, and is absent on any other card', () => {
  const band = src('../../client/src/components/JobCardPartsBand.jsx');
  // an ordinary card (no carton_parts from attachCartonParts) prints exactly as before
  assert.match(band, /const cp = jc\?\.carton_parts;\s*\n\s*if \(!cp\) return null;/);
  // a part card reads as a part, a pasting card as a pasting card — never the other way round
  assert.match(band, /\{cp\.role === 'part'\s*\n\s*\? <>\{cp\.label\} of \{cp\.of_parts\} · for <span className="whitespace-nowrap">\{cp\.outer_code\}<\/span> \{cp\.outer_name\} — runs to die cutting; the pieces are pasted into the carton on its pasting card<\/>\s*\n\s*: <>Pasting card — joins \{cp\.parts\.map\(\(p, i\) => \(/);
  // every part card, joined by " + ", each placed whole on a line when it fits ("Part 2"
  // never ends a line without its card); a part longer than the band wraps inside its
  // own box — a long free-text label wraps — but its "(card: pcs)" never breaks, never
  // "CI-" | "JC-0002", and stays with the label's last word
  assert.match(band, /<Fragment key=\{i\}>\s*\n\s*\{i > 0 && ' \+ '\}\s*\n\s*<span className="inline-block max-w-full">\{p\.label\}&nbsp;<span className="whitespace-nowrap">\{`\(\$\{p\.jc_number \|\| 'not yet'\}: \$\{fmt\(p\.qty_produced\)\} pcs\)`\}<\/span><\/span>\s*\n\s*<\/Fragment>/);
  // black on paper — a border and bold type, never colour alone — and nothing overflows
  const root = band.match(/<div data-carton-parts-band=\{cp\.role\}\s*\n\s*className="([^"]+)">/);
  assert.ok(root, 'the band root carries its classes on one className string');
  const cls = root[1].split(/\s+/);
  for (const c of ['border-2', 'font-bold', 'print:border-ink-900', 'print:text-ink-900', '[overflow-wrap:anywhere]']) {
    assert.ok(cls.includes(c), `band class ${c}`);
  }
});

test('the sheet renders the band once, and only a carton card\'s header column changes', () => {
  const sheet = src('../../client/src/components/JobCardSheet.jsx');
  assert.equal((sheet.match(/<JobCardPartsBand\b/g) || []).length, 1, 'the band renders exactly once');
  // beside the band the customer/PO column is capped and never narrower than its
  // PO line, which is kept whole (no "Released 30 Sept | 2026"); a long customer
  // name wraps inside it. Any other card's header keeps its old markup exactly.
  assert.match(sheet, /<div className=\{`jc-head-right \$\{jc\.carton_parts \? 'min-w-min max-w-\[15rem\] ' : ''\}text-right text-xs text-gray-600`\}>/);
  assert.match(sheet, /<div className=\{jc\.carton_parts \? 'whitespace-nowrap' : undefined\}>PO: <b>\{jc\.po_number\}<\/b> · Released \{fmt\.date\(jc\.created_at\)\}<\/div>/);
});

test('both print pages are fed by GET /job-cards/:id, the route that attaches carton_parts', () => {
  // The batch print renders the same sheet from the same singular GET, so the
  // band prints in a batch exactly as on its own. A leaner feed would lose it.
  for (const page of ['JobCardPrint.jsx', 'JobCardBatchPrint.jsx']) {
    const s = src(`../../client/src/pages/${page}`);
    assert.match(s, /api\.get\(`\/job-cards\/\$\{id\}`\)/, page);
    assert.match(s, /<JobCardSheet jc=\{jc\} \/>/, page);
  }
  const detail = routeOf(src('./routes/production.js'), "r.get('/job-cards/:id',");
  assert.match(detail, /await attachCartonParts\(jc\);\s*\n\s*res\.json\(jc\);/);
});

// ── Task 13a: the final review's server fixes ───────────────────────────────

test('13a E: an order edit speaks a carton\'s part-sync warnings only for the lines it made or changed', () => {
  const put = routeOf(src('./routes/orders.js'), "r.put('/orders/:id', canPlan,");
  assert.match(put, /if \(qty !== \+current\.qty \|\| remark !== \(current\.line_remark \?\? null\) \|\| \+product\.id !== \+current\.product_id\) \{\s*\n\s*saidFor\.add\(current\.id\);/);
  assert.match(put, /codeOf\.set\(created\.id, product\.code \|\| product\.id\);\s*\n\s*saidFor\.add\(created\.id\);/);
  assert.match(put, /const s = await syncPartLines\(id, qc, oc, req\.user\.name\);\s*\n\s*if \(saidFor\.has\(id\)\) warnings\.push\(/);
});

test('13a G1: saving a job card answers with its parts band, as the GET does', () => {
  const put = routeOf(src('./routes/production.js'), "r.put('/job-cards/:id',");
  assert.match(put, /await attachBoardMix\(jc\);\s*\n\s*await attachCartonParts\(jc\);\s*\n\s*res\.json\(jc\);/);
});

test('13a I: a carton made in parts reads its Print Status off its parts — a field, never a fake stage', () => {
  const sheet = routeOf(src('./routes/orders.js'), "r.get('/status-sheet',");
  assert.match(sheet, /WHERE pl\.part_of_line_id = ANY\(\$1::int\[\]\)/);
  assert.match(sheet, /if \(printingByCarton\.has\(l\.line_id\)\) l\.print_state = cartonPrintState\(printingByCarton\.get\(l\.line_id\)\);/);
  // a synthesized printing entry in `stages` would count as the carton's whole route (lib/lineStage.js)
  assert.doesNotMatch(sheet, /stages\.push\(/);
  const page = src('../../client/src/pages/StatusSheet.jsx');
  assert.match(page, /const ps = 'print_state' in m \? \(m\.print_state && \{ status: m\.print_state \}\) : \(m\.stages \|\| \[\]\)\.find\(s => s\.stage === 'printing'\);/);
});

test('13a K: sibling parts of one carton never raise the strength mix-up alarm — told apart by product_parts, not names', () => {
  const prod = src('./routes/production.js');
  const fn = prod.slice(prod.indexOf('async function strengthClash('), prod.indexOf('async function assignPressTx('));
  assert.match(fn, /let hits = findClashes\(target, pool\);\s*\n\s*if \(hits\.length\) \{[\s\S]{0,300}FROM product_parts me JOIN product_parts o ON o\.outer_product_id = me\.outer_product_id\s*\n\s*WHERE me\.part_product_id = \$1`, \[target\.product_id\]\)\)[\s\S]{0,80}hits = hits\.filter\(\(h\) => !siblings\.has\(h\.product_id\)\);/);
  // the pure matcher is untouched: it still reads PART 1 / PART 2 as two strengths
  const a = { customer_id: 1, name: 'VOGEAB GM2 OUTER PART 1' };
  assert.equal(clashes(a, { customer_id: 1, name: 'VOGEAB GM2 OUTER PART 2' }), true);
});

// ── Task 13b: the final review's screen and print fixes ─────────────────────

test('13b C: a pasting card prints no board and its cartons to paste; a part card counts pieces; every other card is unchanged', () => {
  const sheet = src('../../client/src/components/JobCardSheet.jsx');
  // What the card is, off JC_VIEW's own columns — GET /job-cards/:id feeds both
  // print pages, and a card with neither prints exactly as before.
  const view = src('./routes/production.js');
  assert.match(view, /const JC_VIEW = `\s*\n\s*SELECT jc\.\*, /);
  assert.match(view, /\n\s*ol\.part_of_line_id,\n/);
  assert.match(sheet, /const pasting = !!jc\.is_assembly;\s*\n\s*const qtyUnit = jc\.part_of_line_id \? 'pcs' : 'cartons';/);
  // The board box: a pasting card says it uses no board — no master board, no
  // packets, no parent or child sheets — and every other card keeps the whole
  // block, opened and closed around it exactly as before. The sentence itself
  // lives in cartonParts.js since Task 15, where the editor reads it too.
  assert.equal(partsLib.PASTING_NO_BOARD_TEXT, "No board — this card pastes the pieces from its parts' job cards");
  assert.match(sheet, /\{pasting \? \(\s*\n\s*<div data-no-board="assembly" className="mb-3 rounded border-2 border-ink-900 px-3 py-2">\s*\n\s*<div className="text-\[9px\] font-bold uppercase tracking-\[0\.18em\] text-gray-500">Board &amp; cutting plan<\/div>\s*\n\s*<div className="mt-1 text-sm font-bold text-ink-900">\{PASTING_NO_BOARD_TEXT\}<\/div>\s*\n\s*<\/div>\s*\n\s*\) : \(\s*\n\s*<div className="mb-3 rounded border-2 border-ink-900 px-3 py-2">\s*\n\s*<div className="jc-caphead flex items-baseline justify-between gap-3">/);
  assert.match(sheet, /actually consumed\.\s*\n\s*<\/div>\s*\n\s*\)\)\}\s*\n\s*<\/div>\s*\n\s*\)\}\s*\n\s*\n\s*<div className="jc-spec grid/);
  assert.equal((sheet.match(/Product master specs <b/g) || []).length, 1, 'the master board line lives only in the ordinary box');
  // The planning rows: pieces on a part card, cartons on any other; a pasting
  // card's cartons to paste are its planned sets, in place of parent sheets.
  assert.match(sheet, /\['Ordered Qty', `\$\{fmt\.num\(jc\.line_qty\)\} \$\{qtyUnit\}`\],/);
  assert.match(sheet, /\['Qty Produced', jc\.qty_produced \? `\$\{fmt\.num\(jc\.qty_produced\)\} \$\{qtyUnit\}` : '—'\],/);
  assert.match(sheet, /pasting \? \['Cartons to Paste', fmt\.num\(jc\.qty_planned\)\] : \['Parent Sheets Issued', fmt\.num\(jc\.sheets_issued\)\],/);
  assert.equal((sheet.match(/'Parent Sheets Issued'/g) || []).length, 1);
  assert.doesNotMatch(sheet, /\} cartons`/, 'no quantity is labelled cartons regardless of the card');
});

test('13b G2: the Import PO wizard speaks the order-save warnings exactly as the New Order form', () => {
  const wizard = src('../../client/src/components/ImportPOWizard.jsx');
  const page = src('../../client/src/pages/Orders.jsx');
  const say = /for \(const w of created\.warnings \|\| \[\]\) toast\.info\(w\);/;
  assert.match(page, say);
  assert.match(wizard, /const created = await api\.post\('\/orders', \{/);
  assert.match(wizard, /toast\.success\('Order created from PDF'\);\s*\n(\s*\/\/[^\n]*\n){1,4}\s*for \(const w of created\.warnings \|\| \[\]\) toast\.info\(w\);\s*\n\s*onCreated\(\);/);
});

test('13b G4: the job card editor offers no AVS switch on a pasting card — it has no printing stage', () => {
  const page = src('../../client/src/pages/Production.jsx');
  assert.match(page, /\{!editing\.parent_job_card_id && !editing\.is_assembly && \(\s*\n\s*<section className="ci-form-panel">\s*\n\s*<div className="ci-form-panel-title"><span>AVS check before printing is completed<\/span>/);
  assert.equal((page.match(/<AvsSwitch /g) || []).length, 1, 'one switch, behind that gate');
});

test('13b H2: the parts editor reads the rows GET /products lists', () => {
  const ed = src('../../client/src/components/ProductMasterEditor.jsx');
  assert.match(ed, /api\.get\('\/products'\),/);
  assert.doesNotMatch(ed, /\/products\/picker/);
});

test('13b J: a pasting card closed at 0 goes through the Job Cards page\'s own per-stage calls', () => {
  // start where pending, then complete at 0 — sorting, then pasting, whatever order the stages arrive in
  const clear = [{ label: 'Machine cleaned', ok: true }];
  const stages = [
    { id: 72, seq: 2, stage: 'pasting', status: 'pending' },
    { id: 71, seq: 1, stage: 'sorting', status: 'pending' },
  ];
  assert.deepEqual(partsLib.closeAtZeroCalls(stages, clear), [
    { url: '/job-stages/71/start', body: { line_clearance: clear } },
    { url: '/job-stages/71/complete', body: { qty_out: 0, qty_scrap: 0 } },
    { url: '/job-stages/72/start', body: { line_clearance: clear } },
    { url: '/job-stages/72/complete', body: { qty_out: 0, qty_scrap: 0 } },
  ]);
  // sorting already started at Sort & Paste — the dead end Task 12 found
  assert.deepEqual(partsLib.closeAtZeroCalls([{ ...stages[1], status: 'in_progress' }, stages[0]], clear).map(c => c.url),
    ['/job-stages/71/complete', '/job-stages/72/start', '/job-stages/72/complete']);
  // half-closed (sorting done) is finished; a closed card asks for nothing
  assert.deepEqual(partsLib.closeAtZeroCalls([{ ...stages[1], status: 'completed' }, { ...stages[0], status: 'in_progress' }], clear)
    .map(c => c.url), ['/job-stages/72/complete']);
  assert.deepEqual(partsLib.closeAtZeroCalls(stages.map(s => ({ ...s, status: 'completed' })), clear), []);
  // …the very endpoints and bodies the Job Cards page sends (Production.jsx doStart / complete)
  const jobs = src('../../client/src/pages/Production.jsx');
  assert.match(jobs, /await api\.post\(`\/job-stages\/\$\{st\.id\}\/start`, \{ line_clearance: lc,/);
  assert.match(jobs, /await api\.post\(`\/job-stages\/\$\{st\.id\}\/complete`, \{\s*\n\s*qty_out: \+form\.qty_out, qty_scrap: \+form\.qty_scrap,/);
  // The words, before and after — never "FG added to stock" over a close that made nothing
  assert.equal(partsLib.nothingToPasteText('CI-JC-0006', 'SW-715'),
    'CI-JC-0006 has 0 cartons to paste. Close it? SW-715 goes to the Shortage tab for Planning to re-raise.');
  assert.equal(partsLib.closedNothingMadeText('CI-JC-0006', 'SW-715'),
    'CI-JC-0006 closed with nothing made — SW-715 is in the Shortage tab');
  // The Job Cards page says it too, for a pasting card closed at 0 only
  assert.match(jobs, /: isLast && jc\.is_assembly && \+form\.qty_out === 0 \? closedNothingMadeText\(jc\.jc_number, jc\.product_code\)\s*\n\s*: isLast \? `\$\{jc\.jc_number\} closed — FG added to stock, ready for dispatch` : `\$\{fmt\.stage\(st\.stage\)\} completed`\);/);
});

test('13b J: Sort & Paste offers "Close — nothing to paste" on a 0-carton pasting card only, and never loosens its own completion', () => {
  const page = src('../../client/src/pages/SortPaste.jsx');
  // asked only for a card planned at 0, answered by the card's own is_assembly
  assert.match(page, /const plannedAtZero = r => r\.qty_planned != null && Number\(r\.qty_planned\) === 0;/);
  assert.match(page, /if \(!plannedAtZero\(r\) \|\| emptyAsked\.current\.has\(id\)\) continue;[\s\S]{0,200}api\.get\(`\/job-cards\/\$\{id\}`\)\s*\n\s*\.then\(jc => \{ if \(jc\.is_assembly\) setEmptyPasting/);
  assert.match(page, /const closesEmpty = r => r\.queue_state !== 'hold' && plannedAtZero\(r\) && emptyPasting\.has\(r\.job_card_id\);/);
  // the one action, first, in each of the three queue layouts (cards, touch table, desktop table)
  assert.equal((page.match(/\{closesEmpty\(r\) \? \(\s*\n\s*<Button [^>]*onClick=\{\(\) => openCloseEmpty\(r\)\}><Check size=\{1[24]\} \/> Close — nothing to paste<\/Button>\s*\n\s*\) : r\.phase === 'paste'/g) || []).length, 3);
  // the close re-reads the card and walks its stages through the per-stage calls — never /sort-paste/:id/complete
  const close = page.slice(page.indexOf('const closeEmpty = async () => {'), page.indexOf('const submit = async () => {'));
  assert.match(close, /const jc = await api\.get\(`\/job-cards\/\$\{row\.job_card_id\}`\);\s*\n\s*if \(!jc\.is_assembly \|\| Number\(jc\.qty_planned\) !== 0\) \{/);
  assert.match(close, /for \(const call of closeAtZeroCalls\(jc\.stages, clearancePayload\(clearance\)\)\) await api\.post\(call\.url, call\.body\);\s*\n\s*toast\.success\(closedNothingMadeText\(row\.jc_number, row\.product_code\)\);/);
  assert.doesNotMatch(close, /sort-paste/);
  // the confirm names the card and the carton; a stage still to start asks for the clearance
  assert.match(page, /\{nothingToPasteText\(closingEmpty\.jc_number, closingEmpty\.product_code\)\}/);
  assert.match(page, /disabled=\{emptyNeedsStart && !allClear\(clearance\)\}/);
  // the Sort & Paste completion keeps both of its refusals
  const prod = src('./routes/production.js');
  assert.match(prod, /if \(input <= 0\) bad\('input must be greater than zero'\);/);
  assert.match(prod, /At least one pasting row is required/);
});

test('13b L: Planning counts a carton made in parts once, in cartons', () => {
  // 5,000 SW-715 in two parts (one piece of each per carton) + a 3,000 inner read 13,000 before
  const rows = [
    { id: 11, part_of_line_id: 10, qty: 5000, part_per_carton: 1 },
    { id: 12, part_of_line_id: 10, qty: 5000, part_per_carton: 1 },
    { id: 20, part_of_line_id: null, qty: 3000 },
  ];
  assert.equal(partsLib.cartonQtyOf(rows), 8000);
  // pieces per carton divide; only one part on view still counts its carton once;
  // a line that remembers no pieces per carton reads 1, as the pasting card does
  assert.equal(partsLib.cartonQtyOf([{ part_of_line_id: 30, qty: 10000, part_per_carton: 2 },
    { part_of_line_id: 30, qty: 5000, part_per_carton: 1 }]), 5000);
  assert.equal(partsLib.cartonQtyOf([{ part_of_line_id: 30, qty: 5000, part_per_carton: 1 }]), 5000);
  assert.equal(partsLib.cartonQtyOf([{ part_of_line_id: 40, qty: 700, part_per_carton: null }]), 700);
  // two cartons made in parts are two cartons; ordinary lines add exactly as before
  assert.equal(partsLib.cartonQtyOf([...rows, { part_of_line_id: 50, qty: 2400, part_per_carton: 2 }]), 9200);
  assert.equal(partsLib.cartonQtyOf([{ qty: 3000 }, { qty: '1200' }, { qty: null }]), 4200);
  assert.equal(partsLib.cartonQtyOf([]), 0);
  // the KPI strip reads it over the same zone rows as before
  const page = src('../../client/src/pages/Planning.jsx');
  assert.match(page, /const kpiPlan = \(\(\) => \{\s*\n\s*const rows = shown;[\s\S]{0,1500}qty: cartonQtyOf\(rows\),/);
  assert.match(page, /value=\{fmt\.num\(Math\.max\(0, kpiPlan\.qty - kpiPlan\.fgCovered\)\)\}/);
});

test('a pasting card waiting at Sort & Paste shows the cartons it will paste, not 0 — a shown figure, never the cap', () => {
  // The queue rows tell receiptFor what Start will stamp, for a first-stage
  // sorting row only (a split gang child or a pasting card)…
  const floor = src('./routes/floor.js');
  const row = floor.slice(floor.indexOf('const rowReceipt = (s, prev) => {'));
  assert.match(row.slice(0, 600), /plannedIn: !prev && s\.stage === 'sorting' \? \(s\.qty_planned \?\? s\.sheets_issued \?\? null\) : null,/);
  // …the same figure the Start route stamps onto qty_in for those two cards…
  assert.match(src('./routes/production.js'),
    /if \(!prev && \(jc\.parent_job_card_id \|\| jc\.is_assembly\)\) \{[\s\S]{0,900}qtyIn = jc\.qty_planned \?\? jc\.sheets_issued;/);
  // …and the receipt a save is capped and closed against is never told.
  const helpers = src('./helpers.js');
  const gather = helpers.slice(helpers.indexOf('export async function stageReceipt('), helpers.indexOf('export async function upstreamAvailable('));
  assert.ok(gather.length > 200);
  assert.doesNotMatch(gather, /plannedIn/);
});

// ── Task 15: a pasting card's printout, editor and list figures say nothing of board, sheets or presses ──
// A carton's pasting card (job_cards.is_assembly) only sorts and pastes: its
// pieces were cut, printed and die-cut on its parts' cards. Every gate below is
// on is_assembly, and each pin holds the other branch to what it was.

// The row labels of one of the sheet's groups, read off its own source, in
// order — both arms of a ternary included.
const sheetLabels = (sheet, from, to) => {
  const a = sheet.indexOf(from);
  const b = sheet.indexOf(to);
  assert.ok(a >= 0 && b > a, `cannot find ${from} … ${to}`);
  return [...sheet.slice(a, b).matchAll(/\['([^'\n]+)', /g)].map(m => m[1]);
};

test('15 A: a pasting card prints no Sheet & Finish, no Printing Specifications and five Planning rows; every other card prints every group and row', () => {
  const sheet = src('../../client/src/components/JobCardSheet.jsx');
  // The rows each group is built from, by the sheet's own labels: nothing was
  // taken out of the sheet itself, so an ordinary card still has them all.
  const planning = sheetLabels(sheet, '  const planning = [', '  const artwork = [');
  assert.deepEqual(planning, ['Ordered Qty', 'Planned Qty', 'Qty Produced', 'Cartons to Paste', 'Parent Sheets Issued',
    'Sheets Required', 'Press', 'Planned Date', 'Delivery']);
  assert.deepEqual(sheetLabels(sheet, '  const sheet = [', '  const planning = ['),
    ['Coating / Lamination', 'Print Sheet', 'Ups / Print Sheet', 'Print Sheets / Parent']);
  assert.match(sheet, /\.\.\.\(jc\.dripoff_plate \|\| hasDripOffCoating\(jc\) \? \[\[\s*\n\s*'DRIP OFF Plate',/);
  // Every group goes through ONE rule, in reading order, and the grid draws
  // what comes back — no group is drawn past it.
  assert.match(sheet, /import \{ PASTING_NO_BOARD_TEXT, printedSpecGroups \} from '\.\.\/lib\/cartonParts\.js';/);
  assert.match(sheet, /const specGroups = printedSpecGroups\(jc, \[\s*\n\s*\{ title: 'Sheet & Finish', rows: sheet \},\s*\n\s*\{ title: 'Product', rows: product \},\s*\n\s*\.\.\.\(printing\.length > 0 \? \[\{ title: 'Printing Specifications', rows: printing \}\] : \[\]\),\s*\n\s*\{ title: 'Artwork', rows: artwork \},\s*\n\s*\{ title: 'Planning', rows: planning \},\s*\n\s*\]\);/);
  assert.match(sheet, /<div className="jc-spec grid grid-cols-4 gap-x-6 gap-y-2\.5 text-sm">\s*\n\s*\{specGroups\.map\(g => <Group key=\{g\.title\} title=\{g\.title\} rows=\{g\.rows\} \/>\)\}\s*\n\s*<\/div>/);
  assert.equal((sheet.match(/<Group\b/g) || []).length, 1, 'no group is drawn outside the rule');
  // What the rule drops is named by titles and labels the sheet really has.
  assert.deepEqual(partsLib.PASTING_CARD_OMITS,
    { groups: ['Sheet & Finish', 'Printing Specifications'], planning: ['Planned Qty', 'Sheets Required', 'Press'] });
  for (const t of partsLib.PASTING_CARD_OMITS.groups) assert.ok(sheet.includes(`{ title: '${t}', rows: `), `the sheet has a "${t}" group`);
  for (const l of partsLib.PASTING_CARD_OMITS.planning) assert.ok(planning.includes(l), `the sheet's Planning has a "${l}" row`);

  // The groups as the sheet builds them: an ordinary card's Planning carries
  // parent sheets, a pasting card's its cartons to paste (13b C).
  const card = pasting => [
    { title: 'Sheet & Finish', rows: [['Coating / Lamination', 'None'], ['Print Sheet', '11.5×18"'], ['Ups / Print Sheet', 2], ['Print Sheets / Parent', '1:1']] },
    { title: 'Product', rows: [['Product Code', 'SW-715'], ['Carton Size', '—'], ['Pasting', '—'], ['Die', '—']] },
    { title: 'Printing Specifications', rows: [['Colour Type', 'CMYK'], ['Total Colours', 4]] },
    { title: 'Artwork', rows: [['Customer Approval', 'Approved'], ['Lock', 'Locked']] },
    { title: 'Planning', rows: planning.filter(l => l !== (pasting ? 'Parent Sheets Issued' : 'Cartons to Paste')).map(l => [l, `<${l}>`]) },
  ];
  const titles = gs => gs.map(g => g.title);
  const labels = (gs, title) => gs.find(g => g.title === title).rows.map(r => r[0]);

  // A pasting card: Product, Artwork, and Planning without Planned Qty (the
  // same number as Cartons to Paste), Sheets Required and Press.
  const given = card(true);
  const printed = partsLib.printedSpecGroups({ is_assembly: true, order_line_id: 1 }, given);
  assert.deepEqual(titles(printed), ['Product', 'Artwork', 'Planning']);
  assert.deepEqual(labels(printed, 'Planning'), ['Ordered Qty', 'Qty Produced', 'Cartons to Paste', 'Planned Date', 'Delivery']);
  // Product and Artwork are the very groups it gave, a kept row keeps its
  // value, and the list it gave is left as it was.
  assert.equal(printed[0], given[1]);
  assert.equal(printed[1], given[3]);
  assert.deepEqual(printed[2].rows[2], ['Cartons to Paste', '<Cartons to Paste>']);
  assert.deepEqual(given, card(true));
  // With no printing colours recorded the sheet builds no such group at all — the same three print.
  assert.deepEqual(titles(partsLib.printedSpecGroups({ is_assembly: true },
    card(true).filter(g => g.title !== 'Printing Specifications'))), ['Product', 'Artwork', 'Planning']);

  // Every other card — ordinary, a part, a gang parent, a split gang child —
  // gets back the very list it gave: all five groups, all eight Planning rows.
  for (const jc of [{}, { is_assembly: false }, { is_assembly: null }, { part_of_line_id: 7 },
    { gang_parent: true, gang_run_id: 3 }, { parent_job_card_id: 12 }, null, undefined]) {
    const g = card(false);
    const out = partsLib.printedSpecGroups(jc, g);
    assert.equal(out, g, `the same list back for ${JSON.stringify(jc)}`);
    assert.deepEqual(titles(out), ['Sheet & Finish', 'Product', 'Printing Specifications', 'Artwork', 'Planning']);
    assert.deepEqual(labels(out, 'Sheet & Finish'), ['Coating / Lamination', 'Print Sheet', 'Ups / Print Sheet', 'Print Sheets / Parent']);
    assert.deepEqual(labels(out, 'Planning'), ['Ordered Qty', 'Planned Qty', 'Qty Produced', 'Parent Sheets Issued',
      'Sheets Required', 'Press', 'Planned Date', 'Delivery']);
  }
});

test('15 B: the pasting card\'s editor names no board, issues no sheets and takes no press; every other card\'s editor is as it was', () => {
  const page = src('../../client/src/pages/Production.jsx');
  // 1. In place of the "Board in use" band, the printed card's own sentence —
  //    one sentence, kept in cartonParts.js and typed in neither screen.
  assert.match(page, /import \{ closedNothingMadeText, PASTING_NO_BOARD_TEXT, PASTING_ORDER_QTY_TEXT, pastingQtyCorrectionText, sheetsIssuedTotal \} from '\.\.\/lib\/cartonParts\.js';/);
  assert.match(page, /<\/span><span>\{fmt\.title\(editing\.status\)\}<\/span><\/div>\s*\n\s*\{editing\.is_assembly \? \(\s*\n\s*<div data-no-board="assembly" className="[^"]*">\s*\n\s*<div className="[^"]*">Board in use<\/div>\s*\n\s*<div className="[^"]*">\{PASTING_NO_BOARD_TEXT\}<\/div>\s*\n\s*<\/div>\s*\n\s*\) : \(\s*\n\s*<BoardBand board=\{boardUsed\(editing\)\} \/>\s*\n\s*\)\}\s*\n\s*<div className="ci-form-grid">/);
  assert.equal((page.match(/<BoardBand\b/g) || []).length, 1, 'one band, behind that gate');
  for (const f of [page, src('../../client/src/components/JobCardSheet.jsx')]) {
    assert.doesNotMatch(f, /No board —/, 'the sentence is typed in cartonParts.js only');
    assert.equal((f.match(/\{PASTING_NO_BOARD_TEXT\}/g) || []).length, 1);
  }
  // 2. No Sheets Issued and no Press / Machine input on a pasting card; both
  //    stand, untouched, on every other card — and Job Status follows them.
  assert.match(page, /\{!editing\.is_assembly && \(\s*\n\s*<Field label="Sheets Issued">\s*\n\s*<Input type="number" min="0" value=\{jobForm\.sheets_issued\} disabled=\{!canSaveEditing\}\s*\n\s*onChange=\{e => setJobForm\(\{ \.\.\.jobForm, sheets_issued: e\.target\.value \}\)\} \/>\s*\n\s*<\/Field>\s*\n\s*\)\}/);
  assert.match(page, /\{!editing\.is_assembly && \(\s*\n\s*<Field label="Press \/ Machine">\s*\n\s*<Select value=\{jobForm\.machine_id\} disabled=\{!canSaveEditing\}\s*\n\s*onChange=\{e => setJobForm\(\{ \.\.\.jobForm, machine_id: e\.target\.value \}\)\}>\s*\n\s*<option value="">No press assigned<\/option>\s*\n\s*\{machines\.map\(m => <option key=\{m\.id\} value=\{m\.id\} data-search=\{searchText\(m\)\}>\{m\.name\}<\/option>\)\}\s*\n\s*<\/Select>\s*\n\s*<\/Field>\s*\n\s*\)\}\s*\n\s*<Field label="Job Status">/);
  // 3. The quantity is the cartons to paste — shown, never typed — with where it
  //    comes from (how it is corrected: 15 E); any other card keeps its Planned
  //    Quantity input.
  assert.match(page, /<div className="ci-form-grid">\s*\n\s*\{editing\.is_assembly \? \(\s*\n\s*<Field label="Cartons to Paste" hint=\{<>\s*\n\s*\{"from its parts' die-cut pieces — not typed here"\}\s*\n[^\n]*\n\s*<\/>\}>\s*\n\s*<Input value=\{fmt\.num\(jobForm\.qty_planned\)\} disabled readOnly \/>\s*\n\s*<\/Field>\s*\n\s*\) : \(\s*\n\s*<Field label="Planned Quantity">\s*\n\s*<Input type="number" min="1" value=\{jobForm\.qty_planned\} disabled=\{!canSaveEditing\}\s*\n\s*onChange=\{e => setJobForm\(\{ \.\.\.jobForm, qty_planned: e\.target\.value \}\)\} \/>\s*\n\s*<\/Field>\s*\n\s*\)\}/);
  for (const label of ['Planned Quantity', 'Cartons to Paste', 'Sheets Issued', 'Press / Machine']) {
    assert.equal(page.split(`<Field label="${label}"`).length - 1, 1, `one "${label}" field, behind its gate`);
  }
  //    Every other card's form still holds its three values as the card gave
  //    them, and its Save sends the form whole (a pasting card has no Save: 15 E).
  assert.match(page, /setJobForm\(\{\s*\n\s*qty_planned: full\.qty_planned \?\? '',\s*\n\s*sheets_issued: full\.sheets_issued \?\? '',\s*\n\s*machine_id: full\.machine_id \|\| '',\s*\n\s*\}\);/);
  assert.match(page, /const saved = await overIssue\.guard\(ack => api\.put\(`\/job-cards\/\$\{editing\.id\}`,\s*\n\s*ack \? \{ \.\.\.jobForm, ack_over_issue: ack \} : jobForm\)\);/);
  // 4. Planning Engine: ordered, cartons to paste, delivery — the four sheet
  //    and press rows stay on every other card, between the same two.
  assert.match(page, /: `\$\{fmt\.num\(editing\.line_qty\)\} cartons`\}<\/Spec>\s*\n\s*\{editing\.is_assembly \? \(\s*\n\s*<Spec label="Cartons to Paste">\{fmt\.num\(editing\.qty_planned\)\}<\/Spec>\s*\n\s*\) : \(<>\s*\n\s*<Spec label="Sheets Required">\{editing\.sheets_required != null \? fmt\.num\(editing\.sheets_required\) : '—'\}<\/Spec>\s*\n\s*<Spec label="Parent Sheets Issued">\{fmt\.num\(editing\.sheets_issued\)\}<\/Spec>\s*\n\s*<Spec label="Print Sheets \/ Parent">\{yieldTxt\}<\/Spec>\s*\n\s*<Spec label="Press">\{editing\.machine_name \|\| '—'\}<\/Spec>\s*\n\s*<\/>\)\}\s*\n\s*<Spec label="Delivery">\{fmt\.date\(editing\.delivery_date\)\}<\/Spec>\s*\n\s*<\/div>/);
  // 5. No Printing Specifications panel: nothing is printed on this card.
  assert.match(page, /\{!editing\.gang_parent && !editing\.is_assembly && \(\s*\n\s*<section className="ci-form-panel">\s*\n\s*<div className="ci-form-panel-title">\s*\n\s*<span>Printing Specifications<\/span>/);
  assert.equal(page.split('<span>Printing Specifications</span>').length - 1, 1, 'one panel, behind that gate');
  // …and the AVS switch stays behind its own gate (13b G4), untouched.
  assert.match(page, /\{!editing\.parent_job_card_id && !editing\.is_assembly && \(/);
});

test('15 C: the Job Cards list never shows or adds a pasting card\'s cartons as sheets', () => {
  // The total of sheets issued leaves a pasting card out…
  assert.equal(partsLib.sheetsIssuedTotal([{ sheets_issued: 657 }, { sheets_issued: 657 },
    { is_assembly: true, sheets_issued: 5256, qty_planned: 5256 }]), 1314);
  assert.equal(partsLib.sheetsIssuedTotal([{ is_assembly: true, sheets_issued: 5256 }]), 0);
  assert.equal(partsLib.sheetsIssuedTotal([]), 0);
  assert.equal(partsLib.sheetsIssuedTotal(), 0);
  // …and adds every other card exactly as the reduce it replaced did: a part
  // card, a gang parent, a split gang child, a text figure, a blank.
  const rows = [{ sheets_issued: 657, part_of_line_id: 2 }, { sheets_issued: 1200, gang_parent: true },
    { sheets_issued: 4000, parent_job_card_id: 9, is_assembly: false }, { sheets_issued: '15' }, { sheets_issued: null }, {}];
  assert.equal(partsLib.sheetsIssuedTotal(rows), rows.reduce((s, j) => s + (+j.sheets_issued || 0), 0));
  assert.equal(partsLib.sheetsIssuedTotal(rows), 5872);

  const page = src('../../client/src/pages/Production.jsx');
  // The export's KPI reads that total; its column reads a dash on a pasting card.
  assert.match(page, /\{ label: 'Sheets issued', value: fmt\.num\(sheetsIssuedTotal\(shown\)\) \},/);
  assert.match(page, /\{ key: 'sheets_issued', label: 'Sheets Issued', align: 'right', export: j => \(j\.is_assembly \? '—' : fmt\.num\(j\.sheets_issued\)\) \},/);
  // The card on the list says its cartons to paste — its planned sets, the
  // printed card's own figure; any other, its sheets issued (the figure
  // before each: 15 G).
  assert.match(page, /\{jc\.is_assembly \? \(<>\s*\n[^\n]*\n\s*<div><div className="font-bold text-gray-900 tabular-nums">\{fmt\.num\(jc\.qty_planned\)\}<\/div>cartons to paste<\/div>\s*\n\s*<\/>\) : \(<>\s*\n[^\n]*\n\s*<div><div className="font-bold text-gray-900 tabular-nums">\{fmt\.num\(jc\.sheets_issued\)\}<\/div>sheets issued<\/div>\s*\n\s*<\/>\)\}/);
  assert.equal(page.split('</div>sheets issued</div>').length - 1, 1, 'sheets issued is said once, behind that gate');
  assert.equal(page.split('</div>cartons to paste</div>').length - 1, 1);
  // The list's own rows carry the flag: JC_VIEW selects jc.* (13b C) and the
  // register's drop-list leaves it on.
  const drops = src('./routes/production.js').match(/export const JOB_CARD_LIST_DROPS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(drops, 'the register drop-list');
  assert.doesNotMatch(drops[1], /is_assembly/);
});

test('15: the traveler now loads cartonParts.js, so the station does too — the lib\'s one `seq` is a job card\'s own stages, and stays the only one', () => {
  // JobCardSheet reads the sentence and the group rule from this lib, and a
  // station opens the traveler (Section.jsx) — so the lib is among the files the
  // lean-row source guard walks (section-lean-rows.test.js). That guard lets it
  // name `seq`, a field the lean station rows drop, for ONE reader only:
  // closeAtZeroCalls, which orders the stages GET /job-cards/:id serves.
  const lib = src('../../client/src/lib/cartonParts.js');
  const fn = lib.slice(lib.indexOf('export function closeAtZeroCalls('), lib.indexOf('export const nothingToPasteText'));
  assert.match(fn, /for \(const st of \[\.\.\.stages\]\.sort\(\(a, b\) => a\.seq - b\.seq\)\) \{/);
  assert.equal((lib.match(/\bseq\b/g) || []).length, 2, 'no other reader of seq in this lib');
  assert.match(src('./section-lean-rows.test.js'), /\n  'lib\/cartonParts\.js': \['seq'\],\n/);
});

// ── Task 15 follow-up: what was left on the pasting card's editor ───────────

test('15 D: the pasting card\'s Product Master panel keeps what the pasting bench reads — no board, parent sheet, coating, print sheet or ups', () => {
  const page = src('../../client/src/pages/Production.jsx');
  const a = page.indexOf("<span>{editing.gang_parent ? 'Shared Sheet' : 'Product Master'}</span>");
  const b = page.indexOf('{/* Push to next stages — only once finalised */}');
  assert.ok(a > 0 && b > a, 'the Product Master panel');
  const panel = page.slice(a, b);
  // Every row of the panel and the gate it sits behind, in the order drawn.
  // The five that belong to the part cards are not drawn on a pasting card;
  // carton size, pasting and die — its printed card's Product group — are.
  // The gang gates are the ones that were there before.
  const rows = [...panel.matchAll(/\n\s*\{([^\n]+?) && <Spec label="([^"]+)">/g)].map(m => [m[2], m[1]]);
  assert.deepEqual(rows, [
    ['Board (master)', '!editing.is_assembly'],
    ['Parent Sheet', '!editing.is_assembly'],
    ['Coating / Lam', '!editing.is_assembly'],
    ['Print Sheet', '!editing.gang_parent && !editing.is_assembly'],
    ['Carton Size', '!editing.gang_parent'],
    ['Pasting', '!editing.gang_parent'],
    ['Die', '!editing.gang_parent'],
    ['UPS', '!editing.gang_parent && !editing.is_assembly'],
  ]);
  assert.equal((panel.match(/<Spec label=/g) || []).length, 8, 'no row is drawn past its gate');
  // …and what each of the eight reads is what it read before.
  for (const row of [
    `<Spec label="Board (master)">{editing.master_board_name || editing.board_name || '—'}</Spec>`,
    '<Spec label="Parent Sheet">{editing.sheet_l ? `${editing.sheet_l}×${editing.sheet_w}"` : \'—\'}</Spec>',
    `<Spec label="Coating / Lam">{editing.coating && editing.coating !== 'none' ? fmt.title(editing.coating) : 'None'}</Spec>`,
    '<Spec label="Print Sheet">{editing.child_l ? `${editing.child_l}×${editing.child_w}"` : \'—\'}</Spec>',
    `<Spec label="Carton Size">{editing.size || '—'}</Spec>`,
    `<Spec label="Pasting">{editing.pasting_type ? fmt.title(editing.pasting_type) : '—'}</Spec>`,
    '<Spec label="Die">{editing.die_number ? `#${editing.die_number}${editing.die_location ? ` · ${editing.die_location}` : \'\'}` : \'—\'}</Spec>',
    '<Spec label="UPS">{editing.ups}</Spec>',
  ]) assert.ok(panel.includes(row), row);
});

test('15 E: a pasting card\'s editor draws no Save Changes, claims nothing editable, and says how its cartons ARE corrected', () => {
  const page = src('../../client/src/pages/Production.jsx');
  // No Save Changes for a pasting card — nothing on its form can be typed.
  // Any other card keeps the button, behind the conditions it always had.
  assert.match(page, /\{editing && !editing\.finalised_at && canEditJobCard && !editing\.is_assembly &&\s*\n\s*<Button variant="secondary" onClick=\{saveJobForm\} disabled=\{!canSaveEditing\}>Save Changes<\/Button>\}/);
  assert.equal(page.split('>Save Changes</Button>').length - 1, 1, 'one Save Changes, behind that gate');
  // The panel is not called editable on a pasting card.
  assert.match(page, /<div className="ci-form-panel-title"><span>\{editing\.is_assembly \? 'Job fields' : 'Editable job fields'\}<\/span><span>\{fmt\.title\(editing\.status\)\}<\/span><\/div>/);
  assert.equal(page.split('Editable job fields').length - 1, 1, 'said once, on the other branch');
  // Under the cartons: how they are corrected. Amend, with a reason, before
  // Sort & Paste starts the card — and a card not yet finalised is told that
  // Amend comes once it is.
  assert.equal(partsLib.pastingQtyCorrectionText(true),
    'Planning corrects it through Amend, with a reason, before the card is started at Sort & Paste.');
  assert.equal(partsLib.pastingQtyCorrectionText(false),
    'Planning corrects it through Amend, with a reason, once this card is finalised and before it is started at Sort & Paste.');
  assert.equal(partsLib.pastingQtyCorrectionText(undefined), partsLib.pastingQtyCorrectionText(false));
  assert.match(page, /\{"from its parts' die-cut pieces — not typed here"\}\s*\n\s*<span className="mt-0\.5 block">\{pastingQtyCorrectionText\(!!editing\.finalised_at\)\}<\/span>\s*\n\s*<\/>\}>/);
  // That wording is the page's own rule: Amend has ONE way in — the editor's
  // footer — offered to a planner on a FINALISED card that is neither closed
  // nor split, for a pasting card as for any card. On a pasting card the
  // button names what its dialog amends.
  assert.match(page, /\{editing && canEditJobCard && editing\.finalised_at && editing\.status !== 'closed' && editing\.status !== 'split' &&\s*\n\s*<Button variant="secondary" onClick=\{\(\) => openAmend\(editing\)\}>\{editing\.is_assembly \? 'Amend Cartons to Paste' : 'Amend Qty \/ Sheets'\}<\/Button>\}/);
  assert.equal((page.match(/openAmend\(/g) || []).length, 1, 'one way into Amend');
  // A pasting card can be finalised like any card: the same button, the same rule.
  assert.match(page, /const canFinalise = editing && canEditJobCard && !editing\.finalised_at && editing\.status !== 'closed' && editing\.artwork_locked;/);
  assert.match(page, /\? <Button onClick=\{finalise\} disabled=\{!canFinalise\}>Finalise Job Card<\/Button>/);
});

test('15 F: amending a pasting card — its cartons to paste and a reason; no order quantity, no sheets issued', () => {
  const page = src('../../client/src/pages/Production.jsx');
  const a = page.indexOf('<Modal open={!!amending}');
  const b = page.indexOf('{/* Sync Master? — inherited spec edited on the Job Card */}');
  assert.ok(a > 0 && b > a, 'the Amend dialog');
  const dialog = page.slice(a, b);
  // No Order Qty input. In its place, the words the server refuses one with —
  // the same sentence, so the screen and the refusal cannot drift apart.
  assert.equal(partsLib.PASTING_ORDER_QTY_TEXT, 'its quantity follows the carton: change the carton in Orders → Edit');
  assert.ok(src('./routes/production.js').includes(`+ '${partsLib.PASTING_ORDER_QTY_TEXT}'), { status: 409 });`),
    'the amend route refuses a pasting card\'s order quantity in these words');
  assert.match(dialog, /<div className="ci-form-grid">\s*\n\s*\{amending\.is_assembly \? \(\s*\n\s*<div data-order-qty="follows-carton">\s*\n\s*<span className="[^"]*">Order Qty \(now \{fmt\.num\(amending\.line_qty\)\}\)<\/span>\s*\n\s*<span className="[^"]*">Not amended here — \{PASTING_ORDER_QTY_TEXT\}<\/span>\s*\n\s*<\/div>\s*\n\s*\) : !amending\.gang_parent && \(\s*\n\s*<Field label=\{`Order Qty \(now \$\{fmt\.num\(amending\.line_qty\)\}\)`\} hint="flows back to the sales order line — plan sheets re-derive automatically">\s*\n\s*<Input type="number" min="1" value=\{amendForm\.order_qty\}\s*\n\s*onChange=\{e => setAmendForm\(\{ \.\.\.amendForm, order_qty: e\.target\.value \}\)\} \/>\s*\n\s*<\/Field>\s*\n\s*\)\}/);
  assert.equal(dialog.split('amendForm.order_qty}').length - 1, 1, 'one Order Qty input, on the other branch');
  // The one figure it amends is labelled for what it is; the input is the same.
  assert.match(dialog, /<Field label=\{`\$\{amending\.is_assembly \? 'Cartons to Paste' : 'Planned Qty'\} \(now \$\{fmt\.num\(amending\.qty_planned\)\}\)`\}>\s*\n\s*<Input type="number" min="1" value=\{amendForm\.qty_planned\}\s*\n\s*onChange=\{e => setAmendForm\(\{ \.\.\.amendForm, qty_planned: e\.target\.value \}\)\} \/>\s*\n\s*<\/Field>/);
  // No Sheets Issued field: a pasting card issues none. Any other card keeps it, whole.
  assert.match(dialog, /\{!amending\.is_assembly && \(\s*\n\s*<Field label=\{`Sheets Issued \(now \$\{fmt\.num\(amending\.sheets_issued\)\}\)`\}\s*\n\s*hint=\{cuttingStarted\(amending\) \? 'cutting already ran — board is consumed; use Adjust on the cutting stage' : 'board to issue at cutting start'\}>\s*\n\s*<Input type="number" min="0" value=\{amendForm\.sheets_issued\} disabled=\{cuttingStarted\(amending\)\}\s*\n\s*onChange=\{e => setAmendForm\(\{ \.\.\.amendForm, sheets_issued: e\.target\.value \}\)\} \/>\s*\n\s*<\/Field>\s*\n\s*\)\}/);
  assert.equal(dialog.split('amendForm.sheets_issued}').length - 1, 1, 'one Sheets Issued input, behind that gate');
  // What the dialog says an amendment does, and its example reason, are a
  // pasting card's own; every other card reads the words it always read.
  assert.match(dialog, /\{amending\.is_assembly \? \(\s*\n\s*<p className="text-xs text-slate-500">\s*\n\s*This changes the cartons the card starts with at Sort &amp; Paste\. Every amendment is\s*\n\s*recorded with your name and reason in the history trail\.\s*\n\s*<\/p>\s*\n\s*\) : \(\s*\n\s*<p className="text-xs text-slate-500">\s*\n\s*Changes flow everywhere live — the sales line, Planning, Pendency, board demand and the stations —\s*\n\s*and every amendment is recorded with your name and reason in the history trail\.\s*\n\s*<\/p>\s*\n\s*\)\}/);
  assert.match(dialog, /placeholder=\{amending\.is_assembly \? 'e\.g\. 56 sets short — Part 2 pieces damaged before pasting' : 'e\.g\. customer revised PO 01732 from 5,000 to 8,000'\}/);
  // What is SENT is untouched: the reason, and only a figure that changed. The
  // two inputs a pasting card does not draw keep the values the dialog opened
  // with, so nothing goes for them — the request is the reason and the quantity.
  assert.match(page, /setAmendForm\(\{\s*\n\s*order_qty: jc\.gang_parent \? '' : String\(jc\.line_qty \?\? ''\),\s*\n\s*qty_planned: String\(jc\.qty_planned \?\? ''\),\s*\n\s*sheets_issued: String\(jc\.sheets_issued \?\? ''\),\s*\n\s*reason: '',\s*\n\s*\}\);/);
  assert.match(page, /const body = \{ reason: amendForm\.reason \};\s*\n\s*if \(!amending\.gang_parent && amendForm\.order_qty !== '' && \+amendForm\.order_qty !== \+amending\.line_qty\) body\.order_qty = amendForm\.order_qty;\s*\n\s*if \(amendForm\.qty_planned !== '' && \+amendForm\.qty_planned !== \+amending\.qty_planned\) body\.qty_planned = amendForm\.qty_planned;\s*\n\s*if \(amendForm\.sheets_issued !== '' && \+amendForm\.sheets_issued !== \+amending\.sheets_issued\) body\.sheets_issued = amendForm\.sheets_issued;\s*\n\s*const updated = await overIssue\.guard\(ack => api\.post\(`\/job-cards\/\$\{amending\.id\}\/amend`,\s*\n\s*ack \? \{ \.\.\.body, ack_over_issue: ack \} : body\)\);/);
  // The reason stays required.
  assert.match(dialog, /<Button onClick=\{submitAmend\} disabled=\{!amendForm\.reason\.trim\(\)\}>Record Amendment<\/Button>/);
  assert.match(dialog, /<Field label="Reason \(required\)">\s*\n\s*<Input value=\{amendForm\.reason\}/);
});

test('15 G: the list tile of a pasting card reads what the carton\'s line ordered, then its cartons to paste', () => {
  const page = src('../../client/src/pages/Production.jsx');
  // A pasting card's qty_planned is its cartons to paste, not what was
  // ordered: its first figure is the carton line's own quantity — drawn only
  // when the row carries one — and no figure is said twice. Every other card
  // reads qty_planned there, as it did: "ordered", or a gang's "print sheets".
  assert.match(page, /\{jc\.is_assembly \? \(<>\s*\n\s*\{jc\.line_qty != null && <div><div className="font-bold text-gray-900 tabular-nums">\{fmt\.num\(jc\.line_qty\)\}<\/div>ordered<\/div>\}\s*\n[^\n]*\n\s*<\/>\) : \(<>\s*\n\s*<div><div className="font-bold text-gray-900 tabular-nums">\{fmt\.num\(jc\.qty_planned\)\}<\/div>\{jc\.gang_parent \? 'print sheets' : 'ordered'\}<\/div>\s*\n[^\n]*\n\s*<\/>\)\}/);
  assert.equal(page.split('{fmt.num(jc.line_qty)}').length - 1, 1, 'the line\'s quantity is read on the pasting branch only');
  // The register's own rows carry it: JC_VIEW reads the card's line, and the
  // list's drop-list leaves it on. No server field was added for this.
  const prod = src('./routes/production.js');
  assert.match(prod, /\n\s*ol\.qty AS line_qty, ol\.order_id, /);
  const drops = prod.match(/export const JOB_CARD_LIST_DROPS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.doesNotMatch(drops[1], /line_qty/);
});
