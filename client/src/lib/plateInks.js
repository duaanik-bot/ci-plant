// What colours a plate set is made of — the arithmetic, with no JSX in it.
//
// This lives in lib/ rather than beside the components that render it because
// `.jsx` cannot be run under `node --test`, and every rule below is one a screen
// would otherwise state slightly differently: which letter Black gets, what
// order the process plates come in, whether a cancelled plate still counts.

export const PROCESS_PLATES = [
  ['cyan', 'Cyan'], ['magenta', 'Magenta'], ['yellow', 'Yellow'], ['black', 'Black'],
];

// ── The DRIP OFF plate ────────────────────────────────────────────────────
// A drip-off coated carton needs one plate that is not an ink: the varnish
// mask the coating line prints the drip-off pattern with. ONE spelling of its
// name and type, shared by the server (plates.js imports from here, the same
// direction plateRack.js already travels) and every screen — a coating plate
// that reads as a Pantone is exactly the ambiguity the plant asked to end.
//
// Its own default size is 560 x 670 even when the ink set runs 600 x 730, it
// is issued when COATING starts (never printing), and it never returns to the
// rack — one run and it is consumed.
export const DRIPOFF_TYPE = 'dripoff';
export const DRIPOFF_LABEL = 'DRIP OFF';
export const DRIP_OFF_PLATE_SIZE = '560 x 670';
export const isDripOff = component => component?.component_type === DRIPOFF_TYPE;

// The coating labels are free text off the product master ("Drip Off",
// "DRIP-OFF UV", "Drip off + Spot UV") — match the word, not a spelling.
export const hasDripOffCoating = spec => /drip/i.test(String(spec?.coating ?? ''));

// The drip plate's state as the PAPERS say it — the printed traveler and the
// Status Sheet share this one vocabulary. Two deliberate departures from the
// component-status labels the Plates module itself uses:
//   • 'scrapped' reads "Consumed" — scrap is the mask's NORMAL end (single
//     use, no return), and "Scrapped" on a status report raises an alarm
//     about a plate that simply did its one job;
//   • the buying states collapse to what a planner acts on, not the
//     procurement mechanics.
export function dripPlateStateLabel(status) {
  if (!status) return null;
  if (status === 'scrapped') return 'Consumed';
  if (status === 'issued') return 'Issued to coating';
  if (['verified_existing', 'available', 'reserved'].includes(status)) return 'Ready on rack';
  if (['approved', 'po_created', 'ordered', 'grn_received'].includes(status)) return 'On order';
  if (status === 'verification_required') return 'Verify rack plate';
  if (['pr_required', 'replacement_required', 'not_found'].includes(status)) return 'To buy';
  return String(status).replace(/_/g, ' ');
}

// One letter in a dense column, because five words would wrap the row. Spelled
// out rather than taken from the label's first letter: that gives Black a 'B'
// under a column headed CMYK+P, and the press calls it K. DRIP OFF gets two
// letters — a bare D beside CMYK letters reads as another ink.
export const SHORT_COMPONENT = { cyan: 'C', magenta: 'M', yellow: 'Y', black: 'K', pantone: 'P', [DRIPOFF_TYPE]: 'DO' };
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

// CMYK in press order, then spot colours alphabetically, and the DRIP OFF mask
// dead last — it is the coating line's plate, laid down after every ink. A
// vendor reading a PO and a warehouse ticking a delivery both expect the
// process set first and in the order the press lays it down — not in whatever
// order the rows were keyed.
const INK_RANK = new Map(PROCESS_PLATES.map(([type], index) => [type, index]));
const inkRank = type => (INK_RANK.has(type) ? INK_RANK.get(type) : type === DRIPOFF_TYPE ? 500 : 99);
export function inkOrder(rows = []) {
  return [...rows].sort((a, b) => {
    const left = inkRank(a.component_type);
    const right = inkRank(b.component_type);
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
  // Process is the NAMED ink set, not "everything that is not a Pantone" — the
  // DRIP OFF mask is neither an ink nor a spot, and folding it into the process
  // letters would print builds like CMYKDO.
  const process = groups.filter(row => PROCESS_PLATES.some(([type]) => type === row.component_type));
  const spots = groups.filter(row => row.component_type === 'pantone');
  const drip = groups.filter(isDripOff);
  const spotQty = spots.reduce((sum, row) => sum + row.qty, 0);
  const dripQty = drip.reduce((sum, row) => sum + row.qty, 0);
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
  if (dripQty) {
    parts.push({
      key: 'dripoff',
      // Named in full, always — the whole point of the plate is that nobody
      // has to ask what it is.
      label: dripQty > 1 ? `${DRIPOFF_LABEL} x${dripQty}` : DRIPOFF_LABEL,
      title: 'Drip-off coating plate — issued at coating start, single use',
      rows: drip,
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
