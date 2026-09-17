// The Job Cards register, held in two halves.
//
// GET /job-cards used to hand over every card since go-live on every load and
// every realtime tick — 1,580 KB on live prod, 47% of it closed and split cards
// that only the Completed and All tabs show. The register now loads the live
// cards (`?scope=live`) on its own and the history (`?scope=history`) when a
// tab that shows it opens. Both halves carry `counts` for every rung, so the tab
// badges are right before the history has ever been fetched.
//
// Pure, so the server suite can hold the merge to the legacy response
// (server/src/job-cards-scope.test.js).

// Which rung of the ladder a card sits on. Every card sits on exactly one, so
// the tab counts add up to the register total. A gang parent that has split is
// history — it lives with the closed cards. An unfinalised card that has
// started is In Progress, because that is what it is (it wears a "Not
// finalised" chip there). The server's jobCardRung() is this rule's twin.
export const jobCardRung = j => {
  if (j.status === 'closed' || j.status === 'split') return 'closed';
  if (j.status === 'in_progress') return 'running';
  return j.finalised_at ? 'finalised' : 'pending';
};

export const isHistoryCard = j => jobCardRung(j) === 'closed';

// Live cards and history back into ONE list, in the server's legacy order —
// open work first, closed last, newest id first within each — so a batch print
// comes off the printer in the order the planner reads the screen, whichever
// tab each card was ticked under.
//
// A card can briefly be in both halves — a closed card reopened after the
// history was fetched. The live copy wins: the live half is refetched on every
// realtime tick and the history only when its tab opens, so live is the newer
// read, and the register refetches the history as soon as it sees the overlap
// (historyIsStale below). `history` is null until it has been fetched.
export function mergeRegister(live = [], history = null) {
  const byId = new Map();
  for (const j of history || []) byId.set(j.id, j);
  for (const j of live || []) byId.set(j.id, j);
  return [...byId.values()].sort((a, b) =>
    (a.status === 'closed') - (b.status === 'closed') || b.id - a.id);
}

// Has a live refresh just shown that the history is out of date? A card that
// left the live half closed or split (or was deleted); a card that is in both
// was reopened. Either way the history in hand no longer matches the plant, and
// a planner holding the Completed list or a cross-tab selection should not be
// the one to notice.
//
// While no history has been fetched there is nothing to be out of date — EXCEPT
// a card the planner has ticked for printing. The batch print is built from the
// register in hand, so a ticked card that closes under In Progress and is not
// fetched back is silently missing from the printed stack while the bar still
// counts it. `picked` is that selection (a Set of ids); unticked cards closing
// leave the 750 KB history unfetched, which is the whole saving.
export function historyIsStale(prevLive, nextLive, history, picked = null) {
  const next = new Set((nextLive || []).map(j => j.id));
  const left = (prevLive || []).filter(j => !next.has(j.id));
  if (!history) return !!picked && left.some(j => picked.has(j.id));
  if (left.length) return true;
  const past = new Set(history.map(j => j.id));
  return (nextLive || []).some(j => past.has(j.id));
}

// The register's two fetches, outside React so the server suite can drive them
// with hand-released responses (server/src/job-cards-register-loader.test.js).
// load() runs from realtime and from a dozen action handlers whose closures were
// made before the latest tab click, so the tab is read through getTab(), never
// captured. Each half carries its own sequence so a slow response never repaints
// over a newer one.
//
//   get(path)       → Promise of { cards, counts }
//   getTab()        → the tab open right now
//   showsHistory(t) → does tab t list the history?
//   onLive(cards) / onHistory(cards) / onCounts(counts) → the screen's setters
export function createRegisterLoader({ get, getTab, getPicked = () => null, showsHistory, onLive, onHistory, onCounts }) {
  let live = null;
  // History is WANTED from the moment a card is seen leaving the live half until a
  // history answer that STARTED after that moment lands. A failed background fetch
  // (plant Wi-Fi) is asked again on the next live refresh; one already on the wire
  // that started late enough is waited for, not duplicated.
  let clock = 0;
  let wantedAfter = null;
  let historyInFlightFrom = null;
  let history = null;
  let liveSeq = 0;
  let historySeq = 0;
  // `counts` rides with BOTH halves, and each half's own sequence cannot see the
  // other. A background history refetch (≈750 KB, slow) started before a newer
  // live refresh can land after it — and its SELECT ran before, say, a new job
  // card was inserted, so it would paint the All badge one card short until the
  // next DB change. One stamp across both halves, taken when the request
  // STARTS: counts are applied only from a response newer than the last applied.
  let countsStarted = 0;
  let countsShown = 0;
  const takeCounts = (stamp, counts) => {
    if (stamp <= countsShown) return;
    countsShown = stamp;
    onCounts(counts);
  };
  const loadHistory = () => {
    const n = ++historySeq;
    const stamp = ++countsStarted;
    const started = ++clock;
    historyInFlightFrom = started;
    return get('/job-cards?scope=history').then(d => {
      if (n !== historySeq) return;
      if (wantedAfter != null && started > wantedAfter) wantedAfter = null;
      history = d.cards;
      onHistory(d.cards);
      takeCounts(stamp, d.counts);
    }).finally(() => {
      if (n === historySeq) historyInFlightFrom = null;
    });
  };
  const loadLive = () => {
    const n = ++liveSeq;
    const stamp = ++countsStarted;
    return get('/job-cards?scope=live').then(d => {
      if (n !== liveSeq) return;
      // A card that just closed has left the live half and is not yet in the
      // history held from earlier (or no history is held and the card was ticked
      // for printing); a reopened one is in both. Refetch the history then, so a
      // card ticked for printing never drops out of the selection just because it
      // finished while the planner was on another tab. (On a history tab load()
      // is already fetching it alongside.)
      if (historyIsStale(live, d.cards, history, getPicked())) wantedAfter = clock;
      live = d.cards;
      onLive(d.cards);
      takeCounts(stamp, d.counts);
      const covered = historyInFlightFrom != null && historyInFlightFrom > (wantedAfter ?? Infinity);
      if (wantedAfter != null && !covered && !showsHistory(getTab())) loadHistory().catch(() => {});
    });
  };
  const load = () => Promise.all([loadLive(), showsHistory(getTab()) ? loadHistory() : null]);
  return { load, loadLive, loadHistory };
}

// The batch print is the FULL selection. The bar says "Export PDF (5)", so five
// cards print: register order for the cards on screen, then any ticked card the
// screen no longer holds (it closed while its history half was still loading, or
// that fetch failed) — newest first, the register's own order for closed cards.
export function printRunIds(jobs, picked) {
  const shown = jobs.filter(j => picked.has(j.id)).map(j => j.id);
  const held = new Set(shown);
  const missing = [...picked].filter(id => !held.has(id)).sort((a, b) => b - a);
  return [...shown, ...missing];
}
