// The Cash & Bank page, /finance/cash (Cash & Bank spec §5, §5.1–§5.7, §6.3–§6.7, §7.5, §7.7; plan Task 14). The screens are JSX, which
// node cannot load, so they are held to the spec by their source: the nav item, the route, the realtime refresh, the book that never
// sorts, the keys, the adjustment that starts with nothing chosen, typed amounts, the unadjusted list, the HR inbox and the bundle. The
// screen's pure half (client/src/lib/finance/cash.js) is tested as code.
//
// Plan Task 15 adds the Setup and report screens around it (spec §5.4, §6.7, §7.3, §7.8, §7.9, §8, §9.4): Setup's HR & payroll tab, the
// opening corrections on the Opening Balances page, a holder's fields on the ledger form, the approval rules' line on corrections, the
// Reports page's Party bills, and the reversal of a correction. Their pins and their pure halves (setup.js, opening.js, reports.js) are at
// the foot of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  FIN_BRING_IN_MORE, FIN_CASH_UNOFFERED_ROLES, finAdjustRows, finAdjustedText, finBookRows, finBringInText, finCashLinkIn, finCashWarnings,
  finCashWindow, finControlText, finEntryChoices, finEntryDate, finEntryWarnings, finHrEventText, finHrFixText, finLedgerOfParty,
  finMonthWindow, finPendingRows, finPickAmount, finThrottleWait, finTogglePick, finUnofferedLedgerIds,
} from '../../client/src/lib/finance/cash.js';
import * as cashLib from '../../client/src/lib/finance/cash.js';
import { MINTING_POSTS } from '../../client/src/lib/writeOnce.js';
import * as setupLib from '../../client/src/lib/finance/setup.js';
import * as openingLib from '../../client/src/lib/finance/opening.js';
import * as reportsLib from '../../client/src/lib/finance/reports.js';

const CLIENT = new URL('../../client/src/', import.meta.url);
const read = path => readFileSync(new URL(path, CLIENT), 'utf8');
// A file's code without its comments, so a comment that names a rule is not taken for the code that keeps it.
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const PAGE = 'pages/finance/CashBank.jsx';
const TILES = 'components/finance/CashTiles.jsx';
const BOOK = 'components/finance/CashBookTable.jsx';
const FORM = 'components/finance/CashEntryForm.jsx';
const ADJUST = 'components/finance/AdjustPanel.jsx';
const COUNT = 'components/finance/CashCountDialog.jsx';
const INBOX = 'components/finance/HrInbox.jsx';
const NEW_FILES = [PAGE, TILES, BOOK, FORM, ADJUST, COUNT, INBOX];

// The object literal that opens at `start` (its `{`), up to its matching `}`. Quoted strings, template literals and nested braces are
// stepped over, so the braces of a render function or a JSX attribute do not end it early.
function objectAt(text, start) {
  const stack = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && text[i + 1] === '{') { stack.push('{'); i++; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { stack.push(c); continue; }
    if (c === '{') stack.push('{');
    else if (c === '}') {
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// What a file imports statically: every `import … from '…'` and bare `import '…'`. A dynamic import() is not one.
const staticImports = text => [
  ...[...text.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map(m => m[1]),
  ...[...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map(m => m[1]),
];

// ── The brief's pins ─────────────────────────────────────────────────────────────────────────────────────────────────

test('the nav item is the first Finance item, labelled Cash & Bank, with its short label for the tablet rail', () => {
  const nav = read('components/AppLayout.jsx');
  const group = nav.indexOf("group: 'Finance'");
  assert.ok(group > 0, 'non-vacuous: the Finance group is where this pin looks for it');
  const start = nav.indexOf('{ label:', group);
  const first = nav.slice(start, nav.indexOf('}', start) + 1);
  assert.equal(first, "{ label: 'Cash & Bank', to: '/finance/cash', icon: Wallet, roles: ['admin'], module: 'finance' }");
  assert.ok(start < nav.indexOf("{ label: 'Vouchers', to: '/finance', end: true", group), 'before Vouchers');
  assert.match(nav, /'\/finance\/cash': 'Cash'/);
  assert.match(nav, /^\s+ReceiptText, Wallet,/m, 'Wallet is imported already (the Accounts item uses it)');
});

test('the Finance shell routes cash/* to the page, lazily, with what every page is given', () => {
  const shell = read('pages/finance/Finance.jsx');
  assert.match(shell, /const CashBank = lazy\(\(\) => import\('\.\/CashBank\.jsx'\)\);/);
  assert.match(shell, /<Route path="cash\/\*" element=\{<CashBank me=\{me\} book=\{book\} can=\{can\} setBook=\{setBook\} reloadMe=\{reloadMe\} \/>\} \/>/);
  assert.match(read(PAGE), /^export default function CashBank\(\{ me, book, can, setBook \}\) \{/m);
});

test('CashBank refreshes itself through useRealtimeRefresh with FINANCE_TABLES', () => {
  const page = code(read(PAGE));
  assert.match(page, /import \{ FINANCE_TABLES \} from '\.\.\/\.\.\/lib\/finance\/tables\.js';/);
  assert.match(page, /import useRealtimeRefresh from '\.\.\/\.\.\/lib\/useRealtimeRefresh\.js';/);
  assert.match(page, /useRealtimeRefresh\(\w+, FINANCE_TABLES\);/);
});

test('every CashBookTable column has sortable: false, and nothing else orders the rows', () => {
  const book = code(read(BOOK));
  const columns = [...book.matchAll(/\{ key: '/g)].map(m => objectAt(book, m.index));
  assert.ok(columns.length >= 10, `non-vacuous: only ${columns.length} columns found (the book's and the pending list's)`);
  for (const column of columns) {
    assert.ok(column, 'a column object that does not close');
    assert.match(column, /\bsortable: false\b/, `this column sorts: ${column.slice(0, 80)}`);
  }
  // DataTable sorts by its first sortable column when no defaultSort is given, and a default, a pinned row, a group or a merged
  // column's sub-sorts would each move rows: the book keeps the server's order (date, then entry order).
  for (const reorders of ['defaultSort', 'sortKeys', 'pinTop', 'groupBy', 'sortValue']) assert.ok(!book.includes(reorders), reorders);
  assert.doesNotMatch(book, /\.sort\(/, 'and the rows are never sorted here');
});

test('CashEntryForm handles r, p and t when nothing that takes typing has focus, and Ctrl+Enter saves', () => {
  const form = code(read(FORM));
  for (const [key, entry] of [['r', 'receive'], ['p', 'pay'], ['t', 'transfer']]) {
    assert.match(form, new RegExp(`\\['${key}', '${entry}'\\]`), `${key} opens ${entry}`);
  }
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.ok(form.includes(`'${tag}'`), `focus in a ${tag} keeps the key`);
  assert.match(form, /isContentEditable/);
  assert.match(form, /useSaveKey\(save, !asking\);/, 'Ctrl+Enter saves, wherever focus is (ruling R72)');
  assert.match(form, /key === 'Escape'/, 'Esc is the dialog\'s, and a picker\'s open list keeps its own');
  // the page listens through the form's hook, and only while nothing else is open
  assert.match(code(read(PAGE)), /useEntryKeys\(/);
});

test("AdjustPanel starts with neither choice made, and offers Auto – oldest first before I'll pick", () => {
  const panel = code(read(ADJUST));
  assert.match(panel, /const \[mode, setMode\] = useState\(null\);/);
  assert.doesNotMatch(panel, /useState\('(auto|pick)'\)/, 'nothing is pre-chosen');
  const auto = panel.indexOf('Auto – oldest first');
  const pick = panel.indexOf("I'll pick");
  assert.ok(auto > 0, 'Auto – oldest first is offered');
  assert.ok(pick > auto, "I'll pick comes after it, in the source and so in the tab order");
});

test('CashEntryForm reads every typed amount with finToPaiseTyped and shows money with finFormatINR', () => {
  const form = code(read(FORM));
  assert.match(form, /import \{[^}]*\bfinToPaiseTyped\b[^}]*\} from '\.\.\/\.\.\/lib\/finance\/money\.js';/);
  assert.match(form, /finToPaiseTyped\(/);
  assert.match(form, /finFormatINR\(/);
  // never float maths on rupees, in any of the screen's files
  for (const file of NEW_FILES) {
    const text = code(read(file));
    assert.doesNotMatch(text, /parseFloat|\* 100\b|\/ 100\b|toFixed\(/, `${file} does float maths on money`);
  }
  for (const file of [COUNT, ADJUST]) assert.match(code(read(file)), /finToPaiseTyped\(/, `${file} reads typed amounts the same way`);
});

test('CashBank reads /finance/cash/unadjusted and offers Adjust on each item', () => {
  const page = code(read(PAGE));
  assert.match(page, /api\.get\(`\/finance\/cash\/unadjusted\?book=\$\{book\.id\}`\)/);
  assert.match(page, /import \{ AdjustDialog \} from '\.\.\/\.\.\/components\/finance\/AdjustPanel\.jsx';/);
  assert.match(page, />Adjust<\/Button>/);
  const adjust = code(read(ADJUST));
  assert.match(adjust, /api\.put\(`\/finance\/lines\/\$\{[\w.]+\}\/allocations`, \{ mode/, 'an Adjust saves through the redo route');
});

test('nothing in Finance statically imports the exporter or exceljs', () => {
  const files = [];
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, dir));
      else if (/\.jsx?$/.test(e.name)) files.push(new URL(e.name, dir));
    }
  };
  for (const dir of ['pages/finance/', 'components/finance/', 'lib/finance/']) walk(new URL(dir, CLIENT));
  assert.ok(files.length > 40, `non-vacuous: only ${files.length} Finance client files`);
  for (const file of NEW_FILES) assert.ok(files.some(f => f.pathname.endsWith(file)), `${file} is among them`);
  for (const file of files) {
    const imports = staticImports(readFileSync(file, 'utf8'));
    assert.deepEqual(imports.filter(path => /exporter|exceljs/.test(path)), [], file.pathname.split('/client/src/')[1]);
  }
  assert.ok(staticImports(read(PAGE)).length > 5, 'non-vacuous: the page\'s imports are read');
});

// ── Beyond the brief's pins: what each screen says to the server, and the rules for the screens ──────────────────────

test('the entry form sends the entry route exactly the fields it reads, with one save key per opened form', () => {
  const form = code(read(FORM));
  assert.match(form, /api\.post\('\/finance\/cash\/entries', body\)/);
  const at = form.indexOf('const body = {');
  assert.ok(at > 0, 'non-vacuous: the body is built where this pin looks');
  const body = objectAt(form, at + 'const body = '.length);
  assert.ok(body && body.length > 100, 'and it is read whole');
  for (const field of ['book_id', 'entry_type', 'voucher_date', 'account_ledger_id', 'other_ledger_id', 'amount_paise', 'tds_paise',
    'reference', 'narration', 'adjust', 'client_key']) assert.match(body, new RegExp(`\\b${field}\\b`), field);
  assert.match(form, /finNewSaveKey\(\)/);
  assert.match(form, /replay_differs/, 'a retry that asked for another entry says the changes were not saved (ruling R11)');
});

test('the adjustment previews before it is saved, says Nothing open when nothing is, and a redo previews as a redo', () => {
  const panel = code(read(ADJUST));
  assert.match(panel, /api\.post\('\/finance\/allocations\/preview', /);
  assert.ok(panel.includes('Nothing open'));
  for (const field of ['ledger_id', 'side', 'amount_paise', 'mode', 'picks', 'reference', 'line_id']) {
    assert.match(panel, new RegExp(`\\b${field}\\b`), field);
  }
  // what is saved is the server's: the form sends the choice, never the preview's allocations
  const form = code(read(FORM));
  assert.match(form, /adjust: party && choice\?\.mode \? \{ mode: choice\.mode, picks: choice\.mode === 'pick' \? choice\.picks : \[\] \} : null/);
});

test('Redo works from a book row, through the party line of its voucher', () => {
  const page = code(read(PAGE));
  const book = code(read(BOOK));
  assert.match(book, /onRedo/);
  assert.match(book, /r\.adjustment != null/, 'Redo is offered on an entry that settles bills');
  assert.match(page, /api\.get\(`\/finance\/vouchers\/\$\{[\w.]+\}`\)/, 'the party line is read from the voucher');
  assert.match(page, /\.is_party/);
});

test('holder shortcuts: Give cash, Top up only when there is something to top up, and Return', () => {
  const tiles = code(read(TILES));
  for (const label of ['Give cash', 'Top up', 'Return']) assert.ok(tiles.includes(label), label);
  assert.match(tiles, /top_up_paise > 0 &&/);
  assert.match(tiles, /mayEnter/, 'the shortcuts are an entry, and hidden from a login that cannot enter one');
});

test('Count cash records a count, and its difference is cleared from it', () => {
  const count = code(read(COUNT));
  assert.match(count, /api\.post\('\/finance\/cash\/counts', \{ book_id: book\.id, ledger_id: \w+, count_date: \w+, counted_paise, note/);
  assert.match(count, /api\.post\(`\/finance\/cash\/counts\/\$\{[\w.]+\}\/clear`\)/);
  assert.match(count, /api\.get\(`\/finance\/cash\/counts\?ledger=\$\{[\w.]+\}`\)/);
});

test('the staff note says staff money is paid in HR, and links there only for a login with HR access', () => {
  const form = code(read(FORM));
  assert.ok(form.includes('Staff advances and salaries are paid in HR'));
  assert.match(form, /hrAccess \? <Link to="\/hr"/);
  const page = code(read(PAGE));
  assert.match(page, /hrApi\.me\(\)/);
  assert.match(page, /levelAtLeast\(answer\?\.level, 'viewer'\)/);
});

test('pending vouchers are drawn apart, greyed, with their own subtotal', () => {
  const book = code(read(BOOK));
  assert.match(book, /finPendingRows\(/);
  assert.match(book, /not in the balance/);
  assert.match(book, /opacity-60/);
});

test('links in: ?receive_customer= and ?pay_vendor= open Receive and Pay on that party\'s ledger', () => {
  const page = code(read(PAGE));
  assert.match(page, /finCashLinkIn\(params\)/);
  assert.match(page, /finLedgerOfParty\(/);
  assert.match(page, /change\(\{ receive_customer: null, pay_vendor: null \}\)/, 'the link is used once, so a reload does not open it again');
});

test('the header counts come from count-only reads: the tiles\' unadjusted figure and the HR status', () => {
  const page = code(read(PAGE));
  assert.match(page, /api\.get\(`\/finance\/cash\/accounts\?book=\$\{book\.id\}`\)/);
  assert.match(page, /api\.get\(`\/finance\/hr\/status\?book=\$\{book\.id\}`\)/);
  assert.match(page, /\.unadjusted\b/);
  assert.match(page, /api\.get\(finWithLeanRows\(`\/finance\/cash\/book\?\$\{/, 'the book, in lean rows (ruling R65)');
});

test('the HR inbox: Bring in and Retry for a login that can enter, the fix in words, counts and sentences only (privacy)', () => {
  const inbox = code(read(INBOX));
  assert.match(inbox, /api\.post\('\/finance\/hr\/bring-in', \{ book_id: book\.id \}\)/);
  assert.match(inbox, /api\.post\(`\/finance\/hr\/exceptions\/\$\{[\w.]+\}\/retry`\)/);
  assert.match(inbox, /api\.get\(`\/finance\/hr\/exceptions\?book=\$\{book\.id\}`\)/);
  assert.match(inbox, /FIN_BRING_IN_MORE/);
  assert.match(inbox, /finHrFixText\(/);
  assert.match(inbox, /mayEnter &&/);
  // ruling R51: the control check's drill-down is HR's own per-person screen, for a login with HR access only
  assert.match(inbox, /hrAccess && [\s\S]{0,200}to="\/hr\?tab=loans"/);
  // an exception's HR row id is the server's; the screen shows its kind, its HR document number and the server's sentences
  for (const file of [INBOX, PAGE]) assert.doesNotMatch(code(read(file)), /\bhr_id\b/, `${file} names an HR row`);
  assert.match(inbox, /finHrEventText\(/);
  assert.match(inbox, /\.reason\b/);
});

test('capabilities: entries, counts, redo and adjust are offered only to a login that can enter', () => {
  const page = code(read(PAGE));
  assert.match(page, /const mayEnter = can\('enter'\);/);
  for (const file of [BOOK, COUNT]) assert.match(code(read(file)), /mayEnter/, file);
});

test('light theme only, and no line-by-line entrance animation', () => {
  for (const file of NEW_FILES) {
    const text = code(read(file));
    assert.doesNotMatch(text, /\bdark:/, `${file} has a dark-mode class`);
    assert.doesNotMatch(text, /animationDelay|transitionDelay|delay-\[|\bdelay-\d|stagger/i, `${file} staggers`);
  }
});

// ── Fix round 1 (findings F1–F5, rulings R57–R59) ────────────────────────────────────────────────────────────────

// A function's body, from its head to its matching brace.
const bodyOf = (text, head) => {
  const at = text.indexOf(head);
  assert.ok(at >= 0, `non-vacuous: ${head} is where this pin looks for it`);
  return objectAt(text, text.indexOf('{', at + head.length - 1));
};

test('F1: the entry form takes its Enter keys in the capture phase, before a picker sees them', () => {
  const form = code(read(FORM));
  assert.match(form, /<div data-ci-form ref=\{bodyRef\} onKeyDownCapture=\{onKeyDownCapture\} onKeyDown=\{onKeyDown\}\s/);
  assert.match(form, /const PICKER_BOXES = new Set\(\['account', 'other'\]\);/);
  const capture = bodyOf(form, 'const onKeyDownCapture = e => {');
  // Ctrl or Cmd with Enter saves wherever focus is, and the picker never sees it (it would choose its lit option instead): caught on
  // window before this, by useSaveKey (ruling R72, below), so this handler has none of it
  assert.doesNotMatch(capture, /ctrlKey|metaKey/);
  assert.match(form, /useSaveKey\(save, !asking\);/);
  // Enter or Shift+Enter in a picker with nothing typed (its list opened on focus, its first option lit) moves on and chooses nothing;
  // once something is typed in it, or its list is steered with the arrows, Enter is the picker's own
  assert.match(capture, /if \(PICKER_BOXES\.has\(box\) && \(typedIn\(e\.target, box\) \|\| steered\.current === e\.target\)\) return;/);
  // typed is the picker's own text, empty when nothing is typed: its chosen ledger's name, put back after an Esc, is not typing
  const typed = bodyOf(form, 'const typedIn = (input, box) => {');
  assert.match(typed, /const text = input\.value\.trim\(\);/);
  assert.match(typed, /return text !== '' && text !== \(ledgerById\.get\(box === 'account' \? account : other\)\?\.name \?\? null\);/);
  assert.match(capture, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*move\(e\.target, shiftKey \? -1 : 1\);/);
  assert.match(capture, /if \(key === 'ArrowDown' \|\| key === 'ArrowUp'\) \{ if \(PICKER_BOXES\.has\(box\)\) steered\.current = e\.target; return; \}/);
  assert.match(form, /onFocusCapture=\{e => \{ if \(steered\.current !== e\.target\) steered\.current = null; \}\}/, 'a picker is unsteered again when focus comes to it');
  // a picker's list closes when focus leaves it by the keyboard (it closes itself only on a click outside it)
  assert.match(capture, /if \(key === 'Tab' && PICKER_BOXES\.has\(box\)\) \{ closeLists\(\); return; \}/);
  assert.match(bodyOf(form, 'const move = (from, step) => {'), /if \(PICKER_BOXES\.has\(from\.getAttribute\('data-fin-box'\)\)\) closeLists\(\);/);
  // the bubbling handler keeps only Esc
  const bubble = bodyOf(form, 'const onKeyDown = e => {');
  assert.match(bubble, /key === 'Escape'/);
  assert.doesNotMatch(bubble, /Enter/);
});

test('F1: the count dialog takes Ctrl+Enter, and Enter in its account picker, the same way as the entry form', () => {
  const count = code(read(COUNT));
  assert.match(count, /<div data-ci-form onKeyDownCapture=\{onKeyDownCapture\} onFocusCapture=/);
  const capture = bodyOf(count, 'const onKeyDownCapture = e => {');
  // Ctrl or Cmd with Enter records the count wherever focus is: caught on window before this (useSaveKey, ruling R72)
  assert.doesNotMatch(capture, /ctrlKey|metaKey/);
  assert.match(count, /useSaveKey\(\(\) => \{ if \(mayEnter && account != null\) record\(\); \}\);/);
  assert.match(capture, /if \(box === 'account' && \(typedIn\(e\.target\) \|\| steered\.current === e\.target\)\) return;/);
  assert.match(bodyOf(count, 'const typedIn = input => {'), /return text !== '' && text !== \(tile \? labelOf\(tile\) : null\);/);
  assert.match(capture, /if \(key === 'Tab' && box === 'account'\) \{ closeLists\(\); return; \}/);
  assert.match(bodyOf(count, 'const onKeyDown = e => {'), /key === 'Escape'/, 'an open list keeps its own Esc here too');
  assert.match(capture, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  assert.match(count, /data-fin-box="account"/);
});

test('F2 / R59: the form asks the preview for the party\'s cash that day, adds this entry, and says no caveat', () => {
  const form = code(read(FORM));
  assert.match(form, /cashDay=\{finIsValidDate\(date\) && account != null \? \{ voucher_date: date, account_ledger_id: account, client_key: saveKey\.current \} : null\}/);
  assert.doesNotMatch(read(FORM), /the saved answer counts the day/, 'the caveat line is gone');
  const panel = code(read(ADJUST));
  assert.match(panel, /\{ ledger_id: ledgerId, side, amount_paise: money, mode, picks, reference: ref \|\| null, \.\.\.\(cashDay \?\? \{\}\) \}/);
  const lib = read('lib/finance/cash.js');
  assert.match(lib, /preview\?\.party_cash_day_paise/);
});

test('F3: a realtime tick inside the minute leaves one catch-up read of HR\'s line, and the timer goes with the page', () => {
  const page = code(read(PAGE));
  const soon = bodyOf(page, 'const loadStatusSoon = useCallback(() => {');
  assert.match(soon, /const wait = finThrottleWait\(Date\.now\(\), statusAt\.current, STATUS_EVERY_MS\);/);
  assert.match(soon, /if \(statusTimer\.current == null\) statusTimer\.current = setTimeout\(\(\) => \{ statusTimer\.current = null; loadStatus\(\); \}, wait\);/);
  assert.match(page, /useEffect\(\(\) => \(\) => clearTimeout\(statusTimer\.current\), \[\]\);/);
  assert.match(bodyOf(page, 'const loadStatus = useCallback(() => {'), /clearTimeout\(statusTimer\.current\);/, 'a read in the meantime makes the catch-up needless');
  assert.match(page, /const load = useCallback\(\(\) => Promise\.all\(\[[^\]]*loadStatusSoon\(\),\s*\]\)/);
  assert.doesNotMatch(page, /Date\.now\(\) - statusAt\.current >= STATUS_EVERY_MS \? loadStatus\(\) : null/, 'no tick skips HR\'s line with nothing left to catch up');
});

test('F4 / R58: the panel shows the party\'s outstanding and its money already on account, read once per party', () => {
  const panel = code(read(ADJUST));
  assert.match(panel, /api\.get\(`\/finance\/ledgers\/\$\{ledgerId\}\/open-items`\)/);
  assert.match(panel, /\}, \[ledgerId\]\);/, 'read again only for another party');
  for (const field of ['outstanding_paise', 'on_account_paise']) assert.match(panel, new RegExp(`standing\\.${field}`), field);
});

test('F5 / R57: every save on the new screens is one press at a time, the keyboard\'s included', () => {
  const guarded = [
    [FORM, 'async function save() {', 'savingRef'],
    [ADJUST, 'const save = useCallback(async () => {', 'savingRef'],
    [COUNT, 'const record = async () => {', 'savingRef'],
    [COUNT, 'const clear = async count => {', 'savingRef'],
    [INBOX, 'const bringIn = async () => {', 'busyRef'],
    [INBOX, 'const retry = async row => {', 'busyRef'],
  ];
  for (const [file, head, ref] of guarded) {
    const body = bodyOf(code(read(file)), head);
    assert.match(body, new RegExp(`if \\((?:[^)]*\\|\\| )?${ref}\\.current\\) return;`), `${file} ${head} has no in-flight guard`);
    assert.match(body, new RegExp(`${ref}\\.current = true;`), `${file} ${head} never sets it`);
    assert.match(body, new RegExp(`finally \\{[^}]*${ref}\\.current = false;`), `${file} ${head} never lets it go`);
  }
  // a count mints no number, so the client's join (writeOnce) is not for it: the dialog's guard is what holds a double press
  assert.ok(!MINTING_POSTS.includes('/finance/cash/counts'));
  assert.ok(MINTING_POSTS.includes('/finance/cash/counts/:id/clear') && MINTING_POSTS.includes('/finance/cash/entries'));
});

// ── The final fix wave (rulings R71, R72) ─────────────────────────────────────────────────────────────────────────

// Ruling R71: Adjust, on an item of the money on account, settles only that money and keeps what its line settles already; Redo, on a
// book row, works the whole line again. The dialog is the same, so the page names which (`scope`), the preview and the save carry it,
// and the dialog says it in words.
test('R71: Adjust settles only the money on account, Redo works the whole line again: the page names which, the server is told, the screen says it', () => {
  const page = code(read(PAGE));
  const adjust = code(read(ADJUST));
  assert.match(bodyOf(page, 'const redo = async entry => {'), /setAdjusting\(\{\s*scope: 'line', line_id: line\.id,/);
  assert.match(page, /const adjust = item => setAdjusting\(\{\s*scope: 'open', line_id: item\.line_id,/);
  // the save and the preview carry the scope the dialog was opened with
  assert.match(adjust, /api\.put\(`\/finance\/lines\/\$\{target\.line_id\}\/allocations`, \{ mode: choice\.mode, picks: choice\.mode === 'pick' \? choice\.picks : \[\], scope: target\.scope \}\)/);
  assert.match(adjust, /<AdjustPanel ledgerId=\{target\.ledger_id\} lineId=\{target\.line_id\} scope=\{target\.scope\} onChange=\{setChoice\} \/>/);
  assert.match(adjust, /\? \{ ledger_id: ledgerId, line_id: lineId, scope, mode, picks, reference: ref \|\| null \}/);
  // …and both say which they are doing, by the server's own figure for the money
  assert.match(adjust, /scope === 'open' \? `\$\{finFormatINR\(amount\)\} on account to adjust` : `\$\{finFormatINR\(amount\)\} to adjust again`/);
  const note = bodyOf(adjust, 'export function AdjustDialog({ target, onClose, onDone }) {');
  assert.match(note, /target\.scope === 'open'/);
  assert.ok(note.includes('Adjust settles only the money still on account'), 'the Adjust dialog says so');
  assert.ok(note.includes('A redo works the whole entry again'), 'the Redo dialog says so');
});

// Ruling R72: while a Cash & Bank form or dialog is open, Ctrl or Cmd with Enter saves wherever focus is. A key caught on an element
// inside the dialog is lost once focus has left it (a bill ticked with the mouse re-renders its row, and focus falls to the body: the
// walkthrough's W1), so the three forms catch it on window, in the capture phase, through one hook, and keep their one-at-a-time saves.
const SAVE_KEY = 'components/finance/useSaveKey.js';
test('R72: the save key is caught on window in the capture phase while a form is open, and only Ctrl or Cmd with Enter, once a press', async () => {
  const hook = code(read(SAVE_KEY));
  assert.match(hook, /window\.addEventListener\('keydown', listen, true\);/);
  assert.match(hook, /return \(\) => window\.removeEventListener\('keydown', listen, true\);/);
  assert.match(hook, /if \(!enabled\) return undefined;/, 'nothing listens while the form is not the one with the keys');
  assert.match(hook, /const listen = finSaveKeyListener\(\(\) => latest\.current\(\)\);/, 'the newest save, as useEntryKeys keeps its newest');
  // the listener itself, as code: a fake event of each kind
  const { finSaveKeyListener } = await import(new URL(SAVE_KEY, CLIENT));
  const press = fields => {
    const seen = { prevented: false, stopped: false };
    return Object.assign(seen, { key: 'Enter', ctrlKey: false, metaKey: false, isComposing: false, repeat: false,
      preventDefault: () => { seen.prevented = true; }, stopPropagation: () => { seen.stopped = true; } }, fields);
  };
  let saves = 0;
  const listen = finSaveKeyListener(() => { saves += 1; });
  for (const e of [press({ ctrlKey: true }), press({ metaKey: true })]) {
    listen(e);
    assert.deepEqual([e.prevented, e.stopped], [true, true], 'the save, and nothing inside the dialog sees the key (a picker would choose)');
  }
  assert.equal(saves, 2);
  for (const e of [press({}), press({ shiftKey: true }), press({ ctrlKey: true, key: 's' }), press({ ctrlKey: true, isComposing: true }),
    press({ ctrlKey: true, repeat: true })]) {
    listen(e);
    assert.deepEqual([e.prevented, e.stopped], [false, false], JSON.stringify(e));
  }
  assert.equal(saves, 2, 'Enter alone, another key, an IME\'s Enter and a held key save nothing');
});

test('R72: Receive, Pay and Transfer, Redo and Adjust, and the count each save on that key, through their one-press save, and keep no Ctrl+Enter of their own', () => {
  for (const [file, use, guard, from] of [
    [FORM, /useSaveKey\(save, !asking\);/, 'async function save() {', 'export default function CashEntryForm('],
    [ADJUST, /useSaveKey\(save\);/, 'const save = useCallback(async () => {', null],
    [COUNT, /useSaveKey\(\(\) => \{ if \(mayEnter && account != null\) record\(\); \}\);/, 'const record = async () => {', null],
  ]) {
    const text = code(read(file));
    assert.match(text, /import useSaveKey from '\.\/useSaveKey\.js';/, file);
    assert.match(text, use, file);
    assert.match(bodyOf(text, guard), /if \((?:[^)]*\|\| )?savingRef\.current\) return;/, `${file}: the save it calls is one press at a time`);
    // the form's own code, from its head to the end of the file (the page's r, p and t, useEntryKeys, above the form, still look at Ctrl
    // and Cmd, to leave the browser's own shortcuts alone)
    const own = from == null ? text : text.slice(text.indexOf(from));
    assert.ok(own.length > 2000, `non-vacuous: ${file}'s own code is read`);
    assert.doesNotMatch(own, /ctrlKey|metaKey/, `${file} keeps a Ctrl+Enter of its own, which a focus outside it misses`);
  }
  assert.doesNotMatch(code(read(ADJUST)), /onKeyDown/, 'the Redo and Adjust dialog has no key handler of its own left');
});

// ── The screen's pure half (client/src/lib/finance/cash.js) ──────────────────────────────────────────────────────────

// The book's ledgers as GET /finance/books/:id/ledgers lists them: by name.
const L = (id, name, extra = {}) => ({ id, name, active: true, manual_entry: true, is_bank_cash: false, is_party: false, party_side: null, ...extra });
const ledgers = [
  L(1, 'Acme Pharma', { is_party: true, party_side: 'customer', party_type: 'customer', party_id: 41 }),
  L(2, 'Bank Current', { is_bank_cash: true }),
  L(3, 'Beta Supplies', { is_party: true, party_side: 'vendor', party_type: 'vendor', party_id: 7 }),
  L(4, 'Capital A/c'),
  L(5, 'Cash', { is_bank_cash: true }),
  L(7, 'Cash Short & Excess', { manual_entry: false }),
  L(6, 'Cash with Holder A', { is_bank_cash: true, holder_name: 'Holder A' }),
  L(8, 'Delta Traders', { is_party: true, party_side: 'customer' }),
  L(13, 'Gamma Vendors', { is_party: true, party_side: 'vendor' }),
  L(9, 'Old Bank', { is_bank_cash: true, active: false }),
  L(10, 'Rent'),
  L(11, 'Salaries & Wages', { manual_entry: false }),
  L(12, 'Staff Welfare'),
  L(14, 'Wages Mapped'),
];
const accounts = [
  { ledger_id: 5, name: 'Cash', account_kind: 'cash' }, { ledger_id: 6, name: 'Cash with Holder A', account_kind: 'holder' },
  { ledger_id: 2, name: 'Bank Current', account_kind: 'bank' }, { ledger_id: 9, name: 'Old Bank', account_kind: 'bank' },
];
const names = list => list.map(l => l.name);

test('the entry pickers: the accounts in the tiles\' order; customers first on Receive, vendors first on Pay; never a staff ledger', () => {
  const unoffered = finUnofferedLedgerIds({ salary_expense: 11, staff_advances: 14, cash_difference: 7, tds_receivable: 4 });
  assert.deepEqual([...unoffered].sort((a, b) => a - b), [7, 11, 14], 'the staff roles and Cash Short & Excess; a TDS ledger stays');
  const receive = finEntryChoices({ entry_type: 'receive', ledgers, accounts, unoffered });
  assert.deepEqual(names(receive.accounts), ['Cash', 'Cash with Holder A', 'Bank Current'], 'office cash, the holders, the banks; never one switched off');
  assert.deepEqual(names(receive.others), ['Acme Pharma', 'Delta Traders', 'Beta Supplies', 'Capital A/c', 'Gamma Vendors', 'Rent', 'Staff Welfare'],
    'the customers first, then every other ledger a receipt may name, each in the list\'s order');
  const pay = finEntryChoices({ entry_type: 'pay', ledgers, accounts, unoffered });
  assert.deepEqual(names(pay.others), ['Beta Supplies', 'Gamma Vendors', 'Acme Pharma', 'Capital A/c', 'Delta Traders', 'Rent', 'Staff Welfare']);
  const transfer = finEntryChoices({ entry_type: 'transfer', ledgers, accounts, unoffered, except: 6 });
  assert.deepEqual([names(transfer.accounts), names(transfer.others)], [['Cash', 'Cash with Holder A', 'Bank Current'], ['Cash', 'Bank Current']],
    'a transfer goes to another bank or cash account, never the one it comes from');
  assert.deepEqual(finEntryChoices({ entry_type: 'receive', ledgers: null, accounts: null }), { accounts: [], others: [] }, 'nothing loaded yet');
  assert.deepEqual(FIN_CASH_UNOFFERED_ROLES, ['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense', 'cash_difference']);
  assert.ok(Object.isFrozen(FIN_CASH_UNOFFERED_ROLES));
  for (const roles of [null, undefined, 'x', []]) assert.equal(finUnofferedLedgerIds(roles).size, 0, String(roles));
});

test('a link in names Receive from a customer or Pay to a vendor, by the ERP id; the ledger is the one linked to it', () => {
  const q = text => new URLSearchParams(text);
  assert.deepEqual(finCashLinkIn(q('receive_customer=41')), { entry_type: 'receive', party_type: 'customer', party_id: 41 });
  assert.deepEqual(finCashLinkIn(q('pay_vendor=7&tab=book')), { entry_type: 'pay', party_type: 'vendor', party_id: 7 });
  assert.deepEqual(finCashLinkIn(q('receive_customer=abc')), { entry_type: 'receive', party_type: 'customer', party_id: null },
    'a link that names no customer still opens Receive, with nobody chosen');
  assert.deepEqual(finCashLinkIn(q('receive_customer=41&pay_vendor=7')).entry_type, 'receive');
  for (const text of ['', 'tab=book', 'receive_customer=']) assert.equal(finCashLinkIn(q(text)), null, text);
  assert.equal(finCashLinkIn(null), null);
  assert.equal(finLedgerOfParty(ledgers, { party_type: 'customer', party_id: 41 }).name, 'Acme Pharma');
  assert.equal(finLedgerOfParty(ledgers, { party_type: 'vendor', party_id: 7 }).name, 'Beta Supplies');
  assert.equal(finLedgerOfParty(ledgers, { party_type: 'vendor', party_id: 41 }), null, 'a vendor is not a customer of the same id');
  assert.equal(finLedgerOfParty([{ ...ledgers[0], active: false }], { party_type: 'customer', party_id: 41 }), null, 'never a switched-off ledger');
  assert.equal(finLedgerOfParty(null, { party_type: 'customer', party_id: 41 }), null);
  assert.equal(finLedgerOfParty(ledgers, { party_type: 'customer', party_id: null }), null);
});

test('the book opens on this month, or on the month the books begin in while they have not begun; a month steps either way', () => {
  assert.deepEqual(finCashWindow('2027-03-14', '2027-01-01'), { from: '2027-03-01', to: '2027-03-31' });
  assert.deepEqual(finCashWindow('2026-11-21', '2027-01-01'), { from: '2027-01-01', to: '2027-01-31' }, 'before the books begin');
  assert.deepEqual(finCashWindow('2027-02-10', null), { from: '2027-02-01', to: '2027-02-28' });
  assert.deepEqual(finMonthWindow('2027-01-31', -1), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(finMonthWindow('2027-12-05', 1), { from: '2028-01-01', to: '2028-01-31' });
  assert.deepEqual(finMonthWindow('2028-02-10'), { from: '2028-02-01', to: '2028-02-29' }, 'a leap year');
  assert.equal(finEntryDate('2027-01-05', '2027-02-10', '2027-01-01'), '2027-01-05', 'the last date used');
  assert.equal(finEntryDate(null, '2027-02-10', '2027-01-01'), '2027-02-10', 'else today');
  assert.equal(finEntryDate('2027-13-40', '2026-11-21', '2027-01-01'), '2027-01-01', 'never before the books begin');
});

test('the adjustment preview says what each bill gets and what is left of it', () => {
  const items = [{ line_id: 1, open_paise: 2_000_000 }, { line_id: 2, open_paise: 3_500_000 }, { line_id: 3, open_paise: 4_000_000 }, { line_id: 4, open_paise: 100 }];
  const rows = finAdjustRows(items, [{ line_id: 1, amount_paise: 2_000_000 }, { line_id: 2, amount_paise: 3_500_000 }, { line_id: 3, amount_paise: 2_660_000 }]);
  assert.deepEqual(rows.map(r => [r.line_id, r.gets_paise, r.left_paise, r.settles]),
    [[1, 2_000_000, 0, 'all'], [2, 3_500_000, 0, 'all'], [3, 2_660_000, 1_340_000, 'part'], [4, 0, 100, null]]);
  assert.deepEqual(finAdjustRows(null, null), []);
  assert.equal(finAdjustedText({ allocations: [{ line_id: 1, amount_paise: 5 }, { line_id: 2, amount_paise: 5 }], on_account_paise: 0 }),
    'Adjusted: 2 bills, ₹0.00 on account');
  assert.equal(finAdjustedText({ allocations: [{ line_id: 1, amount_paise: 5 }], on_account_paise: 500_000 }), 'Adjusted: 1 bill, ₹5,000.00 on account');
  assert.equal(finAdjustedText({ allocations: [], on_account_paise: 500_000 }), 'Nothing settled: ₹5,000.00 on account');
});

test('a Pick\'s ticks keep their order; a tick takes all that is open until an amount is typed; unticking releases', () => {
  const start = [];
  const one = finTogglePick(start, 5);
  assert.deepEqual([start, one], [[], [{ line_id: 5, amount_paise: null }]], 'never changes the list it was given');
  const two = finTogglePick(one, 3);
  assert.deepEqual(two, [{ line_id: 5, amount_paise: null }, { line_id: 3, amount_paise: null }], 'tick order, not list order');
  assert.deepEqual(finPickAmount(two, 3, 120_000), [{ line_id: 5, amount_paise: null }, { line_id: 3, amount_paise: 120_000 }]);
  assert.deepEqual(finPickAmount(two, 3, null), two, 'a cleared amount is all that is open again');
  assert.deepEqual(finPickAmount(two, 9, 100), two, 'an amount for a bill not ticked changes nothing');
  assert.deepEqual(finTogglePick(two, 5), [{ line_id: 3, amount_paise: null }]);
});

test('the form\'s warnings never refuse: on account, the cash limits on the day (ruling R59), and a cash account or holder going below zero', () => {
  const cash = { ledger_id: 5, name: 'Cash', account_kind: 'cash', balance_paise: 500_000 };
  const holder = { ledger_id: 6, name: 'Cash with Holder A', holder_name: 'Holder A', account_kind: 'holder', balance_paise: 100_000 };
  const bank = { ledger_id: 2, name: 'Bank Current', account_kind: 'bank', balance_paise: -5_000_000 };
  const codes = args => finEntryWarnings(args).map(w => w.code);
  assert.deepEqual(codes({ entry_type: 'receive', account: cash, amount_paise: 20_000_000, preview: { on_account_paise: 300 } }), ['ON_ACCOUNT', 'S269ST']);
  assert.deepEqual(codes({ entry_type: 'pay', account: cash, amount_paise: 1_000_001, preview: null }), ['S40A3', 'BELOW_ZERO']);
  assert.deepEqual(codes({ entry_type: 'pay', account: bank, amount_paise: 1_000_001, preview: null }), [], 'a bank may run an overdraft');
  assert.deepEqual(codes({ entry_type: 'transfer', account: holder, amount_paise: 200_000, preview: null }), ['HOLDER_SHORT']);
  assert.equal(finEntryWarnings({ entry_type: 'transfer', account: holder, amount_paise: 200_000 })[0].sentence, 'Holder A holds less than this.');
  assert.deepEqual(codes({ entry_type: 'pay', account: cash, amount_paise: 0 }), [], 'no amount, nothing to say');
  assert.deepEqual(codes({ entry_type: 'pay', account: null, amount_paise: 100 }), []);
  // Ruling R59: the party's cash that day comes with the preview (party_cash_day_paise, this entry left out), and the form adds this
  // entry: a second cash receipt of ₹60,000 on a day the party already paid ₹1,50,000 in cash reaches ₹2,00,000 before it is saved
  assert.deepEqual(codes({ entry_type: 'receive', account: cash, amount_paise: 6_000_000, preview: { on_account_paise: 0, party_cash_day_paise: 15_000_000 } }),
    ['S269ST']);
  assert.deepEqual(codes({ entry_type: 'receive', account: cash, amount_paise: 6_000_000, preview: { on_account_paise: 0, party_cash_day_paise: 13_999_999 } }),
    [], 'a paisa short of ₹2,00,000 in the day is no warning');
  assert.deepEqual(codes({ entry_type: 'pay', account: cash, amount_paise: 600_000, preview: { on_account_paise: 0, party_cash_day_paise: 400_001 } }),
    ['S40A3', 'BELOW_ZERO'], '₹6,000 now and ₹4,000.01 earlier that day is over ₹10,000');
  assert.deepEqual(codes({ entry_type: 'pay', account: bank, amount_paise: 600_000, preview: { on_account_paise: 0, party_cash_day_paise: null } }), [],
    'by bank there is no cash limit (the server answers no figure)');
  assert.deepEqual(codes({ entry_type: 'transfer', account: cash, amount_paise: 100, preview: { party_cash_day_paise: 50_000_000 } }), [],
    'a transfer is no party\'s cash');
  // the very sentences of finCashWarnings, which the server says too, given the day's total
  assert.deepEqual(finEntryWarnings({ entry_type: 'receive', account: cash, amount_paise: 6_000_000, preview: { on_account_paise: 300, party_cash_day_paise: 15_000_000 } }),
    finCashWarnings({ entry_type: 'receive', is_cash: true, is_holder: false, account_name: 'Cash', party_cash_today_paise: 21_000_000,
      balance_after_paise: null, on_account_paise: 300 }));
});

test('HR\'s line is read at most once a minute, and a tick inside the minute waits for the rest of it (finThrottleWait)', () => {
  const minute = 60_000;
  assert.equal(finThrottleWait(1_000_000, 0, minute), 0, 'never read: now');
  assert.equal(finThrottleWait(1_000_000, 1_000_000 - minute, minute), 0, 'a minute on: now');
  assert.equal(finThrottleWait(1_000_000, 1_000_000 - 15_000, minute), 45_000, 'fifteen seconds on: the other forty-five');
  assert.equal(finThrottleWait(1_000_000, 1_000_000 + 5_000, minute), minute, 'a clock that went back waits a minute at most');
});

test('the book\'s rows: the opening, the entries in the server\'s order, the closing; pending apart with its own subtotal', () => {
  const book = {
    opening_paise: 21_040_000, closing_paise: 18_240_000, total_in_paise: 8_000_000, total_out_paise: 10_800_000, from: '2027-01-01', to: '2027-01-31',
    entries: [
      { date: '2027-01-05', voucher_id: 9, number: 'CI-RV-2627-0003', in_paise: 8_000_000, out_paise: 0, balance_paise: 29_040_000 },
      { date: '2027-01-02', voucher_id: 4, number: 'CI-CV-2627-0001', in_paise: 0, out_paise: 20_000_000, balance_paise: 1_040_000 },
    ],
    pending: [{ date: '2027-01-06', voucher_id: 12, in_paise: 0, out_paise: 12_000_000 }, { date: '2027-01-07', voucher_id: 13, in_paise: 50_000, out_paise: 0 }],
  };
  const rows = finBookRows(book);
  assert.deepEqual(rows.map(r => [r._row, r.kind, r.voucher_id ?? null, r.balance_paise]), [
    ['opening', 'opening', null, 21_040_000], ['e0', 'entry', 9, 29_040_000], ['e1', 'entry', 4, 1_040_000], ['closing', 'closing', null, 18_240_000],
  ], 'never re-sorted: the server\'s order is the one its running balance was worked out in');
  assert.deepEqual([rows[0].date, rows[3].date, rows[3].in_paise, rows[3].out_paise], ['2027-01-01', '2027-01-31', 8_000_000, 10_800_000]);
  assert.deepEqual(finBookRows(null), []);
  const pending = finPendingRows(book);
  assert.deepEqual([pending.rows.map(r => [r._row, r.voucher_id]), pending.in_paise, pending.out_paise], [[['p0', 12], ['p1', 13]], 50_000, 12_000_000]);
  assert.deepEqual(finPendingRows({ pending: [] }), { rows: [], in_paise: 0, out_paise: 0 });
});

// ── Ruling R65: the book's lines, lean ───────────────────────────────────────────────────────

test('R65: the book\'s lines go lean and come back exactly: the column names once, one array per line, the objects put back key for key', () => {
  const {
    FIN_BOOK_ENTRY_COLUMNS, FIN_BOOK_PENDING_COLUMNS, FIN_LEAN_ROWS_QUERY, finLeanBook, finLeanRows, finLeanRowsAsked, finRehydrateBook,
    finRehydrateRows, finWithLeanRows,
  } = cashLib;
  for (const fn of [finLeanBook, finLeanRows, finLeanRowsAsked, finRehydrateBook, finRehydrateRows, finWithLeanRows]) {
    assert.equal(typeof fn, 'function', 'lib/finance/cash.js exports the lean helpers');
  }
  // A book as finCashBook builds it: its entries' and pending lines' keys in the server's own order.
  const entry = over => ({
    date: '2027-01-05', voucher_id: 9, number: 'CI-RV-2627-0003', voucher_type: 'receipt', particulars: 'Acme Pharma', narration: null,
    adjustment: 'Auto: 3 bills, ₹0 on account', in_paise: 8_000_000, out_paise: 0, balance_paise: 29_040_000, ...over,
  });
  const book = {
    ledger: { id: 3, name: 'Office cash', book_id: 1, group_name: 'Cash-in-Hand', account_kind: 'cash', holder_name: null },
    from: '2027-01-01', to: '2027-01-31', opening_paise: 21_040_000,
    entries: [entry({}), entry({ voucher_id: 4, number: 'CI-CV-2627-0001', voucher_type: 'contra', particulars: 'Cash with Holder A',
      narration: 'Opening float', adjustment: null, in_paise: 0, out_paise: 1_000_000, balance_paise: 28_040_000 })],
    total_in_paise: 8_000_000, total_out_paise: 1_000_000, closing_paise: 28_040_000,
    pending: [{ date: '2027-01-06', voucher_id: 12, voucher_type: 'payment', particulars: 'Test Freight', narration: 'freight for January',
      in_paise: 0, out_paise: 12_000_000, submitted_by: 'Test Accountant' }],
  };
  assert.deepEqual([...FIN_BOOK_ENTRY_COLUMNS], Object.keys(book.entries[0]), 'the entry columns are the server\'s own keys, in order');
  assert.deepEqual([...FIN_BOOK_PENDING_COLUMNS], Object.keys(book.pending[0]), 'and the pending ones');

  const lean = finLeanBook(book);
  assert.deepEqual(Object.keys(lean), Object.keys(book), 'the rest of the book as it was, in its place');
  assert.deepEqual(lean.entries, { columns: [...FIN_BOOK_ENTRY_COLUMNS], rows: book.entries.map(e => Object.values(e)) },
    'the column names once, then one array per line');
  assert.deepEqual(lean.pending, { columns: [...FIN_BOOK_PENDING_COLUMNS], rows: book.pending.map(p => Object.values(p)) });
  // Put back from the wire, it is the book again, key for key and in the same order (JSON.stringify compares the order too).
  const back = finRehydrateBook(JSON.parse(JSON.stringify(lean)));
  assert.equal(JSON.stringify(back), JSON.stringify(book));
  assert.deepEqual(finBookRows(back), finBookRows(book), 'the table and the export see the rows they saw');
  assert.deepEqual(finPendingRows(back), finPendingRows(book));
  // An answer that is not lean (one asked for plainly) is handed back as the same object; nothing is not a book.
  assert.equal(finRehydrateBook(book), book);
  assert.equal(finRehydrateBook(null), null);
  assert.deepEqual(finRehydrateRows({ columns: ['a', 'b'], rows: [] }), []);
  assert.equal(finRehydrateRows(book.entries), book.entries);
  // A line whose keys are not exactly the columns, in their order, is a bug, never a field dropped on the way.
  assert.throws(() => finLeanRows([{ ...entry({}), extra: 1 }], FIN_BOOK_ENTRY_COLUMNS), /exactly the columns/);
  assert.throws(() => finLeanRows([{ voucher_id: 9, date: '2027-01-05' }], ['date', 'voucher_id']), /exactly the columns/, 'in their order');
  // Asked for exactly: rows=lean, the one string.
  assert.equal(FIN_LEAN_ROWS_QUERY, 'rows=lean');
  assert.equal(finWithLeanRows('/finance/cash/book?ledger=1&from=2027-01-01'), '/finance/cash/book?ledger=1&from=2027-01-01&rows=lean');
  assert.equal(finWithLeanRows('/finance/cash/book'), '/finance/cash/book?rows=lean');
  assert.equal(finLeanRowsAsked({ rows: 'lean' }), true);
  for (const query of [{}, { rows: 'LEAN' }, { rows: ['lean', 'lean'] }, { rows: 'lean ' }, { fields: 'lean' }, null, undefined]) {
    assert.equal(finLeanRowsAsked(query), false, JSON.stringify(query));
  }
});

test('R65: CashBank asks for the book in lean rows and puts them back once per response, before it keeps the answer', () => {
  const src = code(read(PAGE));
  assert.match(src, /api\.get\(finWithLeanRows\(`\/finance\/cash\/book\?\$\{new URLSearchParams\(\{ ledger: String\(accountId\), from, to \}\)\}`\)\)/);
  assert.doesNotMatch(src, /api\.get\(`\/finance\/cash\/book/, 'the book is never asked for as objects');
  // api.get hands back the SAME object for the same bytes: a fresh rehydration on every refresh would redraw the book for nothing.
  assert.match(src, /if \(hydratedBook\.current\.res !== res\) hydratedBook\.current = \{ res, data: finRehydrateBook\(res\) \};/);
  assert.match(src, /return hydratedBook\.current\.data;/);
  // …inside the book's own read, so what the page keeps, draws, exports and prints is the rehydrated book, never the wire's.
  const ask = /const loadBook = useCallback\([\s\S]*?\), \[read, accountId, from, to\]\);/.exec(src)?.[0] ?? '';
  assert.match(ask, /read\('book',[\s\S]*finRehydrateBook/, 'the rehydration is in the book\'s read');
  assert.match(src, /import \{[^}]*\bfinRehydrateBook\b[^}]*\bfinWithLeanRows\b[^}]*\} from '\.\.\/\.\.\/lib\/finance\/cash\.js';/);
});

test('the HR inbox in words: the event and its HR number, the fix, what Bring in did, and the control check', () => {
  assert.equal(finHrEventText({ type: 'batch', document_no: 'CI-PAY-0041' }), 'Salary paid · CI-PAY-0041');
  assert.equal(finHrEventText({ type: 'line', document_no: null }), 'Salary paid (one line)');
  assert.equal(finHrEventText({ type: 'hidden', document_no: null }), 'Combined salary entry');
  assert.equal(finHrEventText({ type: 'mystery', document_no: null }), 'HR entry', 'a type it does not know is an HR entry, no more');
  assert.match(finHrFixText('map_channel'), /Finance Setup → HR & payroll/);
  assert.match(finHrFixText('reopen_month'), /Months & Years/);
  assert.equal(finHrFixText('ask_md'), 'Ask the MD.');
  assert.equal(finHrFixText('nonsense'), 'Ask the MD.');
  assert.equal(finBringInText({ posted: 3, submitted: 1, skipped: 2, exceptions: ['FIN_UNMAPPED_CHANNEL'], more: false }),
    'Posted 3 · 1 waiting for approval · 2 skipped · 1 exception');
  assert.equal(finBringInText({ posted: 1, submitted: 0, skipped: 0, exceptions: ['A', 'B'], more: true }), 'Posted 1 · 2 exceptions');
  assert.equal(finBringInText({ posted: 0, submitted: 0, skipped: 0, exceptions: [], more: false }), 'Nothing to bring in');
  assert.equal(FIN_BRING_IN_MORE, 'More to bring in: press Bring in again');
  const item = gap => ({ finance_paise: 100, hr_paise: 100 + gap, gap_paise: gap });
  assert.deepEqual(finControlText({ advances: item(0), loans: item(0), salary_payable: null, matches: true }), { tone: 'good', text: 'matches' });
  assert.deepEqual(finControlText({ advances: item(0), loans: item(-250_000), salary_payable: item(0), matches: false }),
    { tone: 'warn', text: 'Staff loans differ by ₹2,500.00' });
  assert.deepEqual(finControlText({ advances: item(100), loans: item(-250_000), salary_payable: null, matches: false }), { tone: 'warn', text: '2 differences' });
  assert.deepEqual(finControlText(null), { tone: 'neutral', text: '—' });
});

// ── Plan Task 15: Setup and report screens ───────────────────────────────────────────────────────────────────────────

const HR_SETUP = 'components/finance/HrSetup.jsx';
const CORRECTION = 'components/finance/OpeningCorrection.jsx';
const PARTY = 'components/finance/PartyStatement.jsx';
const T15_NEW = [HR_SETUP, CORRECTION, PARTY];
const serverSrc = path => readFileSync(new URL(`./${path}`, import.meta.url), 'utf8');

test('Setup lists "HR & payroll" for every login that reads the book, after the approval rules, and draws HrSetup there', () => {
  assert.deepEqual(setupLib.FIN_SETUP_TABS.find(t => t.key === 'hr-payroll'), { key: 'hr-payroll', label: 'HR & payroll', cap: 'view' });
  const keys = setupLib.FIN_SETUP_TABS.map(t => t.key);
  assert.equal(keys.indexOf('hr-payroll'), keys.indexOf('approval-rules') + 1);
  assert.ok(setupLib.finSetupTabs(cap => cap === 'view').some(t => t.key === 'hr-payroll'), 'a viewer reads it: only an Admin changes it');
  assert.equal(setupLib.finSetupTab('hr-payroll', cap => cap === 'view'), 'hr-payroll');
  const page = code(read('pages/finance/Setup.jsx'));
  assert.match(page, /import HrSetup from '\.\.\/\.\.\/components\/finance\/HrSetup\.jsx';/);
  assert.match(page, /\{tab === 'hr-payroll' && <HrSetup me=\{me\} book=\{book\} can=\{can\} \/>\}/);
});

test('HrSetup posts to /finance/hr-setup/ledgers, saves the whole state in one PUT, says the server\'s sentences as they come, and only an Admin edits', () => {
  const hr = code(read(HR_SETUP));
  assert.match(hr, /^export default function HrSetup\(\{ me, book, can \}\) \{/m);
  assert.match(hr, /const setupRead = useReport\(`\/finance\/hr-setup\?book=\$\{book\.id\}`\);/, 'the setup, through useReport');
  assert.match(hr, /api\.post\('\/finance\/hr-setup\/ledgers', \{ book_id: book\.id \}\)/);
  assert.match(hr, /disabled=\{!setup \|\| changes > 0\}>Create the staff ledgers<\/Button>/, 'made from what is saved, so not over changes not saved yet');
  assert.match(hr, /const body = finHrSetupBody\(\{ bookId: book\.id, setup, edits \}\);/);
  assert.match(hr, /api\.put\('\/finance\/hr-setup', body\)/);
  assert.match(hr, /<Button onClick=\{save\} disabled=\{!setup \|\| changes === 0\}>Save<\/Button>/);
  assert.match(hr, /const changes = setup \? finHrSetupChanges\(setup, edits\) : 0;/);
  // capability: only an Admin edits; everyone else reads the same rows as text
  assert.match(hr, /const mayEdit = can\('admin'\);/);
  assert.match(hr, /\{mayEdit && \(/);
  assert.match(hr, /mayEdit \? \(/, 'a picker for the Admin, the ledger\'s name for anyone else');
  // the server's refusal, under the row it names, else at the foot, in its own words
  assert.match(hr, /const \{ problems, attempt \} = useFormWrite\(\);/);
  assert.match(hr, /finHrProblemRow\(problemField, sentRef\.current\)/);
  assert.match(hr, /<FieldError>\{atFoot\}<\/FieldError>/);
  // the rows: one per HR channel, the roles, one per expense key, and the booking
  for (const rows of ['finHrChannelRows(setup, edits)', 'finHrRoleRows(setup, edits)', 'finHrExpenseRows(setup, edits)']) assert.ok(hr.includes(rows), rows);
  assert.match(hr, /FIN_PAYROLL_BOOKINGS\.map\(/);
  // an unmapped CASH shows office cash as the default, never as a saved choice
  assert.match(hr, /r\.default_ledger_id != null/);
  assert.ok(hr.includes('(default)'));
  // the channel pickers: the bank and cash ledgers of every book the login reads
  assert.match(hr, /finHrAccountChoices\(lists, book\.id, /);
  assert.match(hr, /useLedgerLists\(me\?\.books\?\.length \? me\.books : \[book\]\)/);
  // one press at a time (ruling R57): the save and the staff ledgers' write share one guard
  for (const head of ['const save = async () => {', 'const makeStaffLedgers = async () => {']) {
    const body = bodyOf(hr, head);
    assert.match(body, /if \(busyRef\.current\) return;/, head);
    assert.match(body, /busyRef\.current = true;/, head);
    assert.match(body, /finally \{[^}]*busyRef\.current = false;/, head);
  }
  // a form scope to the update bar while it holds changes not saved yet
  assert.match(hr, /<div data-ci-form>/);
  assert.ok(!MINTING_POSTS.includes('/finance/hr-setup/ledgers') && !MINTING_POSTS.includes('/finance/hr-setup'), 'neither write mints a number');
});

test('the HR & payroll rows and body: the channels it can see as they stand or changed and a new map, every role, the keys as saved, and the booking; the CASH default is never saved', () => {
  const setup = {
    channels: [{ channel_code: 'COLOUR', book_id: 1, ledger_id: 21 }, { channel_code: 'GONE', book_id: 1, ledger_id: 22 }],
    cash_default: { book_id: 1, ledger_id: 11 },
    roles: { staff_advances: 31, salary_expense: 34, rounding: 39 },
    expense_map: [{ hr_key: 'dept:Pasting', ledger_id: 51 }, { hr_key: 'dept:Old Dept', ledger_id: 52 }],
    payroll_booking: 'month_end',
    hr_channels: [{ code: 'CASH', name: 'Cash', kind: 'cash' }, { code: 'COLOUR', name: 'Colour bank', kind: 'bank' }, { code: 'DARBI', name: 'Darbi bank', kind: 'bank' }],
    expense_keys: [{ key: 'type:employee', label: 'Person type · Employee' }, { key: 'dept:pasting', label: 'Department · Pasting' }],
  };
  // one row per HR channel, in HR's order; a map whose channel HR no longer has is shown, and never sent (the server refuses its code)
  assert.deepEqual(setupLib.finHrChannelRows(setup, {}).map(r => [r.code, r.name, r.kind, r.saved, r.value, r.default_ledger_id, r.stale]), [
    ['CASH', 'Cash', 'cash', null, null, 11, false],
    ['COLOUR', 'Colour bank', 'bank', 21, 21, null, false],
    ['DARBI', 'Darbi bank', 'bank', null, null, null, false],
    ['GONE', 'GONE', null, 22, 22, null, true],
  ]);
  // CASH keeps its default beside it, whatever it is mapped to; the screen says it only while CASH pays from no account of its own
  assert.equal(setupLib.finHrChannelRows(setup, { channels: { CASH: 12 } })[0].default_ledger_id, 11);
  // the twelve roles, each as saved or as changed
  const roles = setupLib.finHrRoleRows(setup, { roles: { staff_loans: 32 } });
  assert.deepEqual(roles.map(r => r.key), setupLib.FIN_HR_ROLES.map(r => r.key));
  assert.deepEqual(roles.slice(0, 4).map(r => [r.key, r.saved, r.value]), [['staff_advances', 31, 31], ['staff_loans', null, 32], ['salary_payable', null, null], ['salary_expense', 34, 34]]);
  // one row per expense key, found whatever its capitals; a saved key no one in HR has now is shown after them
  assert.deepEqual(setupLib.finHrExpenseRows(setup, {}).map(r => [r.key, r.label, r.saved?.hr_key ?? null, r.value, r.gone]), [
    ['type:employee', 'Person type · Employee', null, null, false],
    ['dept:pasting', 'Department · Pasting', 'dept:Pasting', 51, false],
    ['dept:old dept', 'Department · Old Dept', 'dept:Old Dept', 52, true],
  ]);

  // an untouched form: the maps it can see as they stand; no unmapped channel (one may be mapped into a book out of sight, and sending
  // it as none would be refused); every role; the saved keys as they were spelt (a key in other capitals would be a rename)
  const all = Object.fromEntries(setupLib.FIN_HR_ROLES.map(r => [r.key, null]));
  assert.deepEqual(setupLib.finHrSetupBody({ bookId: 1, setup, edits: {} }), {
    book_id: 1,
    channels: [{ channel_code: 'COLOUR', ledger_id: 21 }],
    roles: { ...all, staff_advances: 31, salary_expense: 34, rounding: 39 },
    expense_map: [{ hr_key: 'dept:Pasting', ledger_id: 51 }, { hr_key: 'dept:Old Dept', ledger_id: 52 }],
    payroll_booking: 'month_end',
  });
  assert.equal(setupLib.finHrSetupChanges(setup, {}), 0);
  // CASH given the default's ledger by hand (a saved choice now), COLOUR taken away, a role given and one taken, a key mapped and a key
  // cleared, the booking switched
  const edits = { channels: { CASH: 11, COLOUR: null }, roles: { staff_loans: 32, rounding: null }, expense: { 'type:employee': 53, 'dept:old dept': null },
    payroll_booking: 'when_paid' };
  const body = setupLib.finHrSetupBody({ bookId: 1, setup, edits });
  assert.deepEqual(body.channels, [{ channel_code: 'CASH', ledger_id: 11 }, { channel_code: 'COLOUR', ledger_id: null }]);
  assert.deepEqual([body.roles.staff_loans, body.roles.rounding, body.roles.staff_advances], [32, null, 31]);
  assert.deepEqual(body.expense_map, [{ hr_key: 'type:employee', ledger_id: 53 }, { hr_key: 'dept:Pasting', ledger_id: 51 }, { hr_key: 'dept:Old Dept', ledger_id: null }]);
  assert.equal(body.payroll_booking, 'when_paid');
  assert.equal(setupLib.finHrSetupChanges(setup, edits), 7);
  // an edit put back as it was is no change; a setting never read is the month end
  assert.equal(setupLib.finHrSetupChanges(setup, { channels: { COLOUR: 21, DARBI: null }, roles: { rounding: 39 }, expense: { 'dept:pasting': 51 }, payroll_booking: 'month_end' }), 0);
  assert.equal(setupLib.finHrSetupBody({ bookId: 2, setup: { ...setup, payroll_booking: undefined }, edits: {} }).payroll_booking, 'month_end');
  // nothing read yet is nothing to draw or send
  assert.deepEqual([setupLib.finHrChannelRows(null, {}), setupLib.finHrExpenseRows(undefined, {})], [[], []]);

  // where a refusal goes: the row of the channel, role or key it names, else the foot
  const sent = body;
  assert.deepEqual(setupLib.finHrProblemRow('channels[1].ledger_id', sent), { part: 'channel', key: 'COLOUR' });
  assert.deepEqual(setupLib.finHrProblemRow('channels[0].channel_code', sent), { part: 'channel', key: 'CASH' });
  assert.deepEqual(setupLib.finHrProblemRow('roles.staff_loans', sent), { part: 'role', key: 'staff_loans' });
  assert.deepEqual(setupLib.finHrProblemRow('expense_map[1].ledger_id', sent), { part: 'expense', key: 'dept:pasting' });
  assert.deepEqual(setupLib.finHrProblemRow('payroll_booking', sent), { part: 'booking', key: 'payroll_booking' });
  for (const none of ['form', 'channels', 'roles', 'channels[9].ledger_id', 'book_id', null, undefined]) assert.equal(setupLib.finHrProblemRow(none, sent), null, String(none));
  assert.equal(setupLib.finHrProblemRow('channels[0].ledger_id', null), null, 'nothing sent: nowhere to put it');
});

test('the channel pickers: the bank and cash ledgers of every book the login reads, this book\'s first, the other book\'s named with its book', () => {
  const ci = { id: 1, name: 'Colour Impressions' };
  const dp = { id: 2, name: 'Darbi Print Pack' };
  const lists = [
    { book: ci, ledgers: [L(11, 'Office cash', { is_bank_cash: true }), L(12, 'Rent'), L(13, 'Bank Current', { is_bank_cash: true })] },
    { book: dp, ledgers: [L(21, 'DP Bank', { is_bank_cash: true }), L(22, 'DP Old Bank', { is_bank_cash: true, active: false }), L(23, 'DP Rent')] },
  ];
  assert.deepEqual(setupLib.finHrAccountChoices(lists, 1).map(l => [l.id, l.name]),
    [[11, 'Office cash'], [13, 'Bank Current'], [21, 'DP Bank · Darbi Print Pack'], [22, 'DP Old Bank · Darbi Print Pack']]);
  assert.deepEqual(setupLib.finHrAccountChoices([lists[1], lists[0]], 2).map(l => l.name),
    ['DP Bank', 'DP Old Bank', 'Office cash · Colour Impressions', 'Bank Current · Colour Impressions'], 'this book first, however the books came');
  // a ledger a channel already pays from stays on offer, whatever has become of it, so the picker shows it (the server judges a change)
  assert.deepEqual(setupLib.finHrAccountChoices(lists, 1, [23]).map(l => l.id), [11, 13, 21, 22, 23]);
  assert.deepEqual(setupLib.finHrAccountChoices(null, 1), []);
  assert.deepEqual(setupLib.finHrAccountChoices([{ book: dp, ledgers: null }], 1), [], 'a book whose ledgers have not come offers nothing yet');
  // the picker is the book's own LedgerPicker, handed the list: the channels' choices, and this book's ledgers for the roles and keys
  const hr = code(read(HR_SETUP));
  assert.match(hr, /<LedgerPicker bookId=\{book\.id\} ledgers=\{ledgers\} value=\{value\}/);
  assert.match(hr, /choice\(\{\s*value: r\.value, ledgers: accounts,/, 'a channel picks among the accounts');
  assert.equal((hr.match(/ledgers: own,/g) || []).length, 2, 'a role and an expense key pick among this book\'s ledgers');
});

test('a re-filed staff ledger warns and never refuses: a ledger with a staff role moved to a bank, cash or party group (Task 9\'s deferred minor)', () => {
  const groups = [
    { id: 1, name: 'Loans & Advances (Asset)', is_bank_cash: false, is_party: false }, { id: 2, name: 'Bank Accounts', is_bank_cash: true, is_party: false },
    { id: 3, name: 'Sundry Debtors', is_bank_cash: false, is_party: true }, { id: 4, name: 'Indirect Expenses', is_bank_cash: false, is_party: false },
  ];
  const advances = { id: 41, group_id: 1, name: 'Staff Advances' };
  const roles = { staff_advances: 41, salary_payable: 44, md_account: 45, cash_difference: 46, intercompany: 47 };
  const warn = (ledger, groupId, r = roles) => setupLib.finRefiledStaffWarning({ ledger, groupId, groups, roles: r });
  const one = "This ledger is Staff advances in HR & payroll setup; a bank, cash or party ledger can't hold that role.";
  assert.equal(warn(advances, 2), one);
  assert.equal(warn(advances, '3'), one, 'the group as the picker holds it');
  assert.equal(warn(advances, 4), '', 'an expense group is no bank, cash or party group');
  assert.equal(warn(advances, 1), '', 'where it is now');
  assert.equal(warn(advances, 2, { staff_advances: 41, staff_loans: 41 }),
    "This ledger is Staff advances and Staff loans in HR & payroll setup; a bank, cash or party ledger can't hold those roles.");
  // the roles a bank, cash or party ledger may hold, or that are no staff money: no warning (MD's Account and the inter-company account are
  // often a party's in Tally; the cash-difference ledger has its own guard)
  for (const id of [45, 46, 47]) assert.equal(warn({ id, group_id: 4 }, 3), '', `ledger ${id}`);
  // a new ledger, roles not read, no group, a group not in the list: nothing to say
  assert.equal(warn(null, 2), '');
  assert.equal(warn(advances, 2, null), '');
  assert.equal(warn(advances, null), '');
  assert.equal(warn(advances, 9), '');
  // the four are the server's R20a roles
  assert.deepEqual(setupLib.FIN_STAFF_ROLES, ['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense']);
  assert.ok(Object.isFrozen(setupLib.FIN_STAFF_ROLES));
  assert.match(serverSrc('finance-hr-setup.js'), /const FIN_STAFF_ROLES = Object\.freeze\(\['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense'\]\);/);
  // the form shows it, reading the roles from the HR & payroll setup, and its Save is what it was
  const form = code(read('components/finance/LedgerForm.jsx'));
  assert.match(form, /const rolesRead = useReport\(ledger && fields\.group \? `\/finance\/hr-setup\?book=\$\{book\.id\}` : null\);/,
    'read only where the group can be changed: an Admin editing a ledger that is not built in');
  assert.match(form, /const refiled = finRefiledStaffWarning\(\{ ledger, groupId: form\.group_id, groups, roles: rolesRead\.data\?\.roles \?\? null \}\);/);
  assert.match(form, /\{refiled && <p className="[^"]*amber[^"]*">\{refiled\}<\/p>\}/);
  assert.doesNotMatch(form, /const ready = [^;]*refiled/, 'a warning never stops the save (no hard blockers)');
  assert.doesNotMatch(form, /api\.get\(/, 'and the form still reads nothing of its own to save');
});

test('LedgerForm shows holder_name only when the group is under Cash-in-Hand', () => {
  const form = code(read('components/finance/LedgerForm.jsx'));
  assert.match(form, /const chosenGroup = groups\.find\(g => String\(g\.id\) === String\(form\.group_id\)\) \?\? null;/);
  assert.match(form, /const holderShown = finHolderShown\(\{ ledger, group: chosenGroup \}\);/, 'under Cash-in-Hand, and never on the built-in Cash (R61)');
  assert.match(form, /\{holderShown && \([\s\S]*?value=\{form\.holder_name\}[\s\S]*?value=\{form\.float_text\}/, 'the name and the float, under the one condition');
  assert.equal((form.match(/value=\{form\.holder_name\}/g) || []).length, 1, 'and nowhere else');
  assert.match(form, /api\.post\('\/finance\/ledgers', finLedgerCreateBody\(form, book\.id, \{ holder: holderShown \}\)\)/);
  assert.match(form, /api\.put\(`\/finance\/ledgers\/\$\{ledger\.id\}`, finLedgerEditBody\(form, \{ isAdmin, holder: holderShown \}\)\)/);
  assert.match(form, /useState\(\(\) => \(\{ \.\.\.finLedgerFormOf\(ledger, \{ group_id: groupId \}\), \.\.\.finHolderFormOf\(ledger\) \}\)\)/);
  assert.match(form, /const floatRead = finHolderFloat\(form\.float_text\);/);
  // a holder left on a ledger moved out of Cash-in-Hand is the server's to refuse, and its sentence is shown where the group is
  assert.match(form, /\{!holderShown && <FieldError>\{problems\.holder_name \|\| problems\.float_paise\}<\/FieldError>\}/);
  // the server says which groups are cash: the groups read's is_cash, finGroupKinds' account_kind (ruling R23)
  const routes = serverSrc('routes/finance.js');
  const block = routes.slice(routes.indexOf("r.get('/finance/books/:bookId/groups'"), routes.indexOf("// The book's ledgers, switched-off ones only"));
  assert.match(block, /is_cash: kinds\.get\(g\.id\)\?\.account_kind === 'cash'/);

  // the pure half: the fields as the form holds them, the float typed in rupees, and the body
  assert.deepEqual(setupLib.finHolderFormOf({ holder_name: 'Holder A', float_paise: 4_000_000 }), { holder_name: 'Holder A', float_text: '40,000.00' });
  assert.deepEqual(setupLib.finHolderFormOf(null), { holder_name: '', float_text: '' });
  assert.deepEqual(setupLib.finHolderFormOf({ holder_name: 'Holder B', float_paise: 0 }), { holder_name: 'Holder B', float_text: '0.00' }, 'a float of nothing is still a float');
  assert.deepEqual(setupLib.finHolderFloat('  '), { paise: null, error: null }, 'blank is no float');
  assert.deepEqual(setupLib.finHolderFloat(' 1,20,000.50 '), { paise: 12_000_050, error: null });
  assert.equal(setupLib.finHolderFloat('12.345').error, 'Enter an amount in rupees with at most two decimals');
  const typed = { ...setupLib.finLedgerFormOf(null, { group_id: 7 }), name: 'Holder B Cash', holder_name: ' Holder B ', float_text: '10,000' };
  assert.deepEqual(setupLib.finLedgerCreateBody(typed, 1, { holder: true }), {
    book_id: 1, group_id: 7, name: 'Holder B Cash', code: null, tally_name: null, notes: null, party_type: null, party_id: null,
    holder_name: 'Holder B', float_paise: 1_000_000,
  });
  for (const body of [setupLib.finLedgerCreateBody(typed, 1), setupLib.finLedgerCreateBody(typed, 1, { holder: false })]) {
    assert.ok(!('holder_name' in body) && !('float_paise' in body), 'anywhere else, nothing of the holder is sent');
  }
  // an edit: the holder is the accountant's as much as the Admin's, so both send it under Cash-in-Hand; blank is none
  assert.deepEqual(setupLib.finLedgerEditBody({ ...typed, holder_name: '', float_text: '' }, { isAdmin: false, holder: true }),
    { name: 'Holder B Cash', code: null, tally_name: null, notes: null, holder_name: null, float_paise: null });
  assert.deepEqual(Object.keys(setupLib.finLedgerEditBody(typed, { isAdmin: false })).sort(), ['code', 'name', 'notes', 'tally_name']);
  // a form that never drew the holder's fields sends none of them, even under Cash-in-Hand: it can't clear a holder by accident
  assert.deepEqual(Object.keys(setupLib.finLedgerEditBody(setupLib.finLedgerFormOf(null, { group_id: 7 }), { isAdmin: false, holder: true })).sort(),
    ['code', 'name', 'notes', 'tally_name']);
  const admin = setupLib.finLedgerEditBody(typed, { isAdmin: true, holder: true });
  assert.deepEqual([admin.holder_name, admin.float_paise, admin.group_id], ['Holder B', 1_000_000, 7]);
});

test('ApprovalRules maps cash_difference to "Cash count differences" and says opening corrections always need an Approver', () => {
  assert.equal(setupLib.finRuleLabel('cash_difference'), 'Cash count differences');
  assert.equal(setupLib.finRuleNote('opening'), 'Opening corrections always need an Approver.');
  for (const key of ['journal', 'cash_difference', 'reversal', 'constructor', null]) assert.equal(setupLib.finRuleNote(key), '', String(key));
  const rules = code(read('components/finance/ApprovalRules.jsx'));
  assert.match(rules, /<span className="font-semibold">\{finRuleLabel\(r\.rule_key\)\}<\/span>/);
  assert.match(rules, /finRuleNote\(r\.rule_key\) && <span [^>]*>\{finRuleNote\(r\.rule_key\)\}<\/span>/, 'the line, under the rule it is about');
});

test('Reports lists "Party bills", and PartyStatement reads /finance/reports/party: open items with their age, on-account credits, the check beside the balance', () => {
  assert.deepEqual(reportsLib.FIN_REPORT_TABS.find(t => t.key === 'party'), { key: 'party', label: 'Party bills' });
  assert.equal(reportsLib.finReportTab('party'), 'party', 'the key is the route\'s own name');
  const page = code(read('pages/finance/Reports.jsx'));
  assert.match(page, /import PartyStatement from '\.\.\/\.\.\/components\/finance\/PartyStatement\.jsx';/);
  assert.match(page, /\{tab === 'party' && <PartyStatement book=\{book\} ledgerId=\{ledgerId\} onPickLedger=\{id => change\(\{ ledger: id \}\)\} onVoucher=\{shared\.onVoucher\} version=\{version\} \/>\}/);
  const party = code(read(PARTY));
  assert.match(party, /`\/finance\/reports\/party\?\$\{new URLSearchParams\(\{ ledger: String\(ledgerId\) \}\)\}`/);
  assert.match(party, /useReport\(url, version\)/);
  for (const field of ['open_items', 'on_account', 'age_days', 'check.outstanding_paise', 'check.on_account_paise', 'check.ok']) {
    assert.ok(party.includes(field), field);
  }
  assert.match(party, /finPartyCheck\(check, report\.ledger\.side\)/, 'the balance beside the two sides, the party\'s own way round');
  // the customers and vendors of this book only, and an answer of another book never drawn
  assert.match(party, /ledgers\.filter\(l => l\.is_party\)/);
  assert.match(party, /finLedgerStatus\(ledgerId, parties, listFailed\)/);
  assert.match(party, /finStatementBelongs\(data, book\.id\)/);
  assert.match(party, /onRowClick=\{r => onVoucher\(r\.voucher_id\)\}/, 'an item opens its voucher');
  // the pure half
  assert.deepEqual([0, 1, 2, 45].map(reportsLib.finAgeText), ['Today', '1 day', '2 days', '45 days']);
  assert.equal(reportsLib.finAgeText(undefined), '—');
  assert.deepEqual(reportsLib.finPartyCheck({ outstanding_paise: 50_000, on_account_paise: 20_000, balance_paise: 30_000, ok: true }, 'customer'),
    { net_paise: 30_000, balance_text: '₹300.00 Dr', ok: true });
  assert.deepEqual(reportsLib.finPartyCheck({ outstanding_paise: 50_000, on_account_paise: 0, balance_paise: 50_000, ok: true }, 'vendor'),
    { net_paise: 50_000, balance_text: '₹500.00 Cr', ok: true }, 'a vendor\'s balance is a credit');
  assert.equal(reportsLib.finPartyCheck({ outstanding_paise: 1, on_account_paise: 0, balance_paise: 2, ok: false }, 'customer').ok, false);
  assert.equal(reportsLib.finPartyCheck(null, 'customer'), null);
});

test('ReverseDialog hides the date input when is_opening_correction is true', () => {
  const detail = code(read('components/finance/VoucherDetail.jsx'));
  const dialog = bodyOf(detail, 'function ReverseDialog({ voucher, onClose, onDone, onFailed }) {');
  assert.match(dialog, /const correction = voucher\.is_opening_correction === true;/);
  assert.match(dialog, /const fixedDay = opening \|\| correction;/);
  assert.match(dialog, /useState\(fixedDay \|\| today < voucher\.voucher_date \? voucher\.voucher_date : today\)/, 'it asks for the day it is reversed on anyway (ruling R15)');
  assert.equal((dialog.match(/<Input type="date"/g) || []).length, 1, 'one date box');
  const fork = dialog.indexOf('{fixedDay ? (');
  assert.ok(fork > 0 && dialog.indexOf('<Input type="date"') > dialog.indexOf(') : (', fork), 'and only where the day is not fixed');
  assert.ok(dialog.includes('A correction is reversed on the opening day.'));
});

test('ActivityLog has a label for hr_setup', () => {
  assert.equal(setupLib.finActionLabel('book', 'hr_setup'), 'HR & payroll setup changed');
  assert.equal(setupLib.finActionLabel('book', 'setup'), 'Set up', 'the book\'s first label is as it was');
  const pairs = [...code(serverSrc('finance-hr-setup.js')).matchAll(/entity: '([a-z_]+)', entityId[^\n]*?action: '([a-z_]+)'/g)].map(m => [m[1], m[2]]);
  assert.ok(pairs.length >= 3, `non-vacuous: ${pairs.length} audit calls`);
  for (const [entity, action] of pairs) {
    assert.notEqual(setupLib.finActionLabel(entity, action), action, `${entity} ${action} has no label`);
    assert.notEqual(setupLib.finEntityLabel(entity), entity, `${entity} has no name`);
  }
  assert.match(code(read('components/finance/ActivityLog.jsx')), /finActionLabel\(r\.entity, r\.action\)/);
});

test('OpeningCorrection posts to /finance/opening-corrections: lines picked with LedgerPicker, "Opening + corrections" for each ledger, and the list', () => {
  const fix = code(read(CORRECTION));
  assert.match(fix, /api\.post\('\/finance\/opening-corrections', \{ book_id: book\.id, lines: finFormLinesToApi\(settled\), narration: narration\.trim\(\) \|\| null, client_key: saveKey\.current \}\)/);
  assert.match(fix, /const saveKey = useRef\(finNewSaveKey\(\)\);/, 'one save key per opened form: a retry is the same correction');
  assert.ok(MINTING_POSTS.includes('/finance/opening-corrections'), 'posting mints a number, so a double press is joined');
  // the lines: LedgerPicker, through the voucher form's own line row, with the system's ledgers on offer (the Opening may hold them, H6)
  assert.match(fix, /<LineRow [\s\S]{0,300}?manualOnly=\{false\}/);
  const row = code(read('components/finance/LineRow.jsx'));
  assert.match(row, /<LedgerPicker bookId=\{bookId\} ledgers=\{ledgers\} manualOnly=\{manualOnly\}/);
  assert.match(row, /manualOnly = true,/, 'the voucher form keeps its own rule');
  // "Opening + corrections" for each ledger, from by_ledger, and the corrections
  assert.ok(read(CORRECTION).includes('Opening + corrections'));
  assert.match(fix, /data\?\.by_ledger/);
  assert.match(fix, /data\?\.corrections/);
  for (const field of ['opening_paise', 'corrections_paise', 'total_paise']) assert.match(fix, new RegExp(`\\br\\.${field}\\b`), field);
  // the Opening's own day, and who waits for whom, said before it is sent
  assert.match(fix, /finOpeningAsAt\(book\.books_begin\)/);
  assert.match(fix, /finCorrectionNote\(book\.roles\)/);
  // entering is an accountant's or an Approver's; it waits for an Opening that stands
  assert.match(fix, /const mayEnter = can\('enter'\);/);
  assert.match(fix, /disabled=\{!openingStands\}/);
  // a correction opens over the Day Book, where Approve, Reverse and the rest are its own
  assert.match(fix, /navigate\(`\/finance\?voucher=\$\{r\.id\}`\)/);
  // one press at a time (ruling R57), and a refusal is the server's sentence, under the line it names
  const save = bodyOf(fix, 'const save = async () => {');
  assert.match(save, /if \(savingRef\.current\) return;/);
  assert.match(save, /savingRef\.current = true;/);
  assert.match(save, /finally \{[^}]*savingRef\.current = false;/);
  assert.match(save, /finFieldTarget\(e\?\.data\?\.field, finSentRows\(settled\)\)/);
  assert.match(fix, /useNoAnswer\(\)/);
  // a repeated save key is answered with the correction the first save made, whatever the second carried (the route has no
  // replay_differs), so after a save with no answer (or a 5xx) the lines are locked until Save goes again as it was; a 4xx wrote nothing
  assert.match(save, /const refused = !finIsNoAnswer\(e\) && e\.status >= 400 && e\.status < 500;\s*setUnsure\(!refused\);/);
  assert.match(fix, /<fieldset disabled=\{unsure\} /);
  assert.match(fix, /if \(typed && !unsure\) setAsking\(true\); else onClose\(\);/, 'after a save with no answer, closing loses nothing the list will not show');
  // the pure half
  assert.equal(openingLib.finCorrectionNote(['approver']), 'You are an Approver, so the correction posts at once, marked self-approved.');
  assert.equal(openingLib.finCorrectionNote(['accountant']), 'It waits for an Approver: an opening correction always needs one.');
});

test('Opening Balances shows the corrections, and warns when a draft correction exists', () => {
  const page = code(read('pages/finance/OpeningBalances.jsx'));
  assert.match(page, /const fixes = useReport\(`\/finance\/opening-corrections\?book=\$\{book\.id\}`\);/);
  assert.match(page, /<OpeningCorrection book=\{book\} can=\{can\} read=\{fixes\} openingStands=\{openingStands\} \/>/);
  assert.match(page, /const openingStands = outcome\?\.state === 'posted';/);
  assert.match(page, /\{finDraftCorrections\(fixes\.data\) > 0 && \(/);
  assert.match(page, /\{FIN_DRAFT_CORRECTION_NOTE\}/);
  assert.equal(openingLib.FIN_DRAFT_CORRECTION_NOTE, 'A draft correction is checked against the Opening that stands when it is submitted.');
  assert.equal(openingLib.finDraftCorrections({ corrections: [{ status: 'draft' }, { status: 'posted' }, { status: 'draft' }, { status: 'submitted' }] }), 2);
  for (const none of [null, undefined, {}, { corrections: 'x' }]) assert.equal(openingLib.finDraftCorrections(none), 0, JSON.stringify(none));
  // the Match step is handed the book's roles (ruling R16), read from the HR & payroll setup, and waits for them as for the groups
  assert.match(page, /const rolesRead = useReport\(live \? `\/finance\/hr-setup\?book=\$\{book\.id\}` : null\);/);
  assert.match(page, /roles=\{roles\}/);
  assert.match(page, /groups && ledgers && roles/);
  assert.match(code(read('components/finance/OpeningMatch.jsx')),
    /^export default function OpeningMatch\(\{ book, view, groups, ledgers, roles, touched, setTouched, onConfirmed, reload \}\) \{/m);
});

test('the Task 15 screens: light theme only, no line-by-line entrance, the server\'s order kept, money through finFormatINR, typed money through finToPaiseTyped', () => {
  for (const file of T15_NEW) {
    const text = code(read(file));
    assert.doesNotMatch(text, /\bdark:/, `${file} has a dark-mode class`);
    assert.doesNotMatch(text, /animationDelay|transitionDelay|delay-\[|\bdelay-\d|stagger/i, `${file} staggers`);
    assert.doesNotMatch(text, /parseFloat|\* 100\b|\/ 100\b|toFixed\(/, `${file} does float maths on money`);
    assert.doesNotMatch(text, /\b(?:localStorage|sessionStorage)\b|createPortal|Object\.hasOwn\s*\(/, file);
    assert.doesNotMatch(text, /import[^;]*(?:lib\/exporter|exceljs)/, `${file} loads the exporter up front`);
    // DataTable sorts by its first sortable column when nothing says otherwise: every table here is given a finUnsorted column list
    const tables = [...text.matchAll(/<DataTable [^>]*?columns=\{(\w+)\}/g)].map(m => m[1]);
    assert.equal(tables.length, (text.match(/<DataTable /g) || []).length, `${file}: every table names its columns`);
    for (const columns of tables) assert.match(text, new RegExp(`const ${columns} = finUnsorted\\(\\[`), `${file}: ${columns} keeps the server's order`);
    assert.doesNotMatch(text, /sortable:\s*true|defaultSort/, file);
  }
  for (const file of [CORRECTION, PARTY]) {
    assert.match(code(read(file)), /finFormatINR\(/, file);
    assert.equal((code(read(file)).match(/<DataTable /g) || []).length, 2, `${file}: non-vacuous, its two tables`);
  }
  // a correction's amounts go through the voucher form's reader (finSetAmount, finSettleAmounts: finToPaiseTyped), a float through
  // finHolderFloat (the same)
  assert.match(code(read(CORRECTION)), /finSettleAmounts\(/);
  assert.match(code(read('components/finance/LineRow.jsx')), /finSetAmount\(l, side, e\.target\.value\)/);
  assert.match(code(read('lib/finance/voucher.js')), /return \{ paise: finToPaiseTyped\(text\), error: null \};/);
  assert.match(bodyOf(code(read('lib/finance/setup.js')), 'export function finHolderFloat(floatText) {'), /finParseAmountText\(/);
});

test('the HR & payroll form mirrors the server: the twelve roles, the two bookings, the CASH channel, and the payroll journal\'s keys', () => {
  const server = serverSrc('finance-hr-setup.js');
  const roles = /export const FIN_LEDGER_ROLES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(server)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1));
  assert.equal(roles.length, 12, 'non-vacuous');
  assert.deepEqual(setupLib.FIN_HR_ROLES.map(r => r.key), roles, 'every role, in the server\'s order');
  for (const r of setupLib.FIN_HR_ROLES) assert.ok(r.label && r.hint, r.key);
  assert.ok(Object.isFrozen(setupLib.FIN_HR_ROLES));
  assert.equal(setupLib.finHrRoleLabel('staff_advances'), 'Staff advances');
  assert.equal(setupLib.finHrRoleLabel('nonsense'), 'nonsense');
  assert.match(server, /const FIN_PAYROLL_BOOKINGS = Object\.freeze\(\['month_end', 'when_paid'\]\);/);
  assert.deepEqual(setupLib.FIN_PAYROLL_BOOKINGS.map(b => b.key), ['month_end', 'when_paid'], 'the month end first: the default');
  assert.match(server, /const FIN_CASH_CHANNEL = 'CASH';/);
  assert.equal(setupLib.FIN_CASH_CHANNEL, 'CASH');
  // an expense key is found as the payroll journal finds it (finHrRunLines): trimmed, lower-cased, nothing after the colon
  assert.match(serverSrc('finance-hr-payroll.js'), /r\.hr_key\.trim\(\)\.toLowerCase\(\)\.replace\(\/\^\(type\|dept\):\\s\*\/, '\$1:'\)/);
  assert.deepEqual([' Dept: Pasting ', 'type:Contractor', 'dept:QC & Lab'].map(setupLib.finHrKey), ['dept:pasting', 'type:contractor', 'dept:qc & lab']);
  assert.deepEqual(['dept:Old Dept', 'type:employee', 'grade:A'].map(setupLib.finHrKeyLabel), ['Department · Old Dept', 'Person type · Employee', 'grade:A']);
});

// ── Task 15 fix round 1 (F1; rulings R60, R61, R62) ──────────────────────────────────────────────────────────────

test('F1: "Create the staff ledgers" says what it made, what it found by name and gave its role, and what now takes no typed entry', () => {
  const four = ['Staff Advances', 'Staff Loans', 'Salary Payable', 'Salaries & Wages'];
  const five = [...four, "MD's Account"];
  // every ledger found by its name (a Tally import brought them in, or an Admin took the roles away): the old words said nothing was made
  assert.equal(setupLib.finStaffLedgersText({ created: [], found: five, system_only: four }),
    "Staff Advances, Staff Loans, Salary Payable, Salaries & Wages and MD's Account were in the book already and have their roles now. "
    + 'Staff Advances, Staff Loans, Salary Payable and Salaries & Wages now take no typed entries.');
  // some made, some found
  assert.equal(setupLib.finStaffLedgersText({ created: ['Staff Loans'], found: ['Staff Advances', "MD's Account"], system_only: ['Staff Advances', 'Staff Loans'] }),
    "Made Staff Loans. Staff Advances and MD's Account were in the book already and have their roles now. Staff Advances and Staff Loans now take no typed entries.");
  assert.equal(setupLib.finStaffLedgersText({ created: [], found: ['Salary Payable'], system_only: ['Salary Payable'] }),
    'Salary Payable was in the book already and has its role now. Salary Payable now takes no typed entries.');
  // a book with none of them
  assert.equal(setupLib.finStaffLedgersText({ created: five, found: [], system_only: four }),
    "Made Staff Advances, Staff Loans, Salary Payable, Salaries & Wages and MD's Account. Staff Advances, Staff Loans, Salary Payable and Salaries & Wages now take no typed entries.");
  // only a role that is no staff ledger's moved (MD's Account): nothing is made system-only
  assert.equal(setupLib.finStaffLedgersText({ created: [], found: ["MD's Account"], system_only: [] }),
    "MD's Account was in the book already and has its role now.");
  // every role set already: nothing changed
  for (const none of [{ created: [], found: [], system_only: [] }, {}, null]) {
    assert.equal(setupLib.finStaffLedgersText(none), 'The book has all its staff ledgers already: nothing changed.', JSON.stringify(none));
  }
  // the screen says it from the whole answer, in the toast and in a line that stays until the next change
  const hr = code(read(HR_SETUP));
  const make = bodyOf(hr, 'const makeStaffLedgers = async () => {');
  assert.match(make, /const said = finStaffLedgersText\(made\);/);
  assert.match(make, /toast\.success\(said\);\s*setStaffNote\(said\);/);
  assert.match(hr, /\{staffNote && <p [^>]*role="status"[^>]*>\{staffNote\}<\/p>\}/);
  assert.match(bodyOf(hr, 'const setPart = (part, key, value) => {'), /setStaffNote\(''\);/, 'a change clears it');
  // the answer carries the names (finance-pg-hr-setup.test.js holds the server to them)
  assert.match(serverSrc('finance-hr-setup.js'), /return \{ created, found, system_only: /);
});

// Ruling R60: every kind of change this branch records has a plain label. The scan reads every finAudit call of the Finance server, so a
// kind added later without words fails here: what was done (finActionLabel) and to what (finEntityLabel, and the filter offers it).
test('R60: every kind of change the books record has a plain label in the Activity Log, and the log\'s filter offers every kind', () => {
  const dir = new URL('./', import.meta.url);
  const files = [...readdirSync(dir).filter(f => /^finance-[\w-]+\.js$/.test(f) && !f.endsWith('.test.js')), 'routes/finance.js'];
  const kinds = [];
  const unread = [];
  for (const file of files) {
    const text = code(serverSrc(file));
    for (const m of text.matchAll(/\bfinAudit\(/g)) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;   // its own definition
      const literal = objectAt(text, text.indexOf('{', m.index));
      const entity = /\bentity: '([a-z_]+)'/.exec(literal ?? '')?.[1];
      const action = /\baction: '([a-z_]+)'/.exec(literal ?? '')?.[1];
      if (entity && action) kinds.push([entity, action, `${file}:${text.slice(0, m.index).split('\n').length}`]);
      else unread.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(unread, [], 'an audit call whose kind is not written out where the scan can read it');
  // …and finAudit is the one door into the log, so no row is written where this scan cannot see it
  const doors = [...readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).map(f => f),
    ...readdirSync(new URL('./routes/', dir)).filter(f => f.endsWith('.js')).map(f => `routes/${f}`)]
    .filter(f => /INSERT\s+INTO\s+fin_audit_log/i.test(code(serverSrc(f))));
  assert.deepEqual(doors, ['finance-audit.js']);
  assert.ok(kinds.length >= 30, `non-vacuous: ${kinds.length} audit calls`);
  for (const [entity, action, at] of kinds) {
    assert.notEqual(setupLib.finActionLabel(entity, action), action, `${entity} ${action} (${at}) has no label`);
    assert.notEqual(setupLib.finEntityLabel(entity), entity, `${entity} (${at}) has no name`);
  }
  assert.deepEqual(setupLib.FIN_ENTITY_CHOICES.map(c => c.key).sort(), [...new Set(kinds.map(k => k[0]))].sort(), 'the filter offers exactly what is recorded');
  // the branch's own, by name
  for (const [entity, action] of [['allocation', 'apply'], ['allocation', 'redo'], ['allocation', 'release'], ['cash_count', 'create'], ['book', 'hr_setup']]) {
    assert.ok(kinds.some(k => k[0] === entity && k[1] === action), `${entity} ${action} is among them`);
  }
  assert.deepEqual([['allocation', 'apply'], ['allocation', 'redo'], ['allocation', 'release'], ['cash_count', 'create']].map(([e, a]) => setupLib.finActionLabel(e, a)),
    ['Set against bills', 'Redone', 'Released', 'Counted']);
  assert.deepEqual(['allocation', 'cash_count'].map(setupLib.finEntityLabel), ['Bill adjustment', 'Cash count']);
  // an adjustment's row is about its entry: the number its record carries (the summary SQL reads `number` already)
  assert.equal(setupLib.finActivityTarget({ entity: 'allocation', entity_id: 31, after: { voucher_id: 31, number: 'CI-RV-2627-0005', line_id: 9 } }), 'CI-RV-2627-0005');
  assert.equal(setupLib.finActivityTarget({ entity: 'allocation', entity_id: 31, before: { voucher_id: 31, number: 'CI-RV-2627-0005' }, after: null }), 'CI-RV-2627-0005');
  assert.equal(setupLib.finActivityTarget({ entity: 'cash_count', entity_id: 12, after: { ledger_id: 5 } }), '#12');
  assert.match(serverSrc('finance-reports.js'), /'number', COALESCE\(a\.after, a\.before\) -> 'number'/);
});

// Ruling R61: office cash stays office cash. The book's built-in Cash, which the CASH channel pays from by default (ruling R19), never
// offers a holder's fields: a holder is always a ledger of its own (spec §5.4), and one typed on office cash would take the default
// away from HR's CASH channel without a word.
test('R61: the built-in Cash never offers a holder\'s fields; any other Cash-in-Hand ledger does, a new one too', () => {
  const cash = { id: 5, is_system: true, group_id: 1 };
  const till = { id: 6, is_system: false, group_id: 1 };
  const underCash = { id: 1, is_cash: true };
  const expense = { id: 3, is_cash: false };
  assert.equal(setupLib.finHolderShown({ ledger: cash, group: underCash }), false, 'office cash: never');
  assert.equal(setupLib.finHolderShown({ ledger: till, group: underCash }), true);
  assert.equal(setupLib.finHolderShown({ ledger: null, group: underCash }), true, 'a new ledger under Cash-in-Hand');
  assert.equal(setupLib.finHolderShown({ ledger: till, group: expense }), false);
  assert.equal(setupLib.finHolderShown({ ledger: null, group: null }), false, 'no group chosen yet');
  // so office cash's edit never carries a holder, whatever the form holds
  const form = { ...setupLib.finLedgerFormOf({ ...cash, name: 'Cash', active: true, manual_entry: true }), ...setupLib.finHolderFormOf(null), holder_name: 'Holder Z' };
  const body = setupLib.finLedgerEditBody(form, { isAdmin: true, holder: setupLib.finHolderShown({ ledger: cash, group: underCash }) });
  assert.ok(!('holder_name' in body) && !('float_paise' in body), JSON.stringify(body));
  // the form draws it by the one rule, and says why office cash has none
  const ledgerForm = code(read('components/finance/LedgerForm.jsx'));
  assert.match(ledgerForm, /finHolderShown\(\{ ledger, group: chosenGroup \}\)/);
  assert.match(ledgerForm, /\{ledger\?\.is_system && chosenGroup\?\.is_cash === true && \(/);
  assert.match(read('components/finance/LedgerForm.jsx'), /a holder(?:'|&apos;)s cash is a ledger of its own/);
});

// Ruling R62: no hidden blockers on a form. A Save is never held back by a field the form does not show: a float typed under Cash-in-Hand,
// left unreadable, and the group then changed, hides the float, and the save goes on without it (finHolderBody sends nothing there).
test('R62: the ledger form\'s Save is never held by the float when the float is not shown', () => {
  const form = code(read('components/finance/LedgerForm.jsx'));
  assert.match(form, /const ready = form\.name\.trim\(\) !== '' && form\.group_id != null && form\.group_id !== '' && !linkMissing && !\(holderShown && floatRead\.error\);/);
  assert.doesNotMatch(form, /&& !floatRead\.error/, 'the float\'s error counts only while the float is drawn');
  assert.match(form, /\{floatRead\.error && <FieldError>\{floatRead\.error\}<\/FieldError>\}/, 'and while it is, it says why');
  // what that save sends: no float at all
  const typed = { ...setupLib.finLedgerFormOf(null, { group_id: 3 }), name: 'Test Freight Two', holder_name: 'Someone', float_text: '12.345' };
  const body = setupLib.finLedgerCreateBody(typed, 1, { holder: setupLib.finHolderShown({ ledger: null, group: { id: 3, is_cash: false } }) });
  assert.ok(!('float_paise' in body) && !('holder_name' in body), JSON.stringify(body));
});
