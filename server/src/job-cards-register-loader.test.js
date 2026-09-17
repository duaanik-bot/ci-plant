// The Job Cards register's two fetches, driven with hand-released responses.
//
// The register loads its live cards on every realtime tick and its history
// (closed + split cards) only when a tab that shows it opens
// (client/src/lib/jobCardRegister.js). Two plant scenarios broke that split and
// are pinned here, in the order the floor produces them:
//
//  1. A planner ticks cards under In Progress for a batch print and never opens
//     Completed. The floor closes one of them. It leaves the live half, the
//     history was never fetched, and the card silently fell out of the printed
//     stack while the bar still said "Export PDF (5)".
//  2. Both halves carry `counts`. A background history refetch (≈750 KB, slow)
//     that started BEFORE a newer live refresh could land AFTER it and paint the
//     Completed/All badges with the older snapshot until the next DB change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegisterLoader, mergeRegister, printRunIds } from '../../client/src/lib/jobCardRegister.js';

// A fake api.get whose responses the test releases one by one, in any order.
function harness({ tab = 'running', picked = new Set() } = {}) {
  const requests = [];
  const screen = { live: [], history: null, counts: null, tab, picked };
  const loader = createRegisterLoader({
    get: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
    getTab: () => screen.tab,
    getPicked: () => screen.picked,
    showsHistory: t => t === 'closed' || t === 'all',
    onLive: cards => { screen.live = cards; },
    onHistory: cards => { screen.history = cards; },
    onCounts: counts => { screen.counts = counts; },
  });
  // Release request i and let every .then it feeds settle.
  const release = async (req, body) => { req.resolve(body); await new Promise(r => setImmediate(r)); };
  const fail = async req => { req.reject(new Error('network')); await new Promise(r => setImmediate(r)); };
  return { loader, requests, screen, release, fail };
}
const card = (id, status) => ({ id, status });
const historyRequests = requests => requests.filter(r => r.path === '/job-cards?scope=history');

test('a ticked card that closes while history was never fetched is fetched back into the print run', async () => {
  const { loader, requests, screen, release } = harness({ tab: 'running', picked: new Set([9, 8]) });
  // First load on In Progress: live only.
  loader.load();
  await release(requests[0], { cards: [card(9, 'in_progress'), card(8, 'in_progress')], counts: { all: 2 } });
  assert.equal(screen.history, null, 'history is not fetched on a live tab');

  // The floor completes card 8's last stage; realtime refreshes the live half.
  loader.load();
  await release(requests[1], { cards: [card(9, 'in_progress')], counts: { all: 2 } });
  const hist = historyRequests(requests);
  assert.equal(hist.length, 1, 'a picked card left the live half — the history must be fetched to keep it in the print run');
  await release(hist[0], { cards: [card(8, 'closed')], counts: { all: 2 } });

  // exportPdf prints jobs.filter(j => picked.has(j.id)) — both cards, register order.
  const ids = mergeRegister(screen.live, screen.history).filter(j => screen.picked.has(j.id)).map(j => j.id);
  assert.deepEqual(ids, [9, 8]);
});

test('an unticked card closing does not pull the history onto a live tab', async () => {
  const { loader, requests, release } = harness({ tab: 'running', picked: new Set([9]) });
  loader.load();
  await release(requests[0], { cards: [card(9, 'in_progress'), card(8, 'in_progress')], counts: { all: 2 } });
  loader.load();
  await release(requests[1], { cards: [card(9, 'in_progress')], counts: { all: 2 } });
  assert.equal(historyRequests(requests).length, 0, 'nothing ticked left — the 750 KB history stays unfetched');
});

test('a slow background history refetch never paints the badges over a newer live refresh', async () => {
  const { loader, requests, screen, release } = harness({ tab: 'pending' });
  // History held from an earlier visit to Completed.
  loader.loadHistory();
  await release(requests[0], { cards: [card(3, 'closed')], counts: { all: 3 } });
  loader.load();
  await release(requests[1], { cards: [card(9, 'in_progress'), card(8, 'open')], counts: { all: 3 } });

  // Card 9 closes: live refresh L sees stale history and starts background H.
  loader.load();
  await release(requests[2], { cards: [card(8, 'open')], counts: { all: 3 } });
  const H = requests[3];
  assert.equal(H.path, '/job-cards?scope=history');

  // ~600 ms later a new job card is created; realtime runs L', which returns first.
  loader.load();
  const L2 = requests[4];
  assert.equal(L2.path, '/job-cards?scope=live');
  await release(L2, { cards: [card(10, 'open'), card(8, 'open')], counts: { all: 4 } });
  assert.equal(screen.counts.all, 4);

  // H's SELECT ran before the insert committed; it lands last with the old count.
  await release(H, { cards: [card(9, 'closed'), card(3, 'closed')], counts: { all: 3 } });
  assert.equal(screen.counts.all, 4, 'the All badge must keep the newer live count (4), not the older history snapshot (3)');
  // The history cards themselves are still taken — they are the only copy.
  assert.deepEqual(screen.history.map(j => j.id), [9, 3]);
});

test('a history response that started after a live one still carries the newer counts', async () => {
  const { loader, requests, screen, release } = harness({ tab: 'closed' });
  // Opening Completed: load() starts live then history.
  loader.load();
  const [L, H] = requests;
  await release(H, { cards: [card(3, 'closed')], counts: { all: 2 } });
  await release(L, { cards: [card(8, 'open')], counts: { all: 1 } });
  assert.equal(screen.counts.all, 2, 'the later-started history read wins over an earlier-started live read');
});

test('with no history held, only a TICKED card leaving the live half marks it stale', async () => {
  const { historyIsStale } = await import('../../client/src/lib/jobCardRegister.js');
  const a = card(9, 'in_progress'), b = card(8, 'in_progress');
  assert.equal(historyIsStale([a, b], [a], null), false, 'nothing ticked — no fetch');
  assert.equal(historyIsStale([a, b], [a], null, new Set([9])), false, 'the ticked card is still live');
  assert.equal(historyIsStale([a, b], [a], null, new Set([8])), true, 'ticked card 8 closed');
  assert.equal(historyIsStale(null, [a], null, new Set([8])), false, 'the first load loses nothing');
});


// 3. The background history fetch that scenario 1 relies on can itself fail — plant
//    Wi-Fi. Staleness was only noticed when a card left BETWEEN two live answers, so
//    after one failed history GET no later refresh looked again and the ticked card
//    stayed out of the print run for good (and the rejection went unhandled).
test('a failed background history fetch is retried on the next live refresh, not forgotten', async () => {
  const { loader, requests, screen, release, fail } = harness({ tab: 'running', picked: new Set([9]) });
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    loader.loadLive(); await release(requests[0], { cards: [card(9, 'in_progress')], counts: {} });
    loader.loadLive(); await release(requests[1], { cards: [], counts: {} });      // card 9 closed
    assert.equal(historyRequests(requests).length, 1);
    await fail(historyRequests(requests)[0]);
    loader.loadLive(); await release(requests.at(-1), { cards: [], counts: {} });  // nothing left this time
    assert.equal(historyRequests(requests).length, 2, 'still wanted: asked again');
    await release(historyRequests(requests)[1], { cards: [card(9, 'closed')], counts: {} });
    loader.loadLive(); await release(requests.at(-1), { cards: [], counts: {} });
    assert.equal(historyRequests(requests).length, 2, 'applied once: no more asking');
    assert.deepEqual(screen.history.map(c => c.id), [9]);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(unhandled, [], 'a failed background fetch is caught');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// And whatever the fetches do, the print run is the FULL selection: the bar says
// "Export PDF (5)", so five cards print — register order for the ones on screen,
// then any ticked card the screen no longer holds, newest first (the register's
// own order for closed cards).
test('the print run never drops a ticked card the screen does not currently hold', () => {
  const jobs = [card(12, 'open'), card(10, 'in_progress'), card(7, 'closed')];
  assert.deepEqual(printRunIds(jobs, new Set([7, 12])), [12, 7]);
  assert.deepEqual(printRunIds(jobs, new Set([3, 10, 9])), [10, 9, 3]);
  assert.deepEqual(printRunIds(jobs, new Set()), []);
});
