import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// HR's money doors and Finance (Cash & Bank spec §7.3, §7.7 and §11 items 2 and 3; plan Task 12). Each HR route that moves staff money
// names the HR rows it made, after its own transaction has committed, to Finance's HR poster (finHrAfter, finance-hr-feed.js), and only
// then answers HR's client: HR's commit comes first and Finance never holds it up. And each HR screen that records where the money came
// from picks it from Finance's one "paid from" list (PaidFromSelect). This reads the source; finance-pg-hr-wiring.test.js drives the
// same doors through the real app and a real database.

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Comments out, line breaks kept (as mint-routes-join-once.test.js reads the routes), so a word in a comment proves nothing.
const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '');

// A route's own code: from its `r.<verb>('<path>'` to the next top-level function, const arrow or route (the scan's block rule).
const HEAD = /^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|^r\.(?:get|post|put|patch|delete)\(\s*'[^']+'|^for\s*\(/gm;
function routeBlock(src, verb, route) {
  const at = src.indexOf(`r.${verb}('${route}'`);
  assert.ok(at >= 0, `${verb.toUpperCase()} ${route} is not written r.${verb}('${route}'`);
  HEAD.lastIndex = at + 1;
  const next = HEAD.exec(src);
  return src.slice(at, next ? next.index : src.length);
}

// Where the call that opens at `open` (the index of its `(`) closes: parentheses counted outside strings, template literals (with their
// ${…} parts) and regular expressions, so a ')' inside a SQL string or a regex is no close.
function closeOf(src, open) {
  let depth = 0;
  let last = '';                    // the last significant character outside a string: tells a regex from a division
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"') {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === '\\') i += 1;
      last = c;
      continue;
    }
    if (c === '`') { i = templateEnd(src, i); last = '`'; continue; }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
      let inClass = false;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      last = '/';
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
    last = c;
  }
  throw new Error(`no close for the call at ${open}`);
}
function templateEnd(src, start) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === '`') return i;
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      for (i += 2; i < src.length && depth > 0; i += 1) {
        if (src[i] === '`') i = templateEnd(src, i);
        else if (src[i] === "'" || src[i] === '"') { const q = src[i]; for (i += 1; i < src.length && src[i] !== q; i += 1) if (src[i] === '\\') i += 1; }
        else if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
      }
      i -= 1;
    }
  }
  throw new Error(`no end for the template at ${start}`);
}
const indexesOf = (text, word) => [...text.matchAll(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(m => m.index);

// The doors (the controller's door table, from Task 11's report) and the HR events each names. A door whose events depend on what the
// request did (a staff payment is an advance or a loan; the line drawer names its batch, or the line) lists every type it may name.
const LEDGERS = 'routes/hr-ledgers.js';
const PAYROLL = 'routes/hr-payroll.js';
const DOORS = [
  [LEDGERS, 'post', '/hr/staff-payments', ['advance', 'loan']],
  [LEDGERS, 'post', '/hr/advances', ['advance']],
  [LEDGERS, 'post', '/hr/loans', ['loan']],
  [LEDGERS, 'post', '/hr/loans/:id/prepay', ['prepay']],
  [LEDGERS, 'post', '/hr/loans/:id/cancel', ['loan', 'sheet']],   // a loan an advance sheet made: its round too (ruling R48)
  [LEDGERS, 'post', '/hr/advances/:personId/waive', ['waiver']],
  [LEDGERS, 'post', '/hr/advance-sheets/:id/post', ['sheet']],
  [LEDGERS, 'put', '/hr/loans/:id/month-instalment', ['run']],
  [PAYROLL, 'post', '/hr/runs/:month/payments', ['batch', 'run']],
  [PAYROLL, 'put', '/hr/runs/:month/lines/:personId/payment', ['batch', 'line', 'run']],
  [PAYROLL, 'post', '/hr/runs/:month/lines/status', ['batch', 'line', 'run']],
  [PAYROLL, 'post', '/hr/runs/:month/finalise', ['run', 'sheetAdvances']],
  [PAYROLL, 'post', '/hr/runs/:month/unfinalise', ['run', 'sheetAdvances']],
];

for (const [file, verb, route, types] of DOORS) {
  test(`${verb.toUpperCase()} ${route} calls finHrAfter(req, after its await tx( block, and answers after it`, () => {
    const block = routeBlock(strip(read(file)), verb, route);
    const txs = indexesOf(block, 'await tx(').map(at => {
      const open = at + 'await tx'.length;
      return { at, end: closeOf(block, open) };
    });
    assert.ok(txs.length >= 1, 'the door writes in a transaction of its own');
    const calls = indexesOf(block, 'finHrAfter(req,');
    assert.ok(calls.length >= 1, 'the door names its events to finHrAfter(req, …)');
    for (const call of calls) {
      assert.ok(!txs.some(t => call > t.at && call < t.end), 'finHrAfter is called inside HR\'s transaction: it must wait for the commit');
      const before = txs.filter(t => t.end < call);
      assert.ok(before.length, 'finHrAfter comes after the door\'s transaction');
      // Nothing answers HR's client between the commit and Finance: the answer is sent after finHrAfter.
      const tx = before[before.length - 1];
      const between = block.slice(tx.end, call);
      assert.doesNotMatch(between, /res\.(json|send|status)\(|runResponse\(/, 'HR answers before Finance has been told');
      assert.match(block.slice(call), /res\.(json|send)\(|runResponse\(/, 'HR still answers after finHrAfter');
    }
    for (const type of types) assert.match(block, new RegExp(`type: '${type}'`), `the door names its '${type}' events`);
  });
}

test('no HR route posts or reverses an HR entry itself: inside HR\'s transaction is no place for the feed', () => {
  for (const file of [LEDGERS, PAYROLL, 'routes/hr.js']) {
    const src = strip(read(file));
    assert.doesNotMatch(src, /finHrPost\(|finHrReverse\(|finHrPostHidden\(/, `${file} calls the feed's own posting`);
  }
  // …and the two route files that do tell Finance take finHrAfter from the feed.
  for (const file of [LEDGERS, PAYROLL]) assert.match(read(file), /import \{ finHrAfter \} from '\.\.\/finance-hr-feed\.js';/, file);
});

// Ruling R73: a feed transaction waits five seconds at most for any lock, so a long Bring-in holding the feed's lock never holds an HR
// answer up for long. finance-pg-hr-payroll.test.js shows a post, a combined entry and finHrReverse giving up behind a held lock; this
// pins that every transaction the feed and its catch-up open sets the timeout first, and only for itself.
test('R73: every feed transaction\'s first statement is the transaction-local lock timeout, and the feed opens no transaction another way', () => {
  const feedSrc = strip(read('finance-hr-feed.js'));
  assert.match(feedSrc, /const FIN_FEED_LOCK_TIMEOUT_SQL = "SELECT set_config\('lock_timeout', '5s', true\)";/);
  assert.doesNotMatch(feedSrc, /\bSET\s+(?:LOCAL\s+|SESSION\s+)?lock_timeout/i, 'a plain SET would stay on a pooled connection');
  assert.match(feedSrc, /export const finHrFeedTx = work => tx\(async \(qc, oc\) => \{\s*await finFeedTimeout\(qc\);\s*return work\(qc, oc\);\s*\}\);/);
  assert.equal([...feedSrc.matchAll(/\btx\(/g)].length, 1, 'the feed opens its transactions through finHrFeedTx alone');
  assert.ok([...feedSrc.matchAll(/finHrFeedTx\(/g)].length >= 5, 'non-vacuous: the post, the exception (twice), the due read, the books check');
  // finHrPostEvent: the feed's lock comes right after the timeout; finHrReverse, in its caller's transaction, sets the timeout itself
  assert.match(feedSrc, /return await finHrFeedTx\(async \(qc, oc\) => \{\s*await finLockFeed\(qc\);/);
  const reverse = feedSrc.slice(feedSrc.indexOf('export async function finHrReverse('));
  assert.match(reverse.slice(0, reverse.indexOf('\n}\n')), /await finFeedTimeout\(qc\);\s*await finLockFeed\(qc\);\s*await finLockEvent\(qc, ev\);/);
  // the catch-up opens none of its own: its one write goes through finHrFeedTx, the rest through finHrPost and finHrPostHidden
  const catchupSrc = strip(read('finance-hr-catchup.js'));
  assert.doesNotMatch(catchupSrc, /\btx\(/);
  assert.match(catchupSrc, /const finSaveDriftCursor = \(bookId, cursor\) => finHrFeedTx\(qc => qc\(/);
});

test('GET /hr/paid-from-options is for the accounts level up, answers { options } from finPaidFromOptions, and a restricted login may ask it', () => {
  const block = routeBlock(strip(read(LEDGERS)), 'get', '/hr/paid-from-options');
  assert.match(block, /^r\.get\('\/hr\/paid-from-options', requireHr\('accounts'\), /);
  assert.match(block, /finPaidFromOptions\(q\)/);
  assert.match(block, /res\.json\(\{ options/);
  // An accounts login is always restricted (hr/privacy.js): the route is on its allow list, or it would never reach it.
  assert.match(read('hr/privacy.js'), /\['GET', '\/hr\/paid-from-options'\]/);
  assert.match(read('../../client/src/lib/hr.js'), /paidFromOptions: \(\) => api\.get\('\/hr\/paid-from-options'\),/);
});

test('every door that takes a paid-from code checks it against the list in its own transaction', () => {
  const ledgers = strip(read(LEDGERS));
  for (const [verb, route] of [['post', '/hr/staff-payments'], ['post', '/hr/advances'], ['post', '/hr/loans'], ['post', '/hr/loans/:id/prepay'],
    ['post', '/hr/advance-sheets'], ['put', '/hr/advance-sheets/:id']]) {
    const block = routeBlock(ledgers, verb, route);
    const tx = indexesOf(block, 'await tx(')[0];
    const check = block.indexOf('paidFromChecked(qc,');
    assert.ok(tx >= 0 && check > tx, `${verb.toUpperCase()} ${route} checks the code inside its transaction`);
  }
  const payroll = strip(read(PAYROLL));
  for (const [verb, route] of [['post', '/hr/runs/:month/payments'], ['put', '/hr/runs/:month/lines/:personId/payment'],
    ['post', '/hr/runs/:month/lines/status']]) {
    const block = routeBlock(payroll, verb, route);
    const tx = indexesOf(block, 'await tx(')[0];
    const check = block.indexOf('paidFromChecked(qc,');
    assert.ok(tx >= 0 && check > tx, `${verb.toUpperCase()} ${route} checks the code inside its transaction`);
  }
});

// Ruling R47: HR is never held up by Finance's setup (§7.7). A door that may need a code reads whether Finance offers any account, with
// the pool and before its own transaction (a failed read there must not abort HR's), and while Finance offers none takes a missing
// code as cash. Once it offers accounts, New loan (R46) and the bulk Mark paid of a cash line or a line of no channel (R44, R44a) need one.
test('a door that may need a code asks finOffersPaidFrom(q) before its transaction (ruling R47)', () => {
  for (const [file, verb, route] of [[LEDGERS, 'post', '/hr/loans'], [PAYROLL, 'post', '/hr/runs/:month/lines/status'],
    [PAYROLL, 'put', '/hr/runs/:month/lines/:personId/payment']]) {
    const block = routeBlock(strip(read(file)), verb, route);
    const offers = block.indexOf('await finOffersPaidFrom(q)');
    const tx = indexesOf(block, 'await tx(')[0];
    assert.ok(offers >= 0 && tx >= 0 && offers < tx, `${verb.toUpperCase()} ${route} asks finOffersPaidFrom(q) before its transaction`);
    assert.doesNotMatch(block, /finOffersPaidFrom\(qc\b/, `${verb.toUpperCase()} ${route} never asks it inside its transaction`);
  }
  for (const file of [LEDGERS, PAYROLL]) assert.match(read(file), /import \{[^}]*\bfinOffersPaidFrom\b[^}]*\} from '\.\.\/finance-hr-setup\.js';/, file);
});

test('finOffersPaidFrom offers nothing while Finance has no book, nor when its list cannot be read (ruling R47)', async () => {
  const { finOffersPaidFrom } = await import('./finance-hr-setup.js');
  assert.equal(await finOffersPaidFrom(async () => []), false, 'no book, no ledger, no channel: nothing offered');
  assert.equal(await finOffersPaidFrom(async () => { throw new Error('relation "fin_books" does not exist'); }), false,
    'a read that fails offers nothing, and throws nothing at HR');
});

// ── The screens ──────────────────────────────────────────────────────────────────────────────

const SCREENS = [
  ['PayStaffModal.jsx', 1],
  ['BulkAdvances.jsx', 1],
  ['LoansAdvances.jsx', 3],     // Give advance, New loan, Prepay
  ['Payroll.jsx', 2],           // the batch Mark paid of the cash channel, and the bulk Mark paid (ruling R44)
  ['RunLineDrawer.jsx', 1],     // Mark paid
];

test('PaidFromSelect is used in each of the five screens', () => {
  for (const [file, uses] of SCREENS) {
    const src = strip(read(`../../client/src/pages/hr/${file}`));
    assert.match(src, /^import PaidFromSelect(?:, \{[^}]*\})? from '\.\/PaidFromSelect\.jsx';$/m, `${file} imports PaidFromSelect`);
    const n = (src.match(/<PaidFromSelect\b/g) ?? []).length;
    assert.ok(n >= uses, `${file} renders PaidFromSelect ${uses} time(s), found ${n}`);
  }
});

// A function's own code in a screen: from `function <name>(` to the next top-level function.
function componentOf(file, name) {
  const src = strip(read(`../../client/src/pages/hr/${file}`));
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is in ${file}`);
  const next = src.indexOf('\nfunction ', at + 1);
  return src.slice(at, next < 0 ? src.length : next);
}

// Rulings R44, R44a: the bulk Mark paid (Payroll's StatusDialog, POST /hr/runs/:month/lines/status) asks where the money came from when
// its ticked lines include the cash channel or a line of no pay channel, requires it there, and sends it as paid_from.
test('the bulk Mark paid dialog asks where the money came from for a cash line or a line of no channel, and sends it', () => {
  const dialog = componentOf('Payroll.jsx', 'StatusDialog');
  assert.match(dialog, /<PaidFromSelect\b[^>]*\brequired\b/, 'it shows PaidFromSelect, required');
  assert.match(dialog, /paidFromProblem\(/, 'it blocks the save without a choice, in the server\'s words');
  assert.match(dialog, /paidFromBody\('paid_from', /, 'it sends the code as paid_from');
  assert.match(dialog, /change\.filter\(r => !r\.line\?\.pay_channel \|\| channelKindOf\(r\.line\.pay_channel\) === 'cash'\)/,
    'only when a ticked line is paid through the cash channel, or through none (ruling R44a)');
});

// Ruling R49: the line drawer's Mark paid asks where a line was paid from when it is paid again after failing out of its batch (HR keeps
// the batch link), whatever its channel, starting at the channel's own account; a bank line's first Mark paid names none (§7.3).
test('the line drawer asks where the money came from when a line is paid again after failing out of its batch, whatever its channel', () => {
  const box = componentOf('RunLineDrawer.jsx', 'PaymentBox');
  assert.match(box, /const repaid = line\?\.payment_batch_id != null && \(status === 'failed' \|\| status === 'reversed'\);/);
  assert.match(box, /const asksAccount = act === 'paid' && \(channelKind === 'cash' \|\| !channelCode \|\| repaid\);/,
    'a cash line, a line of no channel, or one paid again after failing out of its batch; never a bank line\'s first Mark paid');
  assert.match(box, /<PaidFromSelect\b[\s\S]*?\bchannelCode=\{channelCode\} required\b[\s\S]*?\/>/, 'starting at the channel\'s own account');
  assert.match(box, /\.\.\.\(asksAccount \? paidFromBody\('paid_from', paidFrom\) : \{\}\)/, 'it sends the code only when it asks');
});

// Ruling R47, on screen: once the list has been read and offers nothing, or cannot be read at all, the select hands the form null (the
// form sends no code, and the door takes cash) and says so in a short note that holds whatever the form requires; it never leaves '' for
// a required form to refuse. The door may say what it records then (`whenNone`): the drawer's line paid again stays with its batch.
test('PaidFromSelect hands null, with a note, when Finance offers nothing or its list cannot be read (ruling R47)', () => {
  const src = strip(read('../../client/src/pages/hr/PaidFromSelect.jsx'));
  assert.match(src, /\(\) => \{ if \(live\) setState\(\{ status: 'failed', options: \[\] \}\); \}/, 'a read that fails is a list of none');
  assert.match(src, /if \(settled\.current \|\| state\.status === 'loading'\) return;/, 'it settles once the list is in, or has failed');
  assert.match(src, /if \(!state\.options\.length\) \{ change\.current\(null\); return; \}/, 'nothing to choose: null');
  assert.match(src, /disabled=\{state\.status !== 'ready' \|\| none\} required=\{required && !none\}/, 'and no required picker then');
  assert.match(src, /export const paidFromProblem = \(value, required = true\) => \(required && value === '' \? PAID_FROM_REQUIRED : null\);/,
    'null is no problem for a form');
  const note = src.slice(src.indexOf('{none && ('));
  assert.ok(src.includes('{none && ('), 'the note shows whenever there is nothing to choose');
  assert.match(note.slice(0, 400), /, so \{whenNone\}\./, 'it says what the door records');
  assert.doesNotMatch(note.slice(0, 400), /\brequired\b/, 'the same note whatever the form requires');
  const drawer = componentOf('RunLineDrawer.jsx', 'PaymentBox');
  assert.match(drawer, /whenNone=\{repaid \? /, 'the drawer says a line paid again stays with its batch\'s account');
});

test('PaidFromSelect takes { value, onChange, channelCode, required, whenNone }, loads the options once per mount, and shares the server\'s sentence', () => {
  const src = strip(read('../../client/src/pages/hr/PaidFromSelect.jsx'));
  assert.match(src, /export default function PaidFromSelect\(\{ value, onChange, channelCode = null, required = false, whenNone = 'it is recorded as cash' \}\)/);
  assert.match(src, /hrApi\.paidFromOptions\(\)/);
  assert.match(src, /useEffect\(\(\) => \{[\s\S]*?hrApi\.paidFromOptions\(\)[\s\S]*?\}, \[\]\);/, 'read once, when it mounts');
  assert.match(src, /export const PAID_FROM_REQUIRED = 'Choose where it was paid from';/);
  // The server says the same words.
  for (const file of [LEDGERS, PAYROLL]) assert.match(read(file), /'Choose where it was paid from'/, file);
});

// Ruling R74 (Task 12's m1): a line of an advance sheet that is posted (paid out, its advance or loan made) can't be changed or dropped
// (R25: the server refuses it, 409 "Lines already paid out can't be changed."). So the grid shows it read-only, marked paid out, and a
// whole-grid save never sends a change to one: only a line the grid lets you change is ever in its draft.
test('R74: a posted line of an advance sheet is read-only on screen, with a small "paid out" mark, so no save meets the 409', () => {
  const src = strip(read('../../client/src/pages/hr/BulkAdvances.jsx'));
  assert.match(src, /const paidOut = Boolean\(line\?\.posted_at\);/);
  assert.match(src, /const edit = isDraft && canEnter && !paidOut;/, 'every box of the row is disabled by `edit`');
  for (const box of ['Advance or loan for', 'Amount for', 'Loan months for', 'Why the loan for', 'Remarks for']) {
    const at = src.indexOf(`aria-label={\`${box} \${p.name}\`}`);
    assert.ok(at > 0, `non-vacuous: the ${box} box`);
    const tag = src.slice(src.lastIndexOf('<', at), src.indexOf('/>', at) + 2);
    assert.match(tag, /disabled=\{!edit\}/, `the ${box} box is held by edit`);
  }
  assert.match(src, /\{paidOut && <span [^>]*>paid out<\/span>\}/, 'the mark');
  // and the keyboard's Enter or ↓ steps over a box it cannot change
  assert.match(src, /if \(el && !el\.disabled\) \{ el\.focus\(\); return; \}/);
});
