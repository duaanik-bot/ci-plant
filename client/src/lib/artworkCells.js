// What the Artwork queue's action cells SAY — as text, so the export can say it
// too.
//
// exporter.js resolves a cell as `col.export(row)` → `nodeText(col.render(row))`
// → `row[key]`, and **nodeText never RENDERS a component** — it walks
// `node.props?.children`. A cell whose render returns `<ToolingChip line={m} />`
// or `<StatusBadge status={…} />` has no children, so it resolved to ''.
//
// Measured on the live queue before this existed: Approvals, Tooling and Status
// were blank on **33 of 33 rows**. Not only the gang rows — every row. A blank
// cell is a silent failure: nothing throws, the build passes, and the column
// looks perfect on screen.
//
// These live in lib/ rather than beside the chips because `.jsx` cannot be run
// under `node --test`, and because the chip and the export must not word the
// same fact two different ways.

const members = line => (line?._gang?.length ? line._gang : [line]);

// Tooling readiness, exactly as ToolingChip paints it: ready, or the gaps named.
// A gap is a HARD requirement that is not ready, or a soft one explicitly marked
// not_ready — a soft requirement nobody has registered is not a gap.
export function toolingGaps(line) {
  return (line?.tooling || []).filter(x => (x.hard ? x.status !== 'ready' : x.status === 'not_ready'));
}

export function toolingLabel(line) {
  if (line?.tooling_ready) return 'Ready';
  const gaps = toolingGaps(line);
  if (!gaps.length) return 'Not ready';
  return gaps
    .map(g => `${g.label} ${g.status === 'missing' ? 'missing' : g.zone === 'making' ? 'at maker' : 'not ready'}`)
    .join(' · ');
}

// A gang prints as one sheet, so its tooling reads as one verdict — but if the
// members disagree, say each rather than pick one.
export function toolingExport(line) {
  const rows = members(line);
  const labels = [...new Set(rows.map(toolingLabel))];
  return labels.length === 1 ? labels[0] : rows.map(m => `${m.product_code || m.product_name}: ${toolingLabel(m)}`).join(' | ');
}

// The two approval toggles. A gang is approved only when EVERY carton on the
// sheet is — the same rule the toggle itself applies.
export function approvalExport(line) {
  const rows = members(line);
  const customer = rows.every(m => m.artwork_customer_ok);
  const qa = rows.every(m => m.artwork_qa_ok);
  const locked = rows.some(m => m.artwork_locked);
  return [
    `Customer ${customer ? 'approved' : 'pending'}`,
    `QA ${qa ? 'approved' : 'pending'}`,
    locked ? 'locked' : null,
  ].filter(Boolean).join(' · ');
}

// The status badge, including the SAVED-not-locked case the queue shows instead
// of "pending" — a job sitting in artwork with a saved plan is not unplanned.
//
// The words are PlanSavedBadge's own ("Saved · lock pending"), not a second
// phrasing invented for the spreadsheet: somebody reading the export beside the
// screen must not have to work out that two labels mean one thing.
export const PLAN_SAVED_LABEL = 'Saved · lock pending';

export function statusLabel(row) {
  if (row?.plan_draft) return PLAN_SAVED_LABEL;
  // StatusBadge renders `status.replace(/_/g,' ')` and capitalises in CSS, so
  // the underlying value is the shared vocabulary — only the casing is ours.
  const status = String(row?.status || '').trim();
  return status ? status.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—';
}

export function statusExport(line) {
  const rows = members(line);
  const labels = [...new Set(rows.map(statusLabel))];
  return labels.length === 1 ? labels[0] : labels.join(' | ');
}
