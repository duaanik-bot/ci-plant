import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packetPlan, looseAfter } from './packet-plan.js';

const opt = (plan, key) => plan.options.find(o => o.key === key);

// Lots whose remainders sum to exactly `loose` and hold no whole packet, so a
// case can be written as "loose 250" without hand-splitting piles. Every chunk
// is packetSize − 1, i.e. one short of a packet, so intact_available stays 0.
const looseOnlyLots = (loose, packetSize) => {
  const lots = [];
  let left = loose;
  while (left > packetSize - 1) { lots.push({ qty: packetSize - 1 }); left -= packetSize - 1; }
  if (left > 0) lots.push({ qty: left });
  return lots;
};

// ── Anik's Example 1 — 910 sheets, 100 to a packet, nothing loose ─────
// 910 ÷ 100 = 9.1 → 10 sealed packets broken, 1,000 sheets on the trolley,
// 90 sheets of spare. This is what the plant does today, every time.
test("Example 1: no loose at all — 10 packets, 1,000 issued, 90 spare", () => {
  const plan = packetPlan({ required: 910, packetSize: 100, lots: [] });
  assert.equal(plan.loose_available, 0);
  assert.equal(plan.intact_available, 0);
  assert.deepEqual(opt(plan, 'packets_only'),
    { key: 'packets_only', loose_used: 0, remaining: 910, packets: 10, total_issue: 1000, excess: 90 });
  // With an empty shelf, "clear the loose first" IS packets-only. The option
  // must still be present and must degenerate rather than vanish, because the
  // panel shows a fixed set of four.
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 0, remaining: 910, packets: 10, total_issue: 1000, excess: 90 });
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 0, remaining: 910, packets: 10, total_issue: 1000, excess: 90 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 0, remaining: 910, packets: null, total_issue: 910, excess: 0 });
});

// A shelf holding 9 sealed packets and nothing opened is the same answer: it is
// LOOSE that changes the advice, not stock.
test('Example 1: a lot that divides exactly is 9 intact, 0 loose — same four options', () => {
  const plan = packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 900 }] });
  assert.equal(plan.loose_available, 0);
  assert.equal(plan.intact_available, 9);
  assert.deepEqual(plan.options, packetPlan({ required: 910, packetSize: 100, lots: [] }).options);
});

// ── Anik's Example 2 — 60 loose already on the shelf ──────────────────
// One pile of 960: 960 ÷ 100 = 9 whole packets, remainder 60 → 60 loose.
//   clear_loose : 60 loose + ⌈850/100⌉ = 9 packets → 60 + 900 = 960, spare 50
//   least_excess: 10 loose + 900 = 910 exactly, spare 0
test('Example 2: 910 needed, 60 loose — clear_loose 50 spare, least_excess lands on 910', () => {
  const plan = packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 960 }] });
  assert.equal(plan.loose_available, 60);
  assert.equal(plan.intact_available, 9);
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 60, remaining: 850, packets: 9, total_issue: 960, excess: 50 });
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 10, remaining: 900, packets: 9, total_issue: 910, excess: 0 });
  assert.deepEqual(opt(plan, 'packets_only'),
    { key: 'packets_only', loose_used: 0, remaining: 910, packets: 10, total_issue: 1000, excess: 90 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 60, remaining: 850, packets: null, total_issue: 910, excess: 0 });
});

// ── The per-lot rule, which is the heart of the derivation ────────────
// Three part-open packets holding 50 each are 150 loose and NO sealed packet.
// A remainder taken on the TOTAL (150) would report 50 loose + 1 intact — one
// sealed packet that does not exist anywhere in the warehouse.
test('per-lot derivation: three piles of 50 are 150 loose / 0 intact, not 50 / 1', () => {
  const plan = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 50 }, { qty: 50 }, { qty: 50 }] });
  assert.equal(plan.loose_available, 150);
  assert.equal(plan.intact_available, 0);

  // The answer the remainder-of-the-total would have given, spelled out so the
  // regression is unmistakable if the loop is ever moved onto the sum.
  const remainderOfTotal = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 150 }] });
  assert.equal(remainderOfTotal.loose_available, 50);
  assert.equal(remainderOfTotal.intact_available, 1);
  assert.notEqual(plan.loose_available, remainderOfTotal.loose_available);
  assert.notEqual(plan.intact_available, remainderOfTotal.intact_available);
  assert.notDeepEqual(plan.options, remainderOfTotal.options);

  // 400 needed against 150 loose:
  //   clear_loose : 150 + ⌈250/100⌉ = 3 packets → 150 + 300 = 450, spare 50
  //   least_excess: 400 is an exact multiple, so any multiple of 100 of loose
  //                 lands exactly. 100 is the most that fits in 150 → 3 packets.
  //   packets_only: 4 packets = 400, spare 0
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 150, remaining: 250, packets: 3, total_issue: 450, excess: 50 });
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 100, remaining: 300, packets: 3, total_issue: 400, excess: 0 });
  assert.deepEqual(opt(plan, 'packets_only'),
    { key: 'packets_only', loose_used: 0, remaining: 400, packets: 4, total_issue: 400, excess: 0 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 150, remaining: 250, packets: null, total_issue: 400, excess: 0 });
});

// ── The tie, broken toward MORE loose ─────────────────────────────────
// 910 needed, 160 loose (two piles: 880 → 8 intact + 80 loose, 780 → 7 + 80).
// Loose of 10 AND of 110 both land on 910 with zero spare. They are not equal
// on the floor: 110 loose needs 8 sealed packets where 10 loose needs 9. Same
// total, same zero spare, one fewer packet broken and 100 more loose cleared.
test('least_excess: at equal spare it takes MORE loose — 110 + 8 packets, not 10 + 9', () => {
  const plan = packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 880 }, { qty: 780 }] });
  assert.equal(plan.loose_available, 160);
  assert.equal(plan.intact_available, 15);
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 110, remaining: 800, packets: 8, total_issue: 910, excess: 0 });
  // The losing tie member, for the record: 10 loose + 9 packets = 910, spare 0.
  assert.notEqual(opt(plan, 'least_excess').loose_used, 10);
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 160, remaining: 750, packets: 8, total_issue: 960, excess: 50 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 160, remaining: 750, packets: null, total_issue: 910, excess: 0 });
});

// ── The boundary that catches "always use the loose" ──────────────────
// 900 needed is nine whole packets already. Adding 60 loose does not save a
// packet — ⌈840/100⌉ is still 9 — it just puts 60 more sheets on the trolley.
// So least_excess must refuse the loose here and land on 900 with zero spare.
test('exact multiple: using loose ADDS spare, so least_excess uses none', () => {
  const plan = packetPlan({ required: 900, packetSize: 100, lots: [{ qty: 960 }] });
  assert.equal(plan.loose_available, 60);
  assert.equal(plan.intact_available, 9);
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 0, remaining: 900, packets: 9, total_issue: 900, excess: 0 });
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 60, remaining: 840, packets: 9, total_issue: 960, excess: 60 });
  assert.deepEqual(opt(plan, 'packets_only'),
    { key: 'packets_only', loose_used: 0, remaining: 900, packets: 9, total_issue: 900, excess: 0 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 60, remaining: 840, packets: null, total_issue: 900, excess: 0 });
});

// ── Loose covers the whole job ────────────────────────────────────────
// 40 needed, 60 loose: take 40 off the shelf, break nothing, spare nothing.
// `remaining` 0 must produce 0 packets, not a courtesy one.
test('loose exceeds the requirement: 40 off the shelf, no packet opened', () => {
  const plan = packetPlan({ required: 40, packetSize: 100, lots: [{ qty: 60 }] });
  assert.equal(plan.loose_available, 60);
  assert.equal(plan.intact_available, 0);
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 40, remaining: 0, packets: 0, total_issue: 40, excess: 0 });
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 40, remaining: 0, packets: 0, total_issue: 40, excess: 0 });
  // Breaking a sealed packet for a 40-sheet job wastes 60 sheets of it.
  assert.deepEqual(opt(plan, 'packets_only'),
    { key: 'packets_only', loose_used: 0, remaining: 40, packets: 1, total_issue: 100, excess: 60 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 40, remaining: 0, packets: null, total_issue: 40, excess: 0 });
  // Never more loose than the job can use.
  for (const o of plan.options) assert.ok(o.loose_used <= 40, `${o.key} over-picked loose`);
});

// ── Fractional lot quantities floor, never round up ───────────────────
// Board qty is DOUBLE PRECISION. 960.7 on the shelf is 960 pickable sheets:
// 9 sealed packets and 60 loose. Rounding to 961 would promise a sheet nobody
// can hand over, and `960.7 % 100` would print 60.699999999999996 loose.
test('fractional lot qty: 960.7 floors to 960 → 9 intact, 60 loose, never 961', () => {
  const plan = packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 960.7 }] });
  assert.equal(plan.loose_available, 60);
  assert.equal(plan.intact_available, 9);
  // Byte-identical to the whole-number pile of 960 — the fraction is dropped,
  // not carried into a fractional loose figure.
  assert.deepEqual(plan, packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 960 }] }));

  // And a pile one-tenth of a sheet short of a packet is NOT a packet.
  const nearly = packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 99.9 }] });
  assert.equal(nearly.intact_available, 0);
  assert.equal(nearly.loose_available, 99);
});

// ── A fractional requirement still picks WHOLE loose sheets ───────────
// No caller produces a fractional `required` today — parent sheet counts and
// job_board_mix.sheets are both whole — so this closes a latent oddity rather
// than a live bug. Nobody can hand over half a loose sheet, so all four options
// pick out of ONE whole-sheet cap.
//
// 910.5 needed, P 100, one pile of 960 → 9 intact, 60 loose:
//   clear_loose : 60 + ⌈850.5/100⌉ = 9 packets → 960, spare 49.5
//   least_excess: 910.5 mod 100 = 10.5, and loose comes in whole sheets, so the
//                 nearest reachable landing is 11 + 900 = 911, spare 0.5. Ten
//                 loose would leave 900.5 and buy a TENTH packet — spare 99.5.
//   packets_only: 10 packets = 1,000, spare 89.5
//   exact       : 60 loose, issue 910.5, spare 0
test('fractional required: every option picks a whole number of loose sheets', () => {
  const plan = packetPlan({ required: 910.5, packetSize: 100, lots: [{ qty: 960 }] });
  assert.equal(plan.loose_available, 60);
  assert.equal(plan.intact_available, 9);
  for (const o of plan.options) {
    assert.ok(Number.isInteger(o.loose_used), `${o.key} picked ${o.loose_used} loose sheets`);
  }
  assert.deepEqual(opt(plan, 'clear_loose'),
    { key: 'clear_loose', loose_used: 60, remaining: 850.5, packets: 9, total_issue: 960, excess: 49.5 });
  assert.deepEqual(opt(plan, 'least_excess'),
    { key: 'least_excess', loose_used: 11, remaining: 899.5, packets: 9, total_issue: 911, excess: 0.5 });
  assert.deepEqual(opt(plan, 'packets_only'),
    { key: 'packets_only', loose_used: 0, remaining: 910.5, packets: 10, total_issue: 1000, excess: 89.5 });
  assert.deepEqual(opt(plan, 'exact'),
    { key: 'exact', loose_used: 60, remaining: 850.5, packets: null, total_issue: 910.5, excess: 0 });
  // 0.5 is the least a whole number of loose sheets can leave here: the option
  // one sheet down buys a tenth packet and leaves 99.5.
  assert.ok(opt(plan, 'least_excess').excess < opt(plan, 'clear_loose').excess);

  // And where the requirement itself is the binding cap, the cap floors too:
  // 40.5 needed against 60 loose picks 40, not 40.5.
  const small = packetPlan({ required: 40.5, packetSize: 100, lots: [{ qty: 60 }] });
  assert.deepEqual(opt(small, 'clear_loose'),
    { key: 'clear_loose', loose_used: 40, remaining: 0.5, packets: 1, total_issue: 140, excess: 99.5 });
  assert.deepEqual(opt(small, 'exact'),
    { key: 'exact', loose_used: 40, remaining: 0.5, packets: null, total_issue: 40.5, excess: 0 });
  // ⌈40.5⌉ = 41 is past the 40-sheet cap, so the sawtooth never reaches a root
  // and loose only adds spare — no loose is the least-excess answer.
  assert.deepEqual(opt(small, 'least_excess'),
    { key: 'least_excess', loose_used: 0, remaining: 40.5, packets: 1, total_issue: 100, excess: 59.5 });
});

// ── Guards ───────────────────────────────────────────────────────────
// No packet size is a BROKEN MASTER, and the panel must say so. Assuming 100
// would print confident packet advice for a board bought in 144s.
test('guard: no usable packet size returns null — never an assumed 100', () => {
  assert.equal(packetPlan({ required: 910, lots: [] }), null);
  assert.equal(packetPlan({ required: 910, packetSize: null, lots: [] }), null);
  assert.equal(packetPlan({ required: 910, packetSize: 0, lots: [] }), null);
  assert.equal(packetPlan({ required: 910, packetSize: -100, lots: [] }), null);
  assert.equal(packetPlan({ required: 910, packetSize: NaN, lots: [] }), null);
  assert.equal(packetPlan({ required: 910, packetSize: 'abc', lots: [] }), null);
  assert.equal(packetPlan({ required: 910, packetSize: '', lots: [] }), null);
});

// Nothing to plan for. A zero or negative requirement is not a picking problem,
// and four options against it would all read 0 — noise on a screen.
test('guard: a requirement of zero or less returns null', () => {
  assert.equal(packetPlan({ required: 0, packetSize: 100, lots: [] }), null);
  assert.equal(packetPlan({ required: -50, packetSize: 100, lots: [{ qty: 960 }] }), null);
  assert.equal(packetPlan({ required: null, packetSize: 100, lots: [] }), null);
  assert.equal(packetPlan({ packetSize: 100, lots: [] }), null);
  assert.equal(packetPlan({ required: 'many', packetSize: 100, lots: [] }), null);
});

// This runs inside a render. It returns null; it never throws.
test('guard: never throws, whatever it is handed', () => {
  assert.equal(packetPlan(), null);
  assert.equal(packetPlan(null), null);
  assert.equal(packetPlan({}), null);
  assert.equal(packetPlan(0), null);
  assert.equal(packetPlan('nonsense'), null);
});

// DELIBERATE ASYMMETRY with the packet-size guard. An empty shelf is not a
// broken master — it is Anik's Example 1, an ordinary Monday, and the
// packets-only advice against it is exactly right. Answering null there would
// hide working advice behind a "no packet size" message that is a lie.
test('lots: absent, empty or unusable is a real zero-loose answer, not null', () => {
  const bare = { required: 910, packetSize: 100 };
  const zero = packetPlan({ ...bare, lots: [] });
  assert.ok(zero);
  assert.equal(zero.loose_available, 0);
  assert.equal(zero.intact_available, 0);
  for (const lots of [undefined, null, [], 'nonsense', 42, {}]) {
    assert.deepEqual(packetPlan({ ...bare, lots }), zero, `lots: ${JSON.stringify(lots)}`);
  }
  // A row with no usable qty is a pile that is not there. A NEGATIVE qty is not
  // a pile either, and must not eat another lot's loose.
  assert.deepEqual(packetPlan({ ...bare, lots: [{ qty: null }, { qty: 'abc' }, { qty: -500 }, {}, null] }), zero);
  assert.deepEqual(packetPlan({ ...bare, lots: [{ qty: -500 }, { qty: 960 }] }),
    packetPlan({ ...bare, lots: [{ qty: 960 }] }));
});

// pg hands numeric columns back as strings. The panel must not care.
test('string inputs coerce — a pg numeric row reads the same as a number', () => {
  assert.deepEqual(
    packetPlan({ required: '910', packetSize: '100', lots: [{ qty: '960' }] }),
    packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 960 }] }));
});

// ── Shape ────────────────────────────────────────────────────────────
test('shape: four options in the panel order, clear_loose recommended', () => {
  const plan = packetPlan({ required: 910, packetSize: 100, lots: [{ qty: 960 }] });
  assert.deepEqual(Object.keys(plan).sort(),
    ['intact_available', 'loose_available', 'loose_source', 'options', 'packetSize',
     'recommended', 'required', 'suspect']);
  // An uncounted shelf must SAY it is derived. The panel labelling a guess as a
  // count is the failure the counted column exists to end.
  assert.equal(plan.loose_source, 'derived');
  assert.equal(plan.suspect, false);
  assert.deepEqual(plan.options.map(o => o.key), ['clear_loose', 'least_excess', 'packets_only', 'exact']);
  // Clearing opened packets is the warehouse objective; least_excess sits
  // beside it with its own totals so the trade stays visible.
  assert.equal(plan.recommended, 'clear_loose');
  assert.ok(plan.options.some(o => o.key === plan.recommended));
  assert.equal(plan.packetSize, 100);
  assert.equal(plan.required, 910);
  for (const o of plan.options) {
    assert.deepEqual(Object.keys(o), ['key', 'loose_used', 'remaining', 'packets', 'total_issue', 'excess'],
      `${o.key} field set`);
  }
});

// ── Internal arithmetic, on every option of every case ────────────────
// Each option is four numbers that must agree with each other. Asserted as
// identities rather than as expected values, so a future edit cannot make one
// option internally inconsistent while every hand-derived case still passes.
const SPREAD = [
  { required: 910, packetSize: 100, lots: [] },
  { required: 910, packetSize: 100, lots: [{ qty: 900 }] },
  { required: 910, packetSize: 100, lots: [{ qty: 960 }] },
  { required: 900, packetSize: 100, lots: [{ qty: 960 }] },
  { required: 40, packetSize: 100, lots: [{ qty: 60 }] },
  { required: 400, packetSize: 100, lots: [{ qty: 50 }, { qty: 50 }, { qty: 50 }] },
  { required: 910, packetSize: 100, lots: [{ qty: 880 }, { qty: 780 }] },
  { required: 1, packetSize: 150, lots: [{ qty: 149 }] },
  { required: 144, packetSize: 144, lots: [{ qty: 300 }] },
  { required: 2000, packetSize: 144, lots: [{ qty: 1000 }, { qty: 613 }] },
  { required: 1317, packetSize: 100, lots: [{ qty: 1976 }] },
  { required: 5000, packetSize: 150, lots: [{ qty: 12345.6 }] },
  { required: 100, packetSize: 100, lots: [{ qty: 99 }, { qty: 99 }, { qty: 99 }] },
  { required: 3, packetSize: 144, lots: [{ qty: 2 }] },
  // fractional requirements, where the whole-sheet clamp on the cap bites
  { required: 910.5, packetSize: 100, lots: [{ qty: 960 }] },
  { required: 40.5, packetSize: 100, lots: [{ qty: 60 }] },
];

test('every option is internally consistent, on every case', () => {
  for (const c of SPREAD) {
    const plan = packetPlan(c);
    assert.ok(plan, `expected a plan for ${JSON.stringify(c)}`);
    // The module's own clamp, restated: usable loose is capped by the
    // requirement AND floored to whole sheets, because half a loose sheet
    // cannot be handed over.
    const cap = Math.floor(Math.min(plan.loose_available, plan.required) + 1e-6);
    for (const o of plan.options) {
      const at = `${JSON.stringify(c)} → ${o.key}`;
      assert.equal(o.remaining, plan.required - o.loose_used, `remaining: ${at}`);
      assert.equal(o.excess, o.total_issue - plan.required, `excess: ${at}`);
      assert.ok(o.loose_used >= 0 && o.loose_used <= cap, `loose_used within the shelf: ${at}`);
      assert.ok(Number.isInteger(o.loose_used), `whole loose sheets: ${at}`);
      assert.ok(o.remaining >= 0, `remaining not negative: ${at}`);
      assert.ok(o.excess >= 0 && o.excess < plan.packetSize, `excess in [0, P): ${at}`);
      // A suggestion must never hand the job less than it needs.
      assert.ok(o.total_issue >= plan.required, `never short: ${at}`);
      if (o.key === 'exact') {
        // The operational override: no packet arithmetic at all.
        assert.equal(o.packets, null, `exact carries no packet count: ${at}`);
        assert.equal(o.total_issue, plan.required, `exact issues the requirement: ${at}`);
        assert.equal(o.excess, 0, `exact has no spare: ${at}`);
      } else {
        assert.equal(o.total_issue, o.loose_used + o.packets * plan.packetSize, `total_issue: ${at}`);
        assert.ok(Number.isInteger(o.packets) && o.packets >= 0, `whole packets: ${at}`);
      }
    }
    // clear_loose always empties the shelf as far as the job can use it — that
    // is the whole reason it is the recommendation.
    assert.equal(opt(plan, 'clear_loose').loose_used, cap, `clear_loose clears: ${JSON.stringify(c)}`);
    assert.equal(opt(plan, 'packets_only').loose_used, 0, `packets_only takes none: ${JSON.stringify(c)}`);
    assert.equal(opt(plan, 'exact').loose_used, cap, `exact clears: ${JSON.stringify(c)}`);
    // least_excess is never beaten by either packet option it sits beside.
    // (`exact` is excluded: its zero spare is bought by skipping packets
    // altogether, which is a different kind of answer.)
    for (const key of ['clear_loose', 'packets_only']) {
      assert.ok(opt(plan, 'least_excess').excess <= opt(plan, key).excess,
        `least_excess beaten by ${key} on ${JSON.stringify(c)}`);
    }
  }
});

// ── least_excess against an exhaustive scan ───────────────────────────
// The implementation derives least_excess in closed form and must not loop.
// The TEST may loop, and this is the only way to prove the sawtooth argument at
// every boundary instead of at the handful of cases Anik happened to name.
//
// The scan encodes the tie rule explicitly: minimise `excess` FIRST, then take
// MORE loose. If that rule is ever re-read as "the smallest loose_used", this
// test is what fails — on required 910 / loose 160 it wants 110 loose and 8
// packets, where the smallest reading would answer 10 loose and 9.
const bruteLeast = ({ required, packetSize, lots }) => {
  const plan = packetPlan({ required, packetSize, lots });
  const cap = Math.floor(Math.min(plan.loose_available, required) + 1e-6);
  let best = null;
  for (let x = 0; x <= cap; x++) {
    const packets = Math.max(0, Math.ceil((required - x) / packetSize));
    const excess = x + packets * packetSize - required;
    if (!best || excess < best.excess || (excess === best.excess && x > best.loose_used)) {
      best = { loose_used: x, packets, excess };
    }
  }
  return best;
};

test('least_excess: the closed form matches an exhaustive scan at every boundary', () => {
  let checked = 0;
  for (const packetSize of [100, 144, 150]) {
    for (const required of [1, 40, 99, 100, 101, 143, 144, 145, 300, 899, 900, 901, 910, 1317]) {
      for (const loose of [0, 1, 10, 50, 60, 99, 100, 101, 143, 144, 160, 250, 300]) {
        const lots = looseOnlyLots(loose, packetSize);
        const plan = packetPlan({ required, packetSize, lots });
        // Guard the FIXTURE first: a looseOnlyLots that quietly built the wrong
        // shelf would make every assertion below vacuous.
        assert.equal(plan.loose_available, loose, `fixture loose: P${packetSize} loose ${loose}`);
        assert.equal(plan.intact_available, 0, `fixture intact: P${packetSize} loose ${loose}`);

        const least = opt(plan, 'least_excess');
        const brute = bruteLeast({ required, packetSize, lots });
        const at = `required ${required}, P ${packetSize}, loose ${loose}`;
        assert.equal(least.excess, brute.excess, `excess: ${at}`);
        assert.equal(least.loose_used, brute.loose_used, `loose_used: ${at}`);
        assert.equal(least.packets, brute.packets, `packets: ${at}`);
        // Equal spare from more loose always means fewer sealed packets opened.
        assert.ok(least.packets <= opt(plan, 'packets_only').packets, `packets vs packets_only: ${at}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 3 * 14 * 13);
});

// ── COUNTED loose ────────────────────────────────────────────────────
// Loose is an attribute of the pile — sealed packets and loose sheets share one
// stack — so `lots` may now carry a counted `loose_sheets`. Where it is present
// it WINS; where it is null the remainder derivation stands, unchanged, and
// that is what keeps every test above passing untouched.
//
// The one fact under all of this: loose sheets are the ones not in a sealed
// packet, so qty − loose = intact × P and therefore loose ≡ qty (mod P) is
// DEFINITIONAL. The derivation returns the smallest such value; the truth is
// (qty mod P) + k·P. Counting supplies k, nothing else.

test('counted loose beats the derivation on the same pile', () => {
  // 3,150 on the shelf, of which 150 are loose in one heap: 30 sealed packets,
  // not 31. The derivation reads 50 loose / 31 intact and invents a sealed
  // packet that exists nowhere in the warehouse.
  const counted = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: 150 }] });
  assert.equal(counted.loose_available, 150);
  assert.equal(counted.intact_available, 30);
  assert.equal(counted.loose_source, 'counted');

  const derived = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 3150 }] });
  assert.equal(derived.loose_available, 50);
  assert.equal(derived.intact_available, 31);
  assert.equal(derived.loose_source, 'derived');
});

test('a lot with no counted figure still derives — mixed shelves say so', () => {
  const plan = packetPlan({
    required: 400, packetSize: 100,
    lots: [{ qty: 3150, loose_sheets: 150 }, { qty: 960 }],
  });
  assert.equal(plan.loose_available, 210);          // 150 counted + 60 derived
  assert.equal(plan.intact_available, 39);          // 30 + 9
  assert.equal(plan.loose_source, 'mixed');
});

test('loose_sheets = 0 is a COUNT of nil, not an absent one', () => {
  // The trap the whole nullable column exists to avoid: a pile counted and
  // found to hold no loose at all must NOT fall back to the remainder.
  const plan = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: 0 }] });
  assert.equal(plan.loose_available, 0);
  assert.equal(plan.loose_source, 'counted');
});

test('counted is never below derived — it is derived + k·P', () => {
  for (const c of SPREAD) {
    const derived = packetPlan(c);
    if (!derived) continue;
    for (const k of [0, 1, 2]) {
      const lots = (c.lots || []).map(l => {
        const q = Math.max(0, Math.floor(Number(l.qty) || 0));
        return { ...l, loose_sheets: (q % c.packetSize) + k * c.packetSize <= q
          ? (q % c.packetSize) + k * c.packetSize : (q % c.packetSize) };
      });
      const counted = packetPlan({ ...c, lots });
      assert.ok(counted.loose_available >= derived.loose_available,
        `k=${k} on ${JSON.stringify(c)}: ${counted.loose_available} < ${derived.loose_available}`);
    }
  }
});

test('an impossible counted figure snaps DOWN to the nearest possible one', () => {
  // 3,130 on the shelf means loose ≡ 30 (mod 100) — 30, 130, 230 … are the only
  // physically possible answers. A counted 150 cannot be true. Snapping DOWN to
  // 130 keeps the counter's magnitude without promising 20 sheets that are not
  // there; snapping UP to 230 would promise 100 that are not.
  const plan = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 3130, loose_sheets: 150 }] });
  assert.equal(plan.loose_available, 130);
  assert.equal(plan.suspect, true);
});

test('a possible counted figure is left alone and is not suspect', () => {
  const plan = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 3130, loose_sheets: 130 }] });
  assert.equal(plan.loose_available, 130);
  assert.equal(plan.suspect, false);
});

test('a counted figure above the whole pile clamps to the pile', () => {
  const plan = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 250, loose_sheets: 900 }] });
  assert.ok(plan.loose_available <= 250);
  assert.equal(plan.suspect, true);
});

test('a negative counted figure is junk, not a credit — it derives instead', () => {
  const plan = packetPlan({ required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: -50 }] });
  assert.equal(plan.loose_available, 50);
  assert.equal(plan.loose_source, 'derived');
});

// ── looseAfter: the one rule every write path runs ───────────────────

test('looseAfter: a confirmed break moves loose by opened·P − issued', () => {
  // 60 loose on the stack, job takes 910, storeman opened 9 sealed packets.
  // 60 + 900 − 910 = 50 back on the stack, loose.
  assert.equal(looseAfter({ looseBefore: 60, packetSize: 100, issued: 910, packetsOpened: 9 }), 50);
});

test('looseAfter: no confirmation derives the packets the rule implies', () => {
  // Identical answer, and that is the point: the confirmed and unconfirmed
  // paths must not be two different arithmetics for the same shelf.
  assert.equal(looseAfter({ looseBefore: 60, packetSize: 100, issued: 910, packetsOpened: null }), 50);
  assert.equal(looseAfter({ looseBefore: 60, packetSize: 100, issued: 910 }), 50);
});

test('looseAfter: a storeman who opened MORE than the rule is believed', () => {
  // He broke 10, not 9 — the extra 100 stay on the stack as loose. Believing
  // him is the entire reason the field exists.
  assert.equal(looseAfter({ looseBefore: 60, packetSize: 100, issued: 910, packetsOpened: 10 }), 150);
});

test('looseAfter: a pure return adds every sheet to loose', () => {
  // An under-cut hands sheets back. They came out of an opened bundle, so they
  // are loose by definition: nothing opened, negative issue.
  assert.equal(looseAfter({ looseBefore: 50, packetSize: 100, issued: -47, packetsOpened: 0 }), 97);
});

test('looseAfter: never goes negative', () => {
  assert.equal(looseAfter({ looseBefore: 0, packetSize: 100, issued: 50, packetsOpened: 0 }), 0);
  assert.equal(looseAfter({ looseBefore: 10, packetSize: 100, issued: 900, packetsOpened: 0 }), 0);
});

test('looseAfter: null, never 0, when the packet size is unknown', () => {
  // Same contract as packetPlan. A board with no sheets_per_packet has no P to
  // be congruent to, so no loose figure may be written against it at all —
  // 4 of the 332 board masters are in exactly this state.
  assert.equal(looseAfter({ looseBefore: 60, packetSize: null, issued: 910, packetsOpened: 9 }), null);
  assert.equal(looseAfter({ looseBefore: 60, packetSize: 0, issued: 910, packetsOpened: 9 }), null);
  assert.equal(looseAfter(null), null);
});

test('looseAfter preserves loose ≡ qty (mod P) across every movement', () => {
  // The free correctness check on the whole write path. Start from any shelf
  // that satisfies the congruence, apply any movement, and it must still hold —
  // otherwise the book is describing a pile that cannot exist.
  let checked = 0;
  for (const P of [100, 144, 150]) {
    for (const k of [0, 1, 3]) {
      for (const rem of [0, 1, 50, P - 1]) {
        const looseBefore = rem + k * P;
        const qtyBefore = looseBefore + 40 * P;          // 40 sealed packets under it
        for (const issued of [0, 1, rem, P, 910, -47, -P]) {
          for (const opened of [null, 0, 1, 12]) {
            const after = looseAfter({ looseBefore, packetSize: P, issued, packetsOpened: opened });
            const qtyAfter = qtyBefore - issued;
            if (after === 0) continue;   // clamped at nil, or legitimately empty — ambiguous either way
            assert.equal(((qtyAfter - after) % P + P) % P, 0,
              `P=${P} loose=${looseBefore} issued=${issued} opened=${opened} → ${after}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 500, `expected a real spread, checked ${checked}`);
});

// ── client twin parity ───────────────────────────────────────────────
// The planning panel recomputes this locally as the planner edits a mix row,
// and a job card will later print it from the server side. A panel showing
// advice the server would not repeat is the whole failure this twinning
// prevents. Same precedent as board-math.js / boardMath.js.
import * as client from '../../client/src/lib/packetPlan.js';
import * as server from './packet-plan.js';

test('client twin: exported surface matches the server module', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
});

test('client twin: identical output across a spread of cases', () => {
  const cases = [
    ...SPREAD,
    // the guards, which must fail closed identically on both sides
    { required: 910, packetSize: null, lots: [] },
    { required: 910, packetSize: 0, lots: [] },
    { required: 910, packetSize: -100, lots: [] },
    { required: 910, packetSize: NaN, lots: [] },
    { required: 0, packetSize: 100, lots: [] },
    { required: -50, packetSize: 100, lots: [{ qty: 960 }] },
    // junk that must read as an empty shelf on both sides
    { required: 910, packetSize: 100, lots: undefined },
    { required: 910, packetSize: 100, lots: 'nonsense' },
    { required: 910, packetSize: 100, lots: [{ qty: null }, { qty: -500 }, {}, null] },
    // strings off a pg numeric column
    { required: '910', packetSize: '100', lots: [{ qty: '960' }] },
    // counted loose, in every state the column can be in
    { required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: 150 }] },
    { required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: 0 }] },
    { required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: null }] },
    { required: 400, packetSize: 100, lots: [{ qty: 3130, loose_sheets: 150 }] },   // snaps down
    { required: 400, packetSize: 100, lots: [{ qty: 250, loose_sheets: 900 }] },    // over the pile
    { required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: -50 }] },   // junk
    { required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: '150' }] }, // string off pg
    { required: 400, packetSize: 100, lots: [{ qty: 3150, loose_sheets: 150 }, { qty: 960 }] },
    { required: 2000, packetSize: 144, lots: [{ qty: 1000, loose_sheets: 280 }, { qty: 613 }] },
  ];
  for (const c of cases) {
    assert.deepEqual(client.packetPlan(c), server.packetPlan(c), JSON.stringify(c));
  }
  for (const junk of [undefined, null, 0, 'nonsense']) {
    assert.deepEqual(client.packetPlan(junk), server.packetPlan(junk), `bare argument ${JSON.stringify(junk)}`);
  }
});

test('client twin: looseAfter agrees across every movement shape', () => {
  const cases = [];
  for (const packetSize of [100, 144, 150, null, 0]) {
    for (const looseBefore of [0, 60, 150, null]) {
      for (const issued of [0, 910, -47, 50]) {
        for (const packetsOpened of [null, 0, 9, 10]) {
          cases.push({ looseBefore, packetSize, issued, packetsOpened });
        }
      }
    }
  }
  for (const c of cases) {
    assert.deepEqual(client.looseAfter(c), server.looseAfter(c), JSON.stringify(c));
  }
  for (const junk of [undefined, null, 0, 'nonsense']) {
    assert.deepEqual(client.looseAfter(junk), server.looseAfter(junk), `bare argument ${JSON.stringify(junk)}`);
  }
});
