// Intact & loose PACKET SUGGESTION maths. Board is bought, stored and handed
// over in PACKETS — 100 sheets on most boards, 144 on some, 150 on one — but a
// plan asks for a raw sheet count, and the storeman bridges that gap in his
// head. So a job needing 910 sheets gets 10 sealed packets opened while 60
// loose sheets sit on the shelf from the last job. This turns one requirement
// into the four picking choices the planner may make, with every figure each
// one implies.
//
// A PICKING HINT ONLY. Nothing here changes what a job is issued or consumes.
// Rounding the issue up to whole packets would hand a 910-sheet job 1,000
// sheets, and the cutting gate is ZERO-TOLERANCE: every such job would then
// raise a variance demanding a written reason. The spare stays on the shelf
// instead, which is exactly where the next job's loose figure comes from — the
// loop feeds itself with no new bookkeeping.
//
// Mirrored verbatim in client/src/lib/packetPlan.js. packet-plan.test.js
// asserts the two twins produce identical output — keep them in sync.
//
// Returns null (never a zero-filled answer) when the board master carries no
// packet size, so the caller can say so rather than quietly assuming 100. Same
// "null, never 0, when an input is missing" contract as board-math.js.

const EPS = 1e-6;

// boardMix.js's num(), hardened against NaN: a lot row can arrive with a NULL
// qty off a LEFT JOIN or a half-typed string from a form, and one NaN would
// poison loose_available and every option built on top of it. Junk reads as 0
// sheets — that pile is not there.
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// `required` mod `packetSize`, snapped to 0 at both ends. Sheet counts are
// DOUBLE PRECISION, so an exact multiple of the packet size can read back as
// 899.9999999 or 900.0000001 — and either one would put a millionth of a sheet
// into loose_used and print it on the panel.
function packetResidue(required, packetSize) {
  let r = required % packetSize;
  if (r < 0) r += packetSize;
  return (r < EPS || packetSize - r < EPS) ? 0 : r;
}

// The SMALLEST loose figure a pile of this size can hold — the k = 0 root of
// loose = qty (mod P). Two callers, one idea:
//
//   • the opening balance for a pile that has never been counted, and
//   • the loose a fresh RECEIPT is born with, because vendors ship sealed
//     packets so a receipt that does not divide evenly is one broken packet.
//
// Floored first: quantities are DOUBLE PRECISION and a fractional sheet must
// never round up into a promise.
export function looseFloor(input) {
  const { qty, packetSize } = input || {};
  const P = num(packetSize);
  if (!(P > 0)) return null;
  return Math.max(0, Math.floor(num(qty))) % P;
}

// How much of ONE pile is loose. Counted where the warehouse has counted it,
// derived where it has not — and the caller can tell which, because the panel
// must not label a guess as a count.
//
// The rule under this: loose sheets are the ones NOT in a sealed packet, so
// qty − loose = intact × P and therefore loose ≡ qty (mod P) is DEFINITIONAL.
// The derivation returns the smallest value satisfying it; the truth is
// (qty mod P) + k·P. Counting supplies k and nothing else.
//
// A counted figure that breaks the congruence is provably wrong, so it snaps
// DOWN to the nearest possible value — never up. Up would promise sheets that
// are not on the shelf, which is the one direction this whole feature was
// built to avoid. A counted 150 against a pile of 3,130 becomes 130, not 230.
//
// Null, blank, junk or negative all mean NOT COUNTED and fall back to the
// remainder. Zero does NOT: a pile counted and found to hold nothing loose is
// a count, and treating it as absent would silently reinstate the guess.
function looseOfLot(lot, q, P) {
  const rem = q % P;
  const raw = lot?.loose_sheets;
  if (raw == null || raw === '') return { loose: rem, counted: false, suspect: false };
  const c = Number(raw);
  if (!Number.isFinite(c) || c < 0) return { loose: rem, counted: false, suspect: false };
  // Clamped to the pile first — nobody can have more loose than they have.
  const cap = Math.min(Math.floor(c + EPS), q);
  // Largest x ≤ cap with x ≡ q (mod P). Below the remainder there is no such
  // x at all: the count and the pile total contradict each other outright, so
  // the smaller figure is kept — safe direction — and flagged.
  const loose = cap >= rem ? rem + Math.floor((cap - rem) / P + EPS) * P : cap;
  return { loose, counted: true, suspect: loose !== Math.floor(c + EPS) || (q - loose) % P !== 0 };
}

// The new loose level after a movement — the ONE rule every write path runs.
//
//   looseAfter = looseBefore + packetsOpened·P − issued
//
// `packetsOpened` null means nobody confirmed, so the packets the picking rule
// implies are used instead. Confirmed and unconfirmed paths therefore run the
// SAME arithmetic; two spellings of it would drift into two different answers
// for one shelf, which is exactly the bug this feature exists to end.
//
// `issued` is signed. A negative issue is a RETURN — an under-cut handing
// sheets back — and every returned sheet is loose by definition, because it
// came out of a bundle somebody opened.
//
// Null, never 0, when the packet size is unknown: 4 of the 332 board masters
// carry no sheets_per_packet, and a board with no P has no congruence to
// satisfy, so no loose figure may be written against it at all.
export function looseAfter(input) {
  const { looseBefore, packetSize, issued, packetsOpened } = input || {};
  const P = num(packetSize);
  if (!(P > 0)) return null;
  const before = Math.max(0, num(looseBefore));
  const iss = num(issued);
  const opened = packetsOpened == null || !Number.isFinite(Number(packetsOpened))
    ? Math.max(0, Math.ceil((iss - before) / P - EPS))
    : Math.max(0, Math.floor(Number(packetsOpened)));
  // Clamped at nil, never negative — the same reason issueWithWriteOn holds the
  // book at nil: a pile reading −40 loose corrupts every figure derived from it.
  return Math.max(0, before + opened * P - iss);
}

// Every packet option is built HERE, from its loose_used alone, so no option
// can be internally inconsistent: remaining, packets, total_issue and excess
// are each derived, never carried in. `exact` is the one option that does not
// come through this, because it deliberately skips packet arithmetic.
//
// The ceiling takes an EPS slack, the same guard smartSeedRow() uses: without
// it a remainder of 899.9999999996 buys a tenth packet nobody needs.
function issueOption(key, looseUsed, required, packetSize) {
  const loose_used = Math.max(0, Math.min(num(looseUsed), required));
  const remaining = Math.max(0, required - loose_used);
  const packets = Math.max(0, Math.ceil(remaining / packetSize - EPS));
  const total_issue = loose_used + packets * packetSize;
  return { key, loose_used, remaining, packets, total_issue, excess: total_issue - required };
}

// packetPlan({ required, packetSize, lots })
//
// `lots` are the available piles of THIS board — real rows carry a batch id, a
// location and a rate; only `qty` is read here.
//
// Destructured inside rather than in the signature so a null argument returns
// null instead of throwing: this runs inside a render.
export function packetPlan(input) {
  const { required, packetSize, lots } = input || {};
  const P = num(packetSize);
  const req = num(required);
  // No packet size on the board master, or nothing to plan for. Null, never a
  // zero-filled answer — the caller must be able to say "this board has no
  // packet size" instead of showing confident advice built on an assumed 100
  // for a board that is actually bought in 144s.
  if (!(P > 0) || !(req > 0)) return null;

  // Loose is COUNTED where the warehouse has counted it and derived where it
  // has not — see looseOfLot. Either way it is resolved PER LOT then summed.
  // Each lot is a physical pile and its own remainder IS its opened packet:
  // three part-open packets holding 50 each are 150 loose / 0 intact, where a
  // remainder taken on the TOTAL would claim 50 loose / 1 intact — one sealed
  // packet that exists nowhere in the warehouse.
  //
  // Each pile's qty is floored FIRST. Quantities are DOUBLE PRECISION and a
  // fractional sheet must never round up into a promise: 960.7 on the shelf is
  // 9 packets and 60 loose, never 961 sheets. A negative qty is not a physical
  // pile at all, so it contributes nothing rather than eating another lot's
  // loose.
  //
  // A lot carrying NO loose_sheets derives exactly what this loop always
  // derived, so a caller that has never heard of the column gets byte-identical
  // output. That is the regression check on this whole change.
  let loose = 0, intact = 0, countedLots = 0, seenLots = 0, suspect = false;
  for (const lot of (Array.isArray(lots) ? lots : [])) {
    const q = Math.max(0, Math.floor(num(lot?.qty)));
    const r = looseOfLot(lot, q, P);
    loose += r.loose;
    intact += Math.floor((q - r.loose) / P);
    seenLots++;
    if (r.counted) countedLots++;
    if (r.suspect) suspect = true;
  }

  // Usable loose, in WHOLE SHEETS. Two clamps, both load-bearing:
  //   • loose beyond the requirement is not usable on THIS job;
  //   • nobody can hand over half a loose sheet. Each pile is already floored
  //     above, so `loose` is whole by construction and this floor only bites on
  //     a FRACTIONAL `required` — which no caller produces today, since parent
  //     sheet counts and job_board_mix.sheets are both whole. Closed here
  //     anyway rather than left as a latent oddity for the first caller that
  //     feeds it one.
  // ONE clamp, deliberately: clear_loose, least_excess and exact all pick out
  // of this, so no option can ask for a fraction of a sheet the others refuse.
  // The EPS stops a float-noisy 59.9999999 from losing a whole sheet.
  const cap = Math.floor(Math.min(loose, req) + EPS);

  // ── least_excess: LEAST EXCESS, THEN MOST LOOSE ──────────────────────
  // Two keys, in that order, and the second is not a detail: DO NOT "simplify"
  // this to the SMALLEST loose_used that reaches the minimum.
  //
  // Worked, and this case decides it — 910 needed, P 100, 160 loose. Loose of
  // 10 AND of 110 both issue exactly 910 with zero spare, but 10 needs NINE
  // sealed packets where 110 needs EIGHT. Same total, same zero spare, one
  // fewer packet broken and 100 more of the shelf cleared. Taking the smallest
  // there breaks a sealed packet for nothing, which is the whole problem this
  // function exists to stop.
  //
  // Packets only ever cover what loose does not, so for loose_used = x
  //   excess(x) = ⌈(req − x)/P⌉·P − (req − x) = (x − req) mod P
  // — a sawtooth in x with period P, whose root sits wherever x ≡ req (mod P).
  // With res = req mod P, and only WHOLE loose sheets to hand:
  //   • the roots inside [0, cap] are ⌈res⌉, ⌈res⌉+P, ⌈res⌉+2P, … Each ties at
  //     zero excess and issues exactly `req`, so by the rule above the LARGEST
  //     wins — equal excess from a bigger loose_used always means fewer sealed
  //     packets, because the totals are identical.
  //   • if even ⌈res⌉ is past cap, the sawtooth never reaches a root here.
  //     ⌈(req − x)/P⌉ is then the same integer right across [0, cap], so
  //     excess = P − res + x rises with every loose sheet added — using loose
  //     would only ADD spare, and zero loose is the least-excess answer. This
  //     is the case where `required` is already close to a whole number of
  //     packets, and it is why "always use the loose" is wrong.
  // No loop: one modulo and one division decide it, exactly at both ends.
  const res = packetResidue(req, P);
  const firstRoot = Math.max(0, Math.ceil(res - EPS));
  const leastLoose = firstRoot <= cap
    ? Math.min(firstRoot + Math.floor((cap - firstRoot) / P + EPS) * P, cap)
    : 0;

  // The operational override: hand over exactly what the job needs and leave
  // the packet arithmetic alone. No `packets` figure, because no whole number
  // of packets is being opened — the storeman counts the balance out.
  const exactLoose = cap;

  return {
    packetSize: P,
    required: req,
    loose_available: loose,
    intact_available: intact,
    // Provenance, so the panel can label the figure rather than assert it. A
    // shelf with no lots at all reads 'derived': nothing has been counted.
    loose_source: countedLots === 0 ? 'derived' : countedLots === seenLots ? 'counted' : 'mixed',
    // At least one counted figure could not be true of the pile it sits on.
    suspect,
    options: [
      // Empty the shelf first, then whole packets for the rest. The
      // recommendation: opened packets age, and this is the only option that
      // always clears them.
      issueOption('clear_loose', cap, req, P),
      issueOption('least_excess', leastLoose, req, P),
      // Break sealed packets only — what the plant does today.
      issueOption('packets_only', 0, req, P),
      {
        key: 'exact',
        loose_used: exactLoose,
        remaining: Math.max(0, req - exactLoose),
        packets: null,
        total_issue: req,
        excess: 0,
      },
    ],
    recommended: 'clear_loose',
  };
}
