// Finance money, the way the ledger holds it: WHOLE PAISE.
//
// The database stores NUMERIC(18,2). In JS and in every API field money is an integer
// number of paise (the field names end in _paise). A float never carries an amount: the
// one place one arrives is a pool row (db.js reads NUMERIC with parseFloat), and it goes
// through finToPaise() exactly once, so a column of figures adds up to the paisa and
// 0.1 + 0.2 is never 0.30000000000000004 on a voucher.
//
// Pure ESM, no React, no DOM, no bare imports: the server tests import this file by
// relative path and the browser bundles it as written.

// ₹1 lakh crore. A typed or imported amount at or above this is a slip of the finger,
// not a ledger entry. It also keeps every figure far inside the 9e15 paise where a double
// stops holding whole numbers exactly.
export const FIN_MAX_PAISE = 1e14;

const REFUSAL = 'Enter an amount in rupees with at most two decimals';
const RUPEES = new Intl.NumberFormat('en-IN'); // lakh / crore grouping: 1,23,456

// A pool float (or numeric string) to whole paise; null and undefined are nothing, so 0.
// Math.round absorbs the float error. The "+ 0" is because Math.round(-0.4) is -0, and a
// negative zero must not leak out as if it were a different number from 0.
export function finToPaise(v) {
  if (v === null || v === undefined) return 0;
  return Math.round(Number(v) * 100) + 0;
}

// Plain digits with at most two decimals ('1234.5' is 123450), or null for anything else
// and for anything at or above FIN_MAX_PAISE. The rupees and the paise digits are joined
// as whole numbers, so nothing is ever rounded on the way.
function unsignedPaise(s) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return paise < FIN_MAX_PAISE ? paise : null;
}

// The shape of a typed amount. The integer part is an unbroken run of digits, or digits grouped
// by commas the Western way (120,000) or the Indian way (1,20,000); after it comes an optional
// .d or .dd. A comma anywhere else is not a grouping comma.
const TYPED_AMOUNT = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d{1,2})?$/;

// What a person typed into an amount box: plain digits, or digits grouped with commas the
// Western or the Indian way, then at most two decimals. Surrounding spaces are trimmed; a
// space inside, a minus sign or any other comma is refused. A comma is never just dropped:
// '1250,50' would otherwise be stored as 125050 rupees, a hundred times what a decimal comma
// meant. Every refusal is the one sentence, and nothing is rounded: 10.005 is refused, not
// made 10.01.
export function finToPaiseTyped(text) {
  const typed = String(text ?? '').trim();
  const paise = TYPED_AMOUNT.test(typed) ? unsignedPaise(typed.replace(/,/g, '')) : null;
  if (paise === null) throw new Error(REFUSAL);
  return paise;
}

// Whole paise to { neg, rupees, paise } with integer arithmetic, so every digit is exact.
// Never p / 100: that quotient is a float, and its last digit goes wrong near 2^53 paise.
function splitPaise(p) {
  const abs = Math.abs(p);
  const paise = abs % 100;
  return { neg: p < 0, rupees: (abs - paise) / 100, paise: String(paise).padStart(2, '0') };
}

// Paise to the NUMERIC text a query takes: '1234.50', '-0.05'. This is the write door, so
// a fractional or unsafe figure is refused rather than rounded; a silent round here would
// store a paisa nobody entered.
export function finFromPaise(p) {
  if (!Number.isSafeInteger(p)) throw new Error(`Paise must be a whole number, got ${p}`);
  const { neg, rupees, paise } = splitPaise(p);
  return `${neg ? '-' : ''}${rupees}.${paise}`;
}

// Paise to rupees on screen: ₹1,23,456.00, and -₹1,23,456.00 when negative. With drcr the
// ledger way applies instead: positive is Dr, negative is Cr, zero carries neither.
// Display never throws, because a throw inside a render takes the page with it: an absent
// or non-numeric figure shows as '—' (the dash api.js already uses for a missing weight or
// date) and a stray fraction is rounded to the paisa.
export function finFormatINR(p, { drcr = false } = {}) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—';
  const n = Math.round(p);
  const { neg, rupees, paise } = splitPaise(n);
  const text = `₹${RUPEES.format(rupees)}.${paise}`;
  if (!drcr) return neg ? `-${text}` : text;
  return n === 0 ? text : `${text} ${neg ? 'Cr' : 'Dr'}`;
}

const tallyRefusal = cell => new Error(`Cannot read "${String(cell).slice(0, 40)}" as an amount`);

// A cell as Tally or Excel hands it over, to signed paise: debit positive, credit negative.
//   '1,23,456.00 Dr' · '1,23,456.00 Cr' · '(1,234.00)' · '-1,234.00' · '₹ 12,000' · blank
// A number cell is a float, so it is rounded to the paisa like any pool float. Text keeps
// to two decimals. One sign marker at most: '-5 Cr' says two things, so it is refused
// rather than guessed at. Anything unreadable is refused with a sentence naming the cell.
// A comma passes only where a typed amount's does, grouping digits the Western or the Indian
// way (ruling R11): '1250,50' is refused, not read as 1,25,050 rupees, since a misread
// opening balance is worse than a cell sent back to be fixed.
export function finParseTallyAmount(cell) {
  if (cell === null || cell === undefined) return 0;
  if (typeof cell === 'number') {
    const p = finToPaise(cell);
    if (!(Math.abs(p) < FIN_MAX_PAISE)) throw tallyRefusal(cell); // also NaN and Infinity
    return p;
  }
  if (typeof cell !== 'string') throw tallyRefusal(cell); // a boolean, Date, array or object is not a figure
  if (cell.trim() === '') return 0;

  let s = cell.replace(/[₹\s]/g, '');
  const marks = []; // 1 for the debit side, -1 for credit or negative
  const side = /(dr|cr)$/i.exec(s);
  if (side) { marks.push(side[1].toLowerCase() === 'cr' ? -1 : 1); s = s.slice(0, -2); }
  if (s.startsWith('(') && s.endsWith(')')) { marks.push(-1); s = s.slice(1, -1); }
  if (s.startsWith('-')) { marks.push(-1); s = s.slice(1); }

  const p = TYPED_AMOUNT.test(s) ? unsignedPaise(s.replace(/,/g, '')) : null;
  if (p === null || marks.length > 1) throw tallyRefusal(cell);
  return marks[0] === -1 ? 0 - p : p; // 0 - p, because -p is -0 for '0.00 Cr'
}
