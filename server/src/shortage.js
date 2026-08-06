// Shortage — a line whose production is OVER and still did not make enough.
//
// The distinction that matters: a line the pool cannot fill *right now* is not
// short, it is simply mid-run and more is coming. A line is short only once its
// job card has closed, so nothing further will ever arrive for it. Without that
// test the floor would be asked to close or re-plan jobs that are still running.
//
// Pure so the rule is provable without a database.

// Has production finished for this line? A closed card is the normal end; a
// gang parent that SPLIT hands its work to child cards, so the split card is
// not itself an end — the child's own card is what closes.
export function productionOver(line) {
  return line.jc_status === 'closed';
}

// The quantity still owed to the customer that no finished goods can cover.
export function shortfallOf(line) {
  const owed = Math.max(0, (+line.qty || 0) - (+line.dispatched_qty || 0));
  return Math.max(0, owed - Math.max(0, +line.suggested_dispatch || 0));
}

export function isShortage(line) {
  return productionOver(line) && shortfallOf(line) > 0;
}

// What the two decisions do, as data — so the modal, the endpoint and the tests
// all read the same description of the choice instead of three copies of it.
export const SHORTAGE_ACTIONS = {
  close: {
    label: 'Close short',
    describe: l => `Dispatch the ${(+l.suggested_dispatch || 0).toLocaleString('en-IN')} on hand and close the line ${shortfallOf(l).toLocaleString('en-IN')} short`,
  },
  replan: {
    label: 'Send to Planning',
    describe: l => `Send back to Planning to make the ${shortfallOf(l).toLocaleString('en-IN')} balance`,
  },
};
