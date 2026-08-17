// Procurement — PR → PO → GRN → QC. Every arrow is a real record.
// Row-level PR actions (view/edit/approve/convert/close), multi-select PRs
// into ONE purchase order, direct POs without a PR, partial/full GRN in one
// modal, and a pendency dashboard (vendor / category / material / PO-wise).
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { ActionMenu, Button, ConfirmDialog, DataTable, dueDelta, ExportMenu, Field, FulfillmentBar, Input, Modal, PageHeader, ResetFilters, searchText, Select, StatusBadge, SubTabs, Tabs, Textarea, useFilterReset, useToast } from '../components/ui.jsx';
// One chip shape for every filter rail in the ERP — see FilterChip.jsx.
import { FilterChip, FilterGroup, FilterRail } from '../components/FilterChip.jsx';
import { ThreadCell, threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { MaterialQuickCreate } from '../components/QuickCreateMasters.jsx';
import { PrLineEditor, PoLineEditor, PoTotalsPanel, TaxKindToggle } from '../components/ProcurementForms.jsx';
import NewRequisitionModal from '../components/NewRequisitionModal.jsx';
import BoardCommitments from '../components/BoardCommitments.jsx';
import GrnSubstitutionPanel from '../components/GrnSubstitutionPanel.jsx';
import { poTotals, taxKindFor } from '../lib/poTotals.js';
import { canRetireRequisitions } from '../lib/requisitionControls.js';
import { consolidate, consolidateEdit, mergeSummary } from '../lib/poConsolidate.js';
import { clubSuggestions } from '../lib/prClubbing.js';
import { ratePerSheet, packets, totalWeight, packetRate, ratePerKgFromSheet } from '../lib/boardMath.js';
import { Plus, Pencil, CheckCircle2, XCircle, ShoppingBag, PackagePlus, Download, Ban, Eye, Truck, Trash2, Undo2, Package, AlertTriangle } from 'lucide-react';

// PO document terms shared by every PO form (convert / bulk / direct / edit).
// The extra fact a club pill carries past its headline. Amber when there is
// still something to do before it can go on an order — a pending approval, or
// lines that need merging.
function ClubTag({ tone, children }) {
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold ${tone === 'amber'
      ? 'bg-amber-100 text-amber-700' : 'bg-violet-100 text-violet-700'}`}>{children}</span>
  );
}

// One axis of the club strip. Three pills show; the tail is one click away
// rather than silently dropped, because "3 shown" reads as "3 exist". Same
// geometry as Planning's gang bands so the two read as one system.
function ClubBand({ label, note, items, chip, onPick }) {
  const [all, setAll] = useState(false);
  const SHOWN = 3;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-[132px] text-[11px] font-bold text-violet-700">{label}</span>
      {(all ? items : items.slice(0, SHOWN)).map(s => (
        <button key={s.kind === 'within-pr' ? `${s.requisition_id}|${s.material_id}` : `m${s.material_id}`}
          type="button" onClick={() => onPick(s)}
          className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100 touch:min-h-[38px]">
          {chip(s)}
        </button>
      ))}
      {items.length > SHOWN && (
        <button type="button" onClick={() => setAll(a => !a)}
          className="text-[11px] font-bold text-violet-500 underline-offset-2 hover:underline">
          {all ? 'Show less' : `+${items.length - SHOWN} more`}
        </button>
      )}
      <span className="text-[11px] text-violet-400">{note}</span>
    </div>
  );
}

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
  const [subLineId, setSubLineId] = useState(null);   // PO line being received as a DIFFERENT board
  const [qcGrn, setQcGrn] = useState(null);
  const [editGrn, setEditGrn] = useState(null); // { grn, qty, batch_no }
  const [cover, setCover] = useState(null); // { grn, data, qty: { order_line_id: '…' } } — Cover Board modal
  const [coverBusy, setCoverBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [quickMat, setQuickMat] = useState(null); // { target: 'po' | 'editpo' | 'convertpo', line: i }
  const [boardPanel, setBoardPanel] = useState(null); // { materialId, pr }
  const [pendencyView, setPendencyView] = useState('lines'); // lines | items | parties
  // Each register splits into "still needs action" vs "done", so pendency is
  // one glance away instead of buried among converted/received/closed rows.
  const [prView, setPrView] = useState('open');      // open (pending+approved) | converted | closed
  // The register's own axes, narrower than the view tabs above them. "Open"
  // holds two queues that belong to different people — a PR waiting on an
  // approver and one waiting on the buyer — and the tab could not tell them
  // apart. See the rail below.
  const [prWaiting, setPrWaiting] = useState(null);  // null | 'approval' | 'buyer'
  const [prOverdue, setPrOverdue] = useState(false);
  const [prUrgent, setPrUrgent] = useState(false);
  const [clubHidden, setClubHidden] = useState(false); // the club strip is a suggestion, not a nag
  const [poView, setPoView] = useState('pending');   // pending (awaiting receipt) | completed
  // The order register's own axes, same shape as the requisition rail above.
  // "Pending" holds two different chases — an order the vendor has not started
  // and one part-delivered — and "Completed" holds an order still waiting to be
  // closed alongside ones already shut.
  const [poReceipt, setPoReceipt] = useState(null);  // null | 'none' | 'part'   (pending view)
  const [poStage, setPoStage] = useState(null);      // null | 'received' | 'closed' (completed view)
  const [poOverdue, setPoOverdue] = useState(false); // pending view
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
      // kg_rate is the buyer's own ₹/kg keystrokes and outranks the line's stored
      // ₹/sheet in the editor — leaving it behind here would show the old
      // vendor's rate on a line that has just been repriced to the new one.
      return b.rate != null
        ? { ...l, rate: String(b.rate), kg_rate: null, rate_source: b.source, rate_per_kg: b.rate_per_kg }
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
      // Same reason as fillFromMaterial: a ₹/kg typed against the board that used
      // to sit on this line must not survive onto the one replacing it.
      kg_rate: null,
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
      threadSummary('grn', gs.map(g => g.id)).then(setGrnThreads).catch(() => {});
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
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });

  // Stable identity, keyed on the stock array. The board picker memoizes its
  // option list on this function, and a fresh closure per render would rebuild
  // 303 option haystacks on every keystroke in every field of the form.
  const stockFor = useCallback(id => stock.find(s => String(s.id) === String(id)) || null, [stock]);

  // Vendor picked on a PO form → auto-set intra/inter-state from the two states.
  const vendorById = id => vendors.find(v => String(v.id) === String(id));

  const selectedPrs = prs.filter(p => selectedIds.includes(p.id));

  // Boards worth buying on one order instead of several. Derived from the
  // register the page already holds — no second endpoint to keep in step.
  const clubs = useMemo(() => clubSuggestions(prs), [prs]);

  // Open a requisition that names one board on several lines, with those lines
  // already merged — the same consolidate() the PO forms use, so the register
  // and the order agree about what "clubbed" means. Nothing is saved until the
  // buyer presses Save Changes.
  const openPrClub = s => {
    const pr = prs.find(p => p.id === s.requisition_id);
    if (!pr) return;
    const rows = consolidate((pr.lines || []).map(l => ({
      material_id: String(l.material_id), qty: String(l.qty), unit: l.unit || '',
      est_rate: l.est_rate != null ? String(l.est_rate) : '', remarks: l.remarks || '',
    })));
    setPrModal({
      pr, edit: true,
      form: {
        requested_by: pr.requested_by || '', department: pr.department || '',
        needed_by: pr.needed_by || '', priority: pr.priority || 'normal',
        reason: pr.reason || '', remarks: pr.remarks || '',
        // A merged line's remarks come from the first contributing line; the
        // others would otherwise vanish without trace, so they are carried over.
        lines: rows.map(r => ({ ...r, qty: String(r.qty),
          remarks: r.sources.map(x => x.remarks).filter(Boolean).join(' · ') })),
      },
    });
  };
  const selectableOk = selectedPrs.length > 0 && selectedPrs.every(p => p.status === 'approved');

  // Every requisition write below — approve, reject, un-approve, close, convert,
  // PUT and DELETE — sits behind procurement.js's `canBuy`. Until this existed,
  // the row menu offered all of them to every role and let the server answer 403,
  // so a storekeeper who may legitimately RAISE a PR was shown five buttons that
  // could only fail. Shared with the shortage panel (lib/requisitionControls.js)
  // so the same login gets the same answer about the same row on both screens.
  //
  // Deliberately NOT folded into canCoverRole below, which spells out the same
  // two roles today. That one answers a different question — may this login
  // earmark an incoming receipt for the jobs waiting on it — over different
  // endpoints (/grns/:id/cover-preview and /grns/:id/cover). The two are free to
  // be re-scoped independently, and merging them would make one impossible to
  // move without silently moving the other.
  const canRetirePr = canRetireRequisitions(auth.user?.role);

  const openPrModal = async (pr, edit = false) => {
    if (edit) await loadBoardRates(null);
    // The list row is a header; the gang a combined requisition buys for only
    // comes back from the single-PR endpoint. Failing that call must not stop
    // the modal opening — it just means no gang panel.
    let full = pr;
    try { full = { ...pr, ...(await api.get(`/requisitions/${pr.id}`)) }; } catch { /* header is enough */ }
    setPrModal({
    pr: full, edit,
    form: {
      needed_by: full.needed_by || '', reason: full.reason || '',
      requested_by: full.requested_by || '', department: full.department || '',
      priority: full.priority || 'normal', remarks: full.remarks || '',
      lines: (full.lines?.length ? full.lines : [{ material_id: full.material_id, qty: full.qty, unit: full.unit }])
        .map(l => ({ material_id: String(l.material_id), qty: String(l.qty),
          est_rate: l.est_rate != null ? String(l.est_rate) : '', unit: l.unit || '', remarks: l.remarks || '' })),
    },
    });
  };

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
    // The board's base ₹/sheet, or std → last for anything else. Used both as a
    // line's opening rate and as the tie-break when a board repeats on the PR.
    const baseRate = materialId => {
      const b = map.get(String(materialId));
      return b ? b.rate : matRate(materials.find(m => String(m.id) === String(materialId)));
    };
    const built = (pr.lines?.length ? pr.lines : [{ material_id: pr.material_id, qty: pr.qty, unit: pr.unit }]).map(l => {
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
    // A requisition can name the same board on two lines. The form opens with one
    // row for it, quantities added up — the vendor is asked for it once. A board
    // that actually merged takes the rate master's number, because two estimates
    // that disagree cannot both be right; a board named once keeps its estimate.
    const rows = consolidate(built, {
      mergedRate: sources => {
        const d = baseRate(sources[0].material_id);
        return d != null ? d : null;
      },
    });
    const lines = rows.map(r => ({ ...r, qty: String(r.qty),
      rate: r.rate === '' || r.rate == null ? '' : String(r.rate) }));
    setConvertPr({ pr, vendor_id: '', expected_date: '', tax_kind: 'intra', freight: '', round_off: '', lines,
      merges: mergeSummary(rows, id => materials.find(m => String(m.id) === String(id))?.name || `#${id}`),
      ...PO_META });
  };

  const openBulkPo = async () => {
    const map = await loadBoardRates(null); // no vendor yet → base rates
    // Same rule, same order as the server writes them — see poConsolidate.js.
    const flat = [];
    for (const p of selectedPrs) for (const l of (p.lines || [])) flat.push({ ...l, pr_number: p.pr_number });
    const materialsArr = consolidate(flat).map(r => ({
      material_id: r.material_id, material_name: r.material_name, unit: r.unit, qty: r.qty,
      prs: [...new Set(r.sources.map(s => s.pr_number))],
    }));
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

  // One spelling of the merge confirmation, shared by the direct-PO and edit
  // forms. A board line is keyed and read in ₹/kg but STORED in ₹/sheet, so the
  // stored number is translated back — quoting it raw names a figure the buyer
  // never typed and cannot find on the screen behind the dialog.
  const mergesOf = rows => mergeSummary(rows, id => materials.find(m => String(m.id) === String(id))?.name || `#${id}`);
  const andList = xs => (xs.length < 2 ? String(xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const mergeConfirmMessage = merges => {
    const showRate = (materialId, rate) => {
      const rpk = ratePerKgFromSheet(materials.find(m => String(m.id) === String(materialId)), rate);
      return rpk == null ? `₹${(+rate || 0).toFixed(2)}` : `₹${rpk.toFixed(2)}/kg`;
    };
    return (<>
      {merges.map(m => (
        <span key={m.material_id} className="block">
          <b>{m.name}</b> — lines {andList(m.positions)} become one:{' '}
          {fmt.num(m.qty)} {m.unit || ''} at {showRate(m.material_id, m.rate)}
          {/* A merge that quietly picks one of two rates has to say which lost. */}
          {m.dropped.length > 0 && ` — ${m.dropped.map(d => `line ${d.position} had ${showRate(m.material_id, d.rate)}`).join(', ')}`}
        </span>
      ))}
    </>);
  };

  const postDirectPo = async lines => {
    try {
      const po = await api.post('/purchase-orders', {
        vendor_id: +directPo.vendor_id, expected_date: directPo.expected_date || undefined, lines,
        tax_kind: directPo.tax_kind, freight: directPo.freight || 0, round_off: directPo.round_off === '' ? undefined : directPo.round_off,
        vendor_notes: directPo.vendor_notes || undefined, payment_terms: directPo.payment_terms || undefined,
        delivery_terms: directPo.delivery_terms || undefined, reference: directPo.reference || undefined,
      });
      toast.success(`${po.po_number} created`); setDirectPo(null); load(); setTab('pos');
    } catch (e) { toast.error(e.message || 'Could not create PO'); }
  };

  // A buyer can type the same board on two rows. The order carries it once — but
  // the merge is shown and confirmed first. Collapsing rows while they type would
  // pull one out from under the cursor mid-entry, so it happens on the way out.
  const createDirectPo = () => {
    const typed = directPo.lines.filter(l => l.material_id && +l.qty > 0)
      .map(l => ({ material_id: +l.material_id, qty: +l.qty, rate: +l.rate || 0, hsn_code: l.hsn_code || null,
        unit: l.unit || null, discount_pct: +l.discount_pct || 0, gst_rate: +l.gst_rate || 0 }));
    const rows = consolidate(typed);
    const lines = rows.map(l => ({ material_id: l.material_id, qty: l.qty, rate: l.rate, hsn_code: l.hsn_code,
      unit: l.unit, discount_pct: l.discount_pct, gst_rate: l.gst_rate }));
    const merges = mergesOf(rows);
    if (!merges.length) return postDirectPo(lines);
    setConfirm({ title: 'One line per board?', message: mergeConfirmMessage(merges),
      confirmLabel: 'Create PO', onConfirm: () => postDirectPo(lines) });
  };

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

  // Duplicate boards collapse here too, but a line with goods already received
  // keeps its own row: its id is what every GRN points at. So a board that is
  // half-received and re-ordered stays on two lines — one settled, one open —
  // which is what actually happened to it.
  const saveEditPo = async () => {
    const rows = editPo.lines.filter(l => l.material_id && +l.qty > 0);
    if (!rows.length) return toast.error('A PO needs at least one line');
    const { rows: merged } = consolidateEdit(rows, l => +l.committed_qty > 0);
    const lines = merged.map(l => ({ id: l.id, material_id: +l.material_id, qty: +l.qty, rate: +l.rate || 0,
      hsn_code: l.hsn_code || null, unit: l.unit || null,
      discount_pct: +l.discount_pct || 0, gst_rate: +l.gst_rate || 0 }));
    const merges = mergesOf(merged);
    if (!merges.length) return putEditPo(lines);
    setConfirm({ title: 'One line per board?', message: mergeConfirmMessage(merges),
      confirmLabel: 'Save changes', onConfirm: () => putEditPo(lines) });
  };

  const putEditPo = async lines => {
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

  const confirmDelete = async (entity, row, label) => {
    let plan;
    try { plan = await api.get(`/procurement/delete-preview/${entity}/${row.id}`); }
    catch (e) { return toast.error(e.message || 'Could not check what this delete removes'); }

    const bullets = items => items.map((t, i) => <span key={i} className="block">• {t}</span>);

    if (plan.hard_blockers?.length) {
      return setConfirm({
        title: `${label} cannot be deleted`,
        message: (<>
          <span className="block mb-1.5">Its stock has already been issued to production:</span>
          {bullets(plan.hard_blockers)}
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
        <span className="block mb-1.5">{plan.cascade?.length ? 'This will:' : `This permanently removes ${label}.`}</span>
        {bullets(plan.cascade || [])}
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
  // (no-PO) receipt for material that arrived without paperwork.
  const openNewGrn = () => setNewGrn({ mode: 'po', po_id: '', lines: [],
    material_id: '', qty: '', batch_no: '', vendor_id: '', ...GRN_META() });

  // Selecting a PO inside the modal pulls in its still-pending lines to receive.
  const pickNewGrnPo = poId => {
    const po = pos.find(p => String(p.id) === String(poId));
    setNewGrn(s => ({ ...s, po_id: poId,
      lines: po ? po.lines.filter(l => l.received_qty < l.qty).map(l => ({ ...l, receive_qty: '', batch_no: '' })) : [] }));
  };

  const createNewGrn = async () => {
    const meta = {
      vehicle_no: newGrn.vehicle_no || undefined, supplier_invoice_no: newGrn.supplier_invoice_no || undefined,
      supplier_invoice_date: newGrn.supplier_invoice_date || undefined,
      received_by: newGrn.received_by || undefined, remarks: newGrn.remarks || undefined,
    };
    try {
      if (newGrn.mode === 'direct') {
        if (!newGrn.material_id || !(+newGrn.qty > 0)) return toast.error('Pick a board and a positive quantity');
        await api.post('/grns/direct', { material_id: +newGrn.material_id, qty: +newGrn.qty,
          batch_no: newGrn.batch_no || undefined, vendor_id: newGrn.vendor_id ? +newGrn.vendor_id : undefined, ...meta });
        toast.success('Direct GRN created — in quarantine until QC');
      } else {
        const lines = newGrn.lines.filter(l => +l.receive_qty > 0)
          .map(l => ({ po_line_id: l.id, qty: +l.receive_qty, batch_no: l.batch_no || undefined }));
        if (!newGrn.po_id) return toast.error('Select a purchase order to receive against');
        if (!lines.length) return toast.error('Enter at least one received quantity');
        await api.post('/grns/bulk', { purchase_order_id: +newGrn.po_id, lines, ...meta });
        toast.success(`GRN created for ${lines.length} line${lines.length > 1 ? 's' : ''} — in quarantine until QC`);
      }
      setNewGrn(null); load(); setTab('grns');
    } catch (e) { toast.error(e.message || 'Could not create GRN'); }
  };

  const saveEditGrn = async () => {
    if (!(+editGrn.qty > 0)) return toast.error('Received quantity must be positive');
    try {
      await api.put(`/grns/${editGrn.grn.id}`, {
        qty: +editGrn.qty, batch_no: editGrn.batch_no || undefined,
        vehicle_no: editGrn.vehicle_no || null, supplier_invoice_no: editGrn.supplier_invoice_no || null,
        supplier_invoice_date: editGrn.supplier_invoice_date || null,
        received_by: editGrn.received_by || null, remarks: editGrn.remarks || null,
      });
      toast.success(`${editGrn.grn.grn_number} updated`); setEditGrn(null); load();
    } catch (e) { toast.error(e.message || 'Could not update GRN'); }
  };


  // ── Cover board — earmark a fresh receipt for the jobs whose PR asked for
  // it. Preview-then-commit, same shape as BoardCommitments' move flow: the
  // server's cover-preview returns exactly what the dialog renders, so the
  // confirm cannot drift from what the commit writes. Planner-gated like every
  // other allocation write — a pure-QC login must not be chained into a
  // preview its role cannot fetch.
  const canCoverRole = ['admin', 'planner'].includes(auth.user?.role);
  const openCover = async (g, { silent = false } = {}) => {
    try {
      const data = await api.get(`/grns/${g.id}/cover-preview`);
      // Silent mode (chained after QC accept) only interrupts when there is
      // something to DO; opened from the row menu, an all-covered list still
      // shows — that is the answer the user asked for.
      const actionable = data.candidates.some(c => c.coverable > 0);
      if (!data.candidates.length || (silent && !actionable)) {
        if (!silent) toast.info('No open job is waiting on this board');
        return false;
      }
      setCover({ grn: g, data,
        qty: Object.fromEntries(data.candidates.map(c => [c.order_line_id, c.suggested ? String(c.suggested) : ''])) });
      return true;
    } catch (e) {
      if (!silent) toast.error(e.message || 'Could not check who this board covers');
      return false;
    }
  };
  const submitCover = async () => {
    const covers = cover.data.candidates
      .map(c => ({ order_line_id: c.order_line_id, qty: +cover.qty[c.order_line_id] || 0 }))
      .filter(c => c.qty > 0);
    setCoverBusy(true);
    try {
      const res = await api.post(`/grns/${cover.grn.id}/cover`, { covers });
      const held = res.covered.reduce((s, c) => s + c.qty, 0);
      const closed = res.prs_reduced.filter(p => p.closed).map(p => p.pr_number);
      toast.success(`${fmt.num(held)} sheets held for ${res.covered.length} job${res.covered.length === 1 ? '' : 's'}`
        + (closed.length ? ` · ${closed.join(', ')} closed — covered` : ''));
      setCover(null); load();
    } catch (e) { toast.error(e.message || 'Could not cover the board'); }
    finally { setCoverBusy(false); }
  };

  const rollbackGrn = g => setConfirm({
    title: g.po_number ? `Roll ${g.grn_number} back to PO?` : `Roll back ${g.grn_number}?`,
    message: g.po_number
      ? `This undoes the accepted receipt: ${fmt.num(g.qty)} ${g.unit} of ${g.material_name} returns to ${g.po_number}'s pending balance and the released stock batch is removed. Only works if that stock hasn't been used yet.`
      : `This undoes the direct receipt: ${fmt.num(g.qty)} ${g.unit} of ${g.material_name} and its released stock batch are removed. Only works if that stock hasn't been used yet.`,
    confirmLabel: g.po_number ? 'Roll back to PO' : 'Roll back receipt', danger: true,
    onConfirm: async () => {
      try { await api.post(`/grns/${g.id}/rollback`); toast.info(`${g.grn_number} rolled back${g.po_number ? ` — balance returned to ${g.po_number}` : ''}`); load(); }
      catch (e) { toast.error(e.message || 'Could not roll back GRN'); }
    },
  });

  const pendingCount = pendency?.lines?.length || 0;

  // ── Register sub-views: split each list into open/actionable vs done ──────────
  const PR_GROUPS = { open: ['pending', 'approved'], converted: ['converted'], closed: ['closed', 'rejected'] };
  // What the view tab alone shows — the scope every chip below counts within,
  // so a chip's number always says how much of THIS list it would leave.
  const prScope = prs.filter(p => PR_GROUPS[prView].includes(p.status));
  // Late only means late while something can still be done about it: a PR that
  // is already ordered or closed is not waiting on anyone.
  const prIsOverdue = p => ['pending', 'approved'].includes(p.status) && dueDelta(p.needed_by) > 0;
  const prIsUrgent = p => p.priority === 'urgent';
  const prWaitingOn = p => (p.status === 'pending' ? 'approval' : p.status === 'approved' ? 'buyer' : null);
  // "Waiting on" and "Overdue" only mean anything while a requisition is still
  // open, so they are offered on that view alone — and they must stop FILTERING
  // when they stop being offered. A lit chip that is no longer on screen empties
  // the list with nothing to point at, which reads as lost data. Left lit
  // underneath, so coming back restores what was chosen.
  const prOpenAxes = prView === 'open';
  const prRows = prScope
    .filter(p => !prWaiting || !prOpenAxes || prWaitingOn(p) === prWaiting)
    .filter(p => !prOverdue || !prOpenAxes || prIsOverdue(p))
    .filter(p => !prUrgent || prIsUrgent(p));
  // Counts are independent of one another: each says what that chip alone would
  // leave. Compounding them would make a chip read 0 because a DIFFERENT chip is
  // lit, which is how a rail starts lying about what it has.
  const prChipCount = fn => prScope.filter(fn).length;
  // Changing an axis drops the selection with it — a selection that outlives a
  // filter is how a bulk PO ends up carrying rows nobody can see.
  const prFilter = set => v => { set(v); setSelectedIds([]); };
  const prFilters = useFilterReset([
    [prWaiting, setPrWaiting, null, 'waiting on'],
    [prOverdue, setPrOverdue, false, 'overdue'],
    [prUrgent, setPrUrgent, false, 'urgent'],
  ], () => setSelectedIds([]));
  const poIsDone = po => po.status === 'received' || po.status === 'closed';
  const poScope = pos.filter(po => (poView === 'completed' ? poIsDone(po) : !poIsDone(po)));
  // The server derives PO status from its own lines — full → received, some →
  // partially_received, else open — so the status IS the receipt state and
  // there is nothing to recompute from the lines here.
  const poReceiptOf = po => (po.status === 'partially_received' ? 'part' : po.status === 'open' ? 'none' : null);
  // Late only while something can still arrive: a received or closed order is
  // not waiting on the vendor, whatever its expected date says.
  const poIsOverdue = po => !poIsDone(po) && dueDelta(po.expected_date) > 0;
  const poPending = poView === 'pending';
  // Each axis is offered on ONE view and must stop filtering on the other —
  // a chip left lit but off screen empties the list with nothing to point at.
  const poList = poScope
    .filter(po => !poReceipt || !poPending || poReceiptOf(po) === poReceipt)
    .filter(po => !poOverdue || !poPending || poIsOverdue(po))
    .filter(po => !poStage || poPending || po.status === poStage);
  const poChipCount = fn => poScope.filter(fn).length;
  const poFilters = useFilterReset([
    [poReceipt, setPoReceipt, null, 'receipt'],
    [poStage, setPoStage, null, 'stage'],
    [poOverdue, setPoOverdue, false, 'overdue'],
  ]);
  const grnRows = grns.filter(g => (grnView === 'completed' ? g.status !== 'quarantine' : g.status === 'quarantine'));
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
        { key: 'grns', label: 'GRN / QC', count: grns.filter(g => g.status === 'quarantine').length },
        { key: 'pendency', label: 'Pendency', count: pendingCount },
      ]} />

      {/* Club opportunities — the same board sitting on several open requisitions,
          or named twice inside one. PO consolidation merges lines within ONE
          order; it cannot help once the buyer has already made three separate
          orders, so the offer has to happen here, before any of them exist. */}
      {tab === 'prs' && !clubHidden && (clubs.acrossPrs.length > 0 || clubs.withinPr.length > 0) && (
        <div className="mb-3 rounded-2xl border border-violet-200/70 bg-violet-50/50 px-4 py-3 shadow-card backdrop-blur-xl animate-fadeIn">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold text-violet-800">
              <ShoppingBag size={13} /> Worth buying together
            </span>
            <button type="button" onClick={() => setClubHidden(true)}
              className="text-[11px] font-bold text-violet-400 underline-offset-2 hover:underline">Hide</button>
          </div>
          <div className="space-y-2">
            {clubs.acrossPrs.length > 0 && (
              <ClubBand label="Across requisitions" items={clubs.acrossPrs}
                note="selects them — then Create One PO"
                onPick={s => {
                  setSelectedIds(s.prs.map(p => p.id));
                  setPrView('open');
                  if (!s.readyToOrder) toast.info('Approve the pending ones and the PO button opens up');
                }}
                chip={s => <>
                  <span className="max-w-[190px] truncate">{s.material_name}</span>
                  <ClubTag tone={s.readyToOrder ? 'violet' : 'amber'}>{s.prCount} PRs</ClubTag>
                  <span className="tabular-nums text-violet-500">{fmt.num(s.total_qty)}</span>
                </>} />
            )}
            {clubs.withinPr.length > 0 && (
              <ClubBand label="Inside one requisition" items={clubs.withinPr}
                note="opens it with the lines already clubbed"
                onPick={s => openPrClub(s)}
                chip={s => <>
                  <span className="font-bold">{s.pr_number}</span>
                  <span className="max-w-[160px] truncate">{s.material_name}</span>
                  <ClubTag tone="amber">{s.lineCount} lines</ClubTag>
                  <span className="tabular-nums text-violet-500">{fmt.num(s.total_qty)}</span>
                </>} />
            )}
          </div>
        </div>
      )}

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
            { key: 'open', label: 'Open', count: prCount('open') },
            { key: 'converted', label: 'Converted', count: prCount('converted') },
            { key: 'closed', label: 'Closed', count: prCount('closed') },
          ]} />
          {/* One shape for every filter rail in the ERP — see FilterChip.jsx.
              STRUCTURE says which axis a chip belongs to (the group caption),
              COLOUR is spent only where somebody has to act: late and urgent.
              Which queue a PR sits in is classification, so it lights graphite —
              four hues on a four-chip rail would be a paint chart. */}
          <FilterRail className="mt-2">
            {prOpenAxes && (
              <FilterGroup label="Waiting on" divider={false}>
                <FilterChip label="Approval" count={prChipCount(p => p.status === 'pending')}
                  on={prWaiting === 'approval'}
                  title="Raised, not yet approved — the approver's queue"
                  onClick={() => prFilter(setPrWaiting)(prWaiting === 'approval' ? null : 'approval')} />
                <FilterChip label="Buyer" count={prChipCount(p => p.status === 'approved')}
                  on={prWaiting === 'buyer'}
                  title="Approved and still unordered — this is the queue the club pills act on"
                  onClick={() => prFilter(setPrWaiting)(prWaiting === 'buyer' ? null : 'buyer')} />
              </FilterGroup>
            )}
            <FilterGroup label="Flag" divider={prOpenAxes}>
              {prOpenAxes && (
                <FilterChip label="Overdue" icon={AlertTriangle} count={prChipCount(prIsOverdue)}
                  on={prOverdue} tone="border-transparent bg-[#D70015] text-white" countTone="bg-white/25"
                  title="Needed-by date has passed and the requisition is still open"
                  onClick={() => prFilter(setPrOverdue)(!prOverdue)} />
              )}
              <FilterChip label="Urgent" count={prChipCount(prIsUrgent)}
                on={prUrgent} tone="border-amber-200 bg-amber-100 text-amber-800" countTone="bg-white/70"
                title="Raised at urgent priority"
                onClick={() => prFilter(setPrUrgent)(!prUrgent)} />
            </FilterGroup>
            <ResetFilters filters={prFilters} className="ml-auto" />
          </FilterRail>
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
                {matId && stk && (<>
                  <button type="button"
                    onClick={e => { e.stopPropagation(); setBoardPanel({ materialId: matId, pr: p }); }}
                    className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      stk.free > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    <Package size={12} />
                    {fmt.num(stk.available)} in warehouse
                  </button>
                  {/* IN WAREHOUSE → COMMITTED → FREE, the same three words the
                      planning engine uses, always all three. Committed is the sum
                      of the claimants' OPEN needs, so it already nets off what
                      each job has held or has on order — which is why there is no
                      separate "on order" line here to disagree with it. A zero is
                      an answer, so it is stated, just not shouted, and a board
                      owing more than it holds says Short rather than a negative
                      Free that reads like a typo. */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] font-semibold tabular-nums">
                    <span className="text-slate-500">In warehouse <span className="text-slate-700">{fmt.num(stk.available)}</span></span>
                    <span className={stk.committed > 0 ? 'text-amber-600' : 'text-slate-400'}>
                      Committed {fmt.num(stk.committed)}
                      {stk.committed > 0 && stk.jobs > 0 && ` · ${stk.jobs} job${stk.jobs === 1 ? '' : 's'}`}
                    </span>
                    {stk.free >= 0
                      ? <span className={stk.free > 0 ? 'text-emerald-600' : 'text-slate-400'}>Free {fmt.num(stk.free)}</span>
                      : <span className="text-red-500">Short {fmt.num(-stk.free)}</span>}
                    {/* Board on order never reduces Committed — it is not on the
                        shelf — but it is why a shortfall may already be handled,
                        so it rides beside the figure it explains. */}
                    {stk.on_order > 0 && <span className="text-sky-600">{fmt.num(stk.on_order)} on order</span>}
                  </div>
                </>)}
              </div>);
            } },
            { key: 'qty', label: 'Qty', align: 'right', render: p => {
              const ls = p.lines || [];
              if (ls.length > 1)
                return <span className="text-xs text-slate-500">{ls.length} lines{p.est_value > 0 ? <span className="block tabular-nums text-slate-400">{fmt.inr(p.est_value)}</span> : null}</span>;
              // Sheets is the unit the ERP transacts in, but nobody buys or moves
              // board in sheets: a vendor quotes ₹/kg and the warehouse handles
              // packets. Both derive from the board master, and both read "—"
              // rather than a confident zero when that master is incomplete.
              const qty = ls[0]?.qty ?? p.qty;
              const pk = packets(p, qty), kg = totalWeight(p, qty);
              return (<div>
                <div>{fmt.num(qty)} {ls[0]?.unit || p.unit || ''}</div>
                {(pk != null || kg != null) && (
                  <div className="text-[10px] font-semibold tabular-nums text-slate-400">
                    {pk != null && `${pk.toLocaleString('en-IN', { maximumFractionDigits: 1 })} pkt`}
                    {pk != null && kg != null && ' · '}
                    {kg != null && fmt.kg(kg)}
                  </div>
                )}
              </div>);
            } },
            // When it was asked for, next to when it is wanted — the two dates
            // read as a pair, and this is the one the register is sorted on.
            // `export:` is explicit: a column that leaves it off can export an
            // empty cell, which is how the gang columns silently shipped blank.
            { key: 'created_at', label: 'Raised', export: p => fmt.date(p.created_at),
              render: p => <span className="whitespace-nowrap tabular-nums">{fmt.date(p.created_at)}</span> },
            { key: 'needed_by', label: 'Needed By', export: p => fmt.date(p.needed_by), render: p => fmt.date(p.needed_by) },
            // Every requisition that names a job lists it, gang or not. The
            // prose reason buries the product in a sentence and states neither
            // the customer, the sheets nor the due date — a single job deserves
            // the same structured line a gang member gets. Read-only; the modal
            // is still where a requisition is acted on.
            { key: 'reason', label: 'Reason', render: p => (
              <div className="text-xs leading-[1.35] text-gray-500">
                {/* Clamped like status_reason below, and for the same reason: the
                    engine's sentence repeats what the job lines already say, so
                    a long one must not push them out of view. Same caveat — no
                    `block` class, it would beat display:-webkit-box. */}
                <span className="line-clamp-2" title={p.reason}>{p.reason}</span>
                {/* Every job is exactly two lines — name with its sheets pinned
                    right, then the identifiers muted underneath. Wrapping these
                    as one flex run let a long product name break mid-phrase and
                    push the sheet count onto a line of its own, so two members
                    read as a ragged block instead of a list. Fixed rhythm and a
                    right-hand number column make the sheets scannable; the full
                    text of anything truncated is in the modal, and on hover. */}
                {p.jobs?.members?.length > 0 && (
                  <div className="mt-1.5 space-y-1 border-l-2 border-violet-200 pl-2">
                    {p.jobs.members.map(m => {
                      const meta = [m.product_code, m.customer_name, m.po_number,
                        m.delivery_date && fmt.date(m.delivery_date)].filter(Boolean).join(' · ');
                      return (
                        <div key={m.id} className="leading-[1.35]">
                          <div className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate font-semibold text-slate-600" title={m.product_name}>
                              {m.product_name}
                            </span>
                            <span className="shrink-0 tabular-nums font-semibold text-violet-500">
                              {fmt.num(m.sheets)} sheets
                            </span>
                          </div>
                          {meta && <div className="truncate text-slate-400" title={meta}>{meta}</div>}
                        </div>
                      );
                    })}
                    {/* The jobs carry only what they need, so an over-bought PR
                        leaves member lines that do not add up to the quantity
                        being approved. Name the difference rather than let the
                        buyer wonder which number is wrong. */}
                    {p.jobs.for_stock > 0 && (
                      <div className="flex items-baseline gap-2 border-t border-violet-100 pt-1 leading-[1.35]">
                        <span className="min-w-0 flex-1 truncate font-semibold text-sky-600">
                          Bought for stock
                          <span className="font-normal text-slate-400">
                            {' · over the '}{fmt.num(p.jobs.demand)}
                            {p.jobs.members.length === 1 ? ' this job needs' : ' these jobs need'}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums font-semibold text-sky-600">
                          {fmt.num(p.jobs.for_stock)} sheets
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {/* Clamped to two lines — the full note is in the modal; a long
                    one used to swallow the row and the job list with it. No
                    `block` class: line-clamp needs display:-webkit-box, and
                    `block` would win and silently un-clamp it. */}
                {p.status_reason && (
                  <span className="mt-1 line-clamp-2 text-red-400" title={p.status_reason}>
                    {fmt.title(p.status)}: {p.status_reason}
                  </span>
                )}
              </div>
            ) },
            { key: 'status', label: 'Status', render: p => <StatusBadge status={p.status} /> },
            { key: 'po_number', label: 'PO', render: p => p.po_number || '—' },
            threadColumn({ entity: 'requisition', threads: prThreads, idOf: p => p.id }),
            { key: 'act', label: '', sortable: false, render: p => (
              <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                {p.status === 'pending' && canRetirePr && <>
                  <Button size="sm" variant="success" onClick={async () => { await api.post(`/requisitions/${p.id}/approve`); toast.success('Approved'); load(); }}>Approve</Button>
                </>}
                {p.status === 'approved' && canRetirePr && (
                  <Button size="sm" onClick={() => openConvert(p)}>Create PO</Button>
                )}
                <ActionMenu items={[
                  // The one entry every role keeps. `editable` carries the
                  // permission too, so a non-buyer gets the read-only view
                  // rather than a form whose save is a guaranteed 403.
                  // A converted PR opens editable too — quantities only, and the
                  // change follows through to the order it produced.
                  { key: 'view', label: 'View / Edit', icon: Eye, onClick: () => openPrModal(p, canRetirePr && ['pending', 'approved', 'converted'].includes(p.status)) },
                  // Selection exists only to reach the bulk convert-to-PO, which
                  // is canBuy — offering it to a role that cannot convert builds
                  // a basket that can never be checked out.
                  ...(p.status === 'approved' && canRetirePr ? [{
                    key: 'select', label: selectedIds.includes(p.id) ? 'Remove from PO selection' : 'Add to PO selection', icon: ShoppingBag,
                    onClick: () => setSelectedIds(ids => ids.includes(p.id) ? ids.filter(i => i !== p.id) : [...ids, p.id]),
                  }] : []),
                  ...(p.status === 'pending' && canRetirePr ? [{
                    key: 'reject', label: 'Reject', icon: XCircle, tone: 'danger',
                    onClick: async () => { await api.post(`/requisitions/${p.id}/reject`); toast.info('Rejected'); load(); },
                  }] : []),
                  // Approve is one click on a row, so it gets mis-clicked. Undo
                  // is available right up until a PO exists; after that the PO
                  // owns the decision and has its own send-back.
                  ...(p.status === 'approved' && !p.po_number && canRetirePr ? [{
                    key: 'unapprove', label: 'Un-approve — back to pending', icon: Undo2,
                    onClick: async () => { await api.post(`/requisitions/${p.id}/unapprove`); toast.info(`${p.pr_number} back to pending`); load(); },
                  }] : []),
                  ...(['pending', 'approved'].includes(p.status) && canRetirePr ? [{
                    key: 'close', label: 'Close / cancel with reason', icon: Ban, tone: 'danger',
                    onClick: () => setClosePr({ pr: p, reason: '' }),
                  }] : []),
                  // Delete stays status-blind on purpose — this is the previewed,
                  // cascade-aware buyer tool, not the shortage panel's narrow
                  // non-force delete. Only the role gate is new; without it the
                  // first thing a non-buyer hit was a 403 from delete-preview,
                  // reported as "Could not check what this delete removes".
                  ...(canRetirePr ? [{ key: 'delete', label: 'Delete requisition', icon: Trash2, tone: 'danger',
                    onClick: () => confirmDelete('requisition', p, p.pr_number) }] : []),
                ]} />
              </div>) },
          ]}
          rows={prRows}
          // Newest first. Without this the table sorts on its first keyed column
          // — PR number ascending — so the register opened on the oldest
          // requisition raised and the one just written sat at the bottom.
          // Every header is still a sorter; this only decides where it starts.
          defaultSort={{ key: 'created_at', dir: 'desc' }}
          // The table owns the search box, so the rail's Reset only clears it
          // through this token — without it the page would say "cleared" while
          // its own search bar still held a word.
          resetSignal={prFilters.token}
          empty={prFilters.dirty
            ? 'Nothing matches those filters — Reset filters brings the list back'
            : prView === 'open' ? 'No open requisitions' : prView === 'converted' ? 'No converted requisitions yet' : 'Nothing closed or rejected'}
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
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SubTabs active={poView} onChange={setPoView} views={[
                { key: 'pending', label: 'Pending', count: pos.filter(p => !poIsDone(p)).length },
                { key: 'completed', label: 'Completed', count: pos.filter(poIsDone).length },
              ]} />
            </div>
            {/* The same rail as the requisition register — FilterChip.jsx, group
                caption for identity, colour only where somebody has to act. Late
                is the one thing here anybody chases, so it is the only hue. */}
            <FilterRail className="mt-2">
              {poPending ? (
                <>
                  <FilterGroup label="Receipt" divider={false}>
                    <FilterChip label="Not started" count={poChipCount(p => poReceiptOf(p) === 'none')}
                      on={poReceipt === 'none'}
                      title="Ordered, nothing received against it yet"
                      onClick={() => setPoReceipt(poReceipt === 'none' ? null : 'none')} />
                    <FilterChip label="Part received" count={poChipCount(p => poReceiptOf(p) === 'part')}
                      on={poReceipt === 'part'}
                      title="Some of the order has arrived — the balance is still owed"
                      onClick={() => setPoReceipt(poReceipt === 'part' ? null : 'part')} />
                  </FilterGroup>
                  <FilterGroup label="Flag">
                    <FilterChip label="Overdue" icon={AlertTriangle} count={poChipCount(poIsOverdue)}
                      on={poOverdue} tone="border-transparent bg-[#D70015] text-white" countTone="bg-white/25"
                      title="Expected date has passed and the order is still short"
                      onClick={() => setPoOverdue(!poOverdue)} />
                  </FilterGroup>
                </>
              ) : (
                // A fully received order that nobody has closed is still a job —
                // it sits in Completed looking finished while the register keeps
                // counting it open. Worth being able to see on its own.
                <FilterGroup label="Stage" divider={false}>
                  <FilterChip label="To close" count={poChipCount(p => p.status === 'received')}
                    on={poStage === 'received'}
                    title="Fully received but not yet closed"
                    onClick={() => setPoStage(poStage === 'received' ? null : 'received')} />
                  <FilterChip label="Closed" count={poChipCount(p => p.status === 'closed')}
                    on={poStage === 'closed'}
                    title="Closed — no further receipts expected"
                    onClick={() => setPoStage(poStage === 'closed' ? null : 'closed')} />
                </FilterGroup>
              )}
              <ResetFilters filters={poFilters} className="ml-auto" />
            </FilterRail>
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
          {poList.length === 0 && <p className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-gray-400">
            {poFilters.dirty ? 'Nothing matches those filters — Reset filters brings the register back'
              : poView === 'completed' ? 'No completed purchase orders yet.' : 'No pending purchase orders — every order is fully received.'}</p>}
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
                  {po.lines.map(l => {
                    // The list endpoint returns no board dimensions, so weight and
                    // packets come off the material master — the same lookup the
                    // totals panel makes. Boards read in ₹/kg and packets like the
                    // PO document does; anything unweighable keeps sheets and ₹.
                    const mat = materials.find(m => String(m.id) === String(l.material_id));
                    const pk = packets(mat, +l.qty);
                    const rpk = ratePerKgFromSheet(mat, l.rate);
                    const pRate = rpk == null ? null : packetRate(mat, rpk);
                    return (
                    <tr key={l.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2">
                        {l.material_name}
                        {/* A consolidated line names what fed it, and how much each
                            requisition put in — one line on the order, but the
                            trail back to every PR stays readable. */}
                        {l.source_prs?.length > 0 && (
                          <div className="text-[10px] text-slate-400">
                            {l.source_prs.map(s => `${s.pr_number} ${fmt.num(s.qty)}`).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <div>{fmt.num(l.qty)} {l.unit}</div>
                        {pk != null && <div className="text-[10px] text-slate-400">{pk.toLocaleString('en-IN', { maximumFractionDigits: 1 })} pkt</div>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.received_qty)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${l.qty - l.received_qty > 0 ? 'font-semibold text-amber-600' : 'text-slate-300'}`}>{fmt.num(Math.max(0, l.qty - l.received_qty))}</td>
                      <td className="px-3 py-2"><FulfillmentBar className="mx-auto" pct={l.qty > 0 ? (Math.min(l.received_qty, l.qty) / l.qty) * 100 : 0} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {rpk != null ? <>
                          <div>₹{rpk.toFixed(2)}/kg</div>
                          {pRate != null && <div className="text-[10px] text-slate-400">₹{pRate.toFixed(2)}/pkt</div>}
                        </> : `₹${(+l.rate || 0).toFixed(2)}`}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {l.received_qty < l.qty && po.status !== 'closed' && (
                          <Button size="sm" variant="secondary" onClick={() => setReceivePo({ po, line: l, qty: '', batch_no: '', ...GRN_META() })}>Receive</Button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
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
            { key: 'pending', label: 'Pending QC', count: grns.filter(g => g.status === 'quarantine').length },
            { key: 'completed', label: 'Completed', count: grns.filter(g => g.status !== 'quarantine').length },
          ]} />
        </div>
      )}

      {tab === 'grns' && (
        <DataTable searchable
          columns={[
            { key: 'grn_number', label: 'GRN', render: g => <span className="font-semibold">{g.grn_number}</span> },
            { key: 'po_number', label: 'Against PO', render: g => g.po_number
              ? g.po_number
              : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Direct · No PO</span> },
            { key: 'vendor_name', label: 'Vendor', render: g => g.vendor_name || <span className="text-gray-300">—</span> },
            { key: 'material_name', label: 'Board', render: g => (
              <div>
                {g.material_name}
                {/* What LANDED is the board named above; this says what the PO
                    asked for, so the register reads true from either side. */}
                {g.substituted_for_name && (
                  <div className="text-[10px] font-semibold text-amber-700">
                    received in place of {g.substituted_for_name}
                  </div>
                )}
              </div>) },
            { key: 'qty', label: 'Qty', align: 'right', render: g => `${fmt.num(g.qty)} ${g.unit}` },
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
            { key: 'status', label: 'QC', render: g => <StatusBadge status={g.status} /> },
            threadColumn({ entity: 'grn', threads: grnThreads, idOf: g => g.id }),
            { key: 'act', label: '', sortable: false, render: g => (
              <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                {g.status === 'quarantine' && <Button size="sm" onClick={() => setQcGrn({ grn: g, note: '' })}>QC Decision</Button>}
                <ActionMenu label="GRN actions" items={[
                  ...(g.status === 'quarantine' ? [{ key: 'edit', label: 'Edit GRN', icon: Pencil,
                    onClick: () => setEditGrn({ grn: g, qty: String(g.qty), batch_no: g.batch_no || '',
                      vehicle_no: g.vehicle_no || '', supplier_invoice_no: g.supplier_invoice_no || '',
                      supplier_invoice_date: g.supplier_invoice_date || '', received_by: g.received_by || '',
                      remarks: g.remarks || '' }) }] : []),
                  ...(g.status === 'accepted' && canCoverRole ? [{ key: 'cover', label: 'Cover board for jobs', icon: Package,
                    onClick: () => openCover(g) }] : []),
                  ...(g.status === 'accepted' ? [{ key: 'rollback', label: g.po_number ? 'Roll back to PO' : 'Roll back receipt', icon: Undo2, tone: 'danger',
                    onClick: () => rollbackGrn(g) }] : []),
                  { key: 'delete', label: 'Delete GRN', icon: Trash2, tone: 'danger',
                    onClick: () => confirmDelete('grn', g, g.grn_number) },
                ]} />
              </div>) },
          ]}
          rows={grnRows} empty={grnView === 'completed' ? 'No completed QC decisions yet' : 'Nothing awaiting QC'}
          rowClass={unreadRowClass(grnThreads, g => g.id)}
          getRowId={g => g.id}
          exportName="Goods Receipts"
          exportSubtitle="Procurement · GRN register with QC status" />
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
          {/* The same canBuy actions the row menu offers, on the same rows —
              gated the same way. This footer is the more exposed of the two: any
              role reaches it by clicking a row (onRowClick above), and the menu's
              own View / Edit stays open to everyone by design. Leaving Edit here
              ungated would also hand a non-buyer the edit form that the menu's
              `editable` argument just refused them, and its save would 403. */}
          {canRetirePr && ['pending', 'approved', 'converted'].includes(prModal.pr.status) && (
            <Button onClick={() => setPrModal(m => ({ ...m, edit: true }))}>
              <Pencil size={14} /> {prModal.pr.status === 'converted' ? 'Edit Quantity' : 'Edit'}
            </Button>
          )}
          {canRetirePr && prModal.pr.status === 'pending' && (
            <Button variant="success" onClick={async () => { await api.post(`/requisitions/${prModal.pr.id}/approve`); toast.success('Approved'); setPrModal(null); load(); }}>
              <CheckCircle2 size={14} /> Approve
            </Button>
          )}
          {canRetirePr && prModal.pr.status === 'approved' && !prModal.pr.po_number && (
            <Button variant="secondary" onClick={async () => {
              await api.post(`/requisitions/${prModal.pr.id}/unapprove`);
              toast.info(`${prModal.pr.pr_number} back to pending`); setPrModal(null); load();
            }}>
              <Undo2 size={14} /> Un-approve
            </Button>
          )}
          {canRetirePr && prModal.pr.status === 'approved' && (
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
            {prModal.pr.status === 'converted' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-slate-600">
                Already ordered on <span className="font-bold text-slate-700">{prModal.pr.po_number || 'its purchase order'}</span> —
                changing a quantity here moves that order by the same amount. Its items are fixed, and it cannot
                drop below what has already been received.
              </div>
            )}
            <PrLineEditor lines={prModal.form.lines} materials={materials} activePrsFor={() => []} rateFor={rateFor} stockFor={stockFor}
              qtyOnly={prModal.pr.status === 'converted'}
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
            {/* The buyer is committing to a quantity — name the jobs it is for.
                A gang buys one board for several; a single PR buys for one. */}
            {prModal.pr.gang?.members?.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-violet-100 bg-violet-50/40">
                <div className="flex items-baseline gap-2 px-3 pt-2 pb-1">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-violet-500">
                    {prModal.pr.gang.gang_number ? 'Products in this gang' : 'This requisition is for'}
                  </span>
                  <span className="text-[11px] font-semibold text-violet-400">
                    {prModal.pr.gang.gang_number
                      ? `${prModal.pr.gang.gang_number} · ${prModal.pr.gang.members.length} jobs on one sheet`
                      : 'one job'}
                  </span>
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="border-y border-violet-100 text-left text-[11px] font-bold uppercase text-violet-400">
                    <th className="px-3 py-1.5">Product</th><th className="px-3 py-1.5">Customer / PO</th>
                    <th className="px-3 py-1.5">Deliver By</th>
                    <th className="px-3 py-1.5 text-right">Pcs</th><th className="px-3 py-1.5 text-right">Sheets</th>
                  </tr></thead>
                  <tbody>
                    {prModal.pr.gang.members.map(m => (
                      <tr key={m.id} className="border-b border-violet-50 last:border-0">
                        <td className="px-3 py-1.5">
                          <div className="font-semibold text-slate-800">{m.product_name}</div>
                          {m.product_code && <div className="text-[11px] text-slate-400">{m.product_code}</div>}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-600">
                          {m.customer_name}{m.po_number ? ` · ${m.po_number}` : ''}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-600">{fmt.date(m.delivery_date) || '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(m.qty)}</td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmt.num(m.sheets)}</td>
                      </tr>
                    ))}
                  </tbody>
                  {/* The jobs are capped at what they need, so when the buyer has
                      ordered more the member rows stop at the demand. Carry the
                      surplus and the grand total, or the table would appear to
                      contradict the quantity being approved. */}
                  <tfoot>
                    <tr className="border-t border-violet-100 text-[11px] font-bold text-violet-600">
                      <td className="px-3 py-1.5" colSpan={4}>
                        {prModal.pr.gang.gang_number
                          ? `${prModal.pr.gang.members.length} jobs · one combined requisition`
                          : 'one job · this requisition'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {fmt.num(prModal.pr.gang.members.reduce((s, m) => s + (+m.sheets || 0), 0))}
                      </td>
                    </tr>
                    {prModal.pr.gang.for_stock > 0 && (<>
                      <tr className="text-[11px] font-bold text-sky-600">
                        <td className="px-3 py-1.5" colSpan={4}>Bought for stock · no job asked for these</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(prModal.pr.gang.for_stock)}</td>
                      </tr>
                      <tr className="border-t border-violet-100 text-[11px] font-bold text-slate-700">
                        <td className="px-3 py-1.5" colSpan={4}>Total on {prModal.pr.pr_number}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(prModal.pr.qty)}</td>
                      </tr>
                    </>)}
                  </tfoot>
                </table>
              </div>
            )}
            {prModal.pr.reraise_reason && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                Re-raised over {prModal.pr.reraise_of_number}: {prModal.pr.reraise_reason}
              </p>
            )}
            {prModal.pr.reason && <p className="text-sm text-slate-600">Reason: {prModal.pr.reason}</p>}
            {prModal.pr.remarks && <p className="text-sm text-slate-500">Remarks: {prModal.pr.remarks}</p>}
            {/* The note belongs to whatever status the row is IN — a pending PR
                carrying one used to announce itself as "Closed:". */}
            {prModal.pr.status_reason && (
              <p className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                ['closed', 'rejected'].includes(prModal.pr.status)
                  ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                {fmt.title(prModal.pr.status)}: {prModal.pr.status_reason}
              </p>
            )}
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
          {/* The requisition asked for a board more than once. Say so plainly —
              a buyer who counted the PR's rows should not have to wonder where
              one went. */}
          {convertPr.merges?.length > 0 && (
            <div className="rounded-lg border border-brand-100 bg-brand-50/60 p-3 text-xs text-slate-600">
              {convertPr.merges.map(m => (
                <div key={m.material_id}>
                  <span className="font-semibold text-slate-700">{m.name}</span> — {m.lineCount} requisition lines
                  combined into one: <span className="font-semibold tabular-nums">{fmt.num(m.qty)} {m.unit}</span>
                  {/* No rate is quoted here on purpose: choosing a vendor reprices
                      the line below, so any number named at open time would go
                      stale. Point at the differing estimates and let the editor
                      show the live figure. */}
                  {m.estimates.length > 1 && (
                    <span className="text-slate-400"> · the estimates differed
                      ({m.estimates.map(e => `₹${e.toFixed(2)}`).join(', ')}) — check the rate below</span>
                  )}
                </div>
              ))}
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
            onClick={createDirectPo}>Create PO</Button>
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

      {/* ── Create GRN — against an open PO, or a direct (no-PO) receipt ── */}
      <Modal open={!!newGrn} onClose={() => { setSubLineId(null); setNewGrn(null); }} title="Create GRN" wide
        footer={<>
          <Button variant="secondary" onClick={() => setNewGrn(null)}>Cancel</Button>
          <Button variant="success" onClick={createNewGrn}
            disabled={newGrn?.mode === 'direct'
              ? !(newGrn?.material_id && +newGrn?.qty > 0)
              : !newGrn?.lines?.some(l => +l.receive_qty > 0)}>
            <PackagePlus size={14} /> Create GRN
          </Button>
        </>}>
        {newGrn && <div className="space-y-3">
          <SubTabs active={newGrn.mode} onChange={m => setNewGrn(s => ({ ...s, mode: m }))} views={[
            { key: 'po', label: 'Against Open PO' },
            { key: 'direct', label: 'Direct — No PO' },
          ]} />

          {newGrn.mode === 'po' ? (
            <>
              <Field label="Open Purchase Order" required>
                <Select value={newGrn.po_id} onChange={e => pickNewGrnPo(e.target.value)}>
                  <option value="">Select an open PO…</option>
                  {pos.filter(p => p.status !== 'received' && p.status !== 'closed').map(p => (
                    <option key={p.id} value={p.id} data-search={searchText(p)}>{p.po_number} — {p.vendor_name}</option>))}
                </Select>
              </Field>
              {newGrn.po_id && (newGrn.lines.length === 0 ? (
                <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-500">This PO is fully received — nothing pending to receive.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                    <th className="px-3 py-1.5">Board</th><th className="px-3 py-1.5 text-right">Ordered</th>
                    <th className="px-3 py-1.5 text-right">Balance</th><th className="px-3 py-1.5 text-right">Receive Now</th>
                    <th className="px-3 py-1.5">Batch No</th>
                  </tr></thead>
                  <tbody>
                    {newGrn.lines.map((l, i) => (
                      <Fragment key={l.id}>
                      <tr className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-2">
                          {l.material_name}
                          {/* The mill sends a neighbouring GSM often enough that the fix
                              belongs here, on the receipt, not in a follow-up correction. */}
                          {subLineId !== l.id && (
                            <button type="button" onClick={() => {
                              // Clear the ordinary receive quantity: the substitution
                              // posts its own receipt, and a leftover figure here would
                              // book the SAME delivery twice through /grns/bulk.
                              setNewGrn(g => ({ ...g, lines: g.lines.map((x, j) => j === i ? { ...x, receive_qty: '' } : x) }));
                              setSubLineId(l.id);
                            }}
                              className="ml-2 text-xs font-semibold text-brand-600 underline-offset-2 hover:underline">
                              Received a different board?
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)} {l.unit}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-amber-600">{fmt.num(l.qty - l.received_qty)}</td>
                        <td className="px-3 py-2 text-right">
                          <input type="number" min="0" value={l.receive_qty} disabled={subLineId === l.id}
                            onChange={e => setNewGrn(g => ({ ...g, lines: g.lines.map((x, j) => j === i ? { ...x, receive_qty: e.target.value } : x) }))}
                            className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm focus:border-brand-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-400" />
                        </td>
                        <td className="px-3 py-2">
                          <input placeholder="auto" value={l.batch_no} disabled={subLineId === l.id}
                            onChange={e => setNewGrn(g => ({ ...g, lines: g.lines.map((x, j) => j === i ? { ...x, batch_no: e.target.value } : x) }))}
                            className="w-32 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-400" />
                        </td>
                      </tr>
                      {subLineId === l.id && (
                        <tr><td colSpan={5} className="px-3 pb-3">
                          <GrnSubstitutionPanel line={l}
                            meta={{
                              vehicle_no: newGrn.vehicle_no || undefined,
                              supplier_invoice_no: newGrn.supplier_invoice_no || undefined,
                              supplier_invoice_date: newGrn.supplier_invoice_date || undefined,
                              received_by: newGrn.received_by || undefined,
                              remarks: newGrn.remarks || undefined,
                            }}
                            onCancel={() => setSubLineId(null)}
                            onDone={() => { setSubLineId(null); setNewGrn(null); load(); setTab('grns'); }} />
                        </td></tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              ))}
            </>
          ) : (
            <>
              <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
                Board received without a purchase order (sample, urgent buy, stock correction). It lands in
                quarantine and goes through QC exactly like a PO receipt, then into stock.
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Board" required>
                  <Select value={newGrn.material_id} onChange={e => setNewGrn(s => ({ ...s, material_id: e.target.value }))}>
                    <option value="">Select board…</option>
                    {materials.filter(m => !m.leftover && (m.active == null || m.active)).map(m => (
                      <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>))}
                  </Select>
                </Field>
                <Field label="Quantity Received" required>
                  <Input type="number" min="0" value={newGrn.qty} onChange={e => setNewGrn(s => ({ ...s, qty: e.target.value }))} />
                </Field>
                <Field label="Supplier (optional)">
                  <Select value={newGrn.vendor_id} onChange={e => setNewGrn(s => ({ ...s, vendor_id: e.target.value }))}>
                    <option value="">— unknown —</option>
                    {vendors.map(v => <option key={v.id} value={v.id} data-search={searchText(v)}>{v.name}</option>)}
                  </Select>
                </Field>
                <Field label="Batch No"><Input value={newGrn.batch_no} placeholder="auto if blank"
                  onChange={e => setNewGrn(s => ({ ...s, batch_no: e.target.value }))} /></Field>
              </div>
            </>
          )}

          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Receipt context</span><span>vehicle, invoice, received by</span></div>
            <GrnMetaFields value={newGrn} onChange={patch => setNewGrn(s => ({ ...s, ...patch }))} />
          </section>
        </div>}
      </Modal>

      {/* ── Edit GRN (quarantine only) ── */}
      <Modal open={!!editGrn} onClose={() => setEditGrn(null)} title={editGrn ? `Edit ${editGrn.grn.grn_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setEditGrn(null)}>Cancel</Button>
          <Button onClick={saveEditGrn} disabled={!(+editGrn?.qty > 0)}>Save Changes</Button>
        </>}>
        {editGrn && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {editGrn.grn.material_name} · {editGrn.grn.po_number ? `against ${editGrn.grn.po_number}` : 'direct receipt (no PO)'} — correct a receipt entered in error, before QC.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity Received" required><Input type="number" min="1" value={editGrn.qty} onChange={e => setEditGrn({ ...editGrn, qty: e.target.value })} /></Field>
            <Field label="Supplier Batch No"><Input value={editGrn.batch_no} onChange={e => setEditGrn({ ...editGrn, batch_no: e.target.value })} /></Field>
          </div>
          <GrnMetaFields value={editGrn} onChange={patch => setEditGrn(s => ({ ...s, ...patch }))} />
        </div>}
      </Modal>

      {/* ── GRN QC decision ── */}
      <Modal open={!!qcGrn} onClose={() => setQcGrn(null)} title={qcGrn ? `QC — ${qcGrn.grn.grn_number}` : ''}
        footer={<>
          <Button variant="danger" onClick={async () => {
            await api.post(`/grns/${qcGrn.grn.id}/qc`, { accept: false, note: qcGrn.note });
            toast.info('Batch rejected'); setQcGrn(null); load();
          }}>Reject</Button>
          <Button variant="success" onClick={async () => {
            const g = qcGrn.grn;
            await api.post(`/grns/${g.id}/qc`, { accept: true, note: qcGrn.note });
            setQcGrn(null); load();
            // A board receipt chains straight into Cover: the sheets just
            // became free stock, so offer to earmark them for the jobs whose
            // PR asked for this board. Silent when nothing is waiting, and
            // only for roles that can actually cover.
            const opened = canCoverRole && await openCover(g, { silent: true });
            toast.success(opened
              ? 'Accepted — now cover the jobs this board was bought for'
              : 'Accepted — batch released to stock');
          }}>Accept &amp; Release</Button>
        </>}>
        {qcGrn && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {qcGrn.grn.material_name} · {fmt.num(qcGrn.grn.qty)} {qcGrn.grn.unit} · batch {qcGrn.grn.batch_no}
          </div>
          <Field label="QC Note"><Textarea value={qcGrn.note} onChange={e => setQcGrn({ ...qcGrn, note: e.target.value })} placeholder="GSM check, shade, moisture…" /></Field>
        </div>}
      </Modal>

      {/* ── Cover board — the receipt's sheets, earmarked for the jobs that
          ordered them. Suggested split walks the jobs in PR order; every
          quantity stays editable, and free stock is the only hard ceiling. ── */}
      {cover && (() => {
        const { data } = cover;
        const askTotal = data.candidates.reduce((s, c) => s + (+cover.qty[c.order_line_id] || 0), 0);
        const overFree = askTotal > data.stock.free;
        return (
          <Modal open wide onClose={() => setCover(null)}
            title={`Cover board — ${cover.grn.grn_number}`}
            footer={<>
              <Button variant="secondary" onClick={() => setCover(null)}>Not now</Button>
              <Button onClick={submitCover} disabled={coverBusy || askTotal <= 0 || overFree}>
                {coverBusy ? 'Covering…' : `Hold ${fmt.num(askTotal)} sheets`}
              </Button>
            </>}>
            <div className="space-y-3">
              <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                <span className="font-semibold text-gray-800">{data.material.name}</span>
                {' '}· {fmt.num(data.grn.qty)} sheets landed on {data.grn.grn_number}
                {data.grn.source === 'direct' ? ' (direct receipt)' : ''} — hold them for the jobs whose PR
                asked for this board, so the stock stays theirs until cutting draws it.
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  ['In warehouse', data.stock.available, 'bg-slate-100 text-slate-600'],
                  ['Already held', data.stock.held, 'bg-amber-50 text-amber-700'],
                  ['Free', data.stock.free, overFree ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'],
                ].map(([label, n, tone]) => (
                  <span key={label} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold tabular-nums ${tone}`}>
                    {label} · {fmt.num(n)}
                  </span>
                ))}
                {overFree && (
                  <span className="text-[11px] font-bold text-red-600">holding more than is free</span>
                )}
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2">Job</th>
                      <th className="px-3 py-2">PR</th>
                      <th className="px-3 py-2 text-right">Need</th>
                      <th className="px-3 py-2 text-right">Held</th>
                      <th className="px-3 py-2 text-right">Incoming</th>
                      <th className="px-3 py-2 text-right">Still open</th>
                      <th className="px-3 py-2 text-right">Hold now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map(c => (
                      <tr key={c.order_line_id} className={`border-b border-slate-100 last:border-0 ${c.coverable <= 0 ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5 font-bold text-slate-800">
                            {c.product_name}
                            {c.gang_number && <span className="rounded bg-violet-100 px-1 py-px text-[9px] font-bold text-violet-700">{c.gang_number}</span>}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {[c.product_code, c.customer_name, c.po_number && `PO ${c.po_number}`].filter(Boolean).join(' · ')}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-semibold text-slate-500">{c.pr_number}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt.num(c.need)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt.num(c.held)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-700">{fmt.num(c.incoming)}</td>
                        <td className="px-3 py-2 text-right font-bold tabular-nums">{fmt.num(c.coverable)}</td>
                        <td className="px-3 py-2 text-right">
                          {c.coverable > 0 ? (
                            <Input type="number" min="0" max={c.coverable} value={cover.qty[c.order_line_id]}
                              onChange={e => setCover(s => ({ ...s, qty: { ...s.qty, [c.order_line_id]: e.target.value } }))}
                              className="w-24 text-right" />
                          ) : (
                            <span className="text-[10px] font-bold text-emerald-600">covered</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.skipped.length > 0 && (
                <div className="rounded-lg bg-amber-50/60 p-2.5 text-[11px] text-amber-800">
                  {data.skipped.map(s => (
                    <div key={s.order_line_id}>{s.product_name} — {s.reason}</div>
                  ))}
                </div>
              )}
            </div>
          </Modal>
        );
      })()}

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
