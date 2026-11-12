// Size proposals for a new carton (owner, 12 Nov 2026: "Whenever there is a new size, I put the dimensions. You will
// propose the size to me, not only from the sizer, but also by analysing it yourself … out of which I will select one").
//
// Pure: no database, no clock. Shared by the costing screen and the server (routes/sizing.js), like costing.js.
// The rules are the plant's own, measured on 12 Nov 2026 from its dies, output sheets and Size Library (see
// docs/superpowers/specs/2026-11-12-size-proposals-kld-design.md); with them this model gives the same ups as the
// real dies it was checked on (sizing.test.js). The owner has not confirmed them yet, so they are defaults.
//
// Carton size L × W × H in mm; sheets in inches. Two constructions are drawn:
//   RTE  — reverse tuck, side pasted. Read two ways, both tried: side-open (the tube runs along L, faces H and W) and
//          top-open (the tube runs along H, faces L and W).
//   LOCK — crash-lock bottom with a tuck top; the tube runs along H, faces L and W.
// "across" is round the tube (the blank's glue-flap-to-free-edge width), "along" is the tube's direction.
export const IN = 25.4;
const EPS = 1e-6;

export const HOUSE_RULES = Object.freeze({
  glue: w => (w <= 20 ? 8 : w <= 50 ? 10 : 15),
  tuck: w => (w <= 20 ? 10 : w <= 50 ? 12 : w <= 80 ? 14 : 15),
  dust: (w, t) => Math.min(12, (w + t) / 2 - 1),
  lock: w => w / 2 + 5,
  // the plant's output sheets run edge to edge (0–10 mm spare); a margin here is taken off the print sheet
  margin: Object.freeze({ gripper: 0, other: 0 }),
  // inches, the print sheet's long side × short side
  press: Object.freeze({ maxLong: 28, maxShort: 20, minLong: 12, minShort: 10 }),
  // a layout this close to one more row or up is reported as a near miss
  nearMissMm: 3,
});

export const READING_LABEL = Object.freeze({
  'side-open': 'Side-open: the tube runs along L, the tucks close the W × H ends',
  'top-open': 'Top-open: the tube runs along H, the tucks close the L × W ends',
  lock: 'Lock bottom, tuck top',
});

const pos = x => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };

// The ways a carton of this style can be drawn. Styles the engine does not draw give none.
export function readings(style, size) {
  const k = String(style ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  const l = pos(size?.l), w = pos(size?.w), h = pos(size?.h);
  if (!l || !w || !h) return [];
  if (k === 'SIDE') {
    return [
      { key: 'side-open', construction: 'RTE', tube: l, face: h, w, label: READING_LABEL['side-open'] },
      { key: 'top-open', construction: 'RTE', tube: h, face: l, w, label: READING_LABEL['top-open'] },
    ];
  }
  if (k === 'LOCK') return [{ key: 'lock', construction: 'LOCK', tube: h, face: l, w, label: READING_LABEL.lock }];
  return [];
}

// One carton's pitches on a sheet: rows butt at `across`; `along(n)` is what n ups need in the tube's direction.
export function cartonPlan(reading, rules = HOUSE_RULES) {
  const { construction, tube, face, w } = reading;
  const glue = rules.glue(w), tuck = rules.tuck(w), dust = rules.dust(w, tuck);
  const across = 2 * face + 2 * w + glue;
  if (construction === 'RTE') {
    // reverse tuck: the closures sit on opposite faces, so one carton's tuck fits beside the next one's
    const along = n => (n > 0 ? n * (tube + w + tuck) + (w + tuck) : 0);
    return { construction, across, glue, tuck, dust, lock: null, along, blank: { across, along: along(1) } };
  }
  const lock = rules.lock(w);
  const single = lock + tube + w + tuck, pair = 2 * lock + 2 * tube + w + tuck;
  // two lock bottoms go head to head and share one W + tuck gap; pairs butt foot to foot
  const along = n => (n > 0 ? Math.floor(n / 2) * pair + (n % 2) * single : 0);
  return { construction, across, glue, tuck, dust, lock, along, blank: { across, along: single } };
}

// The best grid of one carton on a print sheet, its across direction on the sheet's `acrossOn` side.
export function layoutOn(plan, sheetLong, sheetShort, acrossOn, rules = HOUSE_RULES) {
  const { gripper, other } = rules.margin;
  // the gripper bites a long edge, so it is taken off the short side
  const longMm = sheetLong * IN - 2 * other, shortMm = sheetShort * IN - gripper - other;
  const [A, B] = acrossOn === 'long' ? [longMm, shortMm] : [shortMm, longMm];
  const m = Math.max(0, Math.floor(A / plan.across + EPS));
  let n = 0;
  while (plan.along(n + 1) <= B + EPS && n < 200) n++;
  const ups = m * n;
  return {
    ups, m, n, acrossOn,
    spareAcross: A - m * plan.across, spareAlong: B - plan.along(n),
    needRow: (m + 1) * plan.across - A, needUp: plan.along(n + 1) - B,
  };
}

const floor2 = x => Math.floor(x * 100 + EPS) / 100;

// Print sheets worth proposing: whole pieces of the stocked mill sheets (the plant prints only on exact halves, thirds
// and quarters of what it buys), inside the press window. `grainSide` says which side of the child carries the grain,
// when the mill sheet's grain is recorded ('long' | 'short' on the mill sheet).
export function sheetLadder(boards, rules = HOUSE_RULES) {
  const { maxLong, maxShort, minLong, minShort } = rules.press;
  const bySize = new Map();
  for (const b of boards || []) {
    const a = pos(b?.sheet_l), c = pos(b?.sheet_w);
    if (!a || !c) continue;
    const millLong = Math.max(a, c), millShort = Math.min(a, c);
    const grain = b.grain === 'long' || b.grain === 'short' ? b.grain : null;
    for (let i = 1; i <= 4; i++) for (let j = 1; j <= 3; j++) {
      const alongMillLong = floor2(millLong / i), alongMillShort = floor2(millShort / j);
      const long = Math.max(alongMillLong, alongMillShort), short = Math.min(alongMillLong, alongMillShort);
      if (long > maxLong + EPS || short > maxShort + EPS || long < minLong - EPS || short < minShort - EPS) continue;
      // the child's side cut along the mill sheet's long side keeps that side's grain
      const longFromMillLong = alongMillLong >= alongMillShort;
      const grainSide = !grain ? null : (grain === 'long') === longFromMillLong ? 'long' : 'short';
      const cand = {
        long, short, pieces: i * j, use: (i * j * long * short) / (millLong * millShort), grainSide,
        mill: { id: b.id ?? null, long: millLong, short: millShort, grain, name: b.name ?? null },
      };
      const key = `${long}x${short}`;
      const prev = bySize.get(key);
      // one per size: a known grain beats an unknown one, then the mill that wastes least
      const known = x => x.grainSide != null;
      const better = !prev || (known(cand) && !known(prev)) || (known(cand) === known(prev) && cand.use > prev.use + EPS);
      if (better) bySize.set(key, cand);
    }
  }
  return [...bySize.values()].sort((x, y) => x.long * x.short - y.long * y.short);
}

const sqIn = (long, short, ups) => (long * short) / ups;

// Proposals for one carton: per reading, up to four options with different ups, least board a carton first (more ups
// first when equal: fewer impressions), and the near misses that would beat the best option with a few mm less.
export function proposals({ style, size, boards, gsm = null, rules = HOUSE_RULES, maxOptions = 4 }) {
  const rs = readings(style, size);
  if (!rs.length) {
    return { unsupported: true, readings: [],
      reason: 'Proposals are drawn for side pasting (reverse tuck) and lock bottom cartons — type the sheet and ups for this one.' };
  }
  const ladder = sheetLadder(boards, rules);
  const gramsOf = sq => (pos(gsm) ? +(sq * 645.16e-6 * gsm).toFixed(1) : null);
  const out = rs.map(reading => {
    const plan = cartonPlan(reading, rules);
    const all = [], misses = [];
    for (const s of ladder) {
      for (const acrossOn of ['long', 'short']) {
        const r = layoutOn(plan, s.long, s.short, acrossOn, rules);
        const base = { sheet: { long: s.long, short: s.short }, mill: s.mill, pieces: s.pieces, acrossOn, grainNeeded: acrossOn };
        const grain = s.grainSide == null ? 'unknown' : s.grainSide === acrossOn ? 'ok' : 'wrong';
        if (r.ups > 0) {
          const sq = sqIn(s.long, s.short, r.ups), tight = Math.min(r.spareAcross, r.spareAlong);
          all.push({ ...base, ups: r.ups, m: r.m, n: r.n, sqInPerCarton: +sq.toFixed(1), gramsPerCarton: gramsOf(sq),
            spareAcross: +r.spareAcross.toFixed(1), spareAlong: +r.spareAlong.toFixed(1), grain,
            note: tight < 2 ? `Tight: ${tight.toFixed(1)} mm spare` : null });
        }
        const near = [];
        if (r.m >= 1 && r.needUp <= rules.nearMissMm) near.push({ ups: r.m * (r.n + 1), needMm: r.needUp, axis: 'along' });
        if (r.n >= 1 && r.needRow <= rules.nearMissMm) near.push({ ups: (r.m + 1) * r.n, needMm: r.needRow, axis: 'across' });
        for (const x of near) misses.push({ ...base, ...x, needMm: +x.needMm.toFixed(1), grain, sqInPerCarton: +sqIn(s.long, s.short, x.ups).toFixed(1) });
      }
    }
    all.sort((a, b) => a.sqInPerCarton - b.sqInPerCarton || b.ups - a.ups || (a.grain === 'ok' ? -1 : 0) - (b.grain === 'ok' ? -1 : 0));
    const options = [], seen = new Set();
    for (const o of all) { if (seen.has(o.ups)) continue; seen.add(o.ups); options.push(o); if (options.length >= maxOptions) break; }
    const bar = options[0]?.sqInPerCarton ?? Infinity;
    const nearMisses = [], keys = new Set();
    for (const m of misses.filter(x => x.sqInPerCarton < bar - EPS).sort((a, b) => a.sqInPerCarton - b.sqInPerCarton)) {
      const k = `${m.sheet.long}x${m.sheet.short}|${m.ups}`;
      if (keys.has(k)) continue; keys.add(k); nearMisses.push(m);
      if (nearMisses.length >= 3) break;
    }
    const { along, ...shown } = plan;
    return { reading, plan: shown, options, nearMisses };
  });
  const res = { readings: out };
  if (out.every(r => r.options.length === 0)) {
    const { maxLong, maxShort } = rules.press;
    res.reason = `No stocked sheet inside the press window (up to ${maxLong} × ${maxShort} in) takes this carton.`;
  }
  return res;
}

// The picture of an option: rectangles in mm on the print sheet (x along its long side, y along its short side) —
// each up's body, glue flap and flaps (the tuck closures, and the lock band of a lock bottom).
export function layoutBlocks(planIn, reading, option, rules = HOUSE_RULES) {
  const plan = typeof planIn?.along === 'function' ? planIn : cartonPlan(reading, rules);
  const { tube, face, w } = reading;
  const { across, glue, tuck } = plan, gap = w + tuck;
  const blocks = [];
  const put = (ox, oy, turned, local) => {
    for (const [x, y, bw, bh, kind] of local) {
      // turned 180°: (x, y) → (across − x, tube − y)
      const lx = turned ? across - (x + bw) : x, ly = turned ? tube - (y + bh) : y;
      const u = ox + lx, v = oy + ly;
      blocks.push(option.acrossOn === 'long' ? { x: u, y: v, w: bw, h: bh, kind } : { x: v, y: u, w: bh, h: bw, kind });
    }
  };
  for (let i = 0; i < option.m; i++) {
    for (let j = 0; j < option.n; j++) {
      const ox = i * across;
      if (plan.construction === 'RTE') {
        put(ox, gap + j * (tube + gap), false, [
          [0, 0, across, tube, 'body'], [0, 0, glue, tube, 'glue'],
          [glue + face + w, tube, face, gap, 'flap'], [glue, -gap, face, gap, 'flap'],
        ]);
      } else {
        const lk = plan.lock, pair = 2 * lk + 2 * tube + gap, k = Math.floor(j / 2);
        const local = [[0, 0, across, tube, 'body'], [0, 0, glue, tube, 'glue'], [glue, tube, face, gap, 'flap'], [glue, -lk, across - glue, lk, 'flap']];
        if (j % 2 === 0) put(ox, k * pair + lk, false, local);
        else put(ox, k * pair + lk + tube + gap, true, local);
      }
    }
  }
  return blocks;
}

// An existing layout (a Size Library entry: sheet and ups) read back onto a reading: how many across and along, and
// which sheet side the cartons' across direction lies on — so a KLD can be drawn for a layout chosen before proposals
// existed. A layout the sheet holds exactly is preferred; a die with fewer ups than the sheet takes fills along first.
export function inferLayout({ style, size, sheet_l, sheet_w, ups, rules = HOUSE_RULES }) {
  const a = pos(sheet_l), b = pos(sheet_w), want = Math.round(Number(ups));
  if (!a || !b || !(want > 0)) return null;
  const long = Math.max(a, b), short = Math.min(a, b);
  let fallback = null;
  for (const reading of readings(style, size)) {
    const plan = cartonPlan(reading, rules);
    for (const acrossOn of ['long', 'short']) {
      const r = layoutOn(plan, long, short, acrossOn, rules);
      const option = (m, n) => ({ reading, option: { sheet: { long, short }, ups: want, m, n, acrossOn } });
      if (r.ups === want) return option(r.m, r.n);
      if (!fallback && r.ups > want) {
        for (let n = Math.min(r.n, want); n >= 1; n--) {
          if (want % n === 0 && want / n <= r.m) { fallback = option(want / n, n); break; }
        }
      }
    }
  }
  return fallback;
}
