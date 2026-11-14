// Size proposals for a new carton (owner, 12 Nov 2026: "Whenever there is a new size, I put the dimensions. You will
// propose the size to me, not only from the sizer, but also by analysing it yourself … out of which I will select one").
//
// Pure: no database, no clock. Shared by the costing screen and the server (routes/sizing.js), like costing.js.
// The rules are the plant's own, measured on 12 Nov 2026 from its dies, output sheets and Size Library (see
// docs/superpowers/specs/2026-11-12-size-proposals-kld-design.md); with them this model gives the same ups as the
// real dies it was checked on (sizing.test.js). The owner confirmed them on 14 Nov 2026 (the tube by the opening, inner
// sizes, dust flaps sharing a cut with the next tuck) and asked for the press margins to be warned about, not taken off.
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
  // what the presses want free (owner, 14 Nov 2026: 10 mm gripper, 5 mm edges). Not taken off the sheet — "Warn, don't
  // drop ups": 9 of 11 real dies run with less — a layout that leaves less is flagged (marginShortfall).
  pressMargin: Object.freeze({ gripper: 10, other: 5 }),
  // mm between two ups on the output, both ways (0: neighbouring ups share a cut)
  gutter: 0,
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
  // the output's gap between every two ups (rulesWith), in both directions
  const gutter = Number(rules.gutter) > 0 ? Number(rules.gutter) : 0;
  const acrossFor = m => (m > 0 ? m * across + (m - 1) * gutter : 0);
  if (construction === 'RTE') {
    // reverse tuck: the closures sit on opposite faces, so one carton's tuck fits beside the next one's
    const along = n => (n > 0 ? n * (tube + w + tuck) + (w + tuck) + (n - 1) * gutter : 0);
    return { construction, across, glue, tuck, dust, lock: null, gutter, acrossFor, along, blank: { across, along: along(1) } };
  }
  const lock = rules.lock(w);
  const single = lock + tube + w + tuck, pair = 2 * lock + 2 * tube + w + tuck;
  // two lock bottoms go head to head and share one W + tuck gap (owner, 14 Nov 2026: the tuck and the other carton's
  // dust flaps share one cut line); pairs butt foot to foot
  const along = n => (n > 0 ? Math.floor(n / 2) * pair + (n % 2) * single + (n - 1) * gutter : 0);
  return { construction, across, glue, tuck, dust, lock, gutter, acrossFor, along, blank: { across, along: single } };
}

// A print sheet's usable sides in mm: [the side the cartons' across direction lies on, the other one].
const sheetSides = (sheetLong, sheetShort, acrossOn, rules) => {
  const { gripper, other } = rules.margin;
  // the gripper bites a long edge, so it is taken off the short side
  const longMm = sheetLong * IN - 2 * other, shortMm = sheetShort * IN - gripper - other;
  return acrossOn === 'long' ? [longMm, shortMm] : [shortMm, longMm];
};

// How far a layout falls short of the press margins, or null when it leaves them. The gripper bites a long edge, so the
// short side needs gripper + edge free and the long side an edge at each end; margins typed for the output are free
// too. → null | { short, long } in mm.
export function marginShortfall({ acrossOn, spareAcross, spareAlong, settings = null }, rules = HOUSE_RULES) {
  const pm = rules.pressMargin;
  if (!pm) return null;
  const s = cleanSettings(settings);
  const spareLong = acrossOn === 'long' ? spareAcross : spareAlong;
  const spareShort = acrossOn === 'long' ? spareAlong : spareAcross;
  const short = r1(pm.gripper + pm.other - (spareShort + s.gripper + s.edge));
  const long = r1(2 * pm.other - (spareLong + 2 * s.edge));
  return short > EPS || long > EPS ? { short: Math.max(0, short), long: Math.max(0, long) } : null;
}
// The warning for a layout under the press margins, or null.
export function marginText(shortfall, sheet, rules = HOUSE_RULES) {
  if (!shortfall) return null;
  const pm = rules.pressMargin;
  const parts = [];
  if (shortfall.short > 0) parts.push(`${shortfall.short} mm short on the ${sheet.short} in side`);
  if (shortfall.long > 0) parts.push(`${shortfall.long} mm short on the ${sheet.long} in side`);
  return `Under the press margins (${pm.gripper} mm gripper + ${pm.other} mm edges): ${parts.join(', ')}`;
}

// The best grid of one carton on a print sheet, its across direction on the sheet's `acrossOn` side.
export function layoutOn(plan, sheetLong, sheetShort, acrossOn, rules = HOUSE_RULES) {
  const [A, B] = sheetSides(sheetLong, sheetShort, acrossOn, rules);
  const g = plan.gutter || 0;
  const acrossFor = plan.acrossFor || (k => k * plan.across + Math.max(0, k - 1) * g);
  const m = Math.max(0, Math.floor((A + g) / (plan.across + g) + EPS));
  let n = 0;
  while (plan.along(n + 1) <= B + EPS && n < 200) n++;
  const ups = m * n;
  return {
    ups, m, n, acrossOn,
    spareAcross: A - acrossFor(m), spareAlong: B - plan.along(n),
    needRow: acrossFor(m + 1) - A, needUp: plan.along(n + 1) - B,
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
          const margins = marginShortfall({ acrossOn, spareAcross: r.spareAcross, spareAlong: r.spareAlong }, rules);
          all.push({ ...base, ups: r.ups, m: r.m, n: r.n, sqInPerCarton: +sq.toFixed(1), gramsPerCarton: gramsOf(sq),
            spareAcross: +r.spareAcross.toFixed(1), spareAlong: +r.spareAlong.toFixed(1), grain,
            note: tight < 2 ? `Tight: ${tight.toFixed(1)} mm spare` : null,
            margins, marginNote: marginText(margins, base.sheet, rules) });
        }
        const near = [];
        if (r.m >= 1 && r.needUp <= rules.nearMissMm) near.push({ ups: r.m * (r.n + 1), needMm: r.needUp, axis: 'along' });
        if (r.n >= 1 && r.needRow <= rules.nearMissMm) near.push({ ups: (r.m + 1) * r.n, needMm: r.needRow, axis: 'across' });
        for (const x of near) misses.push({ ...base, ...x, needMm: +x.needMm.toFixed(1), grain, sqInPerCarton: +sqIn(s.long, s.short, x.ups).toFixed(1) });
      }
    }
    // least board a carton, then more ups, then the grain that fits, then the press margins kept
    all.sort((a, b) => a.sqInPerCarton - b.sqInPerCarton || b.ups - a.ups || (a.grain === 'ok' ? -1 : 0) - (b.grain === 'ok' ? -1 : 0)
      || Number(!!a.margins) - Number(!!b.margins));
    const options = [], seen = new Set();
    for (const o of all) { if (seen.has(o.ups)) continue; seen.add(o.ups); options.push(o); if (options.length >= maxOptions) break; }
    const bar = options[0]?.sqInPerCarton ?? Infinity;
    const nearMisses = [], keys = new Set();
    for (const m of misses.filter(x => x.sqInPerCarton < bar - EPS).sort((a, b) => a.sqInPerCarton - b.sqInPerCarton)) {
      const k = `${m.sheet.long}x${m.sheet.short}|${m.ups}`;
      if (keys.has(k)) continue; keys.add(k); nearMisses.push(m);
      if (nearMisses.length >= 3) break;
    }
    const { along, acrossFor, ...shown } = plan;
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
  // the output's settings (option.settings: gripper, edges, gap between ups) on top of the house rules
  const r = rulesWith(option?.settings, rules);
  const plan = typeof planIn?.along === 'function' ? planIn : cartonPlan(reading, r);
  const { tube, face, w } = reading;
  const { across, glue, tuck } = plan, gap = w + tuck, g = plan.gutter || 0;
  // the gripper bites a long edge (y = 0 here); the edges come off the rest
  const { gripper, other } = r.margin;
  const blocks = [];
  const put = (ox, oy, turned, local) => {
    for (const [x, y, bw, bh, kind] of local) {
      // turned 180°: (x, y) → (across − x, tube − y)
      const lx = turned ? across - (x + bw) : x, ly = turned ? tube - (y + bh) : y;
      const u = ox + lx, v = oy + ly;
      blocks.push(option.acrossOn === 'long' ? { x: other + u, y: gripper + v, w: bw, h: bh, kind } : { x: other + v, y: gripper + u, w: bh, h: bw, kind });
    }
  };
  for (let i = 0; i < option.m; i++) {
    for (let j = 0; j < option.n; j++) {
      const ox = i * (across + g);
      if (plan.construction === 'RTE') {
        put(ox, gap + j * (tube + gap + g), false, [
          [0, 0, across, tube, 'body'], [0, 0, glue, tube, 'glue'],
          [glue + face + w, tube, face, gap, 'flap'], [glue, -gap, face, gap, 'flap'],
        ]);
      } else {
        const lk = plan.lock, pair = 2 * lk + 2 * tube + gap, k = Math.floor(j / 2);
        const local = [[0, 0, across, tube, 'body'], [0, 0, glue, tube, 'glue'], [glue, tube, face, gap, 'flap'], [glue, -lk, across - glue, lk, 'flap']];
        if (j % 2 === 0) put(ox, k * pair + lk + j * g, false, local);
        else put(ox, k * pair + lk + tube + gap + j * g, true, local);
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

const r1 = x => Math.round(x * 10) / 10;

// How far a saved layout (a KLD's: sheet_long, sheet_short, m across, n along, across_on) runs past the house rules,
// or null when it fits. A die can run tighter than the measured rules (owner, 12 Nov 2026: a factory die runs
// 100 × 15 × 80 side pasting 10 up on 16 × 25, where the rules fit 9), so this is a note on the KLD, never a refusal.
export function overRules(reading, lay, base = HOUSE_RULES) {
  const long = pos(lay?.sheet_long), short = pos(lay?.sheet_short);
  const m = Math.round(Number(lay?.m)), n = Math.round(Number(lay?.n));
  if (!reading || !long || !short || !(m > 0) || !(n > 0)) return null;
  // with the output's own settings when the layout carries them
  const rules = rulesWith(lay.settings, base);
  const plan = cartonPlan(reading, rules);
  const [A, B] = sheetSides(long, short, lay.across_on === 'long' ? 'long' : 'short', rules);
  const across = plan.acrossFor(m) - A, along = plan.along(n) - B;
  if (across <= EPS && along <= EPS) return null;
  const axis = across > EPS && along > EPS ? 'both' : along > EPS ? 'along' : 'across';
  const fits = Math.max(...['long', 'short'].map(on => layoutOn(plan, long, short, on, rules).ups));
  return { mm: r1(Math.max(across, along)), axis, rules_ups: fits };
}

// The grid to draw when the house rules cannot place a die's sheet and ups (inferLayout gives null): of every reading,
// sheet side and m × n that makes the ups, the one that runs least past the rules, and how far it runs.
export function closestLayout({ style, size, sheet_l, sheet_w, ups, settings = null, rules: base = HOUSE_RULES }) {
  const a = pos(sheet_l), b = pos(sheet_w), want = Math.round(Number(ups));
  if (!a || !b || !(want > 0)) return null;
  const rules = rulesWith(settings, base);
  const long = Math.max(a, b), short = Math.min(a, b);
  let best = null;
  for (const reading of readings(style, size)) {
    const plan = cartonPlan(reading, rules);
    for (const acrossOn of ['long', 'short']) {
      const [A, B] = sheetSides(long, short, acrossOn, rules);
      for (let m = 1; m <= want; m++) {
        if (want % m) continue;
        const n = want / m;
        const run = Math.max(0, plan.acrossFor(m) - A) + Math.max(0, plan.along(n) - B);
        if (!best || run < best.run - EPS) best = { run, reading, option: { sheet: { long, short }, ups: want, m, n, acrossOn } };
      }
    }
  }
  if (!best) return null;
  const { reading, option } = best;
  return { reading, option, over: overRules(reading, { sheet_long: long, sheet_short: short, m: option.m, n: option.n, across_on: option.acrossOn, settings }, base) };
}

// The KLD's note when its layout runs past the house rules ('' when it fits), for the costing screen and the PDF.
export function overRulesText(lay) {
  const o = lay?.over_rules;
  if (!o) return '';
  const acrossSide = lay.across_on === 'long' ? lay.sheet_long : lay.sheet_short;
  const alongSide = lay.across_on === 'long' ? lay.sheet_short : lay.sheet_long;
  const need = o.axis === 'both' ? `up to ${o.mm} mm more than the sheet`
    : `${o.mm} mm more than the ${o.axis === 'along' ? alongSide : acrossSide} in side`;
  const fit = o.rules_ups > 0 ? `they fit ${o.rules_ups} up on this sheet` : 'not one fits this sheet';
  return `By the house rules, ${lay.ups} up (${lay.m} × ${lay.n}) needs ${need}; ${fit}. Check the die maker's layout.`;
}

// ── the output: its own settings, and every way to place the ups (owner, 13 Nov 2026: "key line u are making is good
// but we need proper layout options also for output setting") ───────────────────────────────────────────────────────
// docs/superpowers/specs/2026-11-13-output-layout-options-design.md. The house rules run edge to edge (all 0); a person
// may set a gripper (off one long edge), edges (off the rest) and a gap between ups, in mm.
const num0 = x => (Number(x) > 0 ? Number(x) : 0);
const SETTINGS_KEYS = ['gripper', 'edge', 'gap'];
export function cleanSettings(raw) {
  const v = k => { const n = Number(raw?.[k]); return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0; };
  return { gripper: v('gripper'), edge: v('edge'), gap: v('gap') };
}
export function settingsProblem(raw) {
  if (raw == null) return null;
  for (const k of SETTINGS_KEYS) {
    const x = raw[k];
    if (x == null || x === '') continue;
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0 || n > 50) return 'Gripper, edges and gap are millimetres from 0 to 50.';
  }
  return null;
}
// The house rules with the output's settings on top.
export function rulesWith(settings, rules = HOUSE_RULES) {
  const s = cleanSettings(settings);
  return {
    ...rules,
    margin: { gripper: s.gripper + num0(rules.margin?.gripper), other: s.edge + num0(rules.margin?.other) },
    gutter: s.gap + num0(rules.gutter),
  };
}
export function outputText(lay) {
  const s = cleanSettings(lay?.settings);
  if (!s.gripper && !s.edge && !s.gap) return 'Edge to edge: no gripper, edges or gap';
  return `Gripper ${s.gripper} mm · edges ${s.edge} mm · gap between ups ${s.gap} mm`;
}

// The most ups the sheet takes by the house rules (with the settings), any reading, either side.
export function maxUps({ style, size, sheet_l, sheet_w, settings = null, rules: base = HOUSE_RULES }) {
  const a = pos(sheet_l), b = pos(sheet_w);
  if (!a || !b) return 0;
  const rules = rulesWith(settings, base);
  const long = Math.max(a, b), short = Math.min(a, b);
  let best = 0;
  for (const reading of readings(style, size)) {
    const plan = cartonPlan(reading, rules);
    for (const on of ['long', 'short']) best = Math.max(best, layoutOn(plan, long, short, on, rules).ups);
  }
  return best;
}

// Every way to place exactly `ups` on the sheet: each reading, either sheet side, each rows × columns grid. The ones that
// fit come first (the roomiest first), then the ones over the house rules (least over first); one more than
// OVER_MAX_MM over is no layout. → [{ key, reading, fits, spare: {across, along} | null, over: {mm, axis} | null, option }]
const OVER_MAX_MM = 150;
export function layoutOptions({ style, size, sheet_l, sheet_w, ups, settings = null, rules: base = HOUSE_RULES, limit = 8 }) {
  const a = pos(sheet_l), b = pos(sheet_w), want = Math.round(Number(ups));
  if (!a || !b || !(want > 0)) return [];
  const rules = rulesWith(settings, base);
  const kept = cleanSettings(settings);
  const long = Math.max(a, b), short = Math.min(a, b);
  const out = [];
  for (const reading of readings(style, size)) {
    const plan = cartonPlan(reading, rules);
    for (const acrossOn of ['long', 'short']) {
      const [A, B] = sheetSides(long, short, acrossOn, rules);
      for (let m = 1; m <= want; m++) {
        if (want % m) continue;
        const n = want / m;
        const overA = plan.acrossFor(m) - A, overB = plan.along(n) - B;
        const fits = overA <= EPS && overB <= EPS;
        const over = fits ? null : {
          mm: r1(Math.max(overA, overB)), axis: overA > EPS && overB > EPS ? 'both' : overB > EPS ? 'along' : 'across',
        };
        if (over && over.mm > OVER_MAX_MM) continue;
        const margins = fits ? marginShortfall({ acrossOn, spareAcross: -overA, spareAlong: -overB, settings: kept }, base) : null;
        out.push({
          key: `${reading.key}|${acrossOn}|${m}x${n}`, reading, fits, over,
          spare: fits ? { across: r1(-overA), along: r1(-overB) } : null,
          margins, marginNote: marginText(margins, { long, short }, base),
          option: { sheet: { long, short }, ups: want, m, n, acrossOn, settings: kept },
        });
      }
    }
  }
  const room = o => Math.min(o.spare.across, o.spare.along);
  // the ones that fit first — those keeping the press margins before those that don't — the roomiest first
  out.sort((x, y) => (Number(y.fits) - Number(x.fits))
    || (x.fits ? Number(!!x.margins) - Number(!!y.margins) || room(y) - room(x) : x.over.mm - y.over.mm));
  return out.slice(0, limit);
}

