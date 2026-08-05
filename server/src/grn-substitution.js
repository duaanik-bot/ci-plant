// GRN board substitution — the paper mill sent a different GSM.
//
// PURE. Plain rows in, a decision out. No pg, no await, nothing to mock. The
// dialog renders `effects` and the route executes `effects`, so the preview a
// storekeeper approves cannot drift from what the transaction does — the same
// contract planMove() holds in board-allocation.js.
//
// A substitution is ONE thing: the same board at a different GSM. Same grade,
// same sheet size. A different grade or size is refused outright, because it
// changes ups, cutting and the plan — that is a replanning job, not a receipt.

import { BOARD_DEMAND_STATUSES } from './helpers.js';

const num = v => Number(v || 0);
const fmt = n => Math.round(n).toLocaleString('en-IN');

const no = reason => ({ ok: false, reason });
const YES = { ok: true, reason: null };

// Is `received` the same board as `ordered` at a different weight?
//
// Every gate here is a refusal rather than a warning. A warning on a receipt
// screen gets clicked through at 7am, and the cost of clicking through is a job
// re-boarded onto a sheet it does not fit.
export function isSubstitutable(ordered, received) {
  if (!ordered || !received) return no('Pick the board that actually arrived.');
  if (ordered.id === received.id) return no('That is the same board as the one ordered.');
  if (received.category !== 'board' || ordered.category !== 'board')
    return no('Only a board can be substituted for a board.');
  if (Number(received.leftover) || Number(ordered.leftover))
    return no('A leftover offcut cannot stand in for a purchased board.');

  // Unprovable sameness is the dangerous case, so it fails closed.
  if (!ordered.grade || !received.grade)
    return no('That board has no grade on file — it cannot be matched to the ordered board.');
  if (ordered.sheet_l == null || ordered.sheet_w == null ||
      received.sheet_l == null || received.sheet_w == null)
    return no('That board has no sheet size on file — it cannot be matched to the ordered board.');

  if (String(ordered.grade).trim().toLowerCase() !== String(received.grade).trim().toLowerCase())
    return no(`${received.name || received.code} is a different grade — that is a replanning decision, not a receipt.`);
  if (num(ordered.sheet_l) !== num(received.sheet_l) || num(ordered.sheet_w) !== num(received.sheet_w))
    return no(`${received.name || received.code} is a different sheet size — that changes the cut plan, so it cannot be received here.`);

  return YES;
}

// Packets are how the warehouse counts and how the supplier delivers; sheets are
// what the ERP stores. sheets_per_packet never varies within a grade+size family
// (verified across the whole board master), so both sides of a substitution
// convert at the same rate and packets stay comparable.
export function packetsOf(material, sheets) {
  const per = num(material?.sheets_per_packet);
  if (!per) return null;
  return num(sheets) / per;
}

// Can this job still be moved onto another board?
//
// The status alone cannot answer it: a line flips to in_production the moment it
// is pushed to a job card, LONG before cutting issues any board. The question is
// whether the sheets have actually left the shelf, and board_drawn is the only
// thing entitled to answer it.
export function eligibilityOf(line) {
  if (!line) return { eligible: false, reason: 'That job is no longer on the board.' };
  if (line.board_drawn)
    return { eligible: false, reason: 'Board already issued to the floor for this job.' };
  if (!BOARD_DEMAND_STATUSES.includes(line.status))
    return { eligible: false, reason: `A ${line.status} job no longer claims board.` };
  return { eligible: true, reason: null };
}

const label = c => c.customer_name ? `${c.product_name} (${c.customer_name})` : c.product_name;

// Work out every consequence of receiving `received` against a PO line that
// ordered `ordered`, re-boarding the jobs in `picks`.
//
// `claims` is every job holding a live claim on the ORDERED board — each marked
// `bought: true` if this PO was buying for it. The caller owns that query
// (boardClaimLines + the PO's requisition allocations); this function owns the
// decision.
export function planSubstitution({
  ordered, received, receivedSheets,
  poLine, claims = [], picks = [],
} = {}) {
  const blockers = [];
  const qty = num(receivedSheets);

  const sub = isSubstitutable(ordered, received);
  if (!sub.ok) blockers.push(sub.reason);
  if (!(qty > 0)) blockers.push('Enter a received quantity greater than zero.');
  if (!poLine?.id) blockers.push('This receipt is not against a purchase order line.');

  const picked = [...new Set(picks.map(Number))];
  for (const id of picked) {
    const claim = claims.find(c => c.id === id);
    if (!claim) {
      blockers.push(`A job you ticked is no longer on this board — reopen the receipt and check the list.`);
      continue;
    }
    const el = eligibilityOf(claim);
    if (!el.eligible) blockers.push(`${label(claim)} cannot be re-boarded — ${el.reason.toLowerCase()}`);
  }

  // Nothing is half-planned: one blocker means no effects at all, so a caller
  // that ignores `ok` still cannot execute a partial substitution.
  if (blockers.length) return { ok: false, blockers, effects: [], balance: null };

  const already = num(poLine.received_qty);
  const remaining = Math.max(0, num(poLine.qty) - already - qty);
  const closes = remaining === 0;
  const balance = { ordered_qty: num(poLine.qty), already, receiving: qty, remaining, closes };

  const pkt = packetsOf(received, qty);
  const effects = [{
    kind: 'receive',
    material_id: received.id,
    qty,
    text: `${fmt(qty)} sheets${pkt ? ` (${fmt(pkt)} packets)` : ''} of ${received.name || received.code} into quarantine`,
  }];

  for (const id of picked) {
    const c = claims.find(x => x.id === id);
    effects.push({
      kind: 'reboard',
      order_line_id: c.id,
      from: ordered.id,
      to: received.id,
      text: `${label(c)} moves onto ${received.name || received.code}`,
    });
    effects.push({
      kind: 'alloc_repoint',
      order_line_id: c.id,
      from: ordered.id,
      to: received.id,
      text: `${label(c)}'s ${fmt(c.parent_sheets_required)} sheets are now claimed against ${received.name || received.code}`,
    });
  }

  // The honesty rule. A job this PO was buying for, left un-ticked, on a line
  // that now closes, is waiting for board that will never arrive. Release the
  // incoming allocation so its shortage comes back rather than reading covered.
  if (closes) {
    for (const c of claims) {
      if (!c.bought || picked.includes(c.id)) continue;
      effects.push({
        kind: 'alloc_release',
        order_line_id: c.id,
        requisition_id: c.requisition_id ?? null,
        text: `${label(c)} goes back to short — the board it was waiting for is no longer coming`,
      });
    }
  }

  effects.push(closes
    ? { kind: 'po_close', po_line_id: poLine.id, text: `The purchase order line is settled by this receipt` }
    : { kind: 'po_partial', po_line_id: poLine.id, remaining, text: `${fmt(remaining)} sheets still due on the purchase order line` });

  return { ok: true, blockers: [], effects, balance };
}
