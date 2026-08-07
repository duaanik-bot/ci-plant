// Masters — one generic CRUD engine, five tables + users, zero drift.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import { Button, ConfirmDialog, DataTable, Field, GroupedTabs, Input, Modal, PageHeader, searchText, Select, ShadeAge, StatusBadge, SubTabs, useToast } from '../components/ui.jsx';
import MasterHistory from '../components/MasterHistory.jsx';
import { Plus, Pencil, Trash2, Power, History, AlertTriangle } from 'lucide-react';
import { MODULES, FLOOR_SECTIONS } from '../modules.js';
import { boardName, boardCode, takenCodesFor } from '../lib/boardCode.js';
import { kgPerSheet, packetWeight, ratePerSheet, resolveRatePerKg } from '../lib/boardMath.js';
import { customerInitials, customerSearchText } from '../lib/customerCode.js';
import { nextCodeForRows } from '../lib/productCode.js';
import {
  PRODUCT_MASTER_DEFAULTS,
  PRODUCT_MASTER_FIELDS,
  PRODUCT_MASTER_SOFT_SPEC,
  validateProductMaster,
} from '../lib/productMasterConfig.js';
import { PrintColourChips, colourSummary, colourSearchText, colourTypeOf } from '../components/PrintColour.jsx';

// Sheets in one packet, by grade — the plant's standard bundle. Seeded onto a
// new board when the grade is picked and the field is still blank; never
// overwrites a number the buyer typed, because odd mill packs do happen.
const PACKET_BY_GRADE = {
  'Duplex GB': 144, 'Duplex WB': 144, 'FBB': 100, 'Saffire': 100, 'SBS': 100, 'Chromo Paper': 150,
};

// One-click presets for the standard plant logins. Applying a template fills
// role + module/station/press scope + landing page; everything stays editable
// after. null scope = unrestricted (all); [] = restricted to nothing yet (tick
// the boxes below). Press/Station operators start empty so you pick the press
// or stations for this specific person.
const USER_TEMPLATES = [
  { key: 'md', label: 'MD — full control', role: 'admin', modules: null, sections: null, machine_ids: null, landing_path: '/' },
  { key: 'planning', label: 'Planning — full control', role: 'admin', modules: null, sections: null, machine_ids: null, landing_path: '/planning' },
  { key: 'plant', label: 'Plant — full control', role: 'admin', modules: null, sections: null, machine_ids: null, landing_path: '/floor' },
  { key: 'accounts', label: 'Accounts — full control', role: 'admin', modules: null, sections: null, machine_ids: null, landing_path: '/invoices' },
  // The designer plans, gangs and merges like Planning does, and carries a job
  // through Artwork onto its Job Card — role `planner` clears every one of those
  // guards. Deliberately NOT given the dashboard or the press board: the
  // designer decides what gangs together, the plant decides which press runs it.
  { key: 'designer', label: 'Designer — planning, ganging & artwork', role: 'planner', modules: ['track', 'status_sheet', 'orders', 'planning', 'artwork', 'production', 'shade_cards', 'tooling'], sections: null, machine_ids: null, landing_path: '/planning' },
  { key: 'press', label: 'Press Operator — one press', role: 'production', modules: ['floor'], sections: ['printing'], machine_ids: [], landing_path: '/floor/printing' },
  { key: 'station', label: 'Station Operator — one station', role: 'production', modules: ['floor'], sections: [], machine_ids: null, landing_path: '/floor' },
];

const CONFIGS = {
  customers: {
    label: 'Customers', endpoint: '/customers',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'segment', label: 'Segment', type: 'select', options: ['pharma', 'fmcg'], required: true },
      { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'gstin', label: 'GSTIN' }, { key: 'contact', label: 'Contact Person' }, { key: 'phone', label: 'Phone' },
      { key: 'tolerance_pct', label: 'Dispatch Tolerance %', type: 'number', hint: 'Allowed excess/short dispatch vs ordered qty — snapshotted on each new sales order' },
      // Shade Approval Control removed: the shade module has ONE rule now — the
      // customer has approved and the approval is in date. There is no 'internal
      // sufficient' path any more, so a select offering it changed nothing while
      // telling the user they had changed a production gate. The column survives
      // in the database, unread.
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], render: v => (v ? 'Yes' : 'No') },
    ],
    columns: ['name', 'segment', 'city', 'contact', 'phone', 'tolerance_pct'],
  },
  products: {
    label: 'Products', endpoint: '/products', history: 'products', activeToggle: true,
    defaults: PRODUCT_MASTER_DEFAULTS,
    fields: PRODUCT_MASTER_FIELDS,
    columns: ['name', 'code', 'customer_name', 'board_name', 'sheets', 'ups', 'printing', 'coating', 'die_number', 'shade_card', 'product_type', 'rate', 'active'],
    validate: validateProductMaster,
  },
  gst_rates: {
    label: 'GST Rates', endpoint: '/gst_rates',
    fields: [
      { key: 'label', label: 'Product Type', required: true, hint: 'Display name, e.g. Carton, Labels' },
      { key: 'product_type', label: 'Type Code', required: true, hint: 'Lower-case key, e.g. carton, shipper_label — links products to this rate' },
      { key: 'rate', label: 'GST %', type: 'number', required: true },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['label', 'product_type', 'rate', 'active'],
  },
  machines: {
    label: 'Machines', endpoint: '/machines', operatorMapping: true, activeToggle: true, history: 'machines',
    fields: [
      { key: 'code', label: 'Machine Code', hint: 'e.g. CI-01 — the plant tag, kept separate from the name' },
      { key: 'name', label: 'Machine Name', required: true },
      { key: 'model', label: 'Make / Model', hint: 'e.g. Komori Lithrone 5-Colour — shown on the Print Planning board' },
      { key: 'type', label: 'Category', type: 'select', options: ['cutting', 'ctp', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting'], required: true },
      { key: 'capacity_per_hour', label: 'Capacity / hour', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', options: ['running', 'idle', 'maintenance'] },
      { key: 'is_default', label: 'Default for this station', type: 'select', options: [1, 0], bool: true,
        hint: 'Cutting and Printing start jobs on this machine automatically — one default per category' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['code', 'name', 'model', 'type', 'is_default', 'operators', 'capacity_per_hour', 'status', 'active'],
  },
  // Boards — the plant's ONE raw-material master.
  //
  // There is deliberately no separate "Materials" tab. Materials and Boards were
  // never two things: both read and wrote the same `materials` table, and every
  // row in it is a board (303/303 in production). The generic tab showed those
  // same rows through weaker columns — category (always 'board'), unit (always
  // 'sheets'), std_rate (set on no row) — so it carried nothing this tab does
  // not carry better, while a second door onto one table meant a board could be
  // created with no grade/GSM/size, which are exactly what price and weigh it.
  //
  // Grade / GSM / size are structured fields; the name and code are composed
  // from them (boardCode.js) so they can never drift apart, and kg/sheet +
  // ₹/sheet preview live from the grade's ₹/kg.
  boards: {
    label: 'Boards', endpoint: '/materials', activeToggle: true, history: 'materials',
    rowFilter: r => r.category === 'board' && !r.leftover,
    defaults: { category: 'board', unit: 'sheets', gst_rate: 18, reorder_level: 0, min_stock: 0, max_stock: 0, active: 1 },
    fields: [
      { key: 'grade', label: 'Grade', type: 'graderef', required: true, hint: 'Drives the ₹/kg this board is bought at — managed in Board Rates' },
      { key: 'gsm', label: 'GSM', type: 'number', required: true },
      { key: 'sheet_l', label: 'Parent Sheet Length (in)', type: 'number', newRow: true, required: true },
      { key: 'sheet_w', label: 'Parent Sheet Width (in)', type: 'number', required: true },
      { key: 'sheets_per_packet', label: 'Sheets / Packet', type: 'number', newRow: true, hint: 'Auto-filled from the grade — Duplex 144, FBB/Saffire 100' },
      { key: 'hsn_code', label: 'HSN Code' },
      { key: 'gst_rate', label: 'GST %', type: 'number', newRow: true, hint: 'Plant default 18 for board' },
      { key: 'reorder_level', label: 'Reorder Level', type: 'number', hint: 'Trigger point — below this the board reads SHORT' },
      { key: 'min_stock', label: 'Minimum Stock', type: 'number', newRow: true, hint: 'Leave 0 if not set — the warehouse shows “—”' },
      { key: 'max_stock', label: 'Maximum Stock', type: 'number', hint: 'Caps what a replenishment PR suggests. 0 = no cap' },
      // Composed, not typed. `compute` also runs on save, so the row stored is
      // exactly the row previewed here.
      { key: 'name', label: 'Board Name', type: 'derived', newRow: true, compute: b => boardName(b) },
      { key: 'spec', label: 'Code', type: 'derived', compute: (b, ctx) => boardCode(b, ctx.takenCodes) },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], newRow: true },
    ],
    // `last_rate` is the one field the old Materials tab held that this master
    // did not: what the last PO actually paid. It is shown, never edited — the
    // buyer's ₹/kg is the controlled price and lives in Board Rates, while this
    // is the reference figure procurement writes back on each PO. Read-only here
    // means it can't drift into being a second, competing price.
    columns: ['name', 'grade', 'gsm', 'sheet_size', 'sheets_per_packet', 'kg_per_sheet', 'packet_kg', 'rate_per_kg', 'rate_per_sheet', 'last_rate', 'active'],
    // The name is the plant's identity for a board and is matched on by name
    // elsewhere (products, PO import), so two boards may not share one. Caught
    // here with the composed name rather than left to a confusing server error.
    validate: (body, { rows, editing, loaded }) => {
      if (!body.name) return 'Grade, GSM and both parent sheet sizes are needed before this board can be saved.';
      // Fail closed: an empty/failed load must not read as "no clashes" — with no
      // UNIQUE constraint on materials.name/spec, that would let a duplicate through.
      if (!loaded) return 'Board master not loaded — reload before adding a board.';
      const key = body.name.trim().toLowerCase();
      const clash = rows.find(r => r.category === 'board'
        && String(r.id) !== String(editing.id ?? '')
        && String(r.name ?? '').trim().toLowerCase() === key);
      return clash ? `“${body.name}” already exists in the board master — edit that board instead of creating a second one.` : null;
    },
  },
  // Board Rates — the category rate master. One base ₹/kg per grade drives every
  // board in that grade; add a vendor row only where a mill quotes differently.
  // Changing one number here reprices its whole board list.
  board_rates: {
    label: 'Board Rates', endpoint: '/board-rates', activeToggle: true,
    defaults: { active: 1 },
    fields: [
      { key: 'grade', label: 'Grade', type: 'graderef', required: true, createOnly: true },
      { key: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', createOnly: true,
        hint: 'Leave blank for the base rate that applies to every vendor' },
      { key: 'rate_per_kg', label: 'Rate ₹ / kg', type: 'number', required: true, newRow: true,
        hint: 'Exclusive of GST' },
      { key: 'effective_from', label: 'Effective From', type: 'date' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], newRow: true },
    ],
    columns: ['grade', 'vendor_name', 'rate_per_kg', 'board_count', 'effective_from', 'active'],
  },
  employees: {
    label: 'Employees', endpoint: '/employees',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'role', label: 'Role', type: 'select', options: ['operator', 'supervisor', 'qc_inspector', 'helper'], required: true },
      { key: 'section', label: 'Section', type: 'sectionref', hint: 'Mapped from the Sections master — add or edit sections in the Sections tab' },
      { key: 'phone', label: 'Phone' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'role', 'section', 'phone', 'active'],
  },
  sections: {
    label: 'Sections', endpoint: '/sections', activeToggle: true,
    fields: [
      { key: 'name', label: 'Section Name', required: true, hint: 'Display name shown across the plant, e.g. Die Cutting' },
      { key: 'code', label: 'Code', hint: 'Optional — auto-generated from the name (e.g. Die Cutting → die_cutting) if left blank. Keep stable once in use.' },
      { key: 'sort_order', label: 'Sort Order', type: 'number', hint: 'Optional — auto-assigned to the end of the list if left blank. Lower numbers list first.' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'code', 'sort_order', 'active'],
  },
  vendors: {
    label: 'Vendors', endpoint: '/vendors',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'gstin', label: 'GSTIN', hint: '15-char GST number — prints on the PO' },
      { key: 'address', label: 'Address', newRow: true },
      { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'state_code', label: 'State Code', hint: 'GST state code, e.g. 03 = Punjab — decides CGST/SGST vs IGST' },
      { key: 'contact', label: 'Contact', newRow: true }, { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' }, { key: 'categories', label: 'Supplies (categories)' },
    ],
    columns: ['name', 'gstin', 'city', 'state', 'contact', 'phone', 'categories'],
  },
  users: {
    label: 'Users', endpoint: '/users', adminOnly: true, moduleAccess: true,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
      { key: 'password', label: 'Password', type: 'password', hint: 'Leave blank to keep unchanged' },
      { key: 'role', label: 'Role', type: 'select', options: ['admin', 'planner', 'production', 'qc', 'dispatch', 'viewer'], required: true },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'email', 'role', 'modules', 'active'],
  },
};

// Per-column cell styling for the Products table — wide, wrapping text columns
// get room and a left-clean flow; short codes/numbers stay on one line.
const PRODUCT_CELL_CLASS = {
  name: 'min-w-[160px] max-w-[220px] whitespace-normal break-words font-medium text-slate-800',
  code: 'max-w-[110px] truncate font-mono text-xs text-slate-500',
  customer_name: 'whitespace-nowrap font-semibold tracking-wide text-slate-500',
  board_name: 'min-w-[120px] max-w-[150px] whitespace-normal break-words text-slate-600',
  sheets: 'whitespace-nowrap',
  ups: 'whitespace-nowrap tabular-nums text-slate-600',
  printing: 'min-w-[150px] max-w-[190px] whitespace-normal',
  coating: 'min-w-[110px] whitespace-normal break-words',
  die_number: 'whitespace-nowrap tabular-nums text-slate-600',
  shade_card: 'whitespace-nowrap',
  product_type: 'whitespace-nowrap capitalize',
  rate: 'whitespace-nowrap tabular-nums font-semibold text-slate-800',
};

// Figures a master computes for display rather than stores, so there is no
// `type: 'number'` field to read the alignment off — the board weights, the
// derived ₹/sheet, the last purchased rate, the board count behind a rate.
// rate_per_kg is a real field on the Board Rates master but only a derived
// lookup on the Boards master, so it has to be named here to line up on both.
const DERIVED_NUMERIC_COLS = new Set([
  'kg_per_sheet', 'packet_kg', 'rate_per_kg', 'rate_per_sheet', 'last_rate', 'board_count',
]);

// Short header labels for the Products table — keep column widths tight so the
// table fits without horizontal scroll.
const PRODUCT_COL_LABELS = {
  customer_name: 'Customer', board_name: 'Board', sheets: 'Child / Parent',
  ups: 'Ups', printing: 'Printing', die_number: 'Die', shade_card: 'Shade Card', product_type: 'Type', rate: 'Rate ₹',
};

// Header overrides for the Boards table. Columns with no matching form field
// fall back to fmt.title(key), which would put a bare "Last Rate" beside "Rate
// Per Kg" and "Rate Per Sheet" — three rate columns, one of them ambiguous.
const BOARD_COL_LABELS = { last_rate: 'Last PO Rate' };

// Masters navigation — the twelve masters banded into the four shelves the plant
// actually thinks in, rather than CONFIGS key order. Grouping is declared here
// so adding a config can never silently land it at the end of the nav: a key
// that appears in no group simply isn't reachable, which is loud in review.
const MASTER_GROUPS = [
  { label: 'Business Masters', items: ['customers', 'products', 'vendors'] },
  { label: 'Material & Costing', items: ['boards', 'gst_rates'] },
  { label: 'Production Setup', items: ['machines', 'sections', 'employees'] },
  { label: 'Administration', items: ['users', 'company'] },
];

// Boards is a container, not a single table. The board master and the rate master
// that prices it sit behind ONE nav entry, because a ₹/kg is meaningless except
// as the price of a board, and a board with no rate is the thing you need to see.
// Both keys are ordinary CONFIGS entries and the sub-tabs set `tab` exactly like
// the top nav does — the CRUD engine below is untouched by this grouping.
const BOARD_VIEWS = [
  { key: 'boards', label: 'Boards' },
  { key: 'board_rates', label: 'Board Rates' },
];

export default function Masters() {
  const toast = useToast();
  const isAdmin = auth.user?.role === 'admin';
  // ?tab= makes every master — including the Board Rates sub-module — linkable,
  // so "go set this grade's rate" can be handed over as a URL and survives a
  // reload. An unknown key, or an admin-only master reached by a non-admin,
  // falls back to Customers rather than rendering an empty privileged tab.
  const [tab, setTab] = useState(() => {
    const want = new URLSearchParams(window.location.search).get('tab');
    const ok = want === 'company' || (CONFIGS[want] && (!CONFIGS[want].adminOnly || isAdmin));
    return ok ? want : 'customers';
  });
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false); // did the current tab's rows actually arrive?
  const [loadError, setLoadError] = useState(false); // did the current tab's fetch reject (server unreachable)?
  const [refs, setRefs] = useState({ customers: [], materials: [] });
  const [editing, setEditing] = useState(null); // record or {} for new
  const [deleting, setDeleting] = useState(null);
  const [viewing, setViewing] = useState(null); // {kind, record} for the 360° drawer
  const [company, setCompany] = useState(null); // single-row "our company" profile

  const isCompany = tab === 'company';
  const cfg = CONFIGS[tab];
  // Is this nav key reachable by the signed-in user? Company is the one entry
  // with no CONFIGS row — it's a single-record profile form, not a CRUD table.
  const canSee = k => k === 'company' || (CONFIGS[k] && (!CONFIGS[k].adminOnly || isAdmin));
  const navLabel = k => (k === 'company' ? 'Company' : CONFIGS[k].label);
  // Board Rates lives under the Boards pill, so the top nav stays lit on Boards
  // while the sub-tab moves. Everything else is its own nav entry.
  const boardKeys = BOARD_VIEWS.map(v => v.key);
  const onBoards = boardKeys.includes(tab);
  const navKey = onBoards ? 'boards' : tab;

  // Switch master. Mirrors the key into ?tab= with a replace (not a push) so the
  // back button still leaves Masters rather than walking back through every tab
  // the user browsed.
  const selectTab = (k) => {
    setTab(k);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', k);
    window.history.replaceState({}, '', u);
  };

  // Jump from a board that prices at nothing to the rate that would fix it —
  // opens the Board Rates sub-tab with a new rate already carrying the grade.
  const openRateFor = (grade) => {
    selectTab('board_rates');
    setEditing({ ...(CONFIGS.board_rates.defaults || {}), grade });
  };
  // Clear rows before every (re)load so a slow or failed fetch never leaves the
  // previous tab's data on screen — otherwise switching e.g. Employees → Sections
  // would show employees under Section Name if /sections errors out.
  // `loaded` distinguishes a genuinely empty master from a fetch that failed or
  // is still in flight — the board duplicate guards refuse to run against an
  // unknown set (an empty `rows` would otherwise let a duplicate through).
  const load = () => {
    if (!cfg) return;
    setRows([]); setLoaded(false); setLoadError(false);
    api.get(cfg.endpoint).then(r => {
      setRows(r); setLoaded(true); setLoadError(false);
      // The Boards tab derives every board's ₹/kg from this ref, so keep it in
      // sync whenever the rate master is (re)loaded here — edit a rate, hop to
      // Boards, and the whole grade reprices with no page reload and no migration.
      if (cfg.endpoint === '/board-rates') setRefs(rf => ({ ...rf, board_rates: r }));
    }).catch(() => { setRows([]); setLoaded(false); setLoadError(true); });
  };
  useEffect(() => {
    load();
    if (isCompany) api.get('/company-profile').then(c => setCompany(c || {})).catch(() => setCompany({}));
  }, [tab]);

  const saveCompany = async () => {
    try { await api.put('/company-profile', company); toast.success('Company profile saved'); }
    catch (e) { toast.error(e.message || 'Could not save company profile'); }
  };
  const COMPANY_FIELDS = [
    ['name', 'Company Name'], ['gstin', 'GSTIN'], ['address', 'Address'], ['city', 'City'],
    ['state', 'State'], ['state_code', 'State Code (e.g. 03)'], ['phone', 'Phone'], ['email', 'Email'],
  ];
  useEffect(() => {
    api.get('/customers').then(c => setRefs(r => ({ ...r, customers: c })));
    api.get('/materials').then(m => setRefs(r => ({ ...r, materials: m })));
    api.get('/tools?family=die').then(d => setRefs(r => ({ ...r, dies: d })));
    api.get('/gst_rates').then(g => setRefs(r => ({ ...r, gst_rates: g })));
    api.get('/employees').then(e => setRefs(r => ({ ...r, employees: e })));
    api.get('/sections').then(s => setRefs(r => ({ ...r, sections: s })));
    api.get('/machines').then(m => setRefs(r => ({ ...r, machines: m })));
    api.get('/vendors').then(v => setRefs(r => ({ ...r, vendors: v })));
    // Boards tab: the grade picker and the live ₹/kg → ₹/sheet preview.
    api.get('/board-grades').then(g => setRefs(r => ({ ...r, board_grades: g })));
    api.get('/board-rates').then(b => setRefs(r => ({ ...r, board_rates: b })));
  }, []);

  // Codes already issued — excludes the row being edited and every leftover
  // offcut (which inherits its parent's spec), so an edit never re-suffixes an
  // existing board's code. Sourced from the loaded rows (the whole /materials
  // master on the Boards tab). See takenCodesFor in boardCode.js.
  const takenCodes = useMemo(
    () => takenCodesFor(rows, editing?.id ?? null),
    [rows, editing?.id]);
  // Everything a `derived` field may need to compute itself.
  const derivedCtx = { refs, takenCodes };

  // Grades sitting in the board master with no live rate behind them. Those
  // boards price at nothing — blank ₹/kg, blank ₹/sheet — everywhere they are
  // used, and nothing else in the app says so out loud. Counted off the full
  // material ref rather than `rows`, which on this tab is the rate list, not
  // the boards. Blank grade is kept as its own bucket: it can't be priced at
  // all until someone gives that board a grade.
  const unpricedGrades = useMemo(() => {
    if (tab !== 'board_rates') return [];
    const counts = new Map();
    for (const m of refs.materials || []) {
      if (m.category !== 'board' || m.leftover) continue;
      const g = String(m.grade ?? '').trim();
      if (resolveRatePerKg(refs.board_rates || [], g, null)) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([grade, count]) => ({ grade, count }))
      .sort((a, b) => b.count - a.count);
  }, [tab, refs.materials, refs.board_rates]);

  const columns = useMemo(() => cfg ? [
    ...cfg.columns.map(k => {
      const f = cfg.fields.find(x => x.key === k);
      return {
        key: k,
        label: (cfg.endpoint === '/products' && PRODUCT_COL_LABELS[k])
          || (tab === 'boards' && BOARD_COL_LABELS[k]) || f?.label || fmt.title(k),
        cellClass: cfg.endpoint === '/products' ? PRODUCT_CELL_CLASS[k] : undefined,
        // Quantities line up on their last digit or a column of them cannot be
        // compared by eye — the Boards master alone is seven columns of weights
        // and rupees. A column counts as a quantity when the master declares its
        // field a number, or when it is one of the derived figures that has no
        // field behind it at all. Identifiers that happen to be digits (a die
        // number, a code) are NOT quantities and stay left.
        align: (f?.type === 'number' || DERIVED_NUMERIC_COLS.has(k)) ? 'right' : undefined,
        // Employees sort by department, in the plant's section order (from the
        // Sections master), then alphabetically by name — so people in the same
        // department sit together instead of being scattered alphabetically.
        sortValue: k === 'section'
          ? (r => {
              const sec = (refs.sections || []).find(s => s.code === r.section);
              const ord = sec?.sort_order ?? 9999;
              return String(ord).padStart(5, '0') + '|' + String(r.name || '').toLowerCase();
            })
          // Shade Card sorts by date (oldest card first = highest age on top).
          : k === 'shade_card' ? (r => r.shade_card_date || '9999-99-99')
          : undefined,
        // Plain text of what the cell shows, so search matches the visible/derived
        // form (spaced + unspaced sizes, ₹rate, gst%, customer abbreviation) — not
        // just the raw stored value.
        searchValue: r => {
          // Boards — the four derived money/weight columns are computed, never
          // stored, so search has to be handed the text the cell actually shows
          // ("0.1603", "16.026 kg", "₹81", "₹12.98") or they'd be unsearchable.
          if (tab === 'boards') {
            const rk = resolveRatePerKg(refs.board_rates || [], r.grade, null);
            if (k === 'kg_per_sheet') { const v0 = kgPerSheet(r); return v0 != null ? v0.toFixed(4) : ''; }
            if (k === 'packet_kg') { const v0 = packetWeight(r); return v0 != null ? `${v0.toFixed(3)} kg` : ''; }
            // Unpriced boards are searchable by what the cell says AND by
            // "unpriced", so the whole no-rate set can be pulled in one search.
            if (k === 'rate_per_kg') return rk ? `₹${rk.rate_per_kg} ${rk.rate_per_kg}`
              : (r.grade ? 'No rate — set no rate unpriced' : 'No grade unpriced');
            if (k === 'rate_per_sheet') {
              const v0 = rk ? ratePerSheet(r, rk.rate_per_kg) : null;
              return v0 != null ? `₹${v0.toFixed(2)} ${v0.toFixed(2)}` : '';
            }
            if (k === 'sheet_size') return r.sheet_l != null && r.sheet_w != null ? `${r.sheet_l}×${r.sheet_w}" ${r.sheet_l} x ${r.sheet_w}` : '';
            if (k === 'last_rate') return r.last_rate != null ? `₹${(+r.last_rate).toFixed(2)} ${r.last_rate}` : '';
          }
          // Board Rates — vendor_name shows a muted "Base — all vendors" on base
          // rows; rate/count are formatted (₹81/kg, "104 boards"). Hand search
          // the visible text so those formatted cells stay findable.
          if (tab === 'board_rates') {
            if (k === 'vendor_name') return r.vendor_id ? (r.vendor_name || '') : 'Base — all vendors base all vendors';
            if (k === 'rate_per_kg') return r.rate_per_kg != null ? `₹${r.rate_per_kg}/kg ${r.rate_per_kg}` : '';
            if (k === 'board_count') return `${r.board_count ?? 0} boards`;
          }
          if (cfg.endpoint === '/products') {
            if (k === 'sheets') {
              const c = r.child_l != null && r.child_w != null ? `${r.child_l}×${r.child_w}" ${r.child_l} × ${r.child_w}` : '';
              const p = r.parent_l != null && r.parent_w != null ? `${r.parent_l}×${r.parent_w}" ${r.parent_l} × ${r.parent_w}` : '';
              return `${c} ${p}`.trim();
            }
            if (k === 'rate') return r.rate != null ? `₹${r.rate}` : '';
            if (k === 'shade_card') return [r.shade_card_number, r.shade_card_date].filter(Boolean).join(' ');
            // "pantone", "871", "gold" and "6 colours" all have to find the product.
            if (k === 'printing') return colourSearchText(r);
            if (k === 'gst_pct') { const eff = r.effective_gst ?? r.gst_pct; return eff != null ? `${eff}%` : ''; }
            // The cell shows initials, so both forms have to be searchable —
            // same rule the Planning queue uses. See lib/customerCode.js.
            if (k === 'customer_name' && r.customer_name) return customerSearchText(r.customer_name);
          }
          return '';
        },
        render: r => {
          const v = r[k];
          if (k === 'sheet_size') return r.sheet_l ? <span className="font-mono text-xs">{r.sheet_l}×{r.sheet_w}"</span> : (v ? <span className="font-mono text-xs">{v}</span> : <span className="text-gray-300">—</span>);
          // Boards — weight and money, recomputed from the row's own GSM/size and
          // the grade's live ₹/kg. Nothing here is stored: change a rate in Board
          // Rates and every board in that grade reprices on the next load. A board
          // with no size or no rate shows —, never a confident 0.
          if (tab === 'boards' && k === 'kg_per_sheet') { const kg = kgPerSheet(r); return kg != null ? <span className="tabular-nums text-slate-700">{kg.toFixed(4)}</span> : <span className="text-gray-300">—</span>; }
          if (tab === 'boards' && k === 'packet_kg') { const pw = packetWeight(r); return pw != null ? <span className="tabular-nums text-slate-700">{pw.toFixed(3)} kg</span> : <span className="text-gray-300">—</span>; }
          // Boards tab: ₹/kg is DERIVED from the grade's live rate (a board stores
          // no rate). The Board Rates tab has its own rate_per_kg branch below that
          // reads the row's stored value — so this must stay scoped to boards.
          if (tab === 'boards' && k === 'rate_per_kg') {
            const rk = resolveRatePerKg(refs.board_rates || [], r.grade, null);
            if (rk) return <span className="tabular-nums font-semibold text-slate-800">₹{rk.rate_per_kg}</span>;
            // No rate behind this grade: the board weighs something but costs
            // nothing, and a dash reads as "not applicable" rather than "unpriced".
            // Say it, and make the fix one click into the rate sub-module. A board
            // with no grade can't be priced at all — that's a different repair, so
            // it says so instead of offering a rate form it can't fill.
            if (!r.grade) return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">No grade</span>;
            return <button type="button" title={`No ₹/kg for ${r.grade} — click to set it`}
              onClick={e => { e.stopPropagation(); openRateFor(r.grade); }}
              className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700 transition-colors hover:bg-amber-100">
              No rate — set
            </button>;
          }
          if (tab === 'boards' && k === 'rate_per_sheet') {
            const rk = resolveRatePerKg(refs.board_rates || [], r.grade, null);
            const rs = rk ? ratePerSheet(r, rk.rate_per_kg) : null;
            return rs != null ? <span className="tabular-nums font-semibold text-violet-700">₹{rs.toFixed(2)}</span> : <span className="text-gray-300">—</span>;
          }
          // What the last PO actually paid per sheet. Muted, because it is history,
          // not the controlled price — ₹/sheet above is what the next PO will use.
          // Never bought = dash, which is the truth for most of the master.
          if (tab === 'boards' && k === 'last_rate')
            return v != null && v !== '' ? <span className="tabular-nums text-slate-400">₹{(+v).toFixed(2)}</span> : <span className="text-gray-300">—</span>;
          if (tab === 'boards' && k === 'grade') return v ? <span className="inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">{v}</span> : <span className="text-gray-300">—</span>;
          if (tab === 'boards' && (k === 'gsm' || k === 'sheets_per_packet')) return v != null && v !== '' ? <span className="tabular-nums text-slate-700">{v}</span> : <span className="text-gray-300">—</span>;
          // Board Rates — the rate master's own columns.
          if (tab === 'board_rates' && k === 'grade') return v ? <span className="inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">{v}</span> : <span className="text-gray-300">—</span>;
          if (tab === 'board_rates' && k === 'vendor_name') return r.vendor_id ? <span className="font-medium text-slate-700">{v}</span> : <span className="text-xs italic text-slate-400">Base — all vendors</span>;
          if (tab === 'board_rates' && k === 'rate_per_kg') return v != null ? <span className="tabular-nums font-bold text-slate-900">₹{v}/kg</span> : <span className="text-gray-300">—</span>;
          if (tab === 'board_rates' && k === 'board_count') return <span className="tabular-nums text-slate-600">{v ?? 0} boards</span>;
          if (tab === 'board_rates' && k === 'effective_from') return v ? <span className="tabular-nums text-slate-600">{String(v).slice(0, 10)}</span> : <span className="text-gray-300">—</span>;
          if (k === 'condition') return <span className={`text-xs font-semibold ${v === 'Good' ? 'text-emerald-600' : v === 'Fair' ? 'text-amber-600' : 'text-red-600'}`}>{v}</span>;
          if (k === 'product_count') return v ? `${v} product${v > 1 ? 's' : ''}` : <span className="text-gray-300">—</span>;
          if (k === 'tolerance_pct') return v ? <span className="font-semibold tabular-nums text-slate-700">±{v}%</span> : <span className="text-gray-300">—</span>;
          if (k === 'operators') {
            const ops = r.operators || [];
            return ops.length
              ? <div className="flex max-w-[260px] flex-wrap gap-1">{ops.map(o0 => (
                  <span key={o0.id} className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">{o0.name}</span>))}</div>
              : <span className="text-xs text-amber-600">No operators assigned</span>;
          }
          if (k === 'modules') {
            if (r.role === 'admin') return <span className="text-xs font-semibold text-slate-500">All (admin)</span>;
            if (r.modules == null) return <span className="text-xs font-semibold text-emerald-600">All modules</span>;
            return <span className="text-xs font-semibold text-brand-700">{r.modules.length} of {MODULES.length} modules</span>;
          }
          if (k === 'customer_name' && cfg.endpoint === '/products') {
            if (!v) return <span className="text-gray-300">—</span>;
            // Initials (Swiss Garnier Life Sciences → SGLS), full name on hover.
            return <span title={v} className="cursor-default">{customerInitials(v)}</span>;
          }
          if (k === 'die_number' && cfg.endpoint === '/products') return v || <span className="text-gray-300">—</span>;
          if (k === 'shade_card' && cfg.endpoint === '/products') {
            // Row-level shade card: the number with its live age chip below —
            // green (fresh) · amber (renew soon) · red (past the 1-year life).
            if (!r.shade_card_number && !r.shade_card_date) return <span className="text-gray-300">—</span>;
            // Read-only, and now a way in: /shade-cards?q= opens the card itself
            // rather than dropping you on a 600-row register to retype a number
            // you just clicked. stopPropagation so it doesn't also open the
            // product's own edit drawer underneath.
            return <span className="block leading-tight">
              {r.shade_card_number
                ? <a href={`/shade-cards?q=${encodeURIComponent(r.shade_card_number)}`}
                     className="font-mono text-xs font-semibold text-brand-600 hover:underline"
                     onClick={e => e.stopPropagation()}>{r.shade_card_number}</a>
                : <span className="font-mono text-xs text-slate-700">—</span>}
              {r.shade_card_date && <span className="mt-0.5 block"><ShadeAge date={r.shade_card_date} /></span>}
            </span>;
          }
          if (k === 'name' && cfg.endpoint === '/products' && r.spec_incomplete)
            return <span className="inline-flex items-center gap-2">{v}
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Spec incomplete</span></span>;
          // Boards: the short code sits under the name, so the code an operator is
          // handed on the floor ("2037DPGB230") can be read straight off the list.
          // Same tight two-line stack the Products tab already uses for Sheets and
          // Shade Card, so the row grows by one 11px line and the column width is
          // untouched. No code = no second line, not a blank one.
          if (k === 'name' && tab === 'boards') {
            const code = String(r.spec ?? '').trim();
            return <span className="block leading-tight">
              <span className="block">{v}</span>
              {code && <span className="mt-0.5 block font-mono text-[11px] text-slate-400">{code}</span>}
            </span>;
          }
          if (k === 'board_name' && cfg.endpoint === '/products') {
            // Explicit board name from the plant master (grade + gsm + parent size).
            // Blank in the master stays blank here.
            const bn = String(v ?? '').trim();
            return bn
              ? <span className="font-medium text-slate-700">{bn}</span>
              : <span className="text-gray-300">—</span>;
          }
          if (k === 'sheets' && cfg.endpoint === '/products') {
            const child = r.child_l != null && r.child_w != null ? `${r.child_l}×${r.child_w}"` : null;
            const parent = r.parent_l != null && r.parent_w != null ? `${r.parent_l}×${r.parent_w}"` : null;
            if (!child && !parent) return <span className="text-gray-300">—</span>;
            return <span className="block leading-tight">
              <span className="font-mono text-xs text-slate-700">{child || '—'}</span>
              {parent && <span className="mt-0.5 block font-mono text-[11px] text-slate-400">{parent}</span>}
            </span>;
          }
          if (k === 'ups' && cfg.endpoint === '/products') return r.ups != null ? <span className="tabular-nums">{r.ups}</span> : <span className="text-gray-300">—</span>;
          // Printing — a derived column with no field behind it. The badges are
          // the same ones Planning, Artwork, the Job Card and the press board
          // wear, so a product reads identically in the master and on the floor.
          if (k === 'printing' && cfg.endpoint === '/products') {
            if (!colourTypeOf(r) && !r.print_process) return <span className="text-gray-300">—</span>;
            return <span className="block leading-tight">
              <PrintColourChips row={r} compact />
              <span className="mt-0.5 block truncate text-[11px] text-slate-400" title={colourSummary(r)}>{colourSummary(r)}</span>
            </span>;
          }
          if (k === 'coating' && cfg.endpoint === '/products') {
            const c = String(v ?? '').trim();
            if (!c || c.toLowerCase() === 'none') return <span className="text-gray-300">—</span>;
            return <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{c}</span>;
          }
          // Machine category — use the stage formatter so acronyms read right (CTP, QC).
          if (k === 'type' && cfg.endpoint === '/machines')
            return <span className="text-xs text-gray-600">{fmt.stage(v)}</span>;
          // Section — Title Case with underscores spaced (die_cutting → Die Cutting).
          if (k === 'section')
            return v ? <span className="text-xs capitalize text-gray-600">{String(v).replace(/_/g, ' ')}</span> : <span className="text-gray-300">—</span>;
          if (k === 'status' || k === 'segment' || k === 'category' || k === 'coating' || k === 'type' || k === 'role')
            return <span className="text-xs capitalize text-gray-600">{String(v ?? '').replace(/_/g, ' ')}</span>;
          if (k === 'is_default') return v
            ? <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-bold text-brand-700">Default</span>
            : <span className="text-gray-300">—</span>;
          if (k === 'active') return v ? <span className="text-xs font-semibold text-emerald-600">Active</span> : <span className="text-xs text-gray-400">Inactive</span>;
          if (k === 'rate') return cfg.endpoint === '/gst_rates' ? `${v}%` : `₹${v}`;
          if (k === 'std_rate' || k === 'last_rate') return v != null && v !== '' ? <span className="font-semibold tabular-nums text-slate-800">₹{v}</span> : <span className="text-gray-300">—</span>;
          if (k === 'gst_rate') return v != null && v !== '' ? <span className="tabular-nums text-slate-700">{v}%</span> : <span className="text-gray-300">—</span>;
          if (k === 'gst_pct') {
            const eff = r.effective_gst ?? v;
            if (eff == null) return <span className="text-gray-300">—</span>;
            return <span title={v != null ? 'Manual override' : 'From product type'}>{eff}%{v == null && r.product_type ? <span className="ml-1 text-[10px] text-gray-400">auto</span> : null}</span>;
          }
          if (k === 'product_type') return v ? <span className="text-xs capitalize text-gray-600">{String(v).replace(/_/g, ' ')}</span> : <span className="text-gray-300">—</span>;
          return v ?? '—';
        },
      };
    }),
    { key: '_act', label: '', render: r => (
      <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
        {cfg.history && (
          <button className="rounded p-1.5 text-gray-400 hover:bg-[#E1EFFF] hover:text-[#0064D2]"
            title="History — ledger, invoices, COA, audit"
            onClick={() => setViewing({ kind: cfg.history, record: r })}><History size={14} /></button>
        )}
        {cfg.activeToggle && (
          <button
            className={`rounded p-1.5 ${r.active
              ? 'text-emerald-500 hover:bg-amber-50 hover:text-amber-600'
              : 'text-gray-300 hover:bg-emerald-50 hover:text-emerald-600'}`}
            title={r.active ? 'Deactivate' : 'Activate'}
            onClick={() => toggleActive(r)}><Power size={14} /></button>
        )}
        <button className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" onClick={() => setEditing(r)}><Pencil size={14} /></button>
        {!cfg.noDelete && (
          <button className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600" onClick={() => setDeleting(r)}><Trash2 size={14} /></button>
        )}
      </div>) },
  ] : [], [tab, cfg, refs.sections, refs.board_rates]);

  const save = async () => {
    const body = {};
    // Carry config defaults that aren't editable fields — e.g. the Board Rates
    // tab fixes category=board / unit=sheets, which have no form field of their own.
    if (!editing.id && cfg.defaults)
      for (const [k, v] of Object.entries(cfg.defaults)) if (!cfg.fields.some(f => f.key === k)) body[k] = v;
    for (const f of cfg.fields) {
      if (editing.id && f.createOnly) continue;               // e.g. email
      // A derived field is read-only on the form and never lives in `editing`,
      // but it IS a real column. On an EXISTING record keep the stored value
      // verbatim — the name/code are identifiers (they print on POs, feed
      // smartmatch), so an ordinary edit (reorder level, GST) must never
      // recompose and risk re-suffixing them. Only compose when creating, or
      // when the stored value is blank (backfill). Renaming a board is a
      // deliberate act done by deleting + recreating, not a silent side effect.
      if (f.type === 'derived') {
        body[f.key] = (editing.id && editing[f.key]) ? editing[f.key] : (f.compute(editing, derivedCtx) ?? null);
        continue;
      }
      let v = editing[f.key];
      if (f.type === 'password' && !v) continue;              // blank = unchanged
      if (f.type === 'number' || f.type === 'ref') v = v === '' || v == null ? null : +v;
      if (f.key === 'active' && (v == null || v === '')) v = 1;        // default: active
      if (f.key === 'tolerance_pct' && v == null) v = 0;               // blank = no tolerance
      if (f.key === 'spec_incomplete' && (v == null || v === '')) v = 0; // blank = spec complete
      if ((f.key === 'emboss' || f.key === 'leafing') && (v == null || v === '')) v = 0; // blank = No
      if (f.key === 'leafing_colour' && String(editing.leafing ?? '') !== '1') v = null; // colour only when leafing = Yes
      body[f.key] = v;
    }
    // Special finish is no longer entered directly — derive it from the
    // Emboss/Leafing toggles (leafing = foil stamping). Downstream stage
    // generation (foiling/embossing) and the tooling gate still read
    // products.special, so keep it in sync here.
    if (cfg.endpoint === '/products') {
      const emb = +editing.emboss ? 1 : 0, leaf = +editing.leafing ? 1 : 0;
      body.special = emb && leaf ? 'foil_emboss' : emb ? 'emboss' : leaf ? 'foil' : 'none';
    }
    // Access scope travels with the user save — null on any dimension means
    // "everything" (all modules / all stations / all presses).
    if (cfg.moduleAccess) {
      body.modules = Array.isArray(editing.modules) ? editing.modules : null;
      body.sections = Array.isArray(editing.sections) ? editing.sections : null;
      body.machine_ids = Array.isArray(editing.machine_ids) ? editing.machine_ids : null;
      body.landing_path = editing.landing_path || null;
      // Approval grants ride with the same save (0/1, like active).
      body.xs_approver = +editing.xs_approver ? 1 : 0;
      body.is_management = +editing.is_management ? 1 : 0;
      body.reverse_approver = +editing.reverse_approver ? 1 : 0;
    }
    // Config-level guard (e.g. a duplicate board name) — surfaced as a plain
    // message here rather than as an opaque server failure after the fact.
    const problem = cfg.validate?.(body, { rows, editing, loaded });
    if (problem) { toast.error(problem); return; }
    const saved = editing.id
      ? await api.put(`${cfg.endpoint}/${editing.id}`, body)
      : await api.post(cfg.endpoint, body);
    // Machine ↔ operator mapping travels with the same save.
    if (cfg.operatorMapping && (saved?.id || editing.id)) {
      await api.put(`/machines/${saved?.id ?? editing.id}/operators`, {
        employee_ids: (editing.operators || []).map(o => o.id),
      });
    }
    toast.success(editing.id ? 'Updated' : 'Created');
    setEditing(null); load();
  };

  const remove = async () => {
    const row = deleting;
    setDeleting(null);
    try {
      await api.del(`${cfg.endpoint}/${row.id}`);
      toast.success('Deleted'); load();
    } catch { /* central handler already surfaced the reason as a toast */ }
  };

  const toggleActive = async (row) => {
    const next = row.active ? 0 : 1;
    await api.put(`${cfg.endpoint}/${row.id}`, { active: next });
    toast.success(next ? 'Activated' : 'Deactivated'); load();
  };

  return (
    <div>
      <PageHeader title="Masters" subtitle="Customers, products and vendors · boards and the rates that price them · machines, sections and people"
        actions={!isCompany && <Button onClick={() => setEditing({ ...(cfg.defaults || {}) })}><Plus size={15} /> New {cfg.label.slice(0, -1)}</Button>} />
      <GroupedTabs active={navKey} onChange={selectTab}
        groups={MASTER_GROUPS.map(g => ({
          label: g.label,
          items: g.items.filter(canSee).map(k => ({ key: k, label: navLabel(k) })),
        }))} />
      {onBoards && <SubTabs className="mb-4" views={BOARD_VIEWS} active={tab} onChange={selectTab} />}

      {!isCompany && loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — the {cfg.label.toLowerCase()} master can’t load. Reload once it reconnects.
        </div>
      )}

      {/* Unpriced grades. The rate master is the only place this is fixable, so
          it is reported here rather than left for whoever eventually notices a
          blank ₹/sheet on a costing. Each grade is a one-click new rate with the
          grade already filled; a board carrying no grade at all can't be priced
          from this side, so it's named but not offered as a rate. */}
      {tab === 'board_rates' && unpricedGrades.length > 0 && (() => {
        const total = unpricedGrades.reduce((n, g) => n + g.count, 0);
        return (
          <div className="mb-3 flex items-start gap-2 rounded-[18px] border border-amber-200 bg-amber-50/70 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <div className="text-sm font-bold text-amber-900">
                {total} board{total === 1 ? '' : 's'} in the master have no ₹/kg behind them
              </div>
              <p className="mt-0.5 text-xs text-amber-800">
                They price at nothing everywhere they're used — blank ₹/kg, blank ₹/sheet. Set a rate:
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unpricedGrades.map(g => (g.grade ? (
                  <button key={g.grade} type="button"
                    onClick={() => setEditing({ ...(CONFIGS.board_rates.defaults || {}), grade: g.grade })}
                    className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-800 transition-colors hover:bg-amber-100">
                    {g.grade} <span className="font-semibold text-amber-600">({g.count})</span>
                  </button>
                ) : (
                  <span key="__nograde" title="These boards have no grade — open the board and set one before it can be priced"
                    className="rounded-full border border-amber-200 bg-amber-100/60 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                    No grade ({g.count}) — fix on the board
                  </span>
                )))}
              </div>
            </div>
          </div>
        );
      })()}

      {isCompany ? (
        <div className="max-w-2xl rounded-[22px] border border-white/70 bg-white/65 p-5 shadow-card backdrop-blur-xl">
          <div className="mb-1 text-sm font-bold text-slate-800">Company Profile (our details)</div>
          <p className="mb-4 text-xs text-slate-500">Prints as the buyer block on every purchase order. The state code decides CGST + SGST (same state as vendor) vs IGST (different state).</p>
          {company && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {COMPANY_FIELDS.map(([k, label]) => (
                <Field key={k} label={label} className={k === 'name' || k === 'address' ? 'sm:col-span-2' : ''}>
                  <Input value={company[k] ?? ''} onChange={e => setCompany({ ...company, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
          )}
          <div className="mt-4 flex justify-end"><Button onClick={saveCompany} disabled={!company?.name}>Save Company Profile</Button></div>
        </div>
      ) : (
      <DataTable key={tab} searchable columns={columns} rows={cfg.rowFilter ? rows.filter(cfg.rowFilter) : rows} empty={`No ${cfg.label.toLowerCase()} yet`}
        dense={tab === 'products'}
        onRowClick={cfg.history ? r => setViewing({ kind: cfg.history, record: r }) : undefined}
        defaultSort={tab === 'employees' ? { key: 'section', dir: 'asc' }
          : tab === 'sections' ? { key: 'sort_order', dir: 'asc' } : undefined}
        exportName={`${cfg.label} Master`}
        exportSubtitle={`Masters · ${cfg.label}`} />
      )}

      {cfg && <Modal open={!!editing} onClose={() => setEditing(null)} wide={tab === 'products' || tab === 'machines' || tab === 'boards'}
        title={`${editing?.id ? 'Edit' : 'New'} ${cfg.label.slice(0, -1)}`}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={save} disabled={cfg.fields.some(f => {
            if (editing?.id && (f.createOnly || f.type === 'password')) return false;
            if (!editing?.id && f.type === 'password' && tab === 'users') return !editing?.[f.key]; // password required on create
            return f.required && !editing?.[f.key] && editing?.[f.key] !== 0;
          })}>Save</Button>
        </>}>
        {editing && (
          <div className={`grid gap-3 ${tab === 'products' || tab === 'boards' ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {/* Soft spec alarm — never a gate. These fields are wanted before
                the job reaches the press, not before the master can exist, so
                the form names what is still open and lets the save through.
                Planning, Artwork and the job card all carry the same fields,
                which is where they usually get filled in. */}
            {tab === 'products' && (() => {
              const pending = PRODUCT_MASTER_SOFT_SPEC.filter(s => {
                const v = editing[s.key];
                return v == null || v === '' || (s.zeroIsBlank && +v === 0);
              });
              if (!pending.length) return null;
              return (
                <div className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-[11px] font-semibold text-amber-800">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span>Still to fill — you can save now and finish these later:</span>
                  {pending.map(s => (
                    <span key={s.key} className="rounded-full bg-white/80 px-2 py-0.5 font-bold text-amber-700">{s.label}</span>
                  ))}
                </div>
              );
            })()}
            {cfg.fields.filter(f => !f.showWhen || f.showWhen(editing)).map(f => (
              <Field key={f.key} label={f.label} required={f.required} hint={editing.id ? f.hint : undefined}
                className={f.newRow ? 'col-start-1' : ''}>
                {f.dependsOn ? (() => {
                  // Enabled only when the field it depends on is set to Yes (1) —
                  // e.g. Leafing Colour unlocks when Leafing = Yes.
                  const off = String(editing[f.dependsOn] ?? '') !== '1';
                  return (
                    <Select value={off ? '' : (editing[f.key] ?? '')} disabled={off}
                      onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                      <option value="">{off ? 'Set Leafing to Yes' : 'Select…'}</option>
                      {f.options.map(o => <option key={o} value={o}>{fmt.title(String(o))}</option>)}
                    </Select>
                  );
                })() : f.type === 'select' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">—</option>
                    {f.options.map(o => <option key={o} value={o}>{
                      typeof o === 'number'
                        ? (f.key === 'active' || f.bool ? (o ? 'Yes' : 'No') : (f.key === 'gst_pct' ? `${o}%` : o))
                        : (f.key === 'condition' || f.key === 'coating' || f.key === 'pasting_type' ? o : fmt.title(String(o)))
                    }</option>)}
                  </Select>
                ) : f.type === 'gstref' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">—</option>
                    {(refs.gst_rates || []).filter(x => x.active).map(x => (
                      <option key={x.id} value={x.product_type} data-search={searchText(x)}>{x.label} — {x.rate}%</option>))}
                  </Select>
                ) : f.type === 'sectionref' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">—</option>
                    {(refs.sections || []).filter(x => x.active).map(x => (
                      <option key={x.id} value={x.code} data-search={searchText(x)}>{x.name}</option>))}
                  </Select>
                ) : f.type === 'ref' ? (
                  <Select value={editing[f.key] ?? ''} disabled={!!editing.id && f.createOnly}
                    onChange={e => {
                      const v = e.target.value;
                      // Picking the customer on a NEW product issues the next
                      // Internal Code in that customer's series. A hand-typed
                      // code survives a customer change — only a blank field or
                      // our own previous suggestion is overwritten (same
                      // blank-check philosophy as the grade → packet-size seed).
                      if (tab === 'products' && f.key === 'customer_id' && !editing.id) {
                        const cust = (refs.customers || []).find(x => String(x.id) === String(v));
                        const cur = editing.code ?? '';
                        if (v && cust && (cur === '' || cur === editing._autoCode)) {
                          const next = nextCodeForRows({ rows, customerId: v, customerName: cust.name });
                          return setEditing({ ...editing, [f.key]: v, code: next, _autoCode: next });
                        }
                      }
                      setEditing({ ...editing, [f.key]: v });
                    }}>
                    <option value="">Select…</option>
                    {(refs[f.ref] || []).filter(f.filter || (() => true))
                      // Hide deactivated refs from new picks, but keep the one
                      // already assigned to this record so editing never blanks it.
                      .filter(x => x.active == null || x.active || String(x.id) === String(editing[f.key]))
                      .map(x => (
                      <option key={x.id} value={x.id} data-search={searchText(x)}>
                        {x.name ?? `${x.code}${x.carton_size ? ` — ${x.carton_size}` : ''}${x.condition && x.condition !== 'Good' ? ` (${x.condition})` : ''}`}
                      </option>))}
                  </Select>
                ) : f.type === 'graderef' ? (
                  // Picking a grade seeds the standard packet size, but only into
                  // a blank field — a buyer who typed an odd mill pack keeps it.
                  // The grade is the row's identity, so it locks on edit (createOnly).
                  <Select value={editing[f.key] ?? ''} disabled={!!editing.id && f.createOnly}
                    onChange={e => {
                    const grade = e.target.value;
                    // Only the Boards tab has a packet size to seed — a Board
                    // Rates row has none, so don't write a stray field there.
                    if (tab === 'boards') {
                      // Blank-check, not truthiness — a deliberately typed 0 must
                      // survive the grade change, not be replaced by the default.
                      const spp = (editing.sheets_per_packet ?? '') !== ''
                        ? editing.sheets_per_packet : (PACKET_BY_GRADE[grade] ?? '');
                      setEditing({ ...editing, grade, sheets_per_packet: spp });
                    } else {
                      setEditing({ ...editing, [f.key]: grade });
                    }
                  }}>
                    <option value="">Select…</option>
                    {(refs.board_grades || []).map(g => <option key={g.grade} value={g.grade} data-search={searchText(g)}>{g.grade}</option>)}
                  </Select>
                ) : f.type === 'derived' ? (
                  // Read-only: composed from the fields above, saved as typed here.
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-700">
                    {f.compute(editing, derivedCtx) ?? <span className="font-sans text-slate-400">—</span>}
                  </div>
                ) : (
                  <div>
                    <Input type={f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text'}
                      value={f.type === 'date' ? String(editing[f.key] ?? '').slice(0, 10) : (editing[f.key] ?? '')}
                      disabled={!!editing.id && f.createOnly} className={f.mono ? 'font-mono' : ''}
                      onChange={e => setEditing({ ...editing, [f.key]: e.target.value })} />
                    {/* Live age readout beside the Shade Card Date — the same
                        1-year lifecycle chip shown on the Products table. */}
                    {f.key === 'shade_card_date' && editing[f.key] && (
                      <div className="mt-1"><ShadeAge date={editing[f.key]} /></div>
                    )}
                  </div>
                )}
              </Field>
            ))}
          </div>
        )}
        {/* Boards — the money the fields above imply, live. Board is bought by
            weight, so the buyer's real question is "what does one sheet cost?";
            this answers it before the row is saved. Nothing here is stored. */}
        {editing && tab === 'boards' && (() => {
          const rk = resolveRatePerKg(refs.board_rates || [], editing.grade, null);
          const k = kgPerSheet(editing), pw = packetWeight(editing);
          const rs = rk ? ratePerSheet(editing, rk.rate_per_kg) : null;
          const cell = (label, val, strong) => (
            <div key={label}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-500">{label}</div>
              <div className={`text-base font-bold tabular-nums ${strong ? 'text-violet-700' : 'text-slate-900'}`}>
                {val ?? <span className="font-sans font-medium text-slate-400">—</span>}
              </div>
            </div>
          );
          return (
            <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-violet-400">Derived — live from grade, GSM and sheet size</div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {cell('kg / Sheet', k != null ? k.toFixed(4) : null)}
                {cell('Packet Weight', pw != null ? `${pw.toFixed(3)} kg` : null)}
                {cell('₹ / kg', rk ? `₹${rk.rate_per_kg}` : null)}
                {cell('₹ / Sheet', rs != null ? `₹${rs.toFixed(2)}` : null, true)}
                {!rk && editing.grade && (
                  <div className="col-span-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 sm:col-span-4">
                    No rate on file for {editing.grade} — set one in Board Rates.
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        {/* Board Rates — the blast radius. One ₹/kg reprices its whole grade, so
            show how many boards it touches and a live ₹/sheet sample as it's typed.
            Nothing here is stored; the boards reprice on their next load. */}
        {editing && tab === 'board_rates' && editing.grade && (() => {
          const boards = (refs.materials || []).filter(m =>
            m.category === 'board' && m.active && !m.leftover && m.grade === editing.grade);
          const rate = +editing.rate_per_kg || 0;
          const sample = boards.slice(0, 3).map(b => ({ name: b.name, rs: ratePerSheet(b, rate) }));
          return (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="text-sm font-semibold text-amber-900">
                This rate prices {boards.length} board{boards.length === 1 ? '' : 's'}
                {editing.vendor_id ? ' for this vendor' : ' across every vendor'}.
              </div>
              <div className="mt-2 space-y-1">
                {sample.map(s => (
                  <div key={s.name} className="flex justify-between text-xs text-amber-900">
                    <span>{s.name}</span>
                    <span className="font-semibold">{s.rs == null ? '—' : `₹${s.rs.toFixed(2)}/sheet`}</span>
                  </div>
                ))}
                {boards.length > 3 && <div className="text-xs text-amber-700">+{boards.length - 3} more</div>}
              </div>
            </div>
          );
        })()}
        {/* Per-user access — modules, Live Floor stations, and (for printing)
            the specific press, plus a preset picker and landing page. Null on
            any dimension = all of it; admins always see everything. */}
        {editing && cfg.moduleAccess && (() => {
          const isAdminUser = editing.role === 'admin';

          // Modules
          const modRestricted = Array.isArray(editing.modules);
          const modChecked = k => !modRestricted || editing.modules.includes(k);
          const toggleMod = k => setEditing(ed => {
            const cur = Array.isArray(ed.modules) ? ed.modules : MODULES.map(m => m.key);
            return { ...ed, modules: cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k] };
          });
          const modCount = modRestricted ? editing.modules.length : MODULES.length;
          const floorOn = isAdminUser || modChecked('floor');

          // Live Floor stations (sub-modules of Live Floor)
          const secRestricted = Array.isArray(editing.sections);
          const secChecked = k => !secRestricted || editing.sections.includes(k);
          const toggleSec = k => setEditing(ed => {
            const cur = Array.isArray(ed.sections) ? ed.sections : FLOOR_SECTIONS.map(s => s.key);
            return { ...ed, sections: cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k] };
          });
          const secCount = secRestricted ? editing.sections.length : FLOOR_SECTIONS.length;
          const printingOn = floorOn && secChecked('printing');

          // Presses — only meaningful when the Printing station is on
          const presses = (refs.machines || []).filter(m => m.type === 'printing' && (m.active == null || m.active));
          const mRestricted = Array.isArray(editing.machine_ids);
          const mChecked = id => !mRestricted || editing.machine_ids.includes(id);
          const toggleMachine = id => setEditing(ed => {
            const cur = Array.isArray(ed.machine_ids) ? ed.machine_ids : presses.map(m => m.id);
            return { ...ed, machine_ids: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] };
          });

          // Landing page — the pages this user can actually open.
          const landingRaw = [
            ...MODULES.filter(m => isAdminUser || modChecked(m.key)).map(m => ({ path: m.path, label: m.label })),
            ...(floorOn ? FLOOR_SECTIONS.filter(s => secChecked(s.key)).map(s => ({ path: s.path, label: `Live Floor · ${s.label}` })) : []),
          ];
          const seenPath = new Set();
          const landingList = landingRaw.filter(o => !seenPath.has(o.path) && seenPath.add(o.path));

          const applyTemplate = key => {
            const t = USER_TEMPLATES.find(x => x.key === key);
            if (!t) return;
            setEditing(ed => ({ ...ed, role: t.role, modules: t.modules, sections: t.sections, machine_ids: t.machine_ids, landing_path: t.landing_path }));
          };

          const panel = 'rounded-2xl border border-slate-200 p-4';
          const chip = on => `flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition-colors ${on ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`;

          return (
            <div className="mt-4 space-y-4">
              {/* Preset + landing page */}
              <div className={panel}>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Access Template</h4>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-slate-500">Apply a preset</span>
                    <Select value="" onChange={e => applyTemplate(e.target.value)}>
                      <option value="">Choose a preset…</option>
                      {USER_TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </Select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-slate-500">Landing page after login</span>
                    <Select value={editing.landing_path ?? ''} onChange={e => setEditing(ed => ({ ...ed, landing_path: e.target.value || null }))}>
                      <option value="">Auto — first allowed page</option>
                      {landingList.map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
                    </Select>
                  </label>
                </div>
              </div>

              {/* Approval grants — per-user, NOT tied to role. xs_approver is the
                  plant head's exclusive right to approve/reject extra sheets;
                  is_management receives and decides Planning's "ask management"
                  requests. Both ring the bell in the app shell. */}
              <div className={panel}>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Approvals &amp; Notifications</h4>
                <div className="mt-2 space-y-1">
                  <label className={chip(+editing.xs_approver === 1)}>
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600"
                      checked={+editing.xs_approver === 1}
                      onChange={e => setEditing(ed => ({ ...ed, xs_approver: e.target.checked ? 1 : 0 }))} />
                    <span>
                      <span className="block font-semibold">Extra-sheet approver (plant head)</span>
                      <span className="block text-[11px] text-slate-400">Only users ticked here can approve or reject CI-XS requests — each new request rings their bell.</span>
                    </span>
                  </label>
                  <label className={chip(+editing.reverse_approver === 1)}>
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600"
                      checked={+editing.reverse_approver === 1}
                      onChange={e => setEditing(ed => ({ ...ed, reverse_approver: e.target.checked ? 1 : 0 }))} />
                    <span>
                      <span className="block font-semibold">Reverse approver (plant head)</span>
                      <span className="block text-[11px] text-slate-400">Needed only when sending a job back would return stock to the warehouse, or take it off the floor to Print Planning. Handing work back one station never needs this.</span>
                    </span>
                  </label>
                  <label className={chip(+editing.is_management === 1)}>
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600"
                      checked={+editing.is_management === 1}
                      onChange={e => setEditing(ed => ({ ...ed, is_management: e.target.checked ? 1 : 0 }))} />
                    <span>
                      <span className="block font-semibold">Management (planning approvals)</span>
                      <span className="block text-[11px] text-slate-400">Receives "Ask Management" requests from Planning and decides them from the bell.</span>
                    </span>
                  </label>
                </div>
              </div>

              {isAdminUser ? (
                <div className={panel}>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Module &amp; Station Access</h4>
                  <p className="mt-1.5 text-xs text-slate-500">Admins always have every module and every Live-Floor station — change the role to restrict access.</p>
                </div>
              ) : (
                <>
                  {/* Modules */}
                  <div className={panel}>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Module Access</h4>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-slate-400">
                          {modRestricted ? `${modCount} of ${MODULES.length} modules open` : 'Full access — all modules'}
                        </span>
                        {modRestricted && (
                          <button type="button" className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-slate-200"
                            onClick={() => setEditing(ed => ({ ...ed, modules: null }))}>
                            Grant all
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                      {MODULES.map(m => (
                        <label key={m.key} className={chip(modChecked(m.key))}>
                          <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                            checked={modChecked(m.key)} onChange={() => toggleMod(m.key)} />
                          <span className="min-w-0 flex-1 truncate font-semibold">{m.label}</span>
                        </label>
                      ))}
                    </div>
                    {modRestricted && modCount === 0 && (
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                        No modules selected — this user won't be able to open anything after signing in.
                      </p>
                    )}
                  </div>

                  {/* Live Floor stations — sub-modules, shown when Live Floor is granted */}
                  {floorOn && (
                    <div className={panel}>
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Live Floor Stations</h4>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-slate-400">
                            {secRestricted ? `${secCount} of ${FLOOR_SECTIONS.length} stations` : 'All stations'}
                          </span>
                          {secRestricted && (
                            <button type="button" className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-slate-200"
                              onClick={() => setEditing(ed => ({ ...ed, sections: null }))}>
                              All stations
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="mb-2 text-[11px] text-slate-500">Dedicate this login to specific stations — they'll only see those queues on the Live Floor.</p>
                      <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {FLOOR_SECTIONS.map(s => (
                          <label key={s.key} className={chip(secChecked(s.key))}>
                            <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                              checked={secChecked(s.key)} onChange={() => toggleSec(s.key)} />
                            <span className="min-w-0 flex-1 truncate font-semibold">{s.label}</span>
                          </label>
                        ))}
                      </div>
                      {secRestricted && secCount === 0 && (
                        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                          No stations selected — this user will see an empty Live Floor.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Press — shown when the Printing station is on */}
                  {printingOn && presses.length > 0 && (
                    <div className={panel}>
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Printing Press</h4>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-slate-400">
                            {mRestricted ? `${editing.machine_ids.length} of ${presses.length} presses` : 'All presses'}
                          </span>
                          {mRestricted && (
                            <button type="button" className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-slate-200"
                              onClick={() => setEditing(ed => ({ ...ed, machine_ids: null }))}>
                              All presses
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="mb-2 text-[11px] text-slate-500">Dedicate this operator to one press — they'll only see that press's printing queue.</p>
                      <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {presses.map(m => (
                          <label key={m.id} className={chip(mChecked(m.id)).replace('items-center', 'items-start')}>
                            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                              checked={mChecked(m.id)} onChange={() => toggleMachine(m.id)} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-semibold">{m.code ? `${m.code} · ` : ''}{m.name}</span>
                              {m.model && <span className="block truncate text-[10px] uppercase tracking-wide text-slate-400">{m.model}</span>}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}
        {editing && cfg.operatorMapping && (() => {
          const selected = new Set((editing.operators || []).map(o => o.id));
          const crew = (refs.employees || []).filter(e => e.active);
          // Employees from this machine's section float to the top of the list.
          const sorted = [...crew].sort((a, b) =>
            (b.section === editing.type) - (a.section === editing.type) || a.name.localeCompare(b.name));
          const toggle = emp => setEditing(ed => {
            const has = (ed.operators || []).some(o => o.id === emp.id);
            return { ...ed, operators: has ? ed.operators.filter(o => o.id !== emp.id) : [...(ed.operators || []), emp] };
          });
          return (
            <div className="mt-4 rounded-2xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Assigned Operators</h4>
                <span className="text-[11px] font-semibold text-slate-400">{selected.size} assigned — production entry shows only these</span>
              </div>
              {crew.length === 0 && <p className="py-2 text-xs text-slate-400">No active employees yet — add them in the Employees tab first.</p>}
              <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                {sorted.map(emp => (
                  <label key={emp.id} className={`flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition-colors ${selected.has(emp.id) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>
                    <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                      checked={selected.has(emp.id)} onChange={() => toggle(emp)} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{emp.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-slate-400">{(emp.section || emp.role || '').replace(/_/g, ' ')}</span>
                  </label>
                ))}
              </div>
              {selected.size === 0 && editing.id && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                  No operators assigned — start-run forms on this machine will show the whole section crew until you assign someone.
                </p>
              )}
            </div>
          );
        })()}
      </Modal>}

      {viewing && (
        <MasterHistory kind={viewing.kind} record={viewing.record} onClose={() => setViewing(null)} />
      )}

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={remove} danger
        title="Delete record?" confirmLabel="Delete"
        message={`Delete "${deleting?.name ?? 'this record'}"? Records in use elsewhere cannot be deleted — mark them inactive instead.`} />
    </div>
  );
}
