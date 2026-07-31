// ─── Notification categories — pure logic, no DB ─────────────────────────────
// The tabs in the notification centre. `notifications.kind` already carries
// everything needed to group a row, so a category is a READ-TIME map over kinds
// and not a new column: nothing to migrate, and re-filing a kind later is an
// edit to this file rather than an UPDATE across the plant's whole history.
//
// The map has two halves and the SECOND is the one that matters:
//   1. every kind the server emits lands in a NAMED category, and
//   2. a kind this file has never heard of lands in `other` — never nowhere.
// Without (2) a kind added by a later session would be filtered out of every
// tab while still counting towards the unread badge: a bell that says 3 and
// shows nothing. notify-categories.test.js reads the real route sources and
// asserts (1) for every kind actually emitted, so adding a notification without
// deciding where it belongs breaks the suite instead of the plant.

export const OTHER = 'other';

// Ordered — this IS the tab order. `other` is last because it is the fallback.
//
// `alerts` is declared with no kinds behind it, deliberately: the dashboard's
// shortage / artwork / tooling feed is computed live and writes no notification
// rows today, so the tab exists and reads zero until it does. A zero-count tab
// is the client's to hide; inventing the category later would mean two homes
// for the same decision.
export const CATEGORIES = Object.freeze([
  { id: 'approvals', label: 'Approvals' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'messages', label: 'Messages' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'quality', label: 'Quality' },
  { id: 'alerts', label: 'Plant alerts' },
  { id: OTHER, label: 'Other' },
].map(Object.freeze));

// kind → category, in ONE direction. KINDS_BY_CATEGORY is derived from it below
// so the two can never disagree about where a kind lives.
const OF_KIND = Object.freeze({
  // Somebody is waiting on a decision from the reader — the only category whose
  // rows have a live thing behind them that can still be acted on.
  xs_request: 'approvals',
  mgt_request: 'approvals',
  // Addressed at a person by name. Loud enough to pierce mute (see chat.js),
  // so loud enough to deserve its own tab rather than sitting under Messages.
  mention: 'mentions',
  chat: 'messages',
  // The answer coming back: an ask was decided, or a gate was overridden.
  xs_decision: 'decisions',
  mgt_decision: 'decisions',
  ready_override: 'decisions',
  // A stage sent back one station. It files here rather than under `approvals`
  // because the receiving station has nothing to decide — the call was already
  // made upstream and this is the answer arriving. Same shape as
  // ready_override: somebody's decision changed what a station is doing next.
  stage_sent_back: 'decisions',
  // Shade-card lifecycle, from the parallel shade-card wave. Every one of these
  // says "the colour the customer signed off may no longer be what we print",
  // which is a quality question and not an approval queue — including the two
  // pendency kinds, because nobody in this ERP approves them, the customer does.
  expiring: 'quality',
  expired: 'quality',
  revised: 'quality',
  pending_internal: 'quality',
  pending_customer: 'quality',
  approval_overdue: 'quality',
  artwork_changed: 'quality',
  master_changed: 'quality',
  // The four the shade-card simplification added to the same alerts feed. They
  // file here for the same reason as the rest: each one says the colour we are
  // about to print may not be the colour the customer signed. `return_overdue`
  // included — a card nobody can find is a colour nobody can check — and it is
  // deliberately NOT `alerts`, which stays kind-less by the note above.
  not_sent: 'quality',
  rejected: 'quality',
  no_age: 'quality',
  return_overdue: 'quality',
  code_mismatch: 'quality',
});

// hasOwnProperty, not a bare lookup: `categoryOf('constructor')` must be `other`
// like any other unknown kind, not Object.prototype's function. Same guard, same
// reason as record-entities.entityOr400.
export function categoryOf(kind) {
  const k = typeof kind === 'string' ? kind : '';
  return Object.prototype.hasOwnProperty.call(OF_KIND, k) ? OF_KIND[k] : OTHER;
}

export const CATEGORY_IDS = Object.freeze(CATEGORIES.map(c => c.id));

export const KNOWN_KINDS = Object.freeze(Object.keys(OF_KIND).sort());

export function isCategory(id) {
  return CATEGORY_IDS.includes(typeof id === 'string' ? id : '');
}

// The kinds a category selects, for the `kind = ANY($1)` filter. `other` gets
// an EMPTY list on purpose — it is defined by exclusion (everything KNOWN_KINDS
// does not cover), so a caller filtering on it must negate KNOWN_KINDS instead.
// Returning a list here would silently mean "nothing", which is the one answer
// `other` must never give.
export function kindsFor(category) {
  const id = typeof category === 'string' ? category : '';
  if (id === OTHER || !isCategory(id)) return [];
  return KNOWN_KINDS.filter(k => OF_KIND[k] === id);
}

export const KINDS_BY_CATEGORY = Object.freeze(Object.fromEntries(
  CATEGORY_IDS.map(id => [id, Object.freeze(kindsFor(id))]),
));
