// ─── What can carry a conversation ──────────────────────────────────────────
// A thread used to be addressable only as a job card, which is the sole reason
// Job Cards had a Discuss button and no other module did. Threads are now
// addressed as (entity, entity_id), and THIS FILE is the closed list of what
// `entity` may be. Anything not in the map is refused with a 400 before it can
// reach SQL — the table name in `SELECT 1 FROM <table>` comes from here, never
// from the request, so an entity key is not a place a caller can inject.
//
// Every row was verified against db.js when it was written:
//   * `table` exists as a CREATE TABLE there,
//   * `number` is a column that really exists ON THAT TABLE (several arrive as
//     a later ALTER — materials.code and machines.code both do),
//   * `module` is a real key from client/src/modules.js MODULES.
// record-entities.test.js re-asserts all three by reading db.js and modules.js,
// so a schema rename cannot quietly leave a dead entry behind.
//
// `number` is the human number the plant says out loud (CI-JC-0002, PO-889).
// null means the table genuinely has none — customers, vendors, employees and
// the line tables are identified by name or by their parent, and inventing a
// number for them would only produce a title nobody recognises.
//
// `module` is the module key a permission gate will use LATER. Nothing enforces
// it yet: `own_modules` commenting was cut from wave 1 because there is no
// server-side module gate anywhere in routes/ to hang it on (the design's
// correction #1). It is carried now so adding the gate is a code change and not
// a data migration.
//
// `link` is the in-app route the notification and the cross-link open. The base
// routes are real (client/src/App.jsx); the query strings are the deep-link
// contract the client half implements.

export const ENTITIES = {
  order: {
    table: 'orders', number: 'po_number', label: 'Sales Order',
    module: 'orders', link: id => `/orders?open=${id}`,
  },
  order_line: {
    // A line has no number of its own — it is "the third line of PO-889".
    table: 'order_lines', number: null, label: 'Order Line',
    module: 'planning', link: id => `/planning?line=${id}`,
  },
  job_card: {
    table: 'job_cards', number: 'jc_number', label: 'Job Card',
    module: 'production', link: id => `/production?jc=${id}`,
  },
  job_stage: {
    // Live Floor rows deliberately open the JOB's thread, not the stage's —
    // ten stages would fragment one job's conversation. This key exists for
    // the stage-specific incident somebody raises on purpose.
    table: 'job_stages', number: null, label: 'Stage',
    module: 'floor', link: id => `/floor?stage=${id}`,
  },
  requisition: {
    table: 'requisitions', number: 'pr_number', label: 'Requisition',
    module: 'procurement', link: id => `/procurement?pr=${id}`,
  },
  requisition_line: {
    table: 'requisition_lines', number: null, label: 'PR Line',
    module: 'procurement', link: id => `/procurement?pr_line=${id}`,
  },
  purchase_order: {
    table: 'purchase_orders', number: 'po_number', label: 'Purchase Order',
    module: 'procurement', link: id => `/procurement/po/${id}`,
  },
  grn: {
    table: 'grns', number: 'grn_number', label: 'GRN',
    module: 'procurement', link: id => `/procurement?grn=${id}`,
  },
  invoice: {
    table: 'invoices', number: 'invoice_number', label: 'Invoice',
    module: 'dispatch_invoice', link: id => `/invoices/${id}`,
  },
  dispatch: {
    table: 'dispatches', number: 'challan_number', label: 'Challan',
    module: 'dispatch_invoice', link: id => `/dispatch/challan/${id}`,
  },
  fg_lot: {
    table: 'fg_lots', number: 'lot_number', label: 'FG Lot',
    // Warehouse has no lot-deep-link yet, so this lands on the FG stock view.
    // The id rides along so the link is still addressable when it grows one.
    module: 'inventory', link: id => `/inventory?lot=${id}`,
  },
  extra_sheet: {
    table: 'extra_sheet_requests', number: 'xs_number', label: 'Extra Sheets',
    module: 'extra_sheets', link: id => `/extra-sheets?xs=${id}`,
  },
  shade_card: {
    table: 'shade_cards', number: 'sc_number', label: 'Shade Card',
    module: 'shade_cards', link: id => `/shade-cards?sc=${id}`,
  },
  tool: {
    table: 'tools', number: 'code', label: 'Tool',
    module: 'tooling', link: id => `/tooling?tool=${id}`,
  },
  product: {
    table: 'products', number: 'code', label: 'Product',
    module: 'masters', link: id => `/masters?tab=products&id=${id}`,
  },
  material: {
    // materials IS the board master — the redundant Materials tab was removed
    // and Masters shows it as "Boards", so that is what the tab key says.
    table: 'materials', number: 'code', label: 'Board',
    module: 'masters', link: id => `/masters?tab=boards&id=${id}`,
  },
  customer: {
    table: 'customers', number: null, label: 'Customer',
    module: 'masters', link: id => `/masters?tab=customers&id=${id}`,
  },
  vendor: {
    table: 'vendors', number: null, label: 'Vendor',
    module: 'masters', link: id => `/masters?tab=vendors&id=${id}`,
  },
  machine: {
    // machines.code is the plant's press code (CI-01, CI-02) and it is a real
    // column, so the thread is titled with it. It is nullable, which is exactly
    // what resolveLabel's fallback is for.
    table: 'machines', number: 'code', label: 'Machine',
    module: 'masters', link: id => `/masters?tab=machines&id=${id}`,
  },
  employee: {
    table: 'employees', number: null, label: 'Employee',
    module: 'masters', link: id => `/masters?tab=employees&id=${id}`,
  },
};

for (const spec of Object.values(ENTITIES)) Object.freeze(spec);
Object.freeze(ENTITIES);

// The gate. An unknown key must never reach SQL, so every path that takes an
// entity from the wire starts here. hasOwnProperty, not `ENTITIES[key]`:
// a bare lookup would happily hand back Object.prototype.constructor for
// entity='constructor' and the caller would then interpolate a function into
// a table name. The offending key is echoed back sanitized — it lands in an
// error message the browser renders.
export function entityOr400(key) {
  const k = typeof key === 'string' ? key : '';
  if (!Object.prototype.hasOwnProperty.call(ENTITIES, k)) {
    const shown = k.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
    throw Object.assign(
      new Error(shown ? `Unknown record type '${shown}'` : 'Unknown record type'),
      { status: 400 },
    );
  }
  return ENTITIES[k];
}

// The thread's title: what the plant calls this record. The number when the
// table has one AND the row actually carries it (machines.code and
// materials.code are nullable), otherwise a label the reader can still place —
// "Customer #14" is honest, a blank thread name is not.
export function resolveLabel(entity, row) {
  const spec = entityOr400(entity);
  const num = spec.number ? row?.[spec.number] : null;
  const text = num == null ? '' : String(num).trim();
  return text || `${spec.label} #${row?.id ?? '?'}`;
}
