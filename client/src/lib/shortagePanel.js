// Decisions for the board shortage panel, kept out of JSX so `node --test` can
// reach them — the same arrangement as lib/boardMix.js and lib/received.js.
// Dependency-free on purpose: an extensionless import here would make the module
// unloadable in Node and the tests would die on import rather than on a claim.
//
// Only what is genuinely panel-specific lives here. Which controls a requisition
// offers is a domain rule the PR register answers too, so it moved to
// lib/requisitionControls.js rather than being hand-rolled twice.

// Which face the panel shows. The old inline row rendered only while short > 0,
// so the moment an action worked, the result vanished with the shortage. A live
// shortage still outranks everything — a partial move leaves work to do.
// `prs` is expected to be this line's open/relevant requisitions, not its full
// history: this checks only `prs.length`, with no status filter of its own, so
// a caller that hands it retired PRs would show the 'pr' face for a row that
// actually has no controls to offer.
export function panelMode({ short, prs, lastMove } = {}) {
  if (+short > 0) return 'card';
  if (Array.isArray(prs) && prs.length) return 'pr';
  if (lastMove) return 'move';
  return null;
}
