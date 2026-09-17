// The Live Floor's traffic lights, sent once each instead of once per row.
//
// GET /floor carries a readiness light on every stage row, and on live prod
// (2026-09-17) that was 845 KB of a 1,651 KB board: 627 rows, 59 distinct
// lights. JSON has no references, so a row pinned to a machine or listed in the
// unpinned preview writes its light out AGAIN in that second container.
//
// `GET /floor?lights=ref` answers `{ sections, lights }`: every row's `light`
// becomes `light_ref`, an index into `lights` (null stays null), in the same key
// position. rehydrateLights() undoes it on arrival. Rows sharing a light then
// share ONE object — safe because nothing on the floor writes to a light (the
// dot, the popover and the checklist only read it).
//
// Every container a row lives in is covered: the four lanes, machines[].jobs and
// unpinned. Missing one would leave machine tiles or the unpinned preview with
// no dot, and change what search finds (rowMatches stringifies the row's
// values, light included). Rehydration happens in load(), before the board is
// set, never lazily in render.
//
// Pure, no React: the server (routes/floor.js) interns with this same module,
// and floor-light-intern.test.js pins the round trip byte for byte.

const LANES = ['running', 'held', 'queued', 'incoming', 'unpinned'];

// Rebuild `row` with `from` replaced by `to` in the SAME key position — the
// search haystack is JSON.stringify(Object.values(row)), so order is content.
function swapKey(row, from, to, value) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === from) out[to] = value;
    else out[k] = v;
  }
  return out;
}

// Apply `fn` to every stage row of every section, returning new sections and
// leaving the input untouched. Only the containers that hold stage rows change.
function mapRows(sections, fn) {
  return sections.map(sec => {
    const out = { ...sec };
    for (const lane of LANES) if (Array.isArray(sec[lane])) out[lane] = sec[lane].map(fn);
    if (Array.isArray(sec.machines)) {
      out.machines = sec.machines.map(m => (Array.isArray(m.jobs) ? { ...m, jobs: m.jobs.map(fn) } : m));
    }
    return out;
  });
}

export function internLights(sections) {
  const lights = [];
  const indexOf = new Map();     // JSON identity → index
  const refFor = light => {
    if (light == null) return null;
    const key = JSON.stringify(light);
    if (!indexOf.has(key)) { indexOf.set(key, lights.length); lights.push(light); }
    return indexOf.get(key);
  };
  const out = mapRows(sections, row => (row && 'light' in row ? swapKey(row, 'light', 'light_ref', refFor(row.light)) : row));
  return { sections: out, lights };
}

// An older server ignores the param and answers the bare array — pass it through.
export function rehydrateLights(res) {
  if (Array.isArray(res) || !res || !Array.isArray(res.sections)) return res;
  const lights = res.lights || [];
  return mapRows(res.sections, row => (row && 'light_ref' in row
    ? swapKey(row, 'light_ref', 'light', row.light_ref == null ? null : (lights[row.light_ref] ?? null))
    : row));
}
