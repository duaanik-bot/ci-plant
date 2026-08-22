import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notificationLink } from '../../client/src/lib/notificationLink.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// A notification about an approval used to carry `link: '/planning'` — the page
// name and nothing else. Clicking it opened Planning's default queue, so the
// reader landed on whatever job happened to sort first and had to go find the
// one the bell had just named. These tests pin the whole path from the row to
// the decision: the link names the request, the page reads it, and the buttons
// are there when it lands.

test('an approval notification links to the request, not to the page', () => {
  assert.equal(
    notificationLink({ kind: 'mgt_request', link: '/planning', ref_table: 'approval_requests', ref_id: 4 }),
    '/planning?ar=4');
  assert.equal(
    notificationLink({ kind: 'mgt_decision', link: '/planning', ref_table: 'approval_requests', ref_id: 11 }),
    '/planning?ar=11');
  assert.equal(
    notificationLink({ kind: 'xs_request', link: '/extra-sheets', ref_table: 'extra_sheet_requests', ref_id: 7 }),
    '/extra-sheets?xs=7');
});

// The repair has to reach BACKWARDS. Every row already in the plant's history
// was written with the bare link, and rewriting them would be an UPDATE across
// the whole notifications table — but each one already stores what it is about.
test('rows already in the plant carry the ref that repairs their own link', () => {
  const old = { kind: 'mgt_request', link: '/planning', ref_table: 'approval_requests', ref_id: 3 };
  assert.equal(notificationLink(old), '/planning?ar=3');
});

// /floor/printing?q=CI-JC-0159 puts the reader on the right station with the job
// already searched. No ref-derived link beats that, so a link that already names
// something specific is left exactly as it is.
test('a link that already names something specific is never overwritten', () => {
  for (const link of ['/floor/printing?q=CI-JC-0159', '/floor/cutting?xs=1', '/extra-sheets?xs=9']) {
    assert.equal(notificationLink({ link, ref_table: 'extra_sheet_requests', ref_id: 2 }), link);
  }
});

test('a ref this map has never heard of leaves the stored link alone', () => {
  assert.equal(notificationLink({ kind: 'chat', link: '/chat/12', ref_table: 'conversations', ref_id: 12 }), '/chat/12');
  assert.equal(notificationLink({ link: '/job-cards', ref_table: 'job_cards', ref_id: 5 }), '/job-cards');
  // Prototype keys are unknown kinds like any other — never Object.prototype's.
  assert.equal(notificationLink({ link: '/planning', ref_table: 'constructor', ref_id: 1 }), '/planning');
});

test('a ref with no usable id cannot invent a destination', () => {
  assert.equal(notificationLink({ link: '/planning', ref_table: 'approval_requests', ref_id: null }), '/planning');
  assert.equal(notificationLink({ link: '/planning', ref_table: 'approval_requests', ref_id: 0 }), '/planning');
  assert.equal(notificationLink({ link: '', ref_table: 'approval_requests', ref_id: null }), null);
  assert.equal(notificationLink(null), null);
});

// ── The link the server writes from here on ────────────────────────────────
const notifications = read('./routes/notifications.js');
const extrasheets = read('./routes/extrasheets.js');

test('the server writes the deep link on every approval notification it raises', () => {
  assert.match(notifications, /link: `\/planning\?ar=\$\{row\.id\}`/);
  assert.match(notifications, /link: `\/planning\?ar=\$\{a\.id\}`/);
  assert.doesNotMatch(notifications, /link: '\/planning'/);
  assert.doesNotMatch(extrasheets, /link: '\/extra-sheets'/);
  assert.match(extrasheets, /link: `\/extra-sheets\?xs=\$\{row\.id\}`/);
  assert.match(extrasheets, /link: `\/extra-sheets\?xs=\$\{x\.id\}`/);
});

// One request by id. /approvals/pending only lists what is STILL pending and
// /approvals/by-line only holds the LATEST ask per line, so neither can answer
// "show me CI-MA-0004" once it is decided or superseded — which is exactly the
// notification a decision bell carries.
test('a single approval request can be read by id, and a junk id is a 400 not a 500', () => {
  assert.match(notifications, /r\.get\('\/approvals\/:id'/);
  assert.match(notifications, /Number\.isInteger\(id\)/);
  assert.match(notifications, /status\(400\)/);
  // Declared AFTER the two literal paths, or '/approvals/pending' would be read
  // as an id and Postgres would throw 22P02 at the plant instead of a list.
  assert.ok(notifications.indexOf(`r.get('/approvals/pending'`) < notifications.indexOf(`r.get('/approvals/:id'`));
  assert.ok(notifications.indexOf(`r.get('/approvals/by-line'`) < notifications.indexOf(`r.get('/approvals/:id'`));
});

// ── The client follows it, and lands on something it can act on ────────────
const appLayout = read('../../client/src/components/AppLayout.jsx');
const planning = read('../../client/src/pages/Planning.jsx');
const extraSheetsPage = read('../../client/src/pages/ExtraSheets.jsx');
const ui = read('../../client/src/components/ui.jsx');

test('the notification centre follows the resolved link, not the raw one', () => {
  assert.match(appLayout, /import { notificationLink } from '\.\.\/lib\/notificationLink\.js'/);
  assert.match(appLayout, /const to = notificationLink\(n\)/);
  assert.doesNotMatch(appLayout, /if \(n\.link\) nav\(n\.link\)/);
  // The approval desk's own cards name their request too.
  assert.match(appLayout, /nav\(`\/planning\?ar=\$\{a\.id\}`\)/);
  assert.match(appLayout, /nav\(`\/extra-sheets\?xs=\$\{x\.id\}`\)/);
});

test('Planning opens the named request with the decision on screen', () => {
  assert.match(planning, /useSearchParams/);
  assert.match(planning, /params\.get\('ar'\)/);
  assert.match(planning, /params\.get\('line'\)/);
  assert.match(planning, /api\.get\(`\/approvals\/\$\{arId\}`\)/);
  // Approve and Reject, on the page, without opening anything else.
  assert.match(planning, /decideFocused\('approve'\)/);
  assert.match(planning, /decideFocused\('reject'\)/);
  assert.match(planning, /api\.post\(`\/approvals\/\$\{focusAr\.id\}\/\$\{action\}`/);
});

test('a decided request shows its outcome instead of a button that can only 409', () => {
  // The server answers a second decision with mgtDecisionError's 409, so the
  // buttons hang off `pending` and the decided branch renders the outcome.
  assert.match(planning, /const pending = focusAr\.status === 'pending'/);
  assert.match(planning, /\{!pending \? \(/);
  assert.match(planning, /focusAr\.decided_by \? ` by \$\{focusAr\.decided_by\}`/);
  // …and Approve/Reject render only inside the pending branch, never above it.
  assert.ok(planning.indexOf('const pending = focusAr.status') < planning.indexOf("decideFocused('approve')"));
  // A reader without the grant sees where the ask stands and no dead button.
  assert.match(planning, /focusAr\.can_decide \? \(/);
  assert.match(read('./routes/notifications.js'), /can_decide: canDecideManagement\(await meFlags\(req\)\)/);
});

test('the focused job is brought into view instead of being left in a filtered queue', () => {
  // The row can be in any tab, and any chip or typed word could be hiding it.
  assert.match(planning, /setTab\(/);
  assert.match(planning, /filters\.reset\(\)/);
  assert.match(planning, /scrollIntoView/);
  assert.match(planning, /data-row-id/);
  // BOTH renderers carry the anchor — the phone/tablet card block is a parallel
  // tree, and wiring only the table leaves the plant's tablets unable to scroll.
  assert.equal(ui.match(/data-row-id=/g)?.length, 2);
});

test('Extra Sheets opens the named request the same way', () => {
  assert.match(extraSheetsPage, /params\.get\('xs'\)/);
  assert.match(extraSheetsPage, /scrollIntoView/);
});
