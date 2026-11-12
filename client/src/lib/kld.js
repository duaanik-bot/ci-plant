// The KLD (key line drawing) of one carton blank, drawn by CI Plant from the size and the house rules (owner,
// 12 Nov 2026: "you will create the KLD for the product and save it … in the cost sheet itself (which we will be
// sending to our team to work on the same KLD)").
//
// Pure: the same geometry is drawn on screen (kldSvg) and into the 1:1 PDF for the die maker (server/src/kld-pdf.js).
// Paths are SVG path strings in millimetres, y DOWN, origin at the blank's top-left; curves are short straight runs,
// so a path is only M / L / Z and both renderers read it the same way.
//
// Columns across (round the tube): glue | face | W | face | W.
//   RTE  — reverse tuck: the top closure + tuck on the third panel (front), the bottom one on the second (back),
//          dust flaps on both W panels at both ends.
//   LOCK — crash-lock bottom, tuck top: closure + tuck on the first face, dust flaps on the W panels at the top,
//          lock flaps on the faces and glue tabs (with their 45° crease) on the W panels at the bottom. The lock flaps
//          follow the standard pattern until the plant's own lock KLD is measured.
import { HOUSE_RULES } from './sizing.js';

const CUTBACK = 2.5;     // glue flap ends cut back (mm), as on the plant's drawings
const CLEAR = 1;         // the tuck is this much narrower than its closure panel on each side
const r2 = x => Math.round(x * 100) / 100;
const fmt = x => String(r2(x));

// Quarter arc from a to b (both [x, y] in y-up coordinates) around centre c, as straight runs.
function arc(c, a, b, steps = 6) {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let d = a1 - a0;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]), out = [];
  for (let i = 1; i <= steps; i++) out.push([c[0] + r * Math.cos(a0 + d * i / steps), c[1] + r * Math.sin(a0 + d * i / steps)]);
  return out;
}

// A closure panel (depth W) and its tuck with round corners, from x0 to x1 on edge y = e, pointing `dir` (+1 up, −1 down).
function closure(x0, x1, e, w, t, dir) {
  const r = Math.min(t, (x1 - x0 - 2 * CLEAR) / 3);
  const yT = e + dir * w, yE = yT + dir * t;
  const L = x0 + CLEAR, R = x1 - CLEAR;
  const pts = [[x0, e + dir * 1], [x0, yT], [L, yT], [L, yE - dir * r]];
  pts.push(...arc([L + r, yE - dir * r], [L, yE - dir * r], [L + r, yE]));
  pts.push([R - r, yE]);
  pts.push(...arc([R - r, yE - dir * r], [R - r, yE], [R, yE - dir * r]));
  pts.push([R, yT], [x1, yT], [x1, e + dir * 1]);
  return pts;
}

export function kldBlank({ construction, tube, face, w, rules = HOUSE_RULES }) {
  const T = +tube, F = +face, W = +w;
  const g = rules.glue(W), t = rules.tuck(W), d = rules.dust(W, t);
  const x = { glue: 0, p1: g, p2: g + F, p3: g + F + W, p4: g + 2 * F + W, end: g + 2 * F + 2 * W };
  const lock = construction === 'LOCK' ? rules.lock(W) : null;
  const top = T + W + t, bottom = construction === 'LOCK' ? -lock : -(W + t);
  const P = []; // outline, y up, clockwise from the glue flap's lower corner
  const crease = [];
  const line = (a, b) => crease.push([a, b]);
  for (const cx of [x.p1, x.p2, x.p3, x.p4]) line([cx, 0], [cx, T]);

  // the glue flap's left edge and top cut-back
  P.push([0, CUTBACK], [0, T - CUTBACK], [x.p1, T]);
  const dustUp = (x0, x1, towardRight) => (towardRight
    ? [[x0 + 1, T + d], [x1 - 3, T + d], [x1, T + 1]]
    : [[x0, T + 1], [x0 + 3, T + d], [x1 - 1, T + d], [x1, T]]);
  if (construction === 'RTE') {
    P.push([x.p2, T]);                                   // back: no flap at the top
    P.push(...dustUp(x.p2, x.p3, true));                 // dust flap, leaning away from the front closure
    P.push(...closure(x.p3, x.p4, T, W, t, +1));         // front closure + tuck
    P.push(...dustUp(x.p4, x.end, false));
    line([x.p3, T], [x.p4, T]); line([x.p3 + CLEAR, T + W], [x.p4 - CLEAR, T + W]);
  } else {
    P.push(...closure(x.p1, x.p2, T, W, t, +1).slice(1)); // closure on the first face, straight up from the glue corner
    P.push(...dustUp(x.p2, x.p3, false));
    P.push([x.p4, T]);                                    // the second face: no flap at the top
    P.push([x.p4 + 1, T + d], [x.end - 3, T + d], [x.end, T]);
    line([x.p1, T], [x.p2, T]); line([x.p1 + CLEAR, T + W], [x.p2 - CLEAR, T + W]);
  }
  line([x.p2, T], [x.p3, T]); line([x.p4, T], [x.end, T]);
  P.push([x.end, 0]);                                     // the free edge

  if (construction === 'RTE') {
    P.push([x.end - 1, -d], [x.p4 + 3, -d], [x.p4, -1], [x.p4, 0]);   // dust flap under the second W panel
    P.push([x.p3, 0]);                                                  // front: no flap at the bottom
    P.push([x.p3 - 1, -d], [x.p2 + 3, -d], [x.p2, -1]);                 // dust flap under the first W panel
    P.push(...closure(x.p1, x.p2, 0, W, t, -1).reverse().slice(1));     // back closure + tuck, walked right to left
    P.push([x.p1, 0]);
    line([x.p1, 0], [x.p2, 0]); line([x.p1 + CLEAR, -W], [x.p2 - CLEAR, -W]);
    line([x.p2, 0], [x.p3, 0]); line([x.p4, 0], [x.end, 0]);
  } else {
    const tab = W / 2, lead = Math.min(lock, F / 3);
    // the glue tab: cut almost square, with its 45° fold line inside it from the panel corner
    const glueTab = (xl, xr) => { P.push([xr - 2, -tab], [xl + 2, -tab], [xl, 0]); line([xl, 0], [xl + tab, -tab]); };
    const lockFlap = (xl, xr) => P.push([xr - lead, -lock], [xl, -lock], [xl, 0]);
    glueTab(x.p4, x.end); lockFlap(x.p3, x.p4); glueTab(x.p2, x.p3); lockFlap(x.p1, x.p2);
    for (const [a, b] of [[x.p1, x.p2], [x.p2, x.p3], [x.p3, x.p4], [x.p4, x.end]]) line([a, 0], [b, 0]);
  }

  // to SVG space: y down from the top tip
  const sx = p => fmt(p[0]), sy = p => fmt(top - p[1]);
  const cut = [`M${P.map(p => `${sx(p)},${sy(p)}`).join(' L')} Z`];
  const creasePaths = crease.map(([a, b]) => `M${sx(a)},${sy(a)} L${sx(b)},${sy(b)}`);
  const glue = `M${sx([0, CUTBACK])},${sy([0, CUTBACK])} L${sx([0, T - CUTBACK])},${sy([0, T - CUTBACK])} L${sx([x.p1, T])},${sy([x.p1, T])} L${sx([x.p1, 0])},${sy([x.p1, 0])} Z`;
  const Y = y => r2(top - y), height = r2(top - bottom), width = r2(x.end);
  const below = height + 6;
  const dims = [
    { x1: 0, y1: below, x2: width, y2: below, label: fmt(width), side: 'h' },
    ...[[0, x.p1], [x.p1, x.p2], [x.p2, x.p3], [x.p3, x.p4], [x.p4, x.end]]
      .map(([a, b]) => ({ x1: r2(a), y1: height + 1.5, x2: r2(b), y2: height + 1.5, label: fmt(b - a), side: 'h' })),
    { x1: width + 14, y1: 0, x2: width + 14, y2: height, label: fmt(height), side: 'v' },
    { x1: width + 6, y1: Y(T), x2: width + 6, y2: Y(0), label: fmt(T), side: 'v' },
  ];
  const cx = construction === 'RTE' ? x.p3 - 4 : x.p1 - 4;
  dims.push({ x1: cx, y1: Y(T + W), x2: cx, y2: Y(T), label: fmt(W), side: 'v' });
  dims.push({ x1: cx, y1: Y(T + W + t), x2: cx, y2: Y(T + W), label: fmt(t), side: 'v' });
  dims.push({ x1: x.p2 + 4, y1: Y(T + d), x2: x.p2 + 4, y2: Y(T), label: fmt(d), side: 'v' });
  if (lock != null) dims.push({ x1: x.p1 + 4, y1: Y(0), x2: x.p1 + 4, y2: Y(-lock), label: fmt(lock), side: 'v' });
  const midY = Y(T / 2);
  return {
    construction, tube: T, face: F, w: W, glue: glue, glueWidth: g, tuck: t, dust: r2(d), lock: lock != null ? r2(lock) : null,
    width, height, cut, crease: creasePaths, dims,
    grain: { x1: r2(x.p1 + F * 0.2), y1: midY, x2: r2(x.p2 - F * 0.2), y2: midY },
  };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The drawing for the screen: cut solid, creases dashed, glue area hatched, dimensions, the grain arrow, a title line.
export function kldSvg(b, { title = '', note = '' } = {}) {
  const pad = 12, footer = 18;
  const vw = b.width + pad * 2 + 18, vh = b.height + pad * 2 + 10 + footer;
  const dim = d => {
    const mx = (d.x1 + d.x2) / 2, my = (d.y1 + d.y2) / 2;
    const text = d.side === 'h'
      ? `<text x="${fmt(mx)}" y="${fmt(my - 1)}" text-anchor="middle">${esc(d.label)}</text>`
      : `<text transform="translate(${fmt(mx - 1)},${fmt(my)}) rotate(-90)" text-anchor="middle">${esc(d.label)}</text>`;
    return `<line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" marker-start="url(#kld-a)" marker-end="url(#kld-a)"/>${text}`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${fmt(vw)} ${fmt(vh)}" role="img" aria-label="${esc(title || 'Key line drawing')}">
<defs>
<marker id="kld-a" viewBox="0 0 4 4" refX="2" refY="2" markerWidth="2.4" markerHeight="2.4" orient="auto-start-reverse"><path d="M0,0 L4,2 L0,4 z" fill="#0b7a4b"/></marker>
<marker id="kld-g" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#0b7a4b"/></marker>
<pattern id="kld-h" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="#c99a1c" stroke-width="0.6"/></pattern>
</defs>
<rect x="${-pad}" y="${-pad}" width="${fmt(vw)}" height="${fmt(vh)}" fill="#fff"/>
<path d="${b.glue}" fill="url(#kld-h)" stroke="none"/>
<g class="cut" fill="none" stroke="#c0281c" stroke-width="0.35" stroke-linejoin="round">${b.cut.map(p => `<path d="${p}"/>`).join('')}</g>
<g class="crease" fill="none" stroke="#1f4fa3" stroke-width="0.3" stroke-dasharray="2 1.2">${b.crease.map(p => `<path d="${p}"/>`).join('')}</g>
<line x1="${b.grain.x1}" y1="${b.grain.y1}" x2="${b.grain.x2}" y2="${b.grain.y2}" stroke="#0b7a4b" stroke-width="0.6" marker-end="url(#kld-g)"/>
<text x="${fmt((b.grain.x1 + b.grain.x2) / 2)}" y="${fmt(b.grain.y1 - 2)}" font-size="3" fill="#0b7a4b" text-anchor="middle" font-family="Helvetica, Arial, sans-serif">grain</text>
<g class="dims" stroke="#0b7a4b" stroke-width="0.2" fill="#0b7a4b" font-size="3.2" font-family="Helvetica, Arial, sans-serif">${b.dims.map(dim).join('')}</g>
<text x="0" y="${fmt(b.height + 16)}" font-size="4" font-family="Helvetica, Arial, sans-serif" fill="#1c2530">${esc(title)}</text>
<text x="0" y="${fmt(b.height + 21)}" font-size="2.8" font-family="Helvetica, Arial, sans-serif" fill="#5a6572">${esc(note || 'mm · inner sizes · red = cut · blue dashed = crease · hatched = glue · green arrow = board grain')}</text>
</svg>`;
}
