// Procurement — PR → PO → GRN → QC. Every arrow is a real record.
// Row-level PR actions (view/edit/approve/convert/close), multi-select PRs
// into ONE purchase order, direct POs without a PR, partial/full GRN in one
// modal, and a pendency dashboard (vendor / category / material / PO-wise).
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth, fmt } from '../api.js';
import { ActionMenu, Button, ConfirmDialog, DataTable, ExportMenu, Field, FulfillmentBar, Input, Modal, PageHeader, searchText, Select, StatusBadge, SubTabs, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { ThreadCell, threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { MaterialQuickCreate } from '../components/QuickCreateMasters.jsx';
import { PrLineEditor, PoLineEditor, PoTotalsPanel, TaxKindToggle } from '../components/ProcurementForms.jsx';
import { GrnLineEditor } from '../components/GrnForms.jsx';
import NewRequisitionModal from '../components/NewRequisitionModal.jsx';
import BoardCommitments from '../components/BoardCommitments.jsx';
import { poTotals, taxKindFor } from '../lib/poTotals.js';
import { ratePerSheet } from '../lib/boardMath.js';
import { Plus, Pencil, CheckCircle2, XCircle, ShoppingBag, PackagePlus, Download, Ban, Eye, Truck, Trash2, Undo2, Package, Printer } from 'lucide-react';

// PO document terms shared by every PO form (convert / bulk / direct / edit).
// Auto-populated downstream from the requisition where possible, always editable.
const PO_META = { vendor_notes: '', payment_terms: '', delivery_terms: '', reference: '' };
const PoMetaFields = ({ value, onChange }) => (
  <section className="ci-form-panel">
    <div className="ci-form-panel-title"><span>Terms &amp; vendor notes</span><span>printed on the PO</span></div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Payment Terms"><Input value={value.payment_terms || ''} placeholder="e.g. 30 days from invoice"
        onChange={e => onChange({ payment_terms: e.target.value })} /></Field>
      <Field label="Delivery Terms"><Input value={value.delivery_terms || ''} placeholder="e.g. FOR Patiala, transporter's risk"
        onChange={e => onChange({ delivery_terms: e.target.value })} /></Field>
      <Field label="Vendor Reference" hint="Quotation / offer number"><Input value={value.reference || ''}
        onChange={e => onChange({ reference: e.target.value })} /></Field>
      <Field label="Vendor Notes"><Input value={value.vendor_notes || ''} placeholder="Special instructions to the vendor"
        onChange={e => onChange({ vendor_notes: e.target.value })} /></Field>
    </div>
  </section>
);

// GRN transaction context shared by the receive forms — receiver defaults to
// the logged-in user; everything stays editable.
const GrnMetaFields = ({ value, onChange }) => (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <Field label="Vehicle No"><Input value={value.vehicle_no || ''} placeholder="e.g. PB-11-AB-1234"
      onChange={e => onChange({ vehicle_no: e.target.value })} /></Field>
    <Field label="Received By"><Input value={value.received_by || ''}
      onChange={e => onChange({ received_by: e.target.value })} /></Field>
    <Field label="Supplier Invoice No"><Input value={value.supplier_invoice_no || ''}
      onChange={e => onChange({ supplier_invoice_no: e.target.value })} /></Field>
    <Field label="Supplier Invoice Date"><Input type="date" value={value.supplier_invoice_date || ''}
      onChange={e => onChange({ supplier_invoice_date: e.target.value })} /></Field>
    <div className="sm:col-span-2">
      <Field label="Remarks"><Input value={value.remarks || ''} placeholder="Condition on arrival, shortages noticed…"
        onChange={e => onChange({ remarks: e.target.value })} /></Field>
    </div>
  </div>
);

const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
const td = 'px-4 py-2.5';

// One batched call paints the thread column for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

// Age of the pending line (days since PO raised), bucketed by the server. Cooler
// buckets stay calm; the older it gets, the hotter the chip — a glance tells the
// buyer which lines have been waiting longest.
const AGE_TONE = { '0-7': 'bg-emerald-50 text-emerald-700', '8-15': 'bg-amber-50 text-amber-700', '16-30': 'bg-orange-100 text-orange-700', '30+': 'bg-red-100 text-red-700' };
const AgeBucket = ({ bucket }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${AGE_TONE[bucket] || 'bg-slate-100 text-slate-500'}`}>{bucket || '—'}</span>
);

function exportCsv(filename, header, rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Procurement() {
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState('prs');
  const [prs, setPrs] = useState([]);
  const [pos, setPos] = useState([]);
  const [grns, setGrns] = useState([]);
  const [pendency, setPendency] = useState(null);
  // Three registers on one page, three separate records to talk about.
  const [prThreads, setPrThreads] = useState({});
  const [poThreads, setPoThreads] = useState({});
  const [grnThreads, setGrnThreads] = useState({});
  const [materials, setMaterials] = useState([]);
  const [stock, setStock] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [company, setCompany] = useState(null);
  // Board ₹/sheet resolved for the vendor of the currently open PO modal, keyed
  // by material_id → { rate: ₹/sheet, source, rate_per_kg }. Refetched from the
  // server whenever a PO modal opens or its vendor changes, so the interactive
  // editor prices boards exactly the way the server's resolvePoRate does.
  const [boardRates, setBoardRates] = useState(new Map());

  // Blank templates for the PO forms. The requisition form lives in
  // NewRequisitionModal, which owns its own blank line and header defaults.
  const blankPoLine = () => ({ material_id: '', qty: '', rate: '', hsn_code: '', unit: '', discount_pct: '', gst_rate: '' });
  const newPoForm = () => ({ vendor_id: '', expected_date: '', tax_kind: 'intra', freight: '', round_off: '',
    lines: [blankPoLine()], ...PO_META });

  // A receipt is a purchase order on the receiving side: one header, many priced
  // lines, one tax split. `qty` is the RECEIVED quantity on both tabs — the
  // ordered figure travels separately as ordered_qty — so poTotals prices a GRN
  // with the same code that prices a PO.
  const blankGrnLine = () => ({ material_id: '', qty: '', rate: '', hsn_code: '',
    unit: '', discount_pct: '', gst_rate: '', batch_no: '' });
  const newGrnForm = () => ({ mode: 'direct', po_id: '', vendor_id: '',
    tax_kind: 'intra', freight: '', round_off: '', lines: [blankGrnLine()],
    vehicle_no: '', supplier_invoice_no: '', supplier_invoice_date: '',
    received_by: auth.user?.name || '', remarks: '' });

  const [newPr, setNewPr] = useState(null);
  const [prModal, setPrModal] = useState(null);       // { pr, edit: bool, form }
  const [closePr, setClosePr] = useState(null);       // { pr, reason }
  const [convertPr, setConvertPr] = useState(null);   // single PR → PO
  const [bulkPo, setBulkPo] = useState(null);         // selected PRs → one PO
  const [directPo, setDirectPo] = useState(null);     // PO without PR
  const [editPo, setEditPo] = useState(null);         // edit an existing PO
  const [confirm, setConfirm] = useState(null);       // { title, message, confirmLabel, danger, onConfirm }
  const [receivePo, setReceivePo] = useState(null);   // single line GRN
  const [grnPo, setGrnPo] = useState(null);           // whole-PO GRN (partial/full)
  const [newGrn, setNewGrn] = useState(null);         // header entry: against-PO or direct (no-PO)
  const [qcGrn, setQcGrn] = useState(null);     // { line, note } | { header, all: true, open, note }
  const [editGrn, setEditGrn] = useState(null); // { id (header), grn_number, lines: [{ id (line), … }], …meta }
  const [selectedIds, setSelectedIds] = useState([]);
  const [quickMat, setQuickMat] = useState(null); // { target: 'po' | 'editpo' | 'convertpo', line: i }
  const [boardPanel, setBoardPanel] = useState(null); // { materialId, pr }
  const [pendencyView, setPendencyView] = useState('lines'); // lines | items | parties
  // Each register splits into "still needs action" vs "done", so pendency is
  // one glance away instead of buried among converted/received/closed rows.
  const [prView, setPrView] = useState('open');      // open (pending+approved) | converted | closed
  const [poView, setPoView] = useState('pending');   // pending (awaiting receipt) | completed
  const [grnView, setGrnView] = useState('pending'); // pending QC | completed

  // Build the requisition payload from the multi-line form.
  const prBody = (f, extra = {}) => ({
    requested_by: f.requested_by || undefined, department: f.department || undefined,
    needed_by: f.needed_by || undefined, priority: f.priority || 'normal',
    reason: f.reason || undefined, remarks: f.remarks || undefined,
    lines: f.lines.filter(l => l.material_id && +l.qty > 0).map(l => ({
      material_id: +l.material_id, qty: +l.qty,
      est_rate: l.est_rate === '' || l.est_rate == null ? undefined : +l.est_rate,
      remarks: l.remarks || undefined,
    })), ...extra,
  });

  // Standard (controlled) rate wins over the drifting last-PO rate for non-board
  // materials. Boards never use this — they resolve to the vendor's ₹/sheet.
  const matRate = mat => (mat?.std_rate != null ? mat.std_rate : mat?.last_rate);

  // Fetch the resolved board ₹/sheet for a vendor and stash the map. Called on
  // every PO-modal open and vendor change so the resolver below is always live.
  const loadBoardRates = async vendorId => {
    try {
      const rows = await api.get(`/board-po-rates${vendorId ? `?vendor_id=${vendorId}` : ''}`);
      const map = new Map(rows.map(r => [String(r.material_id),
        { rate: r.rate_per_sheet, source: r.source, rate_per_kg: r.rate_per_kg }]));
      setBoardRates(map);
      return map;
    } catch { return boardRates; }
  };

  // The injected resolver every PO/PR editor uses. A board (present in the
  // board-rate map, even when unrated) resolves to its ₹/sheet + provenance;
  // anything else falls back to std_rate → last_rate. Mirrors the server's
  // resolvePoRate precedence so screen and server never disagree.
  const resolveWith = map => mat => {
    if (!mat) return null;
    const b = map.get(String(mat.id));
    if (b) return { rate: b.rate, source: b.source, rate_per_kg: b.rate_per_kg };
    if (mat.std_rate != null) return { rate: mat.std_rate, source: 'std', rate_per_kg: null };
    if (mat.last_rate != null) return { rate: mat.last_rate, source: 'last', rate_per_kg: null };
    return { rate: null, source: 'none', rate_per_kg: null };
  };
  const rateFor = resolveWith(boardRates);

  // Attach board provenance (source + ₹/kg) to already-built lines without
  // touching a rate the buyer/PR already carries — used when reopening a PO so
  // the chip and "Overridden" state render correctly on persisted rates.
  const withBoardMeta = (lines, map) => lines.map(l => {
    const b = map.get(String(l.material_id));
    return b ? { ...l, rate_source: b.source, rate_per_kg: b.rate_per_kg } : l;
  });

  // Change a PO modal's vendor: refetch board rates and reprice board lines to
  // the new vendor. The vendor is applied immediately so the picker label tracks
  // the choice; board rates reprice at once when nothing was hand-edited. If any
  // board line was hand-edited (its typed rate no longer matches the resolved
  // master), the reprice waits for confirmation — and on cancel the vendor, tax,
  // rates and lines all snap back to what they were.
  const changePoVendor = async (state, setter, newVendorId) => {
    const prevVendor = state.vendor_id, prevTax = state.tax_kind, prevLines = state.lines, prevRates = boardRates;
    const v = vendorById(newVendorId);
    const taxKind = taxKindFor(company, v);
    const map = await loadBoardRates(newVendorId || null);
    const repriced = lines => lines.map(l => {
      const b = map.get(String(l.material_id));
      if (!b) return l;
      return b.rate != null
        ? { ...l, rate: String(b.rate), rate_source: b.source, rate_per_kg: b.rate_per_kg }
        : { ...l, rate_source: b.source, rate_per_kg: b.rate_per_kg };
    });
    let reprice = 0, manual = 0;
    state.lines.forEach(l => {
      const b = map.get(String(l.material_id));
      if (!b || b.rate == null) return;
      reprice++;
      const mat = materials.find(m => String(m.id) === String(l.material_id));
      const oldMaster = l.rate_per_kg != null ? ratePerSheet(mat, l.rate_per_kg) : null;
      const typed = l.rate !== '' && l.rate != null;
      if (typed && (oldMaster == null || Math.abs(+l.rate - oldMaster) > 0.005)) manual++;
    });
    if (manual > 0 && reprice > 0) {
      // Move the vendor now (keeps the picker in sync) but hold the line rates
      // until the buyer confirms overwriting their manual edits.
      setter(s => ({ ...s, vendor_id: newVendorId, tax_kind: taxKind }));
      setConfirm({
        title: 'Reprice lines for the new vendor?',
        message: `Changing the vendor will reprice ${reprice} line${reprice > 1 ? 's' : ''} from the new vendor's rates. ${manual} line${manual > 1 ? 's' : ''} you edited manually will be overwritten. Continue?`,
        confirmLabel: 'Reprice from new vendor', danger: false,
        onConfirm: () => setter(s => ({ ...s, lines: repriced(s.lines) })),
        // Restore vendor/tax/rates/lines on cancel. NOTE: this reverts vendor_id
        // in state, but SearchableSelect (ui.jsx) caches its display label in
        // internal `query` state and does NOT reliably re-derive it when `value`
        // is changed externally like this — verified: after cancel the hidden
        // value snaps back to the old vendor (e.g. 21/DRCL) while the visible
        // label stays on the abandoned vendor (e.g. "Kansal"). The `key` on the
        // vendor Selects (below) forces a clean remount on any committed vendor
        // change so the label always matches vendor_id.
        onCancel: () => { setBoardRates(prevRates); setter(s => ({ ...s, vendor_id: prevVendor, tax_kind: prevTax, lines: prevLines })); },
      });
    } else {
      setter(s => ({ ...s, vendor_id: newVendorId, tax_kind: taxKind, lines: repriced(s.lines) }));
    }
  };

  // Drop a material (picked or just quick-created) onto a form line, carrying the
  // material's saved unit / HSN / GST and a resolver-priced rate. `kind` shapes it.
  const applyMaterialToLine = (line, mat, kind) => {
    if (!mat) return { ...line, material_id: '' };
    const resolved = rateFor(mat);
    if (kind === 'pr') return { ...line, material_id: String(mat.id), unit: mat.unit || '',
      est_rate: line.est_rate ? line.est_rate : (resolved?.rate != null ? String(resolved.rate) : '') };
    return { ...line, material_id: String(mat.id), unit: mat.unit || line.unit || '',
      hsn_code: line.hsn_code || mat.hsn_code || '',
      gst_rate: line.gst_rate ? line.gst_rate : (mat.gst_rate ?? ''),
      rate: line.rate ? line.rate : (resolved?.rate != null ? String(resolved.rate) : ''),
      rate_source: resolved?.source ?? 'none', rate_per_kg: resolved?.rate_per_kg ?? null };
  };

  // The Direct PO opener seeds base board rates so a board picked before a
  // vendor is chosen still prices off the base rate. Await the load before the
  // modal mounts (like the other three openers) so a board picked immediately
  // never resolves against a previously-open modal's vendor map.
  const openDirectPo = async () => { await loadBoardRates(null); setDirectPo(newPoForm()); };
  // The shared modal loads its own masters, rates and stock — this just opens it.
  const openNewPr = () => setNewPr(true);

  // Quick-created material → refresh masters and drop it onto the line that asked.
  const handleMaterialCreated = async material => {
    const ms = await api.get('/materials');
    setMaterials(ms);
    const setLine = (setter, kind) => setter(d => (d ? {
      ...d, lines: d.lines.map((x, j) => (j === quickMat.line ? applyMaterialToLine(x, material, kind) : x)),
    } : d));
    if (quickMat?.target === 'po') setLine(setDirectPo, 'po');
    if (quickMat?.target === 'editpo') setLine(setEditPo, 'po');
    if (quickMat?.target === 'convertpo') setLine(setConvertPr, 'po');
    // A direct receipt prices its lines exactly like a PO line, so it takes the
    // same fill — HSN, GST and the resolved rate all come across.
    if (quickMat?.target === 'grn') setLine(setNewGrn, 'po');
    setQuickMat(null);
  };

  const load = () => {
    api.get('/requisitions').then(rs => {
      setPrs(rs);
      threadSummary('requisition', rs.map(p => p.id)).then(setPrThreads).catch(() => {});
    });
    api.get('/purchase-orders').then(ps => {
      setPos(ps);
      threadSummary('purchase_order', ps.map(p => p.id)).then(setPoThreads).catch(() => {});
    });
    api.get('/grns').then(gs => {
      setGrns(gs);
      // /grns is LINE-grained and `id` is the HEADER — so a 3-line receipt
      // repeats its id three times. /threads/summary refuses more than 200 ids
      // per call, and duplicates would spend that budget on nothing.
      threadSummary('grn', [...new Set(gs.map(g => g.id))]).then(setGrnThreads).catch(() => {});
    });
    api.get('/procurement/pendency').then(setPendency).catch(() => {});
  };
  useEffect(() => {
    load();
    api.get('/materials').then(setMaterials);
    api.get('/vendors').then(setVendors);
    api.get('/company-profile').then(setCompany).catch(() => {});
    // Live position, so the board picker can say whether a board is worth
    // ordering at all. Optional by design — a stock read that fails must not
    // take the procurement forms down with it, and every consumer treats a
    // missing row as "unknown" rather than zero.
    api.get('/inventory/stock').then(setStock).catch(() => setStock([]));
  }, []);

  // Stable identity, keyed on the stock array. The board picker memoizes its
  // option list on this function, and a fresh closure per render would rebuild
  // 303 option haystacks on every keystroke in every field of the form.
  const stockFor = useCallback(id => stock.find(s => String(s.id) === String(id)) || null, [stock]);

  // Vendor picked on a PO form → auto-set intra/inter-state from the two states.
  const vendorById = id => vendors.find(v => String(v.id) === String(id));

  const selectedPrs = prs.filter(p => selectedIds.includes(p.id));
  const selectableOk = selectedPrs.length > 0 && selectedPrs.every(p => p.status === 'approved');

  const openPrModal = async (pr, edit = false) => { if (edit) await loadBoardRates(null); setPrModal({
    pr, edit,
    form: {
      needed_by: pr.needed_by || '', reason: pr.reason || '',
      requested_by: pr.requested_by || '', department: pr.department || '',
      priority: pr.priority || 'normal', remarks: pr.remarks || '',
      lines: (pr.lines?.length ? pr.lines : [{ material_id: pr.material_id, qty: pr.qty, unit: pr.unit }])
        .map(l => ({ material_id: String(l.material_id), qty: String(l.qty),
          est_rate: l.est_rate != null ? String(l.est_rate) : '', unit: l.unit || '', remarks: l.remarks || '' })),
    },
  }); };

  const savePrEdit = async () => {
    if (!prModal.form.lines.some(l => l.material_id && +l.qty > 0)) return toast.error('A requisition needs at least one item');
    await api.put(`/requisitions/${prModal.pr.id}`, prBody(prModal.form));
    toast.success(`${prModal.pr.pr_number} updated`);
    setPrModal(null); load();
  };

  // Approved PR → PO. Every requisition line seeds a PO line, pre-filled with the
  // material's HSN / GST / last rate; the buyer edits before creating the order.
  const openConvert = async pr => {
    const map = await loadBoardRates(null); // no vendor yet → base rates
    const lines = (pr.lines?.length ? pr.lines : [{ material_id: pr.material_id, qty: pr.qty, unit: pr.unit }]).map(l => {
      const mat = materials.find(m => String(m.id) === String(l.material_id));
      const b = map.get(String(l.material_id));
      // Board → base ₹/sheet; else PR estimate, then std/last.
      const dfl = b ? b.rate : matRate(mat);
      return { material_id: String(l.material_id), qty: String(l.qty), unit: l.unit || mat?.unit || '',
        hsn_code: mat?.hsn_code || '', gst_rate: mat?.gst_rate ?? '',
        rate: l.est_rate != null && l.est_rate !== '' ? String(l.est_rate) : (dfl != null ? String(dfl) : ''),
        rate_source: b ? b.source : (mat?.std_rate != null ? 'std' : mat?.last_rate != null ? 'last' : 'none'),
        rate_per_kg: b ? b.rate_per_kg : null, discount_pct: '' };
    });
    setConvertPr({ pr, vendor_id: '', expected_date: '', tax_kind: 'intra', freight: '', round_off: '', lines, ...PO_META });
  };

  const openBulkPo = async () => {
    const map = await loadBoardRates(null); // no vendor yet → base rates
    const mats = {};
    for (const p of selectedPrs) for (const l of (p.lines || [])) {
      (mats[l.material_id] ||= { material_id: l.material_id, material_name: l.material_name, unit: l.unit, qty: 0, prs: new Set() });
      mats[l.material_id].qty += +l.qty;
      mats[l.material_id].prs.add(p.pr_number);
    }
    const materialsArr = Object.values(mats).map(m => ({ ...m, prs: [...m.prs] }));
    // Boards land on their resolved ₹/sheet; non-boards on std → last rate.
    const rates = {};
    for (const m of materialsArr) {
      const b = map.get(String(m.material_id));
      const dfl = b ? b.rate : matRate(materials.find(x => String(x.id) === String(m.material_id)));
      if (dfl != null) rates[m.material_id] = String(dfl);
    }
    setBulkPo({ vendor_id: '', expected_date: '', rates, materials: materialsArr,
      tax_kind: 'intra', freight: '', round_off: '', ...PO_META });
  };

  const createBulkPo = async () => {
    const po = await api.post('/purchase-orders/from-requisitions', {
      requisition_ids: selectedIds, vendor_id: +bulkPo.vendor_id,
      expected_date: bulkPo.expected_date || undefined, rates: bulkPo.rates,
      tax_kind: bulkPo.tax_kind, freight: bulkPo.freight || undefined, round_off: bulkPo.round_off || undefined,
      vendor_notes: bulkPo.vendor_notes || undefined, payment_terms: bulkPo.payment_terms || undefined,
      delivery_terms: bulkPo.delivery_terms || undefined, reference: bulkPo.reference || undefined,
    });
    toast.success(`${po.po_number} created from ${selectedIds.length} requisition${selectedIds.length > 1 ? 's' : ''}`);
    setBulkPo(null); setSelectedIds([]); load(); setTab('pos');
  };

  // Bulk-PO rows carry a rate per material; roll them into PO-line shape so the
  // shared totals panel can price the CGST/SGST/IGST split.
  const bulkPoLines = () => (bulkPo?.materials || []).map(m => ({
    material_id: m.material_id, qty: m.qty, rate: bulkPo.rates[m.material_id] || 0,
    gst_rate: materials.find(x => String(x.id) === String(m.material_id))?.gst_rate || 0, discount_pct: 0,
  }));

  // Edit an existing PO — lines that already received stock stay locked. Board
  // rates are resolved for the PO's vendor so the chip / "Overridden" state
  // renders on the persisted rates without changing any saved number.
  const openEditPo = async po => {
    const map = await loadBoardRates(po.vendor_id);
    const lines = withBoardMeta(po.lines.map(l => ({
      id: l.id, material_id: String(l.material_id), qty: String(l.qty), rate: String(l.rate ?? ''),
      hsn_code: l.hsn_code || '', unit: l.unit || '',
      discount_pct: l.discount_pct != null ? String(l.discount_pct) : '',
      gst_rate: l.gst_rate != null ? String(l.gst_rate) : '',
      committed_qty: Math.max(+l.received_qty || 0, +l.grn_qty || 0),
    })), map);
    setEditPo({
      id: po.id, po_number: po.po_number, vendor_id: String(po.vendor_id), expected_date: po.expected_date || '',
      vendor_notes: po.vendor_notes || '', payment_terms: po.payment_terms || '',
      delivery_terms: po.delivery_terms || '', reference: po.reference || '',
      tax_kind: po.tax_kind || 'intra', freight: po.freight != null ? String(po.freight) : '',
      round_off: po.round_off != null ? String(po.round_off) : '',
      lines,
    });
  };

  const saveEditPo = async () => {
    const lines = editPo.lines.filter(l => l.material_id && +l.qty > 0)
      .map(l => ({ id: l.id, material_id: +l.material_id, qty: +l.qty, rate: +l.rate || 0,
        hsn_code: l.hsn_code || null, unit: l.unit || null,
        discount_pct: +l.discount_pct || 0, gst_rate: +l.gst_rate || 0 }));
    if (!lines.length) return toast.error('A PO needs at least one line');
    try {
      await api.put(`/purchase-orders/${editPo.id}`, {
        vendor_id: +editPo.vendor_id, expected_date: editPo.expected_date || null, lines,
        tax_kind: editPo.tax_kind, freight: editPo.freight || 0, round_off: editPo.round_off === '' ? undefined : editPo.round_off,
        vendor_notes: editPo.vendor_notes || null, payment_terms: editPo.payment_terms || null,
        delivery_terms: editPo.delivery_terms || null, reference: editPo.reference || null,
      });
      toast.success(`${editPo.po_number} updated`); setEditPo(null); load();
    } catch (e) { toast.error(e.message || 'Could not update PO'); }
  };

  // Delete for any procurement row. The chain behind a row — the PO over a PR,
  // the receipts under a PO — is the server's to unwind, so this asks it first
  // what the delete would take with it and shows that before committing. The
  // one refusal it can come back with is stock a job has already drawn on.
  const DELETE_PATH = { requisition: 'requisitions', purchase_order: 'purchase-orders', grn: 'grns' };

  // planProcurementDelete works per LINE — a receipt is a header with many of
  // them — so a two-line GRN comes back as "Reverses receipt CI-GRN-0018" twice,
  // the same document named once per board on the truck. The pure module keeps
  // its line-level truth (the backup and the blockers need it); the dialog
  // collapses each receipt to one bullet.
  //
  // Quantities are deliberately NOT summed into the collapsed line: two lines of
  // one receipt can transact in different units (sheets and rolls), so the tail
  // is dropped and replaced by the line count. Keying on the text before " — "
  // handles both lists without depending on the GRN numbering format.
  const dedupeReceipts = items => {
    const seen = new Map();
    for (const t of items || []) {
      const key = String(t).replace(/^Reverses receipt /, '').split(' — ')[0];
      if (seen.has(key)) seen.get(key).n++;
      else seen.set(key, { text: String(t), n: 1, receipt: /^Reverses receipt /.test(t) });
    }
    return [...seen.values()].map(({ text, n, receipt }) => (n > 1 && receipt
      ? `${text.split(' — ')[0]} (${n} lines)`
      : text));
  };

  const confirmDelete = async (entity, row, label) => {
    let plan;
    try { plan = await api.get(`/procurement/delete-preview/${entity}/${row.id}`); }
    catch (e) { return toast.error(e.message || 'Could not check what this delete removes'); }

    const bullets = items => items.map((t, i) => <span key={i} className="block">• {t}</span>);
    const cascade = dedupeReceipts(plan.cascade);
    const blockers = dedupeReceipts(plan.hard_blockers);

    if (blockers.length) {
      return setConfirm({
        title: `${label} cannot be deleted`,
        message: (<>
          <span className="block mb-1.5">Its stock has already been issued to production:</span>
          {bullets(blockers)}
          <span className="block mt-1.5 text-slate-500">
            Reverse the job that consumed it first — deleting now would drop the board out of the
            warehouse while the job built from it stays on the floor.
          </span>
        </>),
        confirmLabel: 'Close', hideCancel: true, onConfirm: () => {},
      });
    }

    // The cascade already names the row itself, so the lead-in must not repeat
    // it — "removes CI-VPO-0003" twice reads as two separate deletions.
    setConfirm({
      title: `Delete ${label}?`,
      message: (<>
        <span className="block mb-1.5">{cascade.length ? 'This will:' : `This permanently removes ${label}.`}</span>
        {bullets(cascade)}
        <span className="block mt-1.5 text-slate-500">A backup is written first. This cannot be undone.</span>
      </>),
      confirmLabel: `Delete ${label}`, danger: true,
      onConfirm: async () => {
        try {
          const r = await api.del(`/${DELETE_PATH[entity]}/${row.id}`, { force: true });
          toast.info(`${label} deleted${r.reverted?.length ? ` — ${r.reverted.join(', ')} back to approved` : ''}`);
          load();
        } catch (e) { toast.error(e.message || `Could not delete ${label}`); }
      },
    });
  };

  const revertPo = po => setConfirm({
    title: `Send ${po.po_number} back to requisition?`,
    message: `${po.po_number} will be removed and its source requisition(s) returned to the Requisitions tab as approved, ready to re-issue.`,
    confirmLabel: 'Send back', danger: true,
    onConfirm: async () => {
      try { const r = await api.post(`/purchase-orders/${po.id}/revert-to-requisition`);
        toast.info(`${po.po_number} sent back${r.reverted?.length ? ` — ${r.reverted.join(', ')} approved` : ''}`); load(); }
      catch (e) { toast.error(e.message || 'Could not send back'); }
    },
  });


  const GRN_META = () => ({ vehicle_no: '', supplier_invoice_no: '', supplier_invoice_date: '', received_by: auth.user?.name || '', remarks: '' });

  const openGrnPo = po => setGrnPo({
    po, ...GRN_META(),
    lines: po.lines.filter(l => l.received_qty < l.qty)
      .map(l => ({ ...l, receive_qty: '', batch_no: '' })),
  });

  const createBulkGrn = async () => {
    const lines = grnPo.lines.filter(l => +l.receive_qty > 0)
      .map(l => ({ po_line_id: l.id, qty: +l.receive_qty, batch_no: l.batch_no || undefined }));
    if (!lines.length) return toast.error('Enter at least one received quantity');
    await api.post('/grns/bulk', {
      purchase_order_id: grnPo.po.id, lines,
      vehicle_no: grnPo.vehicle_no || undefined, supplier_invoice_no: grnPo.supplier_invoice_no || undefined,
      supplier_invoice_date: grnPo.supplier_invoice_date || undefined,
      received_by: grnPo.received_by || undefined, remarks: grnPo.remarks || undefined,
    });
    toast.success(`GRN created for ${lines.length} line${lines.length > 1 ? 's' : ''} — in quarantine until QC`);
    setGrnPo(null); load(); setTab('grns');
  };

  // Unified "Create GRN" entry point — receive against an open PO, or a direct
  // (no-PO) receipt for material that arrived without paperwork. Base board
  // rates are loaded BEFORE the modal mounts, exactly like openDirectPo, so a
  // board picked immediately on the direct tab never prices off a previously
  // open modal's vendor map.
  const openNewGrn = async () => { await loadBoardRates(null); setNewGrn(newGrnForm()); };

  // The two tabs are two different documents that happen to share a modal, so
  // switching wipes the lines. Carrying a PO's lines onto the direct tab would
  // offer a board for free-hand receipt that is already netting off an order.
  const switchGrnMode = async m => {
    if (newGrn?.mode === m) return;
    if (m === 'direct') await loadBoardRates(null); // back to base rates
    setNewGrn(s => ({ ...s, mode: m, po_id: '', vendor_id: '',
      lines: m === 'direct' ? [blankGrnLine()] : [] }));
  };

  // Selecting a PO pulls in its still-pending lines, priced on the PO's own
  // agreed terms — rate, discount, GST and HSN all pre-filled, all editable,
  // because the supplier may have invoiced differently from what was ordered.
  // po_rate keeps the ordered rate alongside the typed one so the line can show
  // the variance without a second read.
  //
  // "Pending" folds in quarantined receipts (grn_qty), not just QC-accepted ones
  // (received_qty) — the same committed-quantity rule the PO edit lock uses.
  // received_qty alone would offer a balance that a GRN sitting in QC has
  // already claimed.
  const pickNewGrnPo = poId => {
    const po = pos.find(p => String(p.id) === String(poId));
    const v = po ? vendorById(po.vendor_id) : null;
    const lines = (po?.lines || []).map(l => {
      const committed = Math.max(+l.received_qty || 0, +l.grn_qty || 0);
      // A PO line predating the tax columns sits at 0 because nobody set it, not
      // because the board is zero-rated, so 0 falls through to the material —
      // the same rule the bulk route applies server-side. Showing the fallback
      // here rather than a bare 0 keeps the totals on screen equal to the tax
      // the receipt will actually be stored with.
      const mat = materials.find(m => String(m.id) === String(l.material_id));
      const gst = +l.gst_rate > 0 ? l.gst_rate : mat?.gst_rate;
      return { po_line_id: l.id, material_id: String(l.material_id), material_name: l.material_name,
        ordered_qty: +l.qty, balance_qty: +l.qty - committed,
        qty: '', unit: l.unit || '', hsn_code: l.hsn_code || '',
        rate: l.rate != null ? String(l.rate) : '', po_rate: l.rate,
        discount_pct: l.discount_pct != null ? String(l.discount_pct) : '',
        gst_rate: gst != null ? String(gst) : '', batch_no: '' };
    }).filter(l => l.balance_qty > 0);
    setNewGrn(s => ({ ...s, po_id: poId, lines,
      // The PO is the agreed commercial document, so its tax treatment comes
      // with the receipt; the two states decide it only if the PO never said.
      tax_kind: po?.tax_kind || taxKindFor(company, v) }));
  };

  // Both tabs post the same document shape — a header of tax terms plus priced
  // lines. Blank money fields are sent as undefined rather than 0 so the server
  // can fall through to the PO's agreed terms (bulk) or the material master
  // (direct); a hard 0 would silently zero-rate a line nobody meant to change.
  const grnLineBody = l => ({
    qty: +l.qty,
    unit: l.unit || undefined,
    rate: l.rate === '' || l.rate == null ? undefined : +l.rate,
    discount_pct: l.discount_pct === '' || l.discount_pct == null ? undefined : +l.discount_pct,
    gst_rate: l.gst_rate === '' || l.gst_rate == null ? undefined : +l.gst_rate,
    hsn_code: l.hsn_code || undefined,
    batch_no: l.batch_no || undefined,
  });

  const createNewGrn = async () => {
    const doc = {
      tax_kind: newGrn.tax_kind, freight: newGrn.freight || 0,
      round_off: newGrn.round_off === '' ? undefined : newGrn.round_off,
      vehicle_no: newGrn.vehicle_no || undefined, supplier_invoice_no: newGrn.supplier_invoice_no || undefined,
      supplier_invoice_date: newGrn.supplier_invoice_date || undefined,
      received_by: newGrn.received_by || undefined, remarks: newGrn.remarks || undefined,
    };
    try {
      if (newGrn.mode === 'direct') {
        const lines = newGrn.lines.filter(l => l.material_id && +l.qty > 0)
          .map(l => ({ material_id: +l.material_id, ...grnLineBody(l) }));
        if (!lines.length) return toast.error('Add at least one board with a positive quantity');
        const g = await api.post('/grns/direct', { ...doc, lines,
          vendor_id: newGrn.vendor_id ? +newGrn.vendor_id : undefined });
        toast.success(`${g.grn_number} created — ${lines.length} line${lines.length > 1 ? 's' : ''} in quarantine until QC`);
      } else {
        if (!newGrn.po_id) return toast.error('Select a purchase order to receive against');
        const lines = newGrn.lines.filter(l => +l.qty > 0)
          .map(l => ({ po_line_id: l.po_line_id, ...grnLineBody(l) }));
        if (!lines.length) return toast.error('Enter at least one received quantity');
        await api.post('/grns/bulk', { ...doc, purchase_order_id: +newGrn.po_id, lines });
        toast.success(`GRN created for ${lines.length} line${lines.length > 1 ? 's' : ''} — in quarantine until QC`);
      }
      setNewGrn(null); load(); setTab('grns');
    } catch (e) { toast.error(e.message || 'Could not create GRN'); }
  };

  // ── Edit a receipt ───────────────────────────────────────────────────────────
  // A receipt is edited as a document: header context plus every line's qty,
  // rate, discount, GST and batch. Lines cannot be added or removed — a receipt
  // records what physically arrived, and the server refuses a line it has never
  // seen. `id` on each line is the LINE id; the modal's own `id` is the header.
  const openEditGrn = g => setEditGrn({
    id: g.id, grn_number: g.grn_number, po_number: g.po_number,
    vehicle_no: g.vehicle_no || '', supplier_invoice_no: g.supplier_invoice_no || '',
    supplier_invoice_date: g.supplier_invoice_date || '', received_by: g.received_by || '',
    remarks: g.remarks || '',
    lines: linesOfGrn(g.id).map(l => ({
      id: l.line_id, material_name: l.material_name, unit: l.unit, status: l.status,
      qty: String(l.qty ?? ''), rate: l.rate != null ? String(l.rate) : '',
      discount_pct: l.discount_pct != null ? String(l.discount_pct) : '',
      gst_rate: l.gst_rate != null ? String(l.gst_rate) : '',
      hsn_code: l.hsn_code || '', batch_no: l.batch_no || '',
    })),
  });

  const saveEditGrn = async () => {
    if (!editGrn.lines.every(l => +l.qty > 0)) return toast.error('Every line needs a positive received quantity');
    try {
      await api.put(`/grns/${editGrn.id}`, {
        vehicle_no: editGrn.vehicle_no || null, supplier_invoice_no: editGrn.supplier_invoice_no || null,
        supplier_invoice_date: editGrn.supplier_invoice_date || null,
        received_by: editGrn.received_by || null, remarks: editGrn.remarks || null,
        lines: editGrn.lines.map(l => ({
          id: l.id, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate,
          discount_pct: l.discount_pct === '' ? undefined : +l.discount_pct,
          gst_rate: l.gst_rate === '' ? undefined : +l.gst_rate,
          hsn_code: l.hsn_code || undefined, batch_no: l.batch_no || undefined,
        })),
      });
      toast.success(`${editGrn.grn_number} updated`); setEditGrn(null); load();
    } catch (e) {
      // The server refuses (409) the moment any line has been QC-decided. That
      // refusal names how many lines and why — show it, never a generic failure.
      toast.error(e.message || 'Could not update GRN');
    }
  };

  // ── QC ───────────────────────────────────────────────────────────────────────
  // The decision lives on the LINE: four boards arrive on one truck and one bad
  // lot must be refusable while the other three are released. The endpoints
  // answer { ok: true }, not the row, so the register is refetched after.
  const decideLine = async (line, accept, note) => {
    try {
      await api.post(`/grn-lines/${line.line_id}/qc`, { accept, note });
      toast[accept ? 'success' : 'info'](accept
        ? `${line.material_name} accepted — batch released to stock`
        : `${line.material_name} rejected`);
      setQcGrn(null); load();
    } catch (e) { toast.error(e.message || 'Could not record the QC decision'); }
  };

  // Accept All sweeps the receipt's remaining quarantine lines. The endpoint
  // takes `accept`, so it could sweep-REJECT too — deliberately not offered.
  // Rejecting sends board back to the supplier and writes a negative movement
  // per lot; it is the decision that most needs to be made lot by lot, and a
  // one-click "reject everything" turns a slip into a refused truck. Accepting
  // in bulk is the ordinary case — the whole load passed.
  const acceptAllGrn = async (header, note) => {
    try {
      const r = await api.post(`/grns/${header.id}/qc-all`, { accept: true, note });
      toast.success(`${header.grn_number} — ${r.decided} line${r.decided === 1 ? '' : 's'} accepted and released to stock`);
      setQcGrn(null); load();
    } catch (e) { toast.error(e.message || 'Could not accept the receipt'); }
  };

  const rollbackGrn = g => {
    const lines = linesOfGrn(g.id);
    const what = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    setConfirm({
      title: g.po_number ? `Roll ${g.grn_number} back to PO?` : `Roll back ${g.grn_number}?`,
      message: g.po_number
        ? `This undoes the accepted receipt: all ${what} on ${g.grn_number} return to ${g.po_number}'s pending balance and the released stock batches are removed. Only works if that stock hasn't been used yet.`
        : `This undoes the direct receipt: all ${what} on ${g.grn_number} and their released stock batches are removed. Only works if that stock hasn't been used yet.`,
      confirmLabel: g.po_number ? 'Roll back to PO' : 'Roll back receipt', danger: true,
      onConfirm: async () => {
        try { await api.post(`/grns/${g.id}/rollback`); toast.info(`${g.grn_number} rolled back${g.po_number ? ` — balance returned to ${g.po_number}` : ''}`); load(); }
        catch (e) { toast.error(e.message || 'Could not roll back GRN'); }
      },
    });
  };

  // Receipt-level actions. Every item here acts on the whole document, so the
  // menu is mounted once per receipt — on the group band when its lines are
  // gathered, on the row itself when the receipt has only one.
  const grnMenu = g => {
    const lines = linesOfGrn(g.id);
    const open = lines.filter(l => l.status === 'quarantine').length;
    return [
      // The receipt's own document — one page for the store to hold on arrival
      // and to file against the supplier's invoice. `g.id` is the HEADER id in
      // both mountings of this menu (group band and single row), so a 3-line
      // truck prints as one receipt either way.
      { key: 'print', label: 'Print GRN', icon: Printer, onClick: () => navigate(`/procurement/grn/${g.id}`) },
      // One quarantine line already has its own QC Decision button on the row;
      // a sweep is only a shortcut once there is more than one left to decide.
      ...(open > 1 ? [{ key: 'qcall', label: `Accept all ${open} pending lines`, icon: CheckCircle2,
        onClick: () => setQcGrn({ header: g, all: true, open, note: '' }) }] : []),
      // Offered only while EVERY line is still in QC — the same rule the server
      // enforces in grnEditBlockers, which refuses the save the moment one line
      // has been decided. `in_qc` is the only derived status meaning "nothing on
      // this receipt is decided yet"; 'part_qc' still has lines awaiting QC but
      // already has decided ones, so opening a fully editable form on it would
      // dangle an action that can only ever end in a 409.
      ...(g.header_status === 'in_qc'
        ? [{ key: 'edit', label: 'Edit GRN', icon: Pencil, onClick: () => openEditGrn(g) }] : []),
      ...(['accepted', 'partly_accepted'].includes(g.header_status)
        ? [{ key: 'rollback', label: g.po_number ? 'Roll back to PO' : 'Roll back receipt', icon: Undo2, tone: 'danger',
          onClick: () => rollbackGrn(g) }] : []),
      { key: 'delete', label: 'Delete GRN', icon: Trash2, tone: 'danger',
        onClick: () => confirmDelete('grn', g, g.grn_number) },
    ];
  };

  const pendingCount = pendency?.lines?.length || 0;

  // ── Register sub-views: split each list into open/actionable vs done ──────────
  const PR_GROUPS = { open: ['pending', 'approved'], converted: ['converted'], closed: ['closed', 'rejected'] };
  const prRows = prs.filter(p => PR_GROUPS[prView].includes(p.status));
  const poIsDone = po => po.status === 'received' || po.status === 'closed';
  const poList = pos.filter(po => (poView === 'completed' ? poIsDone(po) : !poIsDone(po)));
  // ── The GRN register is LINE-grained ─────────────────────────────────────────
  // /grns returns one row per receipt LINE. Every row carries `id` (the HEADER),
  // `line_id` (its own), `status` (the line's QC state) and `header_status` (the
  // receipt's, derived server-side from all its lines).
  //
  // Two different questions therefore need two different answers:
  //   • WHICH ROWS to show  → the receipt's status, so a part-QC'd receipt stays
  //     whole in Pending instead of splitting across both tabs.
  //   • HOW MANY            → distinct HEADER ids. A three-board truck is one
  //     receipt awaiting QC, not three, and counting rows trebled every badge.
  const GRN_OPEN = new Set(['in_qc', 'part_qc']);
  const grnPending = g => GRN_OPEN.has(g.header_status);
  const grnRows = grns.filter(g => (grnView === 'completed' ? !grnPending(g) : grnPending(g)));
  const receiptCount = pred => new Set(grns.filter(pred).map(g => g.id)).size;
  // Every line of one receipt, in register order — the group band, the QC sweep
  // and the edit form all work on the receipt, not the row that was clicked.
  const linesOfGrn = id => grns.filter(g => g.id === id);
  // Only a MULTI-line receipt becomes a visual group. A single-line receipt has
  // nothing to gather, and banding all of them would paint the whole register in
  // the violet rail that is supposed to mean "these rows belong together".
  const grnLineCount = grns.reduce((m, g) => m.set(g.id, (m.get(g.id) || 0) + 1), new Map());
  const prCount = k => prs.filter(p => PR_GROUPS[k].includes(p.status)).length;

  return (
    <div>
      <PageHeader title="Procurement" subtitle="Requisition → Purchase Order → GRN → QC → stock"
        actions={<>
          <Button variant="secondary" onClick={openDirectPo}>
            <ShoppingBag size={15} /> Direct PO
          </Button>
          <Button variant="success" onClick={openNewGrn}>
            <PackagePlus size={15} /> Create GRN
          </Button>
          <Button onClick={openNewPr}><Plus size={15} /> New Requisition</Button>
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'prs', label: 'Requisitions', count: prs.filter(p => p.status === 'pending').length },
        { key: 'pos', label: 'Purchase Orders', count: pos.filter(p => p.status !== 'received' && p.status !== 'closed').length },
        { key: 'grns', label: 'GRN / QC', count: receiptCount(grnPending) },
        { key: 'pendency', label: 'Pendency', count: pendingCount },
      ]} />

      {/* Bulk bar — multi-select approved PRs → one PO */}
      {tab === 'prs' && selectedIds.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
          <span className="text-sm font-semibold text-slate-700">
            {selectedIds.length} requisition{selectedIds.length > 1 ? 's' : ''} selected
            {!selectableOk && <span className="ml-2 text-xs font-semibold text-amber-600">— only approved PRs can go on a PO</span>}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>Clear</Button>
            <Button size="sm" disabled={!selectableOk} onClick={openBulkPo}>
              <ShoppingBag size={13} /> Create One PO from Selection
            </Button>
          </div>
        </div>
      )}

      {tab === 'prs' && (
        <div className="mb-3">
          <SubTabs active={prView} onChange={setPrView} views={[
            { key: 'open', label: 'Pending', count: prCount('open') },
            { key: 'converted', label: 'Converted', count: prCount('converted') },
            { key: 'closed', label: 'Closed', count: prCount('closed') },
          ]} />
        </div>
      )}

      {tab === 'prs' && (
        <DataTable searchable selectable
          selectedIds={selectedIds}
          onToggleRow={(row, checked) => setSelectedIds(ids => checked ? [...new Set([...ids, row.id])] : ids.filter(id => id !== row.id))}
          onToggleAll={(rows, checked) => {
            const ids = rows.filter(r => r.status === 'approved').map(r => r.id);
            setSelectedIds(cur => checked ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)));
          }}
          onRowClick={p => openPrModal(p)}
          columns={[
            { key: 'pr_number', label: 'PR No', render: p => <span className="font-semibold">{p.pr_number}</span> },
            { key: 'material_name', label: 'Items', render: p => {
              const ls = p.lines || [];
              const first = ls[0]?.material_name || p.material_name;
              const matId = ls.length <= 1 ? (ls[0]?.material_id || p.material_id) : null;
              const stk = p.board_stock;
              return (<div>{first}{ls.length > 1 && <span className="ml-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-600">+{ls.length - 1} more</span>}
                <div className="text-[11px] capitalize text-slate-400">{ls.length > 1 ? `${ls.length} items` : (ls[0]?.material_category || p.material_category)}</div>
                {matId && stk && (
                  <button type="button"
                    onClick={e => { e.stopPropagation(); setBoardPanel({ materialId: matId, pr: p }); }}
                    className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      stk.free > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    <Package size={12} />
                    {fmt.num(stk.available)} in warehouse
                    {stk.available > 0 && (stk.free > 0
                      ? ` · ${fmt.num(stk.free)} free`
                      : ` · all of it committed to ${stk.jobs} job${stk.jobs === 1 ? '' : 's'}`)}
                  </button>
                )}
              </div>);
            } },
            { key: 'qty', label: 'Qty', align: 'right', render: p => {
              const ls = p.lines || [];
              if (ls.length <= 1) return `${fmt.num(ls[0]?.qty ?? p.qty)} ${ls[0]?.unit || p.unit || ''}`;
              return <span className="text-xs text-slate-500">{ls.length} lines{p.est_value > 0 ? <span className="block tabular-nums text-slate-400">{fmt.inr(p.est_value)}</span> : null}</span>;
            } },
            { key: 'needed_by', label: 'Needed By', render: p => fmt.date(p.needed_by) },
            { key: 'reason', label: 'Reason', render: p => <span className="text-xs text-gray-500">{p.reason}{p.status_reason ? <span className="block text-red-400">closed: {p.status_reason}</span> : null}</span> },
            { key: 'status', label: 'Status', render: p => <StatusBadge status={p.status} /> },
            { key: 'po_number', label: 'PO', render: p => p.po_number || '—' },
            threadColumn({ entity: 'requisition', threads: prThreads, idOf: p => p.id }),
            { key: 'act', label: '', sortable: false, render: p => (
              <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                {p.status === 'pending' && <>
                  <Button size="sm" variant="success" onClick={async () => { await api.post(`/requisitions/${p.id}/approve`); toast.success('Approved'); load(); }}>Approve</Button>
                </>}
                {p.status === 'approved' && (
                  <Button size="sm" onClick={() => openConvert(p)}>Create PO</Button>
                )}
                <ActionMenu items={[
                  { key: 'view', label: 'View / Edit', icon: Eye, onClick: () => openPrModal(p, ['pending', 'approved'].includes(p.status)) },
                  ...(p.status === 'approved' ? [{
                    key: 'select', label: selectedIds.includes(p.id) ? 'Remove from PO selection' : 'Add to PO selection', icon: ShoppingBag,
                    onClick: () => setSelectedIds(ids => ids.includes(p.id) ? ids.filter(i => i !== p.id) : [...ids, p.id]),
                  }] : []),
                  ...(p.status === 'pending' ? [{
                    key: 'reject', label: 'Reject', icon: XCircle, tone: 'danger',
                    onClick: async () => { await api.post(`/requisitions/${p.id}/reject`); toast.info('Rejected'); load(); },
                  }] : []),
                  ...(['pending', 'approved'].includes(p.status) ? [{
                    key: 'close', label: 'Close / cancel with reason', icon: Ban, tone: 'danger',
                    onClick: () => setClosePr({ pr: p, reason: '' }),
                  }] : []),
                  { key: 'delete', label: 'Delete requisition', icon: Trash2, tone: 'danger',
                    onClick: () => confirmDelete('requisition', p, p.pr_number) },
                ]} />
              </div>) },
          ]}
          rows={prRows} empty={prView === 'open' ? 'No pending requisitions' : prView === 'converted' ? 'No converted requisitions yet' : 'Nothing closed or rejected'}
          rowClass={unreadRowClass(prThreads, p => p.id)}
          getRowId={p => p.id}
          exportName="Purchase Requisitions"
          exportSubtitle="Procurement · PR register"
          exportSummary={rows => [
            { label: 'Requisitions', value: rows.length },
            { label: 'Pending', value: rows.filter(p => p.status === 'pending').length },
            { label: 'Approved', value: rows.filter(p => p.status === 'approved').length },
            { label: 'Converted', value: rows.filter(p => p.status === 'converted').length },
          ]} />
      )}

      {tab === 'pos' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SubTabs active={poView} onChange={setPoView} views={[
              { key: 'pending', label: 'Pending', count: pos.filter(p => !poIsDone(p)).length },
              { key: 'completed', label: 'Completed', count: pos.filter(poIsDone).length },
            ]} />
          </div>
          {pos.length > 0 && (
            <div className="flex justify-end">
              <ExportMenu build={() => ({
                name: 'Purchase Orders',
                title: 'Purchase Orders',
                subtitle: 'Procurement · PO register with line-wise receipt status',
                summary: [
                  { label: 'POs', value: pos.length },
                  { label: 'Open', value: pos.filter(p => p.status !== 'closed').length },
                  { label: 'Lines pending', value: pos.reduce((s, p) => s + p.lines.filter(l => l.received_qty < l.qty).length, 0) },
                ],
                columns: [
                  { key: 'po_number', label: 'PO' },
                  { key: 'vendor_name', label: 'Vendor' },
                  { key: 'status', label: 'Status', export: r => fmt.title(r.status) },
                  { key: 'expected_date', label: 'Expected', export: r => (r.expected_date ? fmt.date(r.expected_date) : '—') },
                  { key: 'material_name', label: 'Board' },
                  { key: 'qty', label: 'Ordered', align: 'right', export: r => `${fmt.num(r.qty)} ${r.unit}` },
                  { key: 'received_qty', label: 'Received', align: 'right', export: r => fmt.num(r.received_qty) },
                  { key: 'pending', label: 'Pending', align: 'right', export: r => fmt.num(Math.max(0, r.qty - r.received_qty)) },
                  { key: 'rate', label: 'Rate', align: 'right', export: r => `Rs ${r.rate}` },
                ],
                rows: pos.flatMap(po => po.lines.map(l => ({ ...l, po_number: po.po_number, vendor_name: po.vendor_name, status: po.status, expected_date: po.expected_date }))),
              })} />
            </div>
          )}
          {poList.length === 0 && <p className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-gray-400">{poView === 'completed' ? 'No completed purchase orders yet.' : 'No pending purchase orders — every order is fully received.'}</p>}
          {poList.map(po => {
            const pendingLines = po.lines.filter(l => l.received_qty < l.qty);
            const received = po.lines.some(l => +l.received_qty > 0) || po.grn_count > 0;
            const orderedTotal = po.lines.reduce((s, l) => s + +l.qty, 0);
            const receivedTotal = po.lines.reduce((s, l) => s + Math.min(+l.received_qty, +l.qty), 0);
            const poFulfillment = orderedTotal > 0 ? (receivedTotal / orderedTotal) * 100 : 0;
            const hasSourcePr = !!po.pr_number || po.source_pr_count > 0;
            const poMenu = [
              { key: 'open', label: 'Open PO', icon: Eye, onClick: () => navigate(`/procurement/po/${po.id}`) },
              ...(po.status !== 'closed' ? [{ key: 'edit', label: 'Edit PO', icon: Pencil, onClick: () => openEditPo(po) }] : []),
              ...(hasSourcePr && !received ? [{ key: 'revert', label: 'Send back to requisition', icon: Undo2, tone: 'danger', onClick: () => revertPo(po) }] : []),
              { key: 'delete', label: 'Delete PO', icon: Trash2, tone: 'danger', onClick: () => confirmDelete('purchase_order', po, po.po_number) },
              ...(po.status !== 'closed' ? [{ key: 'close', label: 'Close PO (no more receipts)', icon: Ban, tone: 'danger',
                onClick: async () => { await api.post(`/purchase-orders/${po.id}/close`); toast.info(`${po.po_number} closed`); load(); } }] : []),
            ];
            return (
            <div key={po.id} className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link to={`/procurement/po/${po.id}`} className="text-sm font-extrabold text-brand-600 hover:underline">{po.po_number}</Link>
                  <span className="ml-2 text-xs text-gray-500">{po.vendor_name}{po.pr_number ? ` · from ${po.pr_number}` : ''}</span>
                  {po.expected_date && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">expected {fmt.date(po.expected_date)}</span>}
                  {(po.payment_terms || po.delivery_terms || po.reference) && (
                    <span className="ml-2 text-[11px] text-slate-400">
                      {[po.reference && `ref ${po.reference}`, po.payment_terms, po.delivery_terms].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2.5">
                  <FulfillmentBar pct={poFulfillment} done={receivedTotal} total={orderedTotal} />
                  <StatusBadge status={po.status} />
                  {/* POs are cards, not table rows, so the doorbell is hand-mounted —
                      same place it sits in every register: after the status, ahead
                      of the actions. */}
                  <ThreadCell entity="purchase_order" id={po.id} summary={poThreads[po.id]} />
                  {pendingLines.length > 0 && po.status !== 'closed' && (
                    <Button size="sm" onClick={() => openGrnPo(po)}><PackagePlus size={13} /> Create GRN</Button>
                  )}
                  <ActionMenu items={poMenu} />
                </div>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                  <th className="px-3 py-1.5">Board</th><th className="px-3 py-1.5 text-right">Ordered</th>
                  <th className="px-3 py-1.5 text-right">Received</th><th className="px-3 py-1.5 text-right">Pending</th>
                  <th className="px-3 py-1.5 text-center">Fulfillment</th>
                  <th className="px-3 py-1.5 text-right">Rate</th><th className="px-3 py-1.5 text-right"></th>
                </tr></thead>
                <tbody>
                  {po.lines.map(l => (
                    <tr key={l.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2">{l.material_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.received_qty)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${l.qty - l.received_qty > 0 ? 'font-semibold text-amber-600' : 'text-slate-300'}`}>{fmt.num(Math.max(0, l.qty - l.received_qty))}</td>
                      <td className="px-3 py-2"><FulfillmentBar className="mx-auto" pct={l.qty > 0 ? (Math.min(l.received_qty, l.qty) / l.qty) * 100 : 0} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">₹{l.rate}</td>
                      <td className="px-3 py-2 text-right">
                        {l.received_qty < l.qty && po.status !== 'closed' && (
                          <Button size="sm" variant="secondary" onClick={() => setReceivePo({ po, line: l, qty: '', batch_no: '', ...GRN_META() })}>Receive</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            );
          })}
        </div>
      )}

      {tab === 'grns' && (
        <div className="mb-3">
          <SubTabs active={grnView} onChange={setGrnView} views={[
            { key: 'pending', label: 'Pending QC', count: receiptCount(grnPending) },
            { key: 'completed', label: 'Completed', count: receiptCount(g => !grnPending(g)) },
          ]} />
        </div>
      )}

      {tab === 'grns' && (
        <DataTable searchable
          // A receipt with several lines is ONE document, so its lines are
          // pulled together under a band that carries the receipt's identity,
          // its derived header_status and its receipt-level actions. Single-line
          // receipts stay plain rows — see grnLineCount.
          groupBy={g => (grnLineCount.get(g.id) > 1 ? g.grn_number : null)}
          renderGroupHeader={rows => {
            const h = rows[0];
            const value = rows.reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0);
            return (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-extrabold text-slate-800">{h.grn_number}</span>
                  <span className="text-xs text-slate-500">
                    {h.po_number ? `against ${h.po_number}` : 'direct receipt · no PO'}
                    {h.vendor_name ? ` · ${h.vendor_name}` : ''}
                  </span>
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                    {rows.length} lines · {fmt.inr(value)}
                  </span>
                </div>
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <StatusBadge status={h.header_status} />
                  <ActionMenu label="GRN actions" items={grnMenu(h)} />
                </div>
              </div>
            );
          }}
          columns={[
            { key: 'grn_number', label: 'GRN', render: g => <span className="font-semibold">{g.grn_number}</span> },
            { key: 'po_number', label: 'Against PO', render: g => g.po_number
              ? g.po_number
              : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Direct · No PO</span> },
            { key: 'vendor_name', label: 'Vendor', render: g => g.vendor_name || <span className="text-gray-300">—</span> },
            { key: 'material_name', label: 'Board' },
            { key: 'qty', label: 'Qty', align: 'right', render: g => `${fmt.num(g.qty)} ${g.unit}` },
            // A receipt is now priced line by line, so the register shows what
            // each line cost. Rate keeps its paise: board runs at ₹6.85/sheet
            // and a whole-rupee ₹7 would be a different board.
            { key: 'rate', label: 'Rate', align: 'right',
              render: g => (g.rate == null ? <span className="text-gray-300">—</span> : `₹${(+g.rate).toFixed(2)}`),
              export: g => (g.rate == null ? '' : (+g.rate).toFixed(2)) },
            { key: 'amount', label: 'Amount', align: 'right',
              render: g => <span className="font-semibold">{fmt.inr(g.amount)}</span>,
              export: g => Math.round(+g.amount || 0) },
            { key: 'batch_no', label: 'Batch', render: g => (
              <div>
                <span className="font-mono text-xs">{g.batch_no}</span>
                {(g.vehicle_no || g.supplier_invoice_no) && (
                  <div className="text-[10px] text-slate-400">
                    {[g.vehicle_no, g.supplier_invoice_no && `Inv ${g.supplier_invoice_no}`].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>) },
            { key: 'received_at', label: 'Received', render: g => (
              <div className="text-xs">{fmt.date(g.received_at)}{g.received_by && <div className="text-[10px] text-slate-400">by {g.received_by}</div>}</div>) },
            // The LINE's own QC state. The receipt's derived status rides on the
            // group band above it — one bad lot on a good truck has to be
            // readable as exactly that.
            { key: 'status', label: 'QC', render: g => <StatusBadge status={g.status} /> },
            // Deliberately still the HEADER id: every conversation ever started
            // on a GRN points at it, and a thread per line would orphan them.
            threadColumn({ entity: 'grn', threads: grnThreads, idOf: g => g.id }),
            { key: 'act', label: '', sortable: false, render: g => (
              <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                {g.status === 'quarantine' && <Button size="sm" onClick={() => setQcGrn({ line: g, note: '' })}>QC Decision</Button>}
                {/* A grouped receipt carries its own menu on the band, so the
                    row only mounts one when it stands alone — otherwise a
                    3-line truck would offer the same three receipt actions
                    three times over. */}
                {grnLineCount.get(g.id) > 1 ? null : <ActionMenu label="GRN actions" items={grnMenu(g)} />}
              </div>) },
          ]}
          rows={grnRows} empty={grnView === 'completed' ? 'No completed QC decisions yet' : 'Nothing awaiting QC'}
          rowClass={unreadRowClass(grnThreads, g => g.id)}
          // Per LINE — the header id now repeats across rows, and keying on it
          // would give three rows of one receipt the same React identity.
          getRowId={g => g.line_id}
          exportName="Goods Receipts"
          exportSubtitle="Procurement · GRN register, line-wise with QC status" />
      )}

      {/* ── Pendency dashboard ── PO Lines / Item-wise / Party-wise ── */}
      {tab === 'pendency' && (
        <div className="space-y-4">
          {!pendency ? <p className="py-10 text-center text-sm text-slate-400">Loading pendency…</p> : pendency.lines.length === 0 ? (
            <p className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-gray-400">Nothing pending — every open PO is fully received.</p>
          ) : (() => {
            const t = pendency.totals || {};
            const ordered = pendency.lines.reduce((s, l) => s + +l.qty, 0);
            const received = pendency.lines.reduce((s, l) => s + +l.received_qty, 0);
            const views = [['lines', 'PO Lines'], ['items', 'Item-wise Pendency'], ['parties', 'Vendor-wise Pendency'], ['grades', 'Grade-wise Pendency']];
            const kpi = (label, value, tone) => (
              <div key={label} className={`rounded-xl px-3 py-1.5 text-right ${tone === 'amber' ? 'bg-amber-50' : tone === 'brand' ? 'bg-brand-50' : 'bg-slate-100/70'}`}>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
                <div className={`text-sm font-bold tabular-nums ${tone === 'amber' ? 'text-amber-600' : tone === 'brand' ? 'text-brand-600' : 'text-slate-800'}`}>{value}</div>
              </div>
            );
            return (
            <>
              {/* Summary bar: sub-view tabs + live KPIs */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/70 bg-white/70 px-3 py-2.5 shadow-card backdrop-blur-xl">
                <SubTabs active={pendencyView} onChange={setPendencyView}
                  views={views.map(([key, label]) => ({ key, label }))} />
                <div className="flex flex-wrap items-center gap-2">
                  {kpi('Lines', fmt.num(t.lines))}
                  {kpi('Items', fmt.num(t.items))}
                  {kpi('Parties', fmt.num(t.parties))}
                  {kpi('Pending', fmt.num(t.pending_qty), 'amber')}
                  {kpi('Pending Weight', fmt.kg(t.pending_weight), 'amber')}
                  {kpi('Value', fmt.inr(t.pending_value), 'brand')}
                </div>
              </div>

              {/* ── PO Lines ── */}
              {pendencyView === 'lines' && (
                <div className="ci-data-panel">
                  <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.05] bg-white/30 px-4 py-2.5">
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Pending PO Lines</span>
                    <ExportMenu build={() => ({
                      name: 'Procurement Pendency', title: 'Procurement Pendency',
                      subtitle: 'Procurement · What is still to be received, and how late',
                      summary: [
                        { label: 'Pending Lines', value: t.lines },
                        { label: 'Items', value: t.items },
                        { label: 'Parties', value: t.parties },
                        { label: 'Pending Qty', value: fmt.num(t.pending_qty) },
                        { label: 'Pending Weight', value: fmt.kg(t.pending_weight) },
                        { label: 'Pending Value', value: fmt.inr(t.pending_value) },
                      ],
                      columns: [
                        { key: 'po_number', label: 'PO' },
                        { key: 'vendor_name', label: 'Supplier' },
                        { key: 'material_name', label: 'Board' },
                        { key: 'qty', label: 'Ordered', align: 'right', export: l => `${fmt.num(l.qty)} ${l.unit}` },
                        { key: 'received_qty', label: 'Received', align: 'right', export: l => fmt.num(l.received_qty) },
                        { key: 'pending_qty', label: 'Pending', align: 'right', export: l => fmt.num(l.pending_qty) },
                        { key: 'pending_weight', label: 'Pending kg', align: 'right', export: l => fmt.kg(l.pending_weight) },
                        { key: 'rate', label: 'Rate', align: 'right', export: l => fmt.inr(l.rate) },
                        { key: 'pending_value', label: 'Pending Value', align: 'right', export: l => fmt.inr(l.pending_value) },
                        { key: 'age_bucket', label: 'Age Bucket', export: l => `${l.age_bucket} days` },
                        { key: 'expected_date', label: 'Expected', export: l => (l.expected_date ? fmt.date(l.expected_date) : '—') },
                        { key: 'last_grn_at', label: 'Last GRN', export: l => (l.last_grn_at ? fmt.date(l.last_grn_at) : '—') },
                        { key: 'overdue_days', label: 'Ageing', align: 'right', export: l => (l.overdue_days > 0 ? `${l.overdue_days}d overdue` : `${l.age_days}d old`) },
                      ],
                      rows: pendency.lines,
                    })} />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="ci-table-head">
                        <th className={th}>PO Number</th><th className={th}>Supplier</th><th className={th}>Board</th><th className={th}>Type</th>
                        <th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Received</th><th className={`${th} text-right`}>Pending</th>
                        <th className={`${th} text-right`}>Pending kg</th>
                        <th className={`${th} text-right`}>Rate</th><th className={`${th} text-right`}>Pending Value</th>
                        <th className={th}>Age</th><th className={th}>PO Date</th><th className={th}>Expected</th><th className={th}>Last GRN</th><th className={th}>Status</th><th className={`${th} text-right`}>Actions</th>
                      </tr></thead>
                      <tbody>
                        {pendency.lines.map((l, i) => (
                          <tr key={`${l.po_line_id}-${i}`} className={`ci-table-row ${l.overdue_days > 0 ? 'bg-red-50/70' : ''}`}>
                            <td className={`${td} font-semibold`}><Link to={`/procurement/po/${l.po_id}`} className="text-brand-600 hover:underline">{l.po_number}</Link></td>
                            <td className={td}>{l.vendor_name}</td>
                            <td className={td}>{l.material_name}</td>
                            <td className={`${td} text-xs capitalize text-slate-500`}>{fmt.title(l.category)}</td>
                            <td className={`${td} text-right tabular-nums`}>{fmt.num(l.qty)}</td>
                            <td className={`${td} text-right tabular-nums text-slate-500`}>{fmt.num(l.received_qty)}</td>
                            <td className={`${td} text-right font-bold tabular-nums text-amber-600`}>{fmt.num(l.pending_qty)} <span className="text-[10px] font-normal text-slate-400">{l.unit}</span></td>
                            <td className={`${td} text-right tabular-nums font-semibold ${l.pending_weight == null ? 'text-slate-300' : 'text-slate-700'}`}>{fmt.kg(l.pending_weight)}</td>
                            <td className={`${td} text-right tabular-nums`}>{fmt.inr(l.rate)}</td>
                            <td className={`${td} text-right tabular-nums font-semibold`}>{fmt.inr(l.pending_value)}</td>
                            <td className={td}><AgeBucket bucket={l.age_bucket} /></td>
                            <td className={`${td} text-xs`}>{fmt.date(l.created_at)}</td>
                            <td className={`${td} text-xs ${l.overdue_days > 0 ? 'font-bold text-red-600' : ''}`}>{l.expected_date ? fmt.date(l.expected_date) : '—'}{l.overdue_days > 0 && <span className="ml-1 text-[10px] font-bold text-red-500">· {l.overdue_days}d late</span>}</td>
                            <td className={`${td} text-xs text-slate-500`}>{l.last_grn_at ? fmt.date(l.last_grn_at) : '—'}</td>
                            <td className={td}><StatusBadge status={l.status} /></td>
                            <td className={`${td} text-right`} onClick={e => e.stopPropagation()}>
                              <ActionMenu label="Line actions" items={[
                                { key: 'receive', label: 'Receive (create GRN)', icon: PackagePlus, onClick: () => setReceivePo({
                                  po: { id: l.po_id, po_number: l.po_number },
                                  line: { id: l.po_line_id, material_name: l.material_name, qty: l.qty, received_qty: l.received_qty },
                                  qty: '', batch_no: '', ...GRN_META() }) },
                                { key: 'open', label: 'Open PO', icon: Eye, onClick: () => navigate(`/procurement/po/${l.po_id}`) },
                              ]} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-slate-200 bg-slate-50/70 font-bold">
                          <td className={`${td} text-brand-600`} colSpan={4}>Filtered Total</td>
                          <td className={`${td} text-right tabular-nums`}>{fmt.num(ordered)}</td>
                          <td className={`${td} text-right tabular-nums`}>{fmt.num(received)}</td>
                          <td className={`${td} text-right tabular-nums text-amber-600`}>{fmt.num(t.pending_qty)}</td>
                          <td className={`${td} text-right tabular-nums text-amber-600`}>{fmt.kg(t.pending_weight)}</td>
                          <td className={td}></td>
                          <td className={`${td} text-right tabular-nums`}>{fmt.inr(t.pending_value)}</td>
                          <td className={td} colSpan={6}></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Item-wise / Party-wise / Grade-wise roll-ups ── */}
              {pendencyView !== 'lines' && (() => {
                const kind = pendencyView === 'items' ? { rows: pendency.by_material, head: 'Item' }
                  : pendencyView === 'grades' ? { rows: pendency.by_grade, head: 'Grade' }
                  : { rows: pendency.by_vendor, head: 'Party' };
                const rows = kind.rows || [];
                if (pendencyView === 'grades' && rows.length === 0)
                  return <p className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-gray-400">No board (graded) material is pending.</p>;
                return (
                  <div className="ci-data-panel">
                    <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.05] bg-white/30 px-4 py-2.5">
                      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{kind.head}-wise pending</span>
                      <ExportMenu build={() => ({
                        name: `Pendency ${kind.head}-wise`, title: `${kind.head}-wise Pendency`,
                        subtitle: 'Procurement · Pending roll-up',
                        columns: [
                          { key: 'label', label: kind.head, export: r => String(r.label).replace(/_/g, ' ') },
                          { key: 'lines', label: 'Lines', align: 'right' },
                          { key: 'po_count', label: 'POs', align: 'right' },
                          { key: 'pending_qty', label: 'Pending', align: 'right', export: r => fmt.num(r.pending_qty) },
                          { key: 'pending_weight', label: 'Pending kg', align: 'right', export: r => fmt.kg(r.pending_weight) },
                          { key: 'pending_value', label: 'Pending Value', align: 'right', export: r => fmt.inr(r.pending_value) },
                          { key: 'overdue', label: 'Ageing', align: 'right', export: r => (r.overdue > 0 ? `${r.overdue}d overdue` : `${r.max_age}d`) },
                        ],
                        rows,
                      })} />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="ci-table-head">
                          <th className={th}>{kind.head}</th>
                          <th className={`${th} text-right`}>Lines</th><th className={`${th} text-right`}>POs</th>
                          <th className={`${th} text-right`}>Pending</th><th className={`${th} text-right`}>Pending kg</th><th className={`${th} text-right`}>Pending Value</th><th className={`${th} text-right`}>Ageing</th>
                        </tr></thead>
                        <tbody>
                          {rows.map(r => (
                            <tr key={r.key} className="ci-table-row">
                              <td className={`${td} font-semibold capitalize text-slate-800`}>{String(r.label).replace(/_/g, ' ')}</td>
                              <td className={`${td} text-right tabular-nums text-slate-500`}>{r.lines}</td>
                              <td className={`${td} text-right tabular-nums text-slate-500`}>{r.po_count}</td>
                              <td className={`${td} text-right font-bold tabular-nums text-amber-600`}>{fmt.num(r.pending_qty)}</td>
                              <td className={`${td} text-right font-semibold tabular-nums ${r.pending_weight == null ? 'text-slate-300' : 'text-slate-700'}`}>{fmt.kg(r.pending_weight)}</td>
                              <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.inr(r.pending_value)}</td>
                              <td className={`${td} text-right text-xs tabular-nums ${r.overdue > 0 ? 'font-bold text-red-600' : 'text-slate-500'}`}>{r.overdue > 0 ? `${r.overdue}d overdue` : `${r.max_age}d`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </>
            );
          })()}
        </div>
      )}

      {/* ── New PR ── one shared form; Warehouse opens the same component ── */}
      <NewRequisitionModal
        open={!!newPr}
        onClose={() => setNewPr(null)}
        onRaised={load}
        defaults={{ purpose: 'production' }} />

      {/* ── PR view / edit ── */}
      <Modal open={!!prModal} onClose={() => setPrModal(null)} wide
        title={prModal ? `${prModal.pr.pr_number} — ${fmt.title(prModal.pr.status)}` : ''}
        footer={prModal && (prModal.edit ? <>
          <Button variant="secondary" onClick={() => setPrModal(null)}>Cancel</Button>
          <Button onClick={savePrEdit} disabled={!prModal.form.lines.some(l => l.material_id && +l.qty > 0)}>Save Changes</Button>
        </> : <>
          <Button variant="secondary" onClick={() => setPrModal(null)}>Close</Button>
          {['pending', 'approved'].includes(prModal.pr.status) && (
            <Button onClick={() => setPrModal(m => ({ ...m, edit: true }))}><Pencil size={14} /> Edit</Button>
          )}
          {prModal.pr.status === 'pending' && (
            <Button variant="success" onClick={async () => { await api.post(`/requisitions/${prModal.pr.id}/approve`); toast.success('Approved'); setPrModal(null); load(); }}>
              <CheckCircle2 size={14} /> Approve
            </Button>
          )}
          {prModal.pr.status === 'approved' && (
            <Button onClick={() => { openConvert(prModal.pr); setPrModal(null); }}>
              <ShoppingBag size={14} /> Create PO
            </Button>
          )}
        </>)}>
        {prModal && (prModal.edit ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Requested By">
                <Input value={prModal.form.requested_by} onChange={e => setPrModal(m => ({ ...m, form: { ...m.form, requested_by: e.target.value } }))} />
              </Field>
              <Field label="Department">
                <Input value={prModal.form.department} onChange={e => setPrModal(m => ({ ...m, form: { ...m.form, department: e.target.value } }))} />
              </Field>
              <Field label="Needed By">
                <Input type="date" value={prModal.form.needed_by} onChange={e => setPrModal(m => ({ ...m, form: { ...m.form, needed_by: e.target.value } }))} />
              </Field>
              <Field label="Priority">
                <Select value={prModal.form.priority} onChange={e => setPrModal(m => ({ ...m, form: { ...m.form, priority: e.target.value } }))}>
                  <option value="low">Low</option><option value="normal">Normal</option><option value="urgent">Urgent</option>
                </Select>
              </Field>
            </div>
            <PrLineEditor lines={prModal.form.lines} materials={materials} activePrsFor={() => []} rateFor={rateFor} stockFor={stockFor}
              onChange={lines => setPrModal(m => ({ ...m, form: { ...m.form, lines } }))} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Reason">
                <Textarea value={prModal.form.reason} onChange={e => setPrModal(m => ({ ...m, form: { ...m.form, reason: e.target.value } }))} />
              </Field>
              <Field label="Remarks">
                <Textarea value={prModal.form.remarks} onChange={e => setPrModal(m => ({ ...m, form: { ...m.form, remarks: e.target.value } }))} />
              </Field>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['Items', `${(prModal.pr.lines || []).length || 1} item(s)`],
                ['Est. Value', fmt.inr(prModal.pr.est_value || 0)],
                ['Needed By', fmt.date(prModal.pr.needed_by)], ['Raised', fmt.date(prModal.pr.created_at)],
                ['Requested By', prModal.pr.requested_by || '—'], ['Department', prModal.pr.department || '—'],
                ['Priority', fmt.title(prModal.pr.priority || 'normal')],
                ['Re-raise Of', prModal.pr.reraise_of_number || '—']]
                .map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                    <div className="text-sm font-bold text-slate-800">{v}</div>
                  </div>))}
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-100">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-slate-50 text-left text-[11px] font-bold uppercase text-slate-400">
                  <th className="px-3 py-1.5">Board</th><th className="px-3 py-1.5 text-right">Qty</th>
                  <th className="px-3 py-1.5 text-right">Est. Rate</th><th className="px-3 py-1.5 text-right">Est. Value</th>
                  <th className="px-3 py-1.5">Remark</th>
                </tr></thead>
                <tbody>
                  {(prModal.pr.lines?.length ? prModal.pr.lines : [{ material_name: prModal.pr.material_name, qty: prModal.pr.qty, unit: prModal.pr.unit }]).map((l, i) => (
                    <tr key={i} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-1.5">{l.material_name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(l.qty)} {l.unit || ''}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{l.est_rate != null ? fmt.inr(l.est_rate) : '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt.inr((+l.qty || 0) * (+l.est_rate || 0))}</td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">{l.remarks || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {prModal.pr.reraise_reason && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                Re-raised over {prModal.pr.reraise_of_number}: {prModal.pr.reraise_reason}
              </p>
            )}
            {prModal.pr.reason && <p className="text-sm text-slate-600">Reason: {prModal.pr.reason}</p>}
            {prModal.pr.remarks && <p className="text-sm text-slate-500">Remarks: {prModal.pr.remarks}</p>}
            {prModal.pr.status_reason && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">Closed: {prModal.pr.status_reason}</p>}
            {prModal.pr.po_number && <p className="text-xs text-slate-500">Converted into <b>{prModal.pr.po_number}</b></p>}
          </div>
        ))}
      </Modal>

      {/* ── Close PR with reason ── */}
      <Modal open={!!closePr} onClose={() => setClosePr(null)} title={closePr ? `Close ${closePr.pr.pr_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setClosePr(null)}>Cancel</Button>
          <Button variant="danger" disabled={!closePr?.reason.trim()} onClick={async () => {
            await api.post(`/requisitions/${closePr.pr.id}/close`, { reason: closePr.reason });
            toast.info(`${closePr.pr.pr_number} closed`); setClosePr(null); load();
          }}><Ban size={14} /> Close Requisition</Button>
        </>}>
        {closePr && <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Close <b>{closePr.pr.pr_number}</b> ({closePr.pr.material_name} · {fmt.num(closePr.pr.qty)} {closePr.pr.unit})?
            It will no longer be convertible to a purchase order.
          </p>
          <Field label="Reason" required>
            <Textarea value={closePr.reason} onChange={e => setClosePr({ ...closePr, reason: e.target.value })}
              placeholder="e.g. stock arranged internally, duplicate PR, requirement dropped" />
          </Field>
        </div>}
      </Modal>

      {/* ── Convert single PR → PO ── */}
      <Modal open={!!convertPr} onClose={() => setConvertPr(null)} title={convertPr ? `Create PO from ${convertPr.pr.pr_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setConvertPr(null)}>Cancel</Button>
          <Button disabled={!convertPr?.vendor_id || !convertPr?.lines.some(l => l.material_id && +l.qty > 0)} onClick={async () => {
            try {
              const lines = convertPr.lines.filter(l => l.material_id && +l.qty > 0).map(l => ({
                material_id: +l.material_id, qty: +l.qty, rate: +l.rate || 0, hsn_code: l.hsn_code || null,
                unit: l.unit || null, discount_pct: +l.discount_pct || 0, gst_rate: +l.gst_rate || 0 }));
              const po = await api.post(`/requisitions/${convertPr.pr.id}/convert`, {
                vendor_id: +convertPr.vendor_id, expected_date: convertPr.expected_date || undefined, lines,
                tax_kind: convertPr.tax_kind, freight: convertPr.freight || 0, round_off: convertPr.round_off === '' ? undefined : convertPr.round_off,
                vendor_notes: convertPr.vendor_notes || undefined, payment_terms: convertPr.payment_terms || undefined,
                delivery_terms: convertPr.delivery_terms || undefined, reference: convertPr.reference || undefined,
              });
              toast.success(`${po.po_number} created`); setConvertPr(null); load(); setTab('pos');
            } catch (e) { toast.error(e.message || 'Could not create PO'); }
          }}>Create PO</Button>
        </>}>
        {convertPr && <div className="space-y-3">
          {(convertPr.pr.reason || convertPr.pr.remarks) && (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              From {convertPr.pr.pr_number}
              {convertPr.pr.reason ? <span className="block text-slate-400">PR reason: {convertPr.pr.reason}</span> : null}
              {convertPr.pr.remarks ? <span className="block text-slate-400">PR remarks: {convertPr.pr.remarks}</span> : null}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Vendor" required>
              {/* keyed on vendor_id so the label resyncs on cancel-restore — see changePoVendor */}
              <Select key={`ven-${convertPr.vendor_id}`} value={convertPr.vendor_id}
                onChange={e => changePoVendor(convertPr, setConvertPr, e.target.value)}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
              </Select>
              {vendorById(convertPr.vendor_id)?.gstin && <div className="mt-1 text-[11px] text-slate-400">GSTIN {vendorById(convertPr.vendor_id).gstin}</div>}
            </Field>
            <Field label="Expected Delivery"><Input type="date" value={convertPr.expected_date} onChange={e => setConvertPr({ ...convertPr, expected_date: e.target.value })} /></Field>
            <Field label="Tax Type"><TaxKindToggle value={convertPr.tax_kind} onChange={k => setConvertPr({ ...convertPr, tax_kind: k })} /></Field>
          </div>
          <PoLineEditor lines={convertPr.lines} materials={materials} rateFor={rateFor} stockFor={stockFor}
            onChange={lines => setConvertPr({ ...convertPr, lines })}
            onQuickCreate={i => setQuickMat({ target: 'convertpo', line: i })} />
          <PoTotalsPanel lines={convertPr.lines} materials={materials} taxKind={convertPr.tax_kind}
            freight={convertPr.freight} roundOff={convertPr.round_off}
            onFreight={v => setConvertPr({ ...convertPr, freight: v })} onRoundOff={v => setConvertPr({ ...convertPr, round_off: v })} />
          <PoMetaFields value={convertPr} onChange={patch => setConvertPr(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── Multi-PR → one PO ── */}
      <Modal open={!!bulkPo} onClose={() => setBulkPo(null)} title={`One PO from ${selectedIds.length} requisitions`} wide
        footer={<>
          <Button variant="secondary" onClick={() => setBulkPo(null)}>Cancel</Button>
          <Button disabled={!bulkPo?.vendor_id} onClick={createBulkPo}><ShoppingBag size={14} /> Create Purchase Order</Button>
        </>}>
        {bulkPo && <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Vendor" required hint="All selected requisitions go to this single vendor">
              {/* keyed on vendor_id so the label resyncs on vendor change — see changePoVendor */}
              <Select key={`ven-${bulkPo.vendor_id}`} value={bulkPo.vendor_id}
                onChange={async e => {
                  // Unlike Direct/Edit/convert, the bulk path reprices board rates
                  // on vendor change WITHOUT a manual-edit confirm: this is a fresh
                  // creation where the vendor is chosen before any rate is typed
                  // (rates are auto-seeded from the base grade rate at open), so
                  // there is no hand-edited number to protect. Overwriting is safe.
                  const nv = e.target.value; const v = vendorById(nv);
                  const map = await loadBoardRates(nv || null);
                  setBulkPo(s => {
                    const rates = { ...s.rates };
                    for (const m of s.materials) { const b = map.get(String(m.material_id)); if (b && b.rate != null) rates[m.material_id] = String(b.rate); }
                    return { ...s, vendor_id: nv, tax_kind: taxKindFor(company, v), rates };
                  });
                }}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
              </Select>
            </Field>
            <Field label="Expected Delivery">
              <Input type="date" value={bulkPo.expected_date} onChange={e => setBulkPo({ ...bulkPo, expected_date: e.target.value })} />
            </Field>
            <Field label="Tax Type"><TaxKindToggle value={bulkPo.tax_kind} onChange={k => setBulkPo({ ...bulkPo, tax_kind: k })} /></Field>
          </div>
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>PO lines — grouped by material</span><span>{bulkPo.materials.length} line{bulkPo.materials.length > 1 ? 's' : ''}</span></div>
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-1.5">Board</th><th className="px-3 py-1.5">From PRs</th>
                <th className="px-3 py-1.5 text-right">Total Qty</th><th className="px-3 py-1.5 text-right">Rate ₹</th>
              </tr></thead>
              <tbody>
                {bulkPo.materials.map(m => (
                  <tr key={m.material_id} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-2 font-semibold">{m.material_name}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{m.prs.join(', ')}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(m.qty)} {m.unit}</td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" step="0.01" min="0" placeholder="0"
                        value={bulkPo.rates[m.material_id] ?? ''}
                        onChange={e => setBulkPo(b => ({ ...b, rates: { ...b.rates, [m.material_id]: e.target.value } }))}
                        className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm focus:border-brand-500 focus:outline-none" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <PoTotalsPanel lines={bulkPoLines()} materials={materials} taxKind={bulkPo.tax_kind}
            freight={bulkPo.freight} roundOff={bulkPo.round_off}
            onFreight={v => setBulkPo({ ...bulkPo, freight: v })} onRoundOff={v => setBulkPo({ ...bulkPo, round_off: v })} />
          <PoMetaFields value={bulkPo} onChange={patch => setBulkPo(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── Direct PO (no PR) ── */}
      <Modal open={!!directPo} onClose={() => { if (!quickMat) setDirectPo(null); }} title="Direct Purchase Order" wide
        footer={<>
          <Button variant="secondary" onClick={() => setDirectPo(null)}>Cancel</Button>
          <Button disabled={!directPo?.vendor_id || !directPo?.lines.some(l => l.material_id && +l.qty > 0)}
            onClick={async () => {
              try {
                const lines = directPo.lines.filter(l => l.material_id && +l.qty > 0)
                  .map(l => ({ material_id: +l.material_id, qty: +l.qty, rate: +l.rate || 0, hsn_code: l.hsn_code || null,
                    unit: l.unit || null, discount_pct: +l.discount_pct || 0, gst_rate: +l.gst_rate || 0 }));
                const po = await api.post('/purchase-orders', {
                  vendor_id: +directPo.vendor_id, expected_date: directPo.expected_date || undefined, lines,
                  tax_kind: directPo.tax_kind, freight: directPo.freight || 0, round_off: directPo.round_off === '' ? undefined : directPo.round_off,
                  vendor_notes: directPo.vendor_notes || undefined, payment_terms: directPo.payment_terms || undefined,
                  delivery_terms: directPo.delivery_terms || undefined, reference: directPo.reference || undefined,
                });
                toast.success(`${po.po_number} created`); setDirectPo(null); load(); setTab('pos');
              } catch (e) { toast.error(e.message || 'Could not create PO'); }
            }}>Create PO</Button>
        </>}>
        {directPo && <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Vendor" required>
              {/* keyed on vendor_id so the label resyncs on cancel-restore — see changePoVendor */}
              <Select key={`ven-${directPo.vendor_id}`} value={directPo.vendor_id}
                onChange={e => changePoVendor(directPo, setDirectPo, e.target.value)}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
              </Select>
              {vendorById(directPo.vendor_id)?.gstin && <div className="mt-1 text-[11px] text-slate-400">GSTIN {vendorById(directPo.vendor_id).gstin}{vendorById(directPo.vendor_id).state ? ` · ${vendorById(directPo.vendor_id).state}` : ''}</div>}
            </Field>
            <Field label="Expected Delivery">
              <Input type="date" value={directPo.expected_date} onChange={e => setDirectPo({ ...directPo, expected_date: e.target.value })} />
            </Field>
            <Field label="Tax Type"><TaxKindToggle value={directPo.tax_kind} onChange={k => setDirectPo({ ...directPo, tax_kind: k })} /></Field>
          </div>
          <PoLineEditor lines={directPo.lines} materials={materials} rateFor={rateFor} stockFor={stockFor}
            onChange={lines => setDirectPo({ ...directPo, lines })}
            onQuickCreate={i => setQuickMat({ target: 'po', line: i })} />
          <PoTotalsPanel lines={directPo.lines} materials={materials} taxKind={directPo.tax_kind}
            freight={directPo.freight} roundOff={directPo.round_off}
            onFreight={v => setDirectPo({ ...directPo, freight: v })} onRoundOff={v => setDirectPo({ ...directPo, round_off: v })} />
          <PoMetaFields value={directPo} onChange={patch => setDirectPo(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── Edit an existing PO ── */}
      <Modal open={!!editPo} onClose={() => { if (!quickMat) setEditPo(null); }} title={editPo ? `Edit ${editPo.po_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setEditPo(null)}>Cancel</Button>
          <Button disabled={!editPo?.vendor_id || !editPo?.lines.some(l => l.material_id && +l.qty > 0)} onClick={saveEditPo}>Save Changes</Button>
        </>}>
        {editPo && <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Vendor" required>
              {/* keyed on vendor_id so the label resyncs on cancel-restore — see changePoVendor */}
              <Select key={`ven-${editPo.vendor_id}`} value={editPo.vendor_id}
                onChange={e => changePoVendor(editPo, setEditPo, e.target.value)}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
              </Select>
            </Field>
            <Field label="Expected Delivery">
              <Input type="date" value={editPo.expected_date} onChange={e => setEditPo({ ...editPo, expected_date: e.target.value })} />
            </Field>
            <Field label="Tax Type"><TaxKindToggle value={editPo.tax_kind} onChange={k => setEditPo({ ...editPo, tax_kind: k })} /></Field>
          </div>
          <PoLineEditor lines={editPo.lines} materials={materials} rateFor={rateFor} stockFor={stockFor} lockFn={l => l.committed_qty > 0}
            onChange={lines => setEditPo({ ...editPo, lines })}
            onQuickCreate={i => setQuickMat({ target: 'editpo', line: i })} />
          <PoTotalsPanel lines={editPo.lines} materials={materials} taxKind={editPo.tax_kind}
            freight={editPo.freight} roundOff={editPo.round_off}
            onFreight={v => setEditPo({ ...editPo, freight: v })} onRoundOff={v => setEditPo({ ...editPo, round_off: v })} />
          <PoMetaFields value={editPo} onChange={patch => setEditPo(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── Receive one PO line ── */}
      <Modal open={!!receivePo} onClose={() => setReceivePo(null)} title={receivePo ? `Receive — ${receivePo.po.po_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setReceivePo(null)}>Cancel</Button>
          <Button disabled={!receivePo?.qty} onClick={async () => {
            await api.post('/grns', {
              po_line_id: receivePo.line.id, qty: +receivePo.qty, batch_no: receivePo.batch_no || undefined,
              vehicle_no: receivePo.vehicle_no || undefined, supplier_invoice_no: receivePo.supplier_invoice_no || undefined,
              supplier_invoice_date: receivePo.supplier_invoice_date || undefined,
              received_by: receivePo.received_by || undefined, remarks: receivePo.remarks || undefined,
            });
            toast.success('GRN created — material in quarantine until QC'); setReceivePo(null); load(); setTab('grns');
          }}>Create GRN</Button>
        </>}>
        {receivePo && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {receivePo.line.material_name} — ordered {fmt.num(receivePo.line.qty)}, received so far {fmt.num(receivePo.line.received_qty)}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity Received" required><Input type="number" value={receivePo.qty} onChange={e => setReceivePo({ ...receivePo, qty: e.target.value })} /></Field>
            <Field label="Supplier Batch No"><Input value={receivePo.batch_no} onChange={e => setReceivePo({ ...receivePo, batch_no: e.target.value })} placeholder="auto if blank" /></Field>
          </div>
          <GrnMetaFields value={receivePo} onChange={patch => setReceivePo(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── Whole-PO GRN (partial / full) ── */}
      <Modal open={!!grnPo} onClose={() => setGrnPo(null)} title={grnPo ? `Create GRN — ${grnPo.po.po_number} (${grnPo.po.vendor_name})` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setGrnPo(null)}>Cancel</Button>
          <Button variant="ghost" onClick={() => setGrnPo(g => ({
            ...g, lines: g.lines.map(l => ({ ...l, receive_qty: String(Math.max(0, l.qty - l.received_qty)) })),
          }))}><Truck size={14} /> Fill Full Balance</Button>
          <Button onClick={createBulkGrn} disabled={!grnPo?.lines.some(l => +l.receive_qty > 0)}>
            <PackagePlus size={14} /> Create GRN{grnPo?.lines.filter(l => +l.receive_qty > 0).length > 1 ? 's' : ''}
          </Button>
        </>}>
        {grnPo && <div className="space-y-3">
          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            Enter what physically arrived — partial receipt is fine, the PO status tracks it
            (Pending → Partially Received → Fully Received). Every receipt lands in quarantine until QC releases it.
          </p>
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
              <th className="px-3 py-1.5">Board</th><th className="px-3 py-1.5 text-right">Ordered</th>
              <th className="px-3 py-1.5 text-right">Received</th><th className="px-3 py-1.5 text-right">Balance</th>
              <th className="px-3 py-1.5 text-right">Receive Now</th><th className="px-3 py-1.5">Batch No</th>
            </tr></thead>
            <tbody>
              {grnPo.lines.map((l, i) => (
                <tr key={l.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-3 py-2">{l.material_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)} {l.unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.received_qty)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-amber-600">{fmt.num(l.qty - l.received_qty)}</td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" min="0" value={l.receive_qty}
                      onChange={e => setGrnPo(g => ({ ...g, lines: g.lines.map((x, j) => j === i ? { ...x, receive_qty: e.target.value } : x) }))}
                      className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm focus:border-brand-500 focus:outline-none" />
                  </td>
                  <td className="px-3 py-2">
                    <input placeholder="auto" value={l.batch_no}
                      onChange={e => setGrnPo(g => ({ ...g, lines: g.lines.map((x, j) => j === i ? { ...x, batch_no: e.target.value } : x) }))}
                      className="w-32 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Receipt context</span><span>applies to every GRN in this receipt</span></div>
            <GrnMetaFields value={grnPo} onChange={patch => setGrnPo(s => ({ ...s, ...patch }))} />
          </section>
        </div>}
      </Modal>

      {/* ── Create GRN — against an open PO, or a direct (no-PO) receipt ──
          Both tabs are the PO form's own card, totals panel and tax toggle, so a
          receipt and an order cannot compute money differently. ── */}
      <Modal open={!!newGrn} onClose={() => { if (!quickMat) setNewGrn(null); }} title="Create GRN" wide
        footer={<>
          <Button variant="secondary" onClick={() => setNewGrn(null)}>Cancel</Button>
          <Button variant="success" onClick={createNewGrn}
            disabled={newGrn?.mode === 'direct'
              ? !newGrn?.lines?.some(l => l.material_id && +l.qty > 0)
              : !newGrn?.lines?.some(l => +l.qty > 0)}>
            <PackagePlus size={14} /> Create GRN
          </Button>
        </>}>
        {newGrn && <div className="space-y-3">
          <SubTabs active={newGrn.mode} onChange={switchGrnMode} views={[
            { key: 'direct', label: 'Direct — No PO' },
            { key: 'po', label: 'Against Open PO' },
          ]} />

          {newGrn.mode === 'po' ? (
            <Field label="Open Purchase Order" required>
              <Select value={newGrn.po_id} onChange={e => pickNewGrnPo(e.target.value)}>
                <option value="">Select an open PO…</option>
                {pos.filter(p => p.status !== 'received' && p.status !== 'closed').map(p => (
                  <option key={p.id} value={p.id} data-search={searchText(p)}>{p.po_number} — {p.vendor_name}</option>))}
              </Select>
            </Field>
          ) : (
            <>
              <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
                Board received without a purchase order (sample, urgent buy, stock correction). It lands in
                quarantine and goes through QC exactly like a PO receipt, then into stock. Price every line —
                a direct receipt is what Accounts books the purchase from.
              </div>
              <Field label="Supplier (optional)" hint="Sets the tax split and prices boards at this vendor's rate">
                {/* keyed on vendor_id so the label resyncs on cancel-restore — see changePoVendor */}
                <Select key={`grnven-${newGrn.vendor_id}`} value={newGrn.vendor_id}
                  onChange={e => changePoVendor(newGrn, setNewGrn, e.target.value)}>
                  <option value="">— unknown —</option>
                  {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
                </Select>
                {vendorById(newGrn.vendor_id)?.gstin && <div className="mt-1 text-[11px] text-slate-400">GSTIN {vendorById(newGrn.vendor_id).gstin}{vendorById(newGrn.vendor_id).state ? ` · ${vendorById(newGrn.vendor_id).state}` : ''}</div>}
              </Field>
            </>
          )}

          {newGrn.mode === 'po' && newGrn.po_id && newGrn.lines.length === 0 ? (
            <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-500">This PO is fully received — nothing pending to receive.</p>
          ) : (newGrn.mode === 'direct' || newGrn.po_id) && (
            <GrnLineEditor mode={newGrn.mode} lines={newGrn.lines} materials={materials}
              rateFor={rateFor} stockFor={stockFor}
              onChange={lines => setNewGrn(s => ({ ...s, lines }))}
              onQuickCreate={newGrn.mode === 'direct' ? i => setQuickMat({ target: 'grn', line: i }) : undefined} />
          )}

          <PoTotalsPanel title="Receipt tax & totals" lines={newGrn.lines} materials={materials}
            taxKind={newGrn.tax_kind} freight={newGrn.freight} roundOff={newGrn.round_off}
            onFreight={v => setNewGrn(s => ({ ...s, freight: v }))}
            onRoundOff={v => setNewGrn(s => ({ ...s, round_off: v }))} />

          <Field label="Tax Type"><TaxKindToggle value={newGrn.tax_kind}
            onChange={k => setNewGrn(s => ({ ...s, tax_kind: k }))} /></Field>

          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Receipt context</span><span>vehicle, invoice, received by</span></div>
            <GrnMetaFields value={newGrn} onChange={patch => setNewGrn(s => ({ ...s, ...patch }))} />
          </section>
        </div>}
      </Modal>

      {/* ── Edit GRN (before QC) ── a receipt is corrected as a whole document:
          the lines it arrived with, each repriced or recounted, plus the header
          context. Lines cannot be added or removed. ── */}
      <Modal open={!!editGrn} onClose={() => setEditGrn(null)} wide title={editGrn ? `Edit ${editGrn.grn_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setEditGrn(null)}>Cancel</Button>
          <Button onClick={saveEditGrn} disabled={!editGrn?.lines?.every(l => +l.qty > 0)}>Save Changes</Button>
        </>}>
        {editGrn && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {editGrn.po_number ? `Against ${editGrn.po_number}` : 'Direct receipt (no PO)'} · {editGrn.lines.length} line{editGrn.lines.length === 1 ? '' : 's'}
            {' '}— correct a receipt entered in error, before QC. Quantity and rate follow through to the stock batch.
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-slate-50 text-left text-[11px] font-bold uppercase text-slate-400">
                <th className="px-3 py-1.5">Board</th><th className="px-3 py-1.5 text-right">Qty</th>
                <th className="px-3 py-1.5 text-right">Rate ₹</th><th className="px-3 py-1.5 text-right">Disc %</th>
                <th className="px-3 py-1.5 text-right">GST %</th><th className="px-3 py-1.5">Batch No</th>
                <th className="px-3 py-1.5 text-right">Amount</th>
              </tr></thead>
              <tbody>
                {editGrn.lines.map((l, i) => {
                  const set = patch => setEditGrn(s => ({ ...s, lines: s.lines.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
                  const cell = 'w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none';
                  return (
                    <tr key={l.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-700">{l.material_name}</div>
                        <div className="text-[11px] text-slate-400">{l.unit}{l.status !== 'quarantine' ? ` · already ${l.status}` : ''}</div>
                      </td>
                      <td className="px-3 py-2"><input type="number" min="0" value={l.qty}
                        onChange={e => set({ qty: e.target.value })} className={`${cell} w-24 text-right`} /></td>
                      <td className="px-3 py-2"><input type="number" min="0" step="0.01" value={l.rate}
                        onChange={e => set({ rate: e.target.value })} className={`${cell} w-24 text-right`} /></td>
                      <td className="px-3 py-2"><input type="number" min="0" max="100" step="0.01" value={l.discount_pct}
                        onChange={e => set({ discount_pct: e.target.value })} className={`${cell} w-20 text-right`} /></td>
                      <td className="px-3 py-2"><input type="number" min="0" step="0.01" value={l.gst_rate}
                        onChange={e => set({ gst_rate: e.target.value })} className={`${cell} w-20 text-right`} /></td>
                      <td className="px-3 py-2"><input value={l.batch_no} placeholder="auto"
                        onChange={e => set({ batch_no: e.target.value })} className={`${cell} w-36`} /></td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmt.inr((+l.qty || 0) * (+l.rate || 0))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <GrnMetaFields value={editGrn} onChange={patch => setEditGrn(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── GRN QC decision ── one line, or a sweep over everything still
          pending on the receipt. Accept-all only: see acceptAllGrn. ── */}
      <Modal open={!!qcGrn} onClose={() => setQcGrn(null)}
        title={qcGrn ? (qcGrn.all ? `Accept all — ${qcGrn.header.grn_number}` : `QC — ${qcGrn.line.grn_number}`) : ''}
        footer={qcGrn && (qcGrn.all ? (
          <>
            <Button variant="secondary" onClick={() => setQcGrn(null)}>Cancel</Button>
            <Button variant="success" onClick={() => acceptAllGrn(qcGrn.header, qcGrn.note)}>
              <CheckCircle2 size={14} /> Accept All &amp; Release
            </Button>
          </>
        ) : (
          <>
            <Button variant="danger" onClick={() => decideLine(qcGrn.line, false, qcGrn.note)}>Reject</Button>
            <Button variant="success" onClick={() => decideLine(qcGrn.line, true, qcGrn.note)}>Accept &amp; Release</Button>
          </>
        ))}>
        {qcGrn && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {qcGrn.all ? (
              <>Releases the {qcGrn.open} line{qcGrn.open === 1 ? '' : 's'} still in quarantine on {qcGrn.header.grn_number} into stock.
                Lines already decided are left exactly as they are. Reject a lot line by line — there is no sweep-reject.</>
            ) : (
              <>{qcGrn.line.material_name} · {fmt.num(qcGrn.line.qty)} {qcGrn.line.unit} · batch {qcGrn.line.batch_no}</>
            )}
          </div>
          <Field label="QC Note"><Textarea value={qcGrn.note} onChange={e => setQcGrn({ ...qcGrn, note: e.target.value })} placeholder="GSM check, shade, moisture…" /></Field>
        </div>}
      </Modal>

      {/* ── Delete / send-back / reprice confirmation ── onCancel (when present)
          runs on dismissal so a cancelled vendor-reprice can roll everything
          back; a commit flag stops it firing after a real confirm. ── */}
      <ConfirmDialog open={!!confirm} onClose={() => { if (confirm && !confirm._committed) confirm.onCancel?.(); setConfirm(null); }}
        title={confirm?.title} message={confirm?.message}
        confirmLabel={confirm?.confirmLabel} danger={confirm?.danger} hideCancel={confirm?.hideCancel}
        onConfirm={() => { if (confirm) confirm._committed = true; confirm?.onConfirm?.(); }} />

      {/* Quick-create material — stacks above the PR / Direct PO modal that opened it */}
      <MaterialQuickCreate open={!!quickMat} onClose={() => setQuickMat(null)} onCreated={handleMaterialCreated} />

      <BoardCommitments
        open={!!boardPanel}
        onClose={() => setBoardPanel(null)}
        materialId={boardPanel?.materialId}
        prContext={boardPanel?.pr}
        onChanged={load} />
    </div>
  );
}
