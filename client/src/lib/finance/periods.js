// The moves a month makes (spec §6.2): the ONE definition. The server's finSetPeriodStatus (finance-masters.js) judges a move with
// finPeriodMove, and the Months & Years screen offers exactly the moves this table lists (finPeriodMoves), so a button is never drawn
// that the server would refuse, and none the server would accept is missing.
//
// A month is `open` (normal posting), `closing` (only entries an Approver approves post), `locked` (nothing posts) or
// `before_books` (before the books begin: only the Opening voucher, and a reversal of it, may be dated there). A closing or locked
// month holds back the months before it as well, since their entries carry into it (ruling R73). It moves
//   open     -> closing
//   closing  -> locked
//   closing  -> open     (needs a reason)
//   locked   -> closing  (needs a reason: this is the "unlock")
// and a month before the books begin never moves.
//
// Pure ESM, no React, no DOM, no imports: the server imports this file by relative path and the browser bundles it as written.
// Own-property checks are Object.prototype.hasOwnProperty.call, never Object.hasOwn (finance-wiring.test.js holds all client code
// to the browser baseline).

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const FIN_PERIOD_TRANSITIONS = Object.freeze({
  open: Object.freeze([Object.freeze({ to: 'closing', reason: false })]),
  closing: Object.freeze([Object.freeze({ to: 'locked', reason: false }), Object.freeze({ to: 'open', reason: true })]),
  locked: Object.freeze([Object.freeze({ to: 'closing', reason: true })]),
  before_books: Object.freeze([]),
});

// The moves a month in `status` may make, in the table's order: { to, reason } each. A name that is not a status has none
// ('constructor' is not a status, whatever Object.prototype says).
export const finPeriodMoves = status => (typeof status === 'string' && has(FIN_PERIOD_TRANSITIONS, status) ? FIN_PERIOD_TRANSITIONS[status] : []);

// Whether a month may go from one status to another, and whether the move needs a reason. A move that is never allowed does not ask
// for a reason (needsReason is false for it), so a refusal is never put down to a missing one.
export function finPeriodMove(from, to) {
  const move = finPeriodMoves(from).find(m => m.to === to);
  return { ok: Boolean(move), needsReason: Boolean(move?.reason) };
}

// ── Words for the screen ─────────────────────────────────────────────────────────────────────────────────────────────
// Kept beside the table so a move added to it cannot go without a button label (finance-periods.test.js holds the two together).

export const FIN_PERIOD_STATUS_LABELS = Object.freeze({
  before_books: 'Before books', open: 'Open', closing: 'Closing', locked: 'Locked',
});

// A status as a person says it. One that is not a status is shown as it came, and nothing at all is a dash.
export const finPeriodLabel = status => (status == null ? '—' : typeof status === 'string' && has(FIN_PERIOD_STATUS_LABELS, status) ? FIN_PERIOD_STATUS_LABELS[status] : String(status));

// A month's balances are carried into every month after it, so an entry in a month restates every later one (ruling R73): a month
// that closes or locks holds back the months before it too, and the sentences say so.
const MOVE_TEXT = Object.freeze({
  'open>closing': Object.freeze({
    label: 'Start closing',
    effect: 'Only entries an Approver approves can be posted into this month, or any month before it, from now on.',
  }),
  'closing>locked': Object.freeze({
    label: 'Lock',
    effect: 'Nothing can be posted into this month, or any month before it, until it is unlocked.',
  }),
  'closing>open': Object.freeze({
    label: 'Reopen',
    effect: 'The month is open again for normal posting, unless a month after it is still closing or locked.',
  }),
  'locked>closing': Object.freeze({
    label: 'Unlock',
    effect: 'The month goes back to closing: only entries an Approver approves can be posted into it, or into any month before it.',
  }),
});

const textOf = (from, to, field) => {
  const key = `${from}>${to}`;
  return finPeriodMove(from, to).ok && has(MOVE_TEXT, key) ? MOVE_TEXT[key][field] : '';
};

// The button for a move ('Lock', 'Unlock'), or '' for a pair of statuses that is not a move: there is no button for it.
export const finPeriodMoveLabel = (from, to) => textOf(from, to, 'label');

// What a move does to the month, as a sentence for the dialog that asks before it is made.
export const finPeriodMoveEffect = (from, to) => textOf(from, to, 'effect');
