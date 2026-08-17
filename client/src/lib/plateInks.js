// What colours a plate set is made of — the arithmetic, with no JSX in it.
//
// This lives in lib/ rather than beside the components that render it because
// `.jsx` cannot be run under `node --test`, and every rule below is one a screen
// would otherwise state slightly differently: which letter Black gets, what
// order the process plates come in, whether a cancelled plate still counts.

export const PROCESS_PLATES = [
  ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['yellow', 'Yellow'], ['black', 'Black'],
];

// One letter in a dense column, because five words would wrap the row. Spelled
// out rather than taken from the label's first letter: that gives Black a 'B'
// under a column headed CMYK+P, and the press calls it K.
export const SHORT_COMPONENT = { cyan: 'C', magenta: 'M', yellow: 'Y', black: 'K', pantone: 'P' };
export const shortComponent = component => SHORT_COMPONENT[component.component_type]
  || String(component.component_label || component.component_type || '?').charAt(0).toUpperCase();

// A spot plate is identified by its Pantone, a process plate by its type. Two
// PMS 485C rows are the same plate twice; Cyan and Magenta never merge.
export const componentKey = component => `${component.component_type}|${component.component_type === 'pantone'
  ? String(component.pantone_code || component.component_label || '').trim().toLowerCase() : ''}`;

export function groupedComponents(components = []) {
  const groups = new Map();
  for (const component of components.filter(row => row.status !== 'cancelled')) {
    const key = componentKey(component);
    const group = groups.get(key) || {
      key, component_type: component.component_type, component_label: component.component_label,
      pantone_code: component.pantone_code || null, qty: 0, component_ids: [], statuses: [],
      // The rack plates this colour is actually HOLDING. Needed by Retire, which
      // acts on the asset rather than on the requirement line.
      asset_ids: [],
    };
    group.qty += 1; group.component_ids.push(component.id); group.statuses.push(component.status);
    if (component.matched_asset_id) group.asset_ids.push(Number(component.matched_asset_id));
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    status: group.statuses.every(value => value === group.statuses[0]) ? group.statuses[0] : 'mixed',
  }));
}

// CMYK in press order, then spot colours alphabetically. A vendor reading a PO
// and a warehouse ticking a delivery both expect the process set first and in
// the order the press lays it down — not in whatever order the rows were keyed.
const INK_RANK = new Map(PROCESS_PLATES.map(([type], index) => [type, index]));
export function inkOrder(rows = []) {
  return [...rows].sort((a, b) => {
    const left = INK_RANK.has(a.component_type) ? INK_RANK.get(a.component_type) : 99;
    const right = INK_RANK.has(b.component_type) ? INK_RANK.get(b.component_type) : 99;
    if (left !== right) return left - right;
    return String(a.component_label || '').localeCompare(String(b.component_label || ''));
  });
}

// One status for a group of plates: theirs if they agree, 'mixed' if they do not.
// Collapsing four chips into one must not quietly claim they are all in the same
// state — that is the only thing the four chips were still saying.
const sharedStatus = rows => {
  const statuses = [...new Set(rows.map(row => row.status))];
  return statuses.length === 1 ? statuses[0] : 'mixed';
};

// The colour BUILD, not the roll-call.
//
// A nineteen-line PO printed seventy-six chips to say "CMYK" nineteen times. The
// press does not read a plate set as four colours, it reads it as a process build
// plus its spots — so that is what a dense list shows, with the full names kept
// on hover. Detail views still name every plate: where you are ticking plates off
// a delivery, the roll-call IS the point.
// The build of an already-grouped, already-ordered set of colours: the process
// letters (CMYK when all four are there) and a count of the spots. One place,
// because a whole-set summary and a per-state one must not word it differently.
function buildParts(groups) {
  const process = groups.filter(row => row.component_type !== 'pantone');
  const spots = groups.filter(row => row.component_type === 'pantone');
  const spotQty = spots.reduce((sum, row) => sum + row.qty, 0);
  const parts = [];
  if (process.length) {
    const full = PROCESS_PLATES.every(([type]) => process.some(row => row.component_type === type));
    parts.push({
      key: 'process',
      label: full ? 'CMYK' : process.map(shortComponent).join(''),
      title: process.map(row => row.component_label).join(' · '),
      rows: process,
    });
  }
  if (spotQty) {
    parts.push({
      key: 'spot',
      // "2 Pantone" rather than the codes: the codes are long, repeat across
      // sets, and are one hover away.
      label: `${spotQty} Pantone`,
      title: spots.map(row => `${row.component_label}${row.qty > 1 ? ` x${row.qty}` : ''}`).join(' · '),
      rows: spots,
    });
  }
  return parts;
}

export function inkSummary(components = []) {
  return buildParts(inkOrder(groupedComponents(components)))
    .map(({ rows, ...part }) => ({ ...part, status: sharedStatus(rows) }));
}

// The build, said once PER STATE.
//
// On a purchase order every plate of a set is in the same state, so the four
// chips were pure noise and one "CMYK" says it. On a REQUIREMENT they are not:
// two colours may be sitting on the rack while the other two have to be bought,
// and which colours those are is the entire question the column exists to
// answer. Collapsing to one chip there would hide it; leaving four spells out
// "Cyan Magenta Yellow Black" on every row that is simply fine.
//
// So: group by state first, then say each group's build. A uniform set is one
// chip, exactly as before. A split set is two — "CM" ready, "YK" to buy — which
// is both shorter than the roll-call and more pointed than it.
export function inkSummaryByStatus(components = []) {
  const groups = inkOrder(groupedComponents(components));
  // Insertion order is press order, so the states come out in the order their
  // first colour prints — stable between two rows holding the same plates.
  const byStatus = new Map();
  for (const row of groups) {
    if (!byStatus.has(row.status)) byStatus.set(row.status, []);
    byStatus.get(row.status).push(row);
  }
  return [...byStatus.entries()].map(([status, rows]) => {
    const parts = buildParts(rows);
    return {
      status,
      label: parts.map(part => part.label).join(' + '),
      title: parts.map(part => part.title).join(' · '),
    };
  });
}

// What to call one plate on a tick list. A spot plate's Pantone is the thing
// that identifies it — but plenty of labels already carry it ("Pantone -
// Pantone 1"), and appending it again reads as two different codes.
export function componentTickLabel(component) {
  const label = String(component?.component_label || '').trim();
  const code = String(component?.pantone_code || '').trim();
  if (!code || label.toLowerCase().includes(code.toLowerCase())) return label || code;
  return `${label} (${code})`;
}

// The cartons on a shared sheet. A gang line names the RUN, and the run number
// alone does not say what is on it — which is the question asked of a gang row.
export const gangMemberNames = line => (Array.isArray(line?.gang_members) ? line.gang_members : [])
  .map(member => member.product_name).filter(Boolean).join(' · ');

// The paperwork line: which PR raised it, on which job card.
export const plateLineRefs = line => [line?.request_number, line?.jc_number].filter(Boolean).join(' · ');

// The spec line: what the plant and the vendor call this plate by. Output first
// because that is the number spoken on the floor; the size is what the rack is
// physically organised around.
export const plateLineSpec = line => [
  line?.output_number ? `Output ${line.output_number}` : null,
  line?.plate_size || null,
].filter(Boolean).join(' · ');

// The same identity as flat text, for the printed PO. A vendor document has no
// chips and no colour — it needs the words on the page.
export function plateLinePrintSpec(line) {
  const inks = inkOrder(groupedComponents(line?.components || []))
    .map(row => `${row.component_label}${row.qty > 1 ? ` x${row.qty}` : ''}`);
  return {
    name: line?.product_name || null,
    refs: plateLineRefs(line),
    spec: plateLineSpec(line),
    inks: inks.join(' · '),
  };
}
