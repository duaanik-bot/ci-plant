// Status Sheet export — the customer-wise workbook.
//
// Pure on purpose. This is the one part of the sheet with real branching (which
// rows go on which worksheet, and what happens to a run shared by two
// customers), and a `.jsx` page cannot be imported by `node --test` — so the
// decisions live here and StatusSheet.jsx only supplies rows and columns.
//
// Two rules drive everything below:
//   1. A worksheet is ONE customer's report. Sending customer A a sheet with
//      customer B's carton on it is a leak, not a formatting quirk.
//   2. The export shows what the list view shows — minus the status column,
//      plus Remarks. EDD is already a column on the sheet and rides along.

// The status column exists to drive the Pending/Completed/Dispatched chips. It
// is a filter control, not a fact the customer asked for, so it is dropped from
// every export. Keyed by column key, so renaming the label cannot silently put
// it back in the workbook.
export const EXPORT_EXCLUDED_KEYS = ['line_status'];

export function wipExportColumns(columns, excluded = EXPORT_EXCLUDED_KEYS) {
  const drop = new Set(excluded);
  return (columns || []).filter(c => !drop.has(c.key));
}

// Every distinct customer a display row answers for. A plain line has one; a
// collapsed gang row carries `_gang` and may span several, because a gang is a
// shared sheet and nothing says the cartons on it were ordered by one company.
export function customersOf(row) {
  const members = row._gang || [row];
  return [...new Set(members.map(m => m.customer_name).filter(Boolean))];
}

// Rows grouped into one bucket per customer.
//
// A row belonging to ONE customer is exported exactly as the planner sees it —
// a gang stays collapsed, so the workbook and the screen agree. A row spanning
// SEVERAL customers is expanded into its member lines first, and each member
// lands on its own customer's sheet. That expansion is the whole reason this
// function is not a one-line groupBy: collapsed, such a row would have to be
// duplicated onto both sheets, and each copy would carry the other customer's
// carton in its cells.
//
// Insertion order is preserved (the sorted order the table handed over) and
// buckets come back alphabetically, so a workbook's tabs are findable.
export function groupRowsByCustomer(rows) {
  const buckets = new Map();
  const put = (name, row) => {
    const key = name || 'Unassigned';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  };
  for (const row of rows || []) {
    const names = customersOf(row);
    if (names.length <= 1) { put(names[0], row); continue; }
    for (const m of row._gang) put(m.customer_name, m);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([customer, rowsFor]) => ({ customer, rows: rowsFor }));
}

// The exporter spec.
//
// Two or more customers in view → one section per customer with
// `sheetPerSection`, which exportXLSX turns into one worksheet each, every
// sheet keeping its own frozen header row and auto-filter (a single stacked
// sheet necessarily loses both). One customer → a plain single-table report,
// exactly as this sheet has always exported, titled with whose it is.
//
// `sheetPerSection` is an XLSX-only instruction; a PDF of the same spec prints
// the sections stacked with their headings, which is the right shape for paper.
export function buildWipExportSpec({
  rows = [],
  columns = [],
  name = 'Status Sheet',
  subtitle = 'Pending order status',
  meta = [],
  excluded = EXPORT_EXCLUDED_KEYS,
} = {}) {
  const cols = wipExportColumns(columns, excluded);
  const groups = groupRowsByCustomer(rows);
  const base = {
    name,
    subtitle,
    meta: (meta || []).filter(Boolean),
  };

  if (groups.length <= 1) {
    const only = groups[0];
    return {
      ...base,
      title: only ? `${name} — ${only.customer}` : name,
      columns: cols,
      rows: only ? only.rows : [],
    };
  }

  return {
    ...base,
    title: name,
    sheetPerSection: true,
    // `heading` is what writeSectionSheets names the worksheet tab, so it is
    // the customer and nothing else — Excel truncates a tab at 31 characters
    // and a decorated heading would spend them on decoration.
    sections: groups.map(g => ({ heading: g.customer, columns: cols, rows: g.rows })),
    meta: [...base.meta, `${groups.length} customers · one worksheet each`],
  };
}
