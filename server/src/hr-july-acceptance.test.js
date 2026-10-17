// July acceptance (spec section 2): the system must reproduce the owner's real July salary workbook.
//
// The workbook holds real people's pay and lives OUTSIDE this public repo. This test reads it from the file named by
// the environment variable HR_JULY_XLSX and is skipped when that does not point to a readable file. Every expected
// value is derived from the workbook at run time; nothing from it is written to any file, and nothing from it is
// printed: output is counts and pass/fail only, and a failure names a position (row or person index) and a field.
// The path is used exactly as given (the real folder and file names end in spaces), never trimmed.
//
//   HR_JULY_XLSX=<path> node --test src/hr-july-acceptance.test.js
//   HR_JULY_INPUT_SHEET=<sheet name>   the monthly-input sheet FINAL SHEET reads (default 'GENERAL DATA ')
//
// Two levels:
//   engine   parseSalaryWorkbook, then computeLine for every person; gross and "Final Payment" within half a paisa.
//   import   readWorkbook, autoMap, extractRows and matchRow on the input sheet: each matched row carries the inputs
//            the workbook used for that person, and each person with inputs is matched by exactly one row.
//
// Assertions never receive a real value (node:test would print actual/expected on a failure): they receive counts
// and the list of {position, field} that failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { parseSalaryWorkbook } from './hr/workbook-loader.js';
import { computeLine } from './hr/engine.js';
import { readWorkbook, detectHeader, autoMap, extractRows } from './hr/import-parse.js';
import { buildIndex, matchRow, normName } from './hr/match.js';
import { rat, sub, cmp, neg } from './hr/money.js';

const FILE = process.env.HR_JULY_XLSX;
const INPUT_SHEET = process.env.HR_JULY_INPUT_SHEET ?? 'GENERAL DATA ';
const COMPARE_SHEET = 'New data ';

function readable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
const skip = readable(FILE)
  ? false
  : 'HR_JULY_XLSX does not point to a readable file (the real July workbook lives outside the repo)';

const ZERO = rat(0);
const HALF_PAISA = rat('0.005');
const MATCHED = new Set(['code', 'exact_name', 'alias']);
const COMPARED = ['ot_hours', 'absent_days', 'misc_earning', 'advance_given'];   // what the input sheet and FINAL SHEET share
const BLANK_ZERO = { ot_hours: true, absent_days: true, misc_earning: true, advance_given: true, bill_amount: true };

// exact equality of two decimal texts; a missing value never equals anything
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && cmp(rat(a), rat(b)) === 0;
const nonZero = (v) => v !== null && v !== undefined && cmp(rat(v), ZERO) !== 0;
const within = (a, b) => {
  const d = sub(rat(a), rat(b));
  return cmp(d, HALF_PAISA) < 0 && cmp(d, neg(HALF_PAISA)) > 0;
};
// a failure list as a message that holds positions and field names only
const where = (list) => list.map((f) => `${f.position}:${f.field}`).join(' ');
const none = (list, what) => assert.ok(list.length === 0, `${what}: ${list.length} failing (position:field) ${where(list.slice(0, 20))}`);

// The one error the owner's sheet is allowed to raise: a code used by two people (the review path settles it by name).
const DUPLICATE_CODE = /^FINAL SHEET rows .* all have the code /;
const otherErrors = (parsed) => parsed.issues.filter((i) => i.level === 'error' && !DUPLICATE_CODE.test(i.message)).length;

let loaded;
function load() {
  loaded ??= (async () => {
    const buffer = readFileSync(FILE);
    return { buffer, parsed: await parseSalaryWorkbook(buffer) };
  })();
  return loaded;
}

test('engine: every person reproduces the workbook gross and final payment to half a paisa', { skip }, async (t) => {
  const { parsed } = await load();
  const errors = parsed.issues.filter((i) => i.level === 'error').length;
  const warns = parsed.issues.filter((i) => i.level === 'warn').length;
  t.diagnostic(`parse: people=${parsed.people.length} expected=${parsed.expected.length} issues error=${errors} warn=${warns}`);

  const duplicateCodes = parsed.people.length - new Set(parsed.people.map((p) => p.code)).size;
  assert.ok(parsed.people.length > 0, 'no people were parsed');
  assert.equal(parsed.expected.length, parsed.people.length, 'expected rows differ in number from people');
  assert.equal(parsed.setups.length, parsed.people.length, 'setups differ in number from people');
  assert.equal(parsed.monthInputs.length, parsed.people.length, 'monthInputs differ in number from people');
  const policy = { rounding: 'paise', ot_high_hours: '1000', deduction_warn_pct: '100', variance_warn_pct: '1000' };
  const person = { status: 'active', pay_channel_kind: 'cash', has_bank_details: true, joined_on: null, exited_on: null };

  const grossBad = [];
  const finalBad = [];
  const other = [];
  let blocked = 0;
  parsed.people.forEach((p, position) => {
    // the loader fills people, setups, monthInputs and expected in step, one entry per FINAL SHEET person; the
    // positions are used (a shared code would make a code lookup ambiguous) and each entry's code is checked
    const s = parsed.setups[position];
    const m = parsed.monthInputs[position];
    const e = parsed.expected[position];
    if (!s || !m || !e || s.code !== p.code || m.code !== p.code || e.code !== p.code) {
      other.push({ position, field: 'lookup' });
      return;
    }
    let r;
    try {
      r = computeLine({
        month: parsed.month,
        daysInMonth: parsed.daysInMonth,
        setup: { ...s, absence_basis: 'calendar_days', ot_multiplier: '1' },
        inputs: {
          ot_hours: m.ot_hours,
          absent_days: m.absent_days,
          misc_earning: m.misc_earning,
          advance_given: m.advance_given,
          bill_amount: m.bill_amount,
          paid_separately: m.paid_separately,
        },
        balances: {
          advance: '0',
          loans: cmp(rat(m.loan_instalment), ZERO) > 0
            ? [{ loan_id: 1, loan_no: 'L', due: m.loan_instalment, outstanding: m.loan_instalment }]
            : [],
        },
        person,
        policy,
      });
    } catch (err) {
      other.push({ position, field: `computeLine threw ${err?.name ?? 'Error'}` });
      return;
    }
    if (r.flags.some((f) => f.level === 'block')) blocked++;
    if (!within(r.exact.gross, e.gross_exact)) grossBad.push({ position, field: 'gross' });
    if (!within(r.exact.net_before_cap, e.final_exact)) finalBad.push({ position, field: 'final' });
  });

  const n = parsed.people.length;
  t.diagnostic(`engine: people=${n} gross within 0.005: ${n - grossBad.length}/${n}; final within 0.005: ${n - finalBad.length}/${n}; `
    + `could not compute: ${other.length}; people with a blocking flag: ${blocked}`);
  none(other, 'engine input');
  none(grossBad, 'gross differs from the workbook');
  none(finalBad, 'final payment differs from the workbook');
  t.diagnostic(`parse: people sharing a code=${duplicateCodes}`);
  assert.equal(otherErrors(parsed), 0, 'the workbook parse reported an error other than a duplicate code');
});

// Reads the input sheet into rows matched against the parsed people.
async function matchedRows(sheetName, parsed, buffer) {
  const { sheets } = await readWorkbook(buffer);
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets.find((s) => normName(s.name) === normName(sheetName));
  assert.ok(sheet, `input sheet not found among ${sheets.length} sheets`);
  const head = detectHeader(sheet.grid);
  assert.ok(head, 'the input sheet has no recognisable header row');
  const { map } = autoMap(head.headers);
  for (const key of ['name', 'code', ...COMPARED]) assert.ok(map[key] !== undefined, `the input sheet has no column for ${key}`);
  const rows = extractRows(sheet.grid, head.headerRow, map, { blankZero: BLANK_ZERO, daysInMonth: parsed.daysInMonth });
  const index = buildIndex(parsed.people.map((p, id) => ({ id, code: p.code, name: p.name, display_name: p.display_name })));
  const matches = rows.map((row) => ({ row, m: matchRow({ code: row.fields.code, name: row.fields.name }, index) }));
  const status = {};
  for (const { m } of matches) status[m.status] = (status[m.status] ?? 0) + 1;
  return { rows, matches, status };
}

const statusText = (status) => Object.entries(status).sort().map(([k, v]) => `${k}=${v}`).join(' ');

test('import: with the operator\'s decisions on held rows, every row carries the workbook inputs and every person with inputs has one row', { skip }, async (t) => {
  const { buffer, parsed } = await load();
  const { rows, matches, status } = await matchedRows(INPUT_SHEET, parsed, buffer);
  const review = (status.conflict ?? 0) + (status.ambiguous ?? 0) + (status.unmatched ?? 0) + (status.unknown_code ?? 0);
  t.diagnostic(`import: rows=${rows.length} people=${parsed.people.length}; matched ${statusText(status)}; `
    + `rows needing review: conflict=${status.conflict ?? 0} ambiguous=${status.ambiguous ?? 0} `
    + `unmatched=${(status.unmatched ?? 0) + (status.unknown_code ?? 0)} (total ${review})`);

  // The simulated decision: of the candidates the matcher offers, the one whose name or display name exactly equals the
  // row's name, when there is exactly one; otherwise the row stays unresolved.
  const assigned = [];                                // {row, person} for every row that ends up with a person
  const unresolved = [];
  let decided = 0;
  for (const { row, m } of matches) {
    if (MATCHED.has(m.status)) { assigned.push({ row, person: m.person_id }); continue; }
    const n = normName(row.fields.name);
    const named = n === '' ? [] : [...new Set(m.candidates)].filter((id) => {
      const p = parsed.people[id];
      return normName(p.name) === n || normName(p.display_name) === n;
    });
    if (named.length === 1) { assigned.push({ row, person: named[0] }); decided++; } else unresolved.push({ position: row.row_no, field: m.status });
  }

  const valueBad = [];
  let billDiffers = 0;
  const rowsOf = new Map();
  for (const { row, person } of assigned) {
    rowsOf.set(person, (rowsOf.get(person) ?? 0) + 1);
    const mine = parsed.monthInputs[person];
    for (const field of COMPARED) {
      if (!same(row.fields[field], mine[field])) valueBad.push({ position: row.row_no, field });
    }
    if (!same(row.fields.bill_amount ?? '0', mine.bill_amount ?? '0')) billDiffers++;
  }
  const missing = [];
  const doubled = [];
  parsed.monthInputs.forEach((mi, position) => {
    const any = [...COMPARED, 'bill_amount'].some((f) => nonZero(mi[f]));
    if (!any) return;
    const count = rowsOf.get(position) ?? 0;
    if (count === 0) missing.push({ position, field: 'no row' });
    if (count > 1) doubled.push({ position, field: `${count} rows` });
  });
  t.diagnostic(`import: decisions made by name=${decided} of ${review} rows needing review; unresolved=${unresolved.length}; `
    + `rows with a person=${assigned.length}; value differences=${valueBad.length} (bill amount, info only: ${billDiffers}); `
    + `people with inputs but no row=${missing.length}, with several rows=${doubled.length}`);
  none(valueBad, 'a resolved row differs from the workbook inputs (row number:field)');
  none(missing, 'a person with inputs is covered by no row (person index)');
  none(doubled, 'a person with inputs is covered by several rows (person index)');
  assert.equal(otherErrors(parsed), 0, 'the workbook parse reported an error other than a duplicate code');
});

test('import: the New data sheet against the input sheet (information only)', { skip }, async (t) => {
  const { buffer, parsed } = await load();
  const first = await matchedRows(INPUT_SHEET, parsed, buffer);
  let second;
  try {
    second = await matchedRows(COMPARE_SHEET, parsed, buffer);
  } catch {
    t.diagnostic('New data: sheet not usable, nothing compared');
    return;
  }
  const valuesOf = ({ matches }) => {
    const out = new Map();
    for (const { row, m } of matches) if (MATCHED.has(m.status) && !out.has(m.person_id)) out.set(m.person_id, row.fields);
    return out;
  };
  const a = valuesOf(first);
  const b = valuesOf(second);
  let differ = 0;
  let onlyOne = 0;
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(id) || !b.has(id)) { onlyOne++; continue; }
    for (const field of [...COMPARED, 'bill_amount']) {
      if (!same(a.get(id)[field] ?? '0', b.get(id)[field] ?? '0')) differ++;
    }
  }
  const s = second.status;
  t.diagnostic(`New data: rows=${second.rows.length}; matched ${statusText(s)}; unmatched/unknown=${(s.unmatched ?? 0) + (s.unknown_code ?? 0)} `
    + `ambiguous=${s.ambiguous ?? 0} conflict=${s.conflict ?? 0}; value differences vs the input sheet=${differ}; `
    + `people matched in only one sheet=${onlyOne}`);
});
