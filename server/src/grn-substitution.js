// GRN board substitution — the paper mill sent a different board.
//
// PURE. Plain rows in, a decision out. No pg, no await, nothing to mock. The
// dialog renders `effects` and the route executes `effects`, so the preview a
// storekeeper approves cannot drift from what the transaction does — the same
// contract planMove() holds in board-allocation.js.
//
// TWO AXES, and they are judged in two different places:
//
//   GSM   is a property of the BOARD. A lighter or heavier sheet of the same
//         grade and size is receivable for every job on it — nothing about the
//         cut changes.
//   SIZE  is a property of each JOB. Whether a different sheet can be received
//         depends on whether THAT job's parent can still be trimmed out of it,
//         which is a per-claim question and lives in eligibilityOf().
//
// Grade is the one thing that never varies: a different grade is a different
// material with different strength and print behaviour, and no amount of
// arithmetic makes it the same board.

import { BOARD_DEMAND_STATUSES, parentFitsBoard } from './helpers.js';

const num = v => Number(v || 0);
const fmt = n => Math.round(n).toLocaleString('en-IN');
const dim = n => (Math.round(num(n) * 100) / 100);
const sheetOf = m => `${dim(m?.sheet_l)}×${dim(m?.sheet_w)}″`;

const no = reason => ({ ok: false, reason });

// Is `received` the same grade of board as `ordered`, differing only in ways a
// receipt is entitled to settle?
//
// Every gate is a refusal rather than a warning. A warning on a receipt screen
// gets clicked through at 7am, and the cost of clicking through is board on the
// floor that the job physically cannot use.
//
// Note what this does NOT decide: whether any particular job can move onto the
// new sheet. A size change is legitimate at the board level and still wrong for
// a given job — see eligibilityOf().
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

  return {
    ok: true,
    reason: null,
    axes: {
      gsm: num(ordered.gsm) !== num(received.gsm),
      size: num(ordered.sheet_l) !== num(received.sheet_l) || num(ordered.sheet_w) !== num(received.sheet_w),
    },
  };
}

// What is thrown away trimming `parent` out of one sheet of `board`.
//
// Orientation-free, like parentFitsBoard: long edge against long, short against
// short. Reported so the storekeeper can see what the substitution costs — the
// board-to-parent trim has no representation anywhere in the app, and a receipt
// screen is not the place to invent stock out of it.
export function trimOf(parent, board) {
  const pl = num(parent?.sheet_l), pw = num(parent?.sheet_w);
  const bl = num(board?.sheet_l), bw = num(board?.sheet_w);
  if (!(pl > 0 && pw > 0 && bl > 0 && bw > 0)) return null;
  const [PL, PW] = [Math.max(pl, pw), Math.min(pl, pw)];
  const [BL, BW] = [Math.max(bl, bw), Math.min(bl, bw)];
  if (PL > BL + 1e-6 || PW > BW + 1e-6) return null;   // does not fit; not a trim
  const area = BL * BW;
  return {
    long_edge: dim(BL - PL),
    short_edge: dim(BW - PW),
    waste_pct: area > 0 ? Math.round((1 - (PL * PW) / area) * 1000) / 10 : 0,
  };
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

// Can THIS job be moved onto the received board?
//
// The status alone cannot answer the first half: a line flips to in_production
// the moment it is pushed to a job card, LONG before cutting issues any board.
// The question is whether the sheets have actually left the shelf, and
// board_drawn is the only thing entitled to answer it.
//
// The second half is the size axis, and it is where a size substitution earns
// its refusals. `line.parent_l/parent_w` is the job's EFFECTIVE parent — the
// caller resolves spec_override over the product master before calling.
//
//   parent present and fits    → eligible. One board sheet still yields one
//                                parent; the cut is unchanged and the surplus
//                                is trimmed off.
//   parent present, won't fit  → REFUSED. No guillotine makes that cut, and
//                                board a job cannot use is worse than no board.
//   no parent on file          → REFUSED, temporarily. Without an explicit
//                                parent the BOARD is the parent, so a different
//                                sheet re-bases the job: cuts per parent move
//                                and the sheet count moves with them. That is a
//                                planning decision, not a receipt.
//
// That last rule is deliberately self-retiring. It needs no flag and no
// migration: the day a product is given its standard parent size, the job stops
// being refused and flows through the ordinary path. Nothing has to be removed
// for the exception to disappear.
export function eligibilityOf(line, { ordered, received } = {}) {
  if (!line) return { eligible: false, reason: 'That job is no longer on the board.' };
  if (line.board_drawn)
    return { eligible: false, reason: 'Board already issued to the floor for this job.' };
  if (!BOARD_DEMAND_STATUSES.includes(line.status))
    return { eligible: false, reason: `A ${line.status} job no longer claims board.` };

  const sizeChanged = ordered && received &&
    (num(ordered.sheet_l) !== num(received.sheet_l) || num(ordered.sheet_w) !== num(received.sheet_w));
  if (!sizeChanged) return { eligible: true, reason: null };

  const parent = { sheet_l: line.parent_l, sheet_w: line.parent_w };
  if (!(num(parent.sheet_l) > 0 && num(parent.sheet_w) > 0))
    return {
      eligible: false,
      reason: 'No parent sheet on file — this job is cut to whatever board it is given, so a different size re-plans it. Set the parent size in Planning.',
    };

  if (!parentFitsBoard(parent, received))
    return {
      eligible: false,
      reason: `${dim(parent.sheet_l)}×${dim(parent.sheet_w)}″ parent cannot be trimmed from a ${sheetOf(received)} sheet.`,
    };

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
    const el = eligibilityOf(claim, { ordered, received });
    if (!el.eligible) blockers.push(`${label(claim)} cannot be re-boarded — ${el.reason}`);
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
    // The job keeps its parent, its cuts and its sheet count — one board sheet
    // still yields one parent, with the surplus trimmed off. Reported, because a
    // substitution that quietly wastes 12% of every sheet is worth seeing.
    const trim = trimOf({ sheet_l: c.parent_l, sheet_w: c.parent_w }, received);
    effects.push({
      kind: 'reboard',
      order_line_id: c.id,
      from: ordered.id,
      to: received.id,
      trim,
      text: `${label(c)} moves onto ${received.name || received.code}`
        + (trim && (trim.long_edge > 0 || trim.short_edge > 0)
          ? `, trimmed back to ${dim(c.parent_l)}×${dim(c.parent_w)}″ — ${trim.waste_pct}% of each sheet wasted`
          : ''),
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
