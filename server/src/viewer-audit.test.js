import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gangPosition, stockHoldBudget } from './board-allocation.js';

// THE VIEWER RULE, swept across the whole app after the ACEBROBID panel:
// every stock figure has a viewer, and a number computed for one viewer must
// never be rendered, summed or gated under a label claiming another. These
// pins hold the 2026-08-11 audit's fixes in place — each one was a live,
// adversarially-verified disagreement between a number and its sentence.

const read = f => readFileSync(new URL(f, import.meta.url), 'utf8');

// ── /warehouse/paper: the picker IS the engine's Warehouse button ──────────
test('the warehouse picker reserves stock holds, not just open needs', () => {
  const src = read('./routes/inventory.js');
  const i = src.indexOf('LEFT JOIN (SELECT mid, SUM(reserved)');
  assert.ok(i > 0, 'the committed subquery sums reservations, both arms');
  const q = src.slice(i, i + 1200);
  assert.match(q, /UNION ALL/, 'open need is ONE arm — the holds are the other');
  assert.match(q, /ba\.status='active' AND ba\.source='stock'/,
    'every active stock hold reserves shelf at face value, whoever owns it — '
    + 'open need alone let a fully-frozen job\'s 8,959 sit inside "Free"');
});

// ── one ledger for held_for_me ─────────────────────────────────────────────
test('held_for_me is never overwritten with mix PLAN sheets', () => {
  for (const f of ['./routes/orders.js', './routes/board.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /held_for_me:\s*mixPos\.held/,
      `${f}: mixPos.held is job_board_mix plan sheets — a different ledger, and `
      + 'the saved hold is CAPPED below the row; subtracting plan-sheets from an '
      + 'allocations total sent heldOthers wrong the moment a mix was capped');
    assert.match(src, /mix_held:\s*mixPos\.held/,
      `${f}: the mix figure still rides along, under its own name`);
  }
});

// ── gangPosition: a draft's freeze is not invisible ────────────────────────
test('gangPosition book-mode short counts holds outside the claim set', () => {
  const base = {
    needed: 700, committedOther: 0, available: 9000,
    allocations: [], memberIds: [10], materialId: 5, stockBooking: 'book',
  };
  assert.equal(gangPosition(base).short, 0, 'plenty free, nothing short');
  // A pending draft (line 99, in NO claim set) froze 8,959 — the run must
  // read short 659, exactly the ACEBROBID/HB-29 arithmetic.
  const p = gangPosition({ ...base, heldOthers: 8959 });
  assert.equal(p.short, 659);
  assert.equal(p.held_others, 8959, 'and says so under its own name');
  // fresh_pr refuses the shelf — outsiders' freezes are not its business.
  const f = gangPosition({ ...base, heldOthers: 8959, stockBooking: 'fresh_pr' });
  assert.equal(f.short, 700, 'still-to-buy is its own requirement, untouched');
});

test('gangDetail feeds heldOthers and splits multi-board runs', () => {
  const src = read('./routes/gangs.js');
  assert.match(src, /heldOthers,\s*\n?\s*available/, 'positionFor passes heldOthers');
  assert.match(src, /other_board_positions/, 'a second board gets its own position');
  assert.match(src, /!claimLineIds\.has\(Number\(a\.order_line_id\)\)/,
    'claim lines\' holds are EXCLUDED — they already sit inside committedOther, '
    + 'and adding them again bills the same sheets twice');
});

// ── candidate costing quotes the figure the lock will actually allow ───────
test('every candidate/saved-row free comes from stockHoldBudget', () => {
  const orders = read('./routes/orders.js');
  const gangs = read('./routes/gangs.js');
  for (const [name, src] of [['orders.js', orders], ['gangs.js', gangs]]) {
    assert.doesNotMatch(src, /\.free = Math\.max\(0, Math\.round\(Number\(\w+\.available \|\| 0\) - \w+\.committed\)\)/,
      `${name}: available − committed omits heldOutsideClaims — the hand-rolled spelling is banned`);
  }
  assert.match(orders, /c\.free = Math\.round\(budget\.free\)/);
  assert.match(gangs, /c\.free = Math\.round\(budget\.free\)/);
  assert.match(gangs, /r\.free = Math\.round\(budget\.free\)/);
});

test('smart match nets outsiders\' holds off its free', () => {
  const sm = read('./smartmatch.js');
  assert.match(sm, /const free = Math\.max\(0, available - committed - held\)/,
    'a suggestion must never quote board a saved draft has frozen');
  const orders = read('./routes/orders.js');
  assert.match(orders, /c\.held = stockHoldBudget\(/,
    'the endpoint supplies that held figure');
});

// ── raise-pr judges claimable, not the gross shelf ─────────────────────────
test('raise-pr builds a readiness ctx so available means claimable', () => {
  const src = read('./routes/orders.js');
  const i = src.indexOf("r.post('/order-lines/:id/raise-pr'");
  const block = src.slice(i, i + 1400);
  assert.match(block, /readinessBatch\(\[line\]\)/,
    'without a ctx the gate read the gross shelf and answered "No shortage" '
    + 'for a board fully frozen for other jobs — refusing the PR for the exact '
    + 'situation a PR exists to solve');
  assert.match(block, /readiness\(line, one, ctx\)/);
});

// ── client: the gates and the one-ledger seeds ─────────────────────────────
test('Commit-more caps at free_for_others — an increment\'s viewer is "unheld"', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  assert.match(src, /Math\.min\(position\?\.free_for_others \?\? 0, \(calc\?\.parent \?\? 0\) - held\)/,
    'position.free contains the job\'s own hold; capping the INCREMENT there '
    + 'offered Commit 700 against four-tenths of a packet of unheld board');
});

test('a short lock is amber and asks — single engine and run alike', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  assert.match(src, /position\.short > 0 && !lockShortConfirm/, 'single-engine soft gate in onLock');
  assert.match(src, /setGangLockShortConfirm\(gangShortNow\)/, 'run-level soft gate in lockGangPlan');
  assert.match(src, /onClick=\{\(\) => lockGangPlan\(\)\}/,
    'never a bare onClick={lockGangPlan} — the click event would land in '
    + 'confirmedShort, truthy, and silently skip the confirm');
  const gates = [...src.matchAll(/!bg-amber-500/g)];
  assert.ok(gates.length >= 2, 'both Lock buttons wear amber when short (variant="solid" — .btn-brand paints over bg-*)');
});

test('the Board Position claimants carry the figure its Committed tile sums', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  assert.match(src, /<Claimants claimants=\{ctx\.stock\.claimants\} figure="claim"/,
    'rows of open_need under a tile summing open_need + holds showed '
    + '"Committed to ACEBROBID — 0" for the job freezing the shelf');
  const bc = read('../../client/src/components/BoardClaims.jsx');
  assert.match(bc, /figure === 'claim'/, 'and BoardClaims knows the mode');
});

test('reopened mix rows read free first, and a frozen board is not "empty"', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  const seeds = [...src.matchAll(/available: r\.free \?\? r\.available \?\? c\?\.free \?\? c\?\.available \?\? null/g)];
  assert.equal(seeds.length, 2, 'single-line and gang seeds share ONE spelling');
  const bm = read('../../client/src/components/BoardMix.jsx');
  assert.match(bm, /Number\(r\.shelf\) > 0/,
    'full-but-frozen ≠ empty: the raw shelf rides separately so the warning '
    + 'stops sending planners hunting for stock sitting in the racks');
});

test('the run panel has ONE spelling of "short right now"', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  const lib = read('../../client/src/lib/gangShort.js');
  // The arithmetic lives in the lib and NOWHERE else. Three inline copies is
  // how the single engine's verdicts drifted, and an inline copy in a .jsx is
  // unreachable by `node --test`, which is how it drifted unnoticed.
  assert.equal([...lib.matchAll(/leadShare \+ other - avail - onOrder/g)].length, 1,
    'the book-branch shortfall arithmetic lives ONLY in lib/gangShort.js');
  assert.equal([...src.matchAll(/leadShare \+ other - avail - onOrder/g)].length, 0,
    'and Planning.jsx re-derives none of it');
  assert.equal([...src.matchAll(/gangShortView\(/g)].length, 1,
    'the page calls it exactly once — the footer, the Board Position card and '
    + 'the lock gate all read that one result');
  assert.match(lib, /held_others \?\? 0/, 'and it carries the server\'s held_others');
  // The LEAD board answers for its own members' sheets — the server scopes it
  // that way and gives every other board its own entry. A shared layout is the
  // exception: one sheet prints every member.
  assert.match(lib, /sharedMode \? num\(issueNow\) : num\(position\?\.needed_gross \?\? issueNow\)/,
    'scoped on sharedMode — the server\'s sharedRun is also null for a merge '
    + 'run and a pending layout, which layout_mode alone cannot tell');
  assert.match(lib, /otherBoardPositions \|\| \[\]/,
    'and the other boards\' shortfalls are read, not left invisible');
  assert.match(lib, /totalShort: short \+ otherBoards\.reduce/,
    'the lock gate and the button quote the WHOLE run — the lock caps holds on every board');
});

// CI-MRG-0014, 18 Aug 2026: the Board Mix panel totalled "Fully covered ✓" over
// 2,875 of 2,875 while the footer and the Lock button both read "short 507" —
// the exact shortfall the mix had just been seeded to close. The verdict was
// read off position.needed, which credits the SAVED mix and cannot see rows
// still being typed.
test('the run\'s shortfall is measured against the mix ON SCREEN', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  const lib = read('../../client/src/lib/gangShort.js');
  assert.match(src, /mixRows: gangMixRows/,
    'the LIVE draft rows go in, not gangView.mix.rows — the planner is looking '
    + 'at what they have typed, and the server has not seen it');
  assert.match(src, /mixCovered: mixTotals\(gangMixRows,/,
    'and the coverage the panel itself totals, so the two cannot disagree');
  // needed_gross is the lead board's requirement BEFORE any mix credit.
  // position.needed is the same figure with the saved mix already taken off, so
  // re-applying pressingOnPlanned to it would credit a saved mix twice and a
  // drafted one not at all.
  assert.doesNotMatch(lib, /position\?\.needed\b(?!_gross)/,
    'the lead share is built from needed_gross, never the mix-credited needed');
  const gangs = read('./routes/gangs.js');
  assert.match(gangs, /needed_gross: Number\(neededGross\) \|\| 0/,
    'which the server has to ship — it cannot be recovered by subtraction once '
    + 'pressingOnPlanned\'s max() has clamped it');
  assert.match(gangs, /position = positionFor\(boardId, neededOnPlanned, requiredOnPlanned\)/,
    'and it is the PRE-mix requirement that goes in');
});

// The server owns the others-only figure, because only the server knows each
// line's cap. A client that derives it by subtraction reintroduces the
// over-hold erasure — held is CAPPED per line, held_for_me is not.
test('held_others is emitted by the server and consumed verbatim', () => {
  const alloc = read('./board-allocation.js');
  assert.match(alloc, /held_others: held - Math\.min\(heldFor\(filtered, line\.id\), lineNeed\(line\)\)/,
    'linePosition subtracts this line\'s CAPPED contribution, not its raw hold');
  const orders = read('./routes/orders.js');
  assert.match(orders, /held_others: stockShown\.held_others/, 'and the payload carries it');
  const planning = read('../../client/src/pages/Planning.jsx');
  assert.match(planning, /heldOthers: ctx\.stock\.held_others != null \? \+ctx\.stock\.held_others : null/,
    'the client passes it through rather than deriving it');
});

// The traffic light and the badge are fed the SAME gates object precisely so
// "the two can never describe different facts" — but only the badge knew about
// the draw, so a card whose board was on the machine wore a green Board OK chip
// beside a RED light saying "Board short — nothing on order", and
// board_available is hard:true so that light blocked the row.
test('the traffic light knows a drawn board is not a board question', () => {
  const light = read('./readiness-light.js');
  const fn = light.slice(light.indexOf('function boardAvailable'), light.indexOf('function boardAvailable') + 2600);
  assert.match(fn, /if \(gates\.board_drawn\) return \['ok', null\]/,
    'and it short-circuits FIRST — a mixed drawn job returns blocked from inside the mix arm');
  assert.ok(fn.indexOf('gates.board_drawn') < fn.indexOf('gates.mix_active'),
    'ahead of the mix branch, not after gates.material');
  const helpers = read('./helpers.js');
  assert.match(helpers, /gates\.board_drawn = drawn\.has\(id\)/,
    'stampBoardState stamps the fact onto the shared gates, not just into the verdict');
});

// A fresh_pr line said it will not run on the shelf. claimsByBoard fences such a
// claim to its own incoming PR, gangPosition gives it a branch, boardPositionView
// gives it another — and COMMITTED_DEMAND_SQL did not, so the Board register's
// Frozen / Free to Promise denied the promise the planning engine had just made.
test('committed demand fences a fresh_pr claim to its own PR', async () => {
  const { COMMITTED_DEMAND_SQL } = await import('./replenishment.js');
  assert.match(COMMITTED_DEMAND_SQL, /fenced AS \(/, 'the fence is its own CTE');
  assert.match(COMMITTED_DEMAND_SQL, /WHEN ol\.stock_booking = 'fresh_pr'/);
  assert.match(COMMITTED_DEMAND_SQL, /GREATEST\(b\.qty - COALESCE\(inc\.qty, 0\), 0\)/,
    'capped at what its own PR has NOT covered — before the PR exists the full claim still presses');
  assert.match(COMMITTED_DEMAND_SQL, /FROM fenced b/, 'and the final SELECT reads the fenced set');
});

// smartmatch subtracts a third term; the run path never supplied it, so the two
// Smart Match panels quoted different free stock for the same board — and the
// run's is the one that buys on ONE combined PR.
test('the run Smart Match supplies the held term too', () => {
  const gangs = read('./routes/gangs.js');
  const i = gangs.indexOf("r.get('/gang-runs/:id/smart-match'");
  const block = gangs.slice(i, i + 4200);
  assert.match(block, /c\.held = stockHoldBudget\(/, 'the run endpoint sets held');
  assert.match(block, /ownerLineIds: members\.map\(m => m\.id\)/, "excluding the run's own members");
});
