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
// Client twin of server/src/packet-plan.js — the planning panel recomputes
// these figures locally as the planner edits a cut plan or a Board Mix row, so
// the advice appears as the sheets change and before anything reaches the
// server. packet-plan.test.js asserts the two twins produce identical output —
// keep them in sync.
//
// Returns null (never a zero-filled answer) when the board master carries no
// packet size, so the caller can say so rather than quietly assuming 100. Same
// "null, never 0, when an input is missing" contract as boardMath.js.

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

  // Loose is DERIVED, and derived PER LOT then summed. Each lot is a physical
  // pile and its own remainder IS its opened packet: three part-open packets
  // holding 50 each are 150 loose / 0 intact, where a remainder taken on the
  // TOTAL would claim 50 loose / 1 intact — one sealed packet that exists
  // nowhere in the warehouse.
  //
  // Each pile's qty is floored FIRST. Quantities are DOUBLE PRECISION and a
  // fractional sheet must never round up into a promise: 960.7 on the shelf is
  // 9 packets and 60 loose, never 961 sheets. A negative qty is not a physical
  // pile at all, so it contributes nothing rather than eating another lot's
  // loose.
  let loose = 0, intact = 0;
  for (const lot of (Array.isArray(lots) ? lots : [])) {
    const q = Math.max(0, Math.floor(num(lot?.qty)));
    loose += q % P;
    intact += Math.floor(q / P);
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
