const COATINGS = [
  'Aqueous Varnish', 'Aqueous Varnish + Spot UV', 'Drip Off', 'Full UV',
];

const PASTING_TYPES = ['BSO', 'LOCK BOTTOM'];
const COLOUR_TYPES = ['CMYK', 'Pantone', 'CMYK + Pantone'];
const PRINT_PROCESSES = ['Offset', 'Metallic', 'Offset + Metallic'];

const hasCmyk = record => String(record?.colour_type ?? '').toLowerCase().includes('cmyk');
const hasPantone = record => String(record?.colour_type ?? '').toLowerCase().includes('pantone');
const hasMetallic = record => String(record?.print_process ?? '').toLowerCase().includes('metallic');

export const PRODUCT_MASTER_DEFAULTS = {
  emboss: 0,
  leafing: 0,
  colors: 4,
  colour_type: 'CMYK',
};

export const PRODUCT_MASTER_SOFT_SPEC = [
  { key: 'output_number', label: 'Output Number' },
  { key: 'size', label: 'Carton Size' },
  { key: 'child_l', label: 'Child Sheet L' },
  { key: 'child_w', label: 'Child Sheet W' },
  { key: 'gsm', label: 'GSM' },
  { key: 'rate', label: 'Rate', zeroIsBlank: true },
];

// One field definition powers both the Masters page and the in-place editor
// opened from Product 360. Keeping the definition here prevents the two forms
// from drifting as the product master grows.
export const PRODUCT_MASTER_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true },
  { key: 'code', label: 'Internal Code', mono: true, newRow: true, hint: 'Auto-issued from the customer\'s series (e.g. SW-768). Editable — clear it to take the next code.' },
  { key: 'party_item_code', label: 'Item Code', hint: 'The customer\'s own item / SKU code' },
  { key: 'party_artwork_code', label: 'Artwork Code', newRow: true, hint: 'The customer\'s artwork code' },
  { key: 'output_number', label: 'Output Number', hint: 'Print set number — auto-populates single-run plans in the Planning Engine' },
  { key: 'board_material_id', label: 'Board', type: 'ref', ref: 'materials', filter: m => m.category === 'board', required: true, newRow: true },
  { key: 'board_grade', label: 'Board Grade', hint: 'Grade / brand only — e.g. "Saffire", "FBB". The board carries GSM + parent size.' },
  { key: 'gsm', label: 'GSM', type: 'number', newRow: true },
  { key: 'size', label: 'Carton Size (L×W×H)' },
  { key: 'child_l', label: 'Child Sheet Length (in)', type: 'number', newRow: true, hint: 'Print (child) sheet — e.g. 15' },
  { key: 'child_w', label: 'Child Sheet Width (in)', type: 'number', hint: 'Print (child) sheet — e.g. 23' },
  { key: 'parent_l', label: 'Parent Sheet Length (in)', type: 'number', newRow: true, hint: 'Mother (parent) sheet — e.g. 26' },
  { key: 'parent_w', label: 'Parent Sheet Width (in)', type: 'number', hint: 'Mother (parent) sheet — e.g. 30' },
  { key: 'ups', label: 'Ups per Print Sheet', type: 'number', newRow: true, hint: 'Defaults to 1 — Planning re-derives it from the cut layout' },
  { key: 'colors', label: 'Total No. of Colours', type: 'number', hint: 'Editable throughout the job journey; Plate PR uses this total to identify unnamed Pantone plates. Defaults to 4.' },
  { key: 'colour_type', label: 'Colour Type', type: 'select', options: COLOUR_TYPES, newRow: true },
  { key: 'cmyk_colours', label: 'CMYK Colours', type: 'number', showWhen: hasCmyk, hint: 'Process set — normally 4' },
  { key: 'pantone_colours', label: 'Pantone Colours', type: 'number', newRow: true, showWhen: hasPantone, hint: 'How many spot colours' },
  { key: 'pantone_codes', label: 'Pantone Codes', showWhen: hasPantone, hint: 'e.g. Pantone 186 C, Pantone 286 C' },
  { key: 'print_process', label: 'Printing Process', type: 'select', options: PRINT_PROCESSES, newRow: true, hint: 'Metallic only when a metallic ink is genuinely used — a Pantone colour is not metallic' },
  { key: 'metallic_colours', label: 'Metallic Colours', type: 'number', showWhen: hasMetallic },
  { key: 'metallic_details', label: 'Metallic Colour / Code', newRow: true, showWhen: hasMetallic, hint: 'e.g. Metallic Gold (Pantone 871 C)' },
  { key: 'print_instructions', label: 'Printing Instructions', showWhen: record => hasMetallic(record) || hasPantone(record), hint: 'Special press instructions — carried to Planning, Artwork and the Job Card' },
  { key: 'coating', label: 'Coating', type: 'select', options: COATINGS },
  { key: 'pasting_type', label: 'Pasting Type', type: 'select', options: PASTING_TYPES, newRow: true },
  { key: 'emboss', label: 'Emboss', type: 'select', options: [1, 0], bool: true },
  { key: 'leafing', label: 'Leafing', type: 'select', options: [1, 0], bool: true, newRow: true },
  { key: 'leafing_colour', label: 'Leafing Colour', type: 'select', options: ['gold', 'silver', 'red', 'green', 'blue', 'magenta', 'special'], dependsOn: 'leafing', hint: 'Foil shade — enabled when Leafing is Yes' },
  { key: 'die_number', label: 'Die Number', newRow: true, hint: 'Plant die number from the master — link to a managed die on the right' },
  { key: 'tool_id', label: 'Die (Tooling Hub)', type: 'ref', ref: 'dies', hint: 'Managed in the Tooling Hub — left blank until linked' },
  { key: 'block_number', label: 'Block Number', newRow: true, hint: 'Foil/emboss block number — auto-populates Planning, Artwork and the Job Card (hub BLK code is the fallback)' },
  { key: 'product_type', label: 'Product Type', type: 'gstref', newRow: true, hint: 'Sets the default GST — carton 5%, labels/leaflets/shippers 18%' },
  { key: 'rate', label: 'Rate ₹/carton', type: 'number', hint: 'Defaults to 0 — the sales order line carries the price that bills' },
  { key: 'mrp', label: 'MRP ₹', type: 'number', newRow: true, hint: 'For printing on the product only — not used in any pricing or calculation' },
  { key: 'spec_incomplete', label: 'Spec Incomplete', type: 'select', options: [0, 1], render: value => (value ? 'Yes' : 'No'), hint: 'Set by import/PO quick-create — switch to 0 once board & spec are real' },
  { key: 'active', label: 'Active', type: 'select', options: [1, 0], newRow: true },
];

export function validateProductMaster(body, { rows = [], editing = {} } = {}) {
  const typed = String(body.code ?? '').trim().toLowerCase();
  if (!typed) return null;
  const clash = rows.find(row => String(row.id) !== String(editing.id ?? '')
    && String(row.code ?? '').trim().toLowerCase() === typed);
  return clash
    ? `${clash.code} already belongs to ${clash.name}. Clear the field to take the next code in the series.`
    : null;
}

export function productMasterBody(form = {}) {
  const body = {};
  for (const field of PRODUCT_MASTER_FIELDS) {
    let value = form[field.key];
    if (field.type === 'number' || field.type === 'ref') {
      value = value === '' || value == null ? null : +value;
    }
    if (field.key === 'active' && (value == null || value === '')) value = 1;
    if (field.key === 'spec_incomplete' && (value == null || value === '')) value = 0;
    if ((field.key === 'emboss' || field.key === 'leafing') && (value == null || value === '')) value = 0;
    if (field.key === 'leafing_colour' && String(form.leafing ?? '') !== '1') value = null;
    body[field.key] = value;
  }
  const emboss = +form.emboss ? 1 : 0;
  const leafing = +form.leafing ? 1 : 0;
  body.special = emboss && leafing ? 'foil_emboss' : emboss ? 'emboss' : leafing ? 'foil' : 'none';
  return body;
}

export function productMasterRequiredMissing(form = {}) {
  return PRODUCT_MASTER_FIELDS.some(field => field.required
    && !form[field.key] && form[field.key] !== 0);
}
