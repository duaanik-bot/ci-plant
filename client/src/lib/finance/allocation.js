// Settling bills with a receipt or payment: the Auto and Pick allocators for Finance
// Cash & Bank (spec §6.3 Auto, §6.4 Pick).
//
// Auto settles in a fixed order: the opening lump first (a balance carried in with no bill
// behind it), then bills by date, then due date (none last), then bill reference in natural
// order (INV-9 before INV-10), then line id so the order is total. Pick takes the bills the
// user ticked, in tick order. Money left over, in either, goes on account.
//
// Amounts are whole paise. Pure ESM, no imports, no React, no DOM: the server imports this
// file by relative path and the browser bundles it as written.

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Upper-case letters and digits only, so 'bill-0104' and 'Opening bill 0104' can be matched.
export function finNormRef(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// null sorts after any value.
function nullsLast(x, y, cmp) {
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return cmp(x, y);
}

const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

export function finItemOrder(a, b) {
  if (a.is_opening_lump !== b.is_opening_lump) return a.is_opening_lump ? -1 : 1;
  return byText(a.date, b.date)
    || nullsLast(a.due_date, b.due_date, byText)
    || nullsLast(a.bill_ref, b.bill_ref, (x, y) => COLLATOR.compare(x, y))
    || a.line_id - b.line_id;
}

const open = (items) => items.filter(i => i.open_paise > 0);

// Items whose reference contains the typed one come first; each group keeps finItemOrder.
export function finPickOrder(items, reference) {
  const want = finNormRef(reference);
  const hit = (i) => want !== '' && finNormRef(i.bill_ref).includes(want);
  return open(items).sort((a, b) => (hit(b) - hit(a)) || finItemOrder(a, b));
}

function checkAmount(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new RangeError('amountPaise must be a whole number of paise, zero or more');
  }
}

export function finAutoAllocate(items, amountPaise) {
  checkAmount(amountPaise);
  let left = amountPaise;
  const allocations = [];
  for (const i of open(items).sort(finItemOrder)) {
    if (left === 0) break;
    const take = Math.min(i.open_paise, left);
    allocations.push({ line_id: i.line_id, amount_paise: take });
    left -= take;
  }
  return { allocations, on_account_paise: left };
}

export function finPickAllocate(items, picks, amountPaise) {
  checkAmount(amountPaise);
  const room = new Map(open(items).map(i => [i.line_id, i.open_paise]));
  const taken = new Map();
  let left = amountPaise;
  for (const p of picks) {
    if (left === 0) break;
    const avail = room.get(p.line_id);
    if (!avail) continue; // unknown or closed line, or already filled by an earlier tick
    const asked = p.amount_paise == null ? avail : p.amount_paise;
    if (!Number.isSafeInteger(asked) || asked <= 0) continue;
    const take = Math.min(asked, avail, left);
    room.set(p.line_id, avail - take);
    taken.set(p.line_id, (taken.get(p.line_id) ?? 0) + take);
    left -= take;
  }
  return {
    allocations: [...taken].map(([line_id, amount_paise]) => ({ line_id, amount_paise })),
    on_account_paise: left,
  };
}
