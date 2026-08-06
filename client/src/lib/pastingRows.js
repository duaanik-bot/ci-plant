// Row-level pasting maths for the Sort & Paste station.
//
// SEQUENTIAL vs PARALLEL is the one distinction this station turns on, and the
// two look identical on screen — both collect a machine number and a hand
// number:
//
//   machine_manual  ONE pile, two steps. The machine side-pastes, the hand
//                   locks. The row's output is what came off the LAST step:
//                   30,000 side-pasted and 29,000 hand-locked is 29,000
//                   cartons, and the 1,000 that never got locked is waste.
//   split           TWO piles worked in parallel — half on the folder-gluer,
//                   half by a hand contractor. These genuinely add up:
//                   50,000 + 50,000 = 100,000.
//
// Summing a sequential row would book 30,000 pieces as 59,000. The server
// enforces the same split in reconcilePastingRow(); this module is the client
// half, kept pure so the invariant is unit-tested rather than clicked through.
export const qty = v => Math.max(0, +v || 0);

export function rowGood(r) {
  if (r.method === 'machine') return qty(r.auto);
  if (r.method === 'manual') return qty(r.manual);
  if (r.method === 'machine_manual') return qty(r.manual);      // the LAST step
  if (r.method === 'split') return qty(r.auto) + qty(r.manual);
  // Unknown or blank: contribute nothing rather than falling through to the
  // SUM, which would silently read a half-configured row as a split batch and
  // double it. The server throws on an unknown method for the same reason.
  return 0;
}

// Pieces lost BETWEEN the two steps of a sequential row — side-pasted but never
// locked. Owned by the row itself: the row's machine count would otherwise
// exceed the row's own input and the server would reject it.
export const rowStepGap = r =>
  (r.method === 'machine_manual' ? Math.max(0, qty(r.auto) - qty(r.manual)) : 0);

export const rowWaste = r => Math.max(0, +r.waste || 0);
export const rowInput = r => rowGood(r) + rowWaste(r) + rowStepGap(r);

// A hand step that reports MORE than the machine step is a miscount, not a lie:
// you cannot lock a piece that was never side-pasted, so the machine figure is
// the wrong one. It is corrected UP to the hand count and the correction is
// shown and recorded — never blocked. Returns null when the row is consistent.
export function rowStepCorrection(r) {
  if (r.method !== 'machine_manual') return null;
  const a = qty(r.auto), m = qty(r.manual);
  return m > a ? { from: a, to: m, delta: m - a } : null;
}

// Map a UI row → the server's { auto_qty, manual_qty } shape.
export function rowToPayload(r) {
  const waste = rowWaste(r);
  const base = {
    // The RAW machine count goes to the server, which applies the correction and
    // records it — so there is one place that decides, not two. input already
    // balances either way: when the hand step is the higher of the two, the step
    // gap is zero and input is simply good + waste.
    method: r.method, input_qty: rowInput(r), waste_qty: waste + rowStepGap(r),
    waste_reason: waste > 0 ? r.waste_reason || undefined : undefined,
    auto_machine_id: r.machine_id ? +r.machine_id : undefined,
    auto_operator: r.auto_operator || undefined,
    manual_operator: r.manual_operator || undefined,
  };
  if (r.method === 'machine') return { ...base, auto_qty: qty(r.auto), manual_qty: 0 };
  if (r.method === 'manual') return { ...base, auto_qty: 0, manual_qty: qty(r.manual) };
  return { ...base, auto_qty: qty(r.auto), manual_qty: qty(r.manual) };  // sequential + split
}

// The whole grid → the rows the server is sent.
//
// `pasteWaste` is the pool the rows did not turn into good (derived on screen,
// never typed). A sequential row has already claimed the pieces lost between
// its own two steps, so only the REMAINDER is unallocated — attributing the
// full figure again would inflate total input past the sorted-good pool and the
// server would reject the lot.
export function buildRowPayloads(rows, pasteWaste, reason) {
  const payloads = rows.filter(r => rowGood(r) > 0).map(rowToPayload);
  const owned = payloads.reduce((s, p) => s + p.waste_qty, 0);
  const unallocated = Math.max(0, qty(pasteWaste) - owned);
  if (payloads.length && unallocated > 0) {
    payloads[0].input_qty += unallocated;
    payloads[0].waste_qty += unallocated;
  }
  for (const p of payloads) if (p.waste_qty > 0) p.waste_reason = reason || 'Pasting wastage';
  return payloads;
}

// How much the CLOSING grid must still cover.
//
// The trap this exists to stop: while a job is still sorting, its day log counts
// SORTED pieces. Nothing has been pasted, so the pasting grid must cover the
// whole sorted-good pool — subtracting sorting progress from it made the form
// ask for 4,800 while the server, correctly, demanded 10,200, and the close died
// on "rows cover 4800 — must equal the 10200 still to paste".
//
// Only once the active phase IS pasting does the log describe pasting progress.
// The pasting stage cannot hold runs before then: it stays 'pending' until
// sorting closes, so there is nothing to miss by reading zero.
export function stillToPaste({ pool = 0, phase, priorGood = 0, priorScrap = 0 } = {}) {
  const done = phase === 'paste' ? Math.max(0, priorGood) + Math.max(0, priorScrap) : 0;
  return Math.max(0, Math.max(0, pool) - done);
}

// The chip label for a machine — display only, never the stored name.
//
// The masters read "Automatic Lock Bottom Pasting Machine" and "Side Pasting
// Machine". Rendered whole they are 289px and 169px, which is 30px more than
// the column has, so the pair wrapped onto two ragged lines. And the words
// doing the overflowing carry nothing: the column is headed MACHINE, on a
// screen called Sort & Paste. Every tile was spending a third of its width
// repeating its own heading.
//
// So: drop a trailing "Machine", then a trailing "Pasting" — but only while
// two words survive, because "Side Pasting Machine" reduced all the way is
// "Side", which names nothing on the floor.
//
//   "Automatic Lock Bottom Pasting Machine" -> "Automatic Lock Bottom"
//   "Side Pasting Machine"                  -> "Side Pasting"
//   "Manual Pasting"                        -> "Manual Pasting"
//
// The full master name stays on the chip's title, so hovering still gives the
// name that is written on the machine itself.
export function machineLabel(name) {
  let words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  for (const noise of ['machine', 'pasting']) {
    if (words.length > 2 && words[words.length - 1].toLowerCase() === noise) words = words.slice(0, -1);
  }
  return words.join(' ');
}
