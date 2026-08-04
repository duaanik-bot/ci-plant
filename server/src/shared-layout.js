// Shared-layout (co-printed) gang arithmetic. PURE — plain rows in, numbers
// out. No pg, no await (same contract as board-allocation.js).
//
// A SHARED layout nests every member on ONE child sheet: Job A 2-up beside
// Job B 1-up beside Job C 3-up. One pass of the press therefore advances every
// member at once, so the run needs the MAX any member requires —
//
//     N = max_i( ceil(net_i / ups_i) )  + wastage (a single allowance)
//
// — never the SUM the separate-mode gang uses. Everything downstream of the
// plan (committed demand, PR sizing, board consumption, cutting variance,
// readiness) reads per-line sheet columns, so each member is stored its
// PROPORTIONAL SHARE of that one count, by its share of the ups, with
// largest-remainder rounding so the members always sum to EXACTLY the run.
// The plant's totals stay right and no downstream reader needs to know
// co-printing exists.
//
// This module decides NOTHING about parents: the caller converts the run's
// child count with the SAME childFit / parentSheetsRequired every plan uses,
// then splits the parent count with splitProportional below. One engine.

// members: [{ id, net, ups }] — net cartons still to produce, ups on the layout.
export function sharedLayoutRun(members = [], { wastage = 0 } = {}) {
  if (!members.length) return { run_child: 0, need_child: 0, total_ups: 0, per: [] };
  for (const m of members) {
    if (!(+m.ups > 0)) {
      const e = new Error(`Every job on a shared layout needs its ups — job ${m.id} has none`);
      e.status = 400;
      throw e;
    }
  }
  const w = Math.max(0, Math.round(+wastage || 0));
  // The member that needs the most sheets sets the run: every sheet prints
  // everyone, so nobody can be printed less than the run.
  const needs = members.map(m => Math.ceil(Math.max(0, +m.net || 0) / +m.ups));
  const need = Math.max(...needs, 0);
  const run = need + w;
  const totalUps = members.reduce((s, m) => s + +m.ups, 0);
  return {
    run_child: run,          // sheets the press actually runs (incl. wastage)
    need_child: need,        // sheets the orders actually need
    total_ups: totalUps,
    per: members.map((m, i) => ({
      id: m.id,
      ups: +m.ups,
      need_child: needs[i],
      pieces: need * +m.ups,                              // what the run yields it
      overs: Math.max(0, need * +m.ups - Math.max(0, +m.net || 0)),
    })),
  };
}

// The soft side of Layout Pending. A pending SHARED layout may still plan
// when every member already agrees on ONE child sheet through its effective
// spec (job override, else product master): the plan lock adopts that
// agreement as the layout and stamps it. Returns the agreed {l, w} or null —
// null keeps the refusal, because a member with no child size anywhere, or
// members whose sizes disagree, give the press no single sheet to run.
export function agreedChildSize(sizes = []) {
  if (!sizes.length) return null;
  const norm = sizes.map(s => ({ l: +(s?.l) || 0, w: +(s?.w) || 0 }));
  if (norm.some(s => !(s.l > 0) || !(s.w > 0))) return null;
  const uniq = new Set(norm.map(s => `${s.l}x${s.w}`));
  return uniq.size === 1 ? { l: norm[0].l, w: norm[0].w } : null;
}

// Split ONE total across members in proportion to their ups, largest-remainder
// so the parts sum to EXACTLY the total (same discipline as splitGangQty and
// the plan-lock's issue-override distribution).
export function splitProportional(total, members = []) {
  if (!members.length) return [];
  const t = Math.max(0, Math.round(+total || 0));
  const weights = members.map(m => Math.max(0, +m.ups || 0));
  const sum = weights.reduce((s, x) => s + x, 0);
  const share = sum > 0 ? weights : members.map(() => 1);
  const shareSum = share.reduce((s, x) => s + x, 0);
  const raw = members.map((m, i) => t * share[i] / shareSum);
  const parts = raw.map(x => Math.floor(x));
  let rem = t - parts.reduce((s, x) => s + x, 0);
  const byFrac = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < byFrac.length && rem > 0; k++) { parts[byFrac[k].i]++; rem--; }
  return members.map((m, i) => ({ id: m.id, share: parts[i] }));
}
