// Bulk costing — several products in one go, on the same engine as a single costing. A batch is a
// table, one row per product.
//   • Paste Product · Size · Quantity from Excel. A pasted name (or code) that is one Product Master
//     entry fills that row's size, pasting, sheet & ups, GSM, colours and board from the master.
//   • Typing a size fills an empty layout from the Size Library (the most used).
//   • The common settings carry into the rows that still follow them; a row given its own value keeps
//     it, and "↓" beside a setting copies it over every row. Die & pasting, left blank in common,
//     follows each row's pasting style — what the plant's costings usually charge for that style.
//   • "Also price at" quantities add a column per quantity: the same costing at that quantity, set-up
//     spread over it. The quotation sheet carries a price per quantity.
//   • Each row keeps its own complete inputs, and on save only a changed row gets a new revision.
//     A login with the Management right approves every ready row at once.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, BadgeCheck, ClipboardPaste, Copy, FolderOpen, Plus, Save, Sparkles, Trash2, X } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, ExportMenu, Field, Input, Modal, Select, Textarea, useToast } from '../../components/ui.jsx';
import { computeCosting, parseSize, styleLabel, num, quantityBreaks } from '../../lib/costing.js';
import {
  answeredNo, batchExportSpec, coatingChoices, coatingLabel, gradeFor, libraryDeclined, libraryKey, newLibraryEntry, parsePaste, pastingFromProduct,
  perUnit, plain, rupees, startingInputs,
} from '../../lib/costingUi.js';
import CostingEditor, { NumField } from './CostingEditor.jsx';

// The settings a batch shares. Size, layout and quantity are each product's own.
const COMMON = [
  { key: 'gsm', label: 'GSM' },
  { key: 'board_rate', label: 'Board ₹/kg' },
  { key: 'wastage', label: 'Wastage sheets' },
  { key: 'colours', label: 'Colours' },
  { key: 'print_rate', label: 'Printing ₹ per 1,000 sheets per colour' },
  { key: 'print_min', label: 'Minimum printing ₹' },
  { key: 'dp_rate', label: 'Die & pasting ₹/carton', placeholder: 'by pasting style' },
  { key: 'emb_rate', label: 'Embossing ₹/carton' },
  { key: 'process', label: 'Process ₹ per job' },
  { key: 'pf_pct', label: 'P&F %' },
  { key: 'misc_pct', label: 'Misc %' },
  { key: 'margin', label: 'Quote margin ₹/carton' },
];
const STYLE_OPTIONS = ['LOCK', 'SIDE', 'LIT', 'CUP', 'DBL PAS', 'DIE CUT', 'NONE'];
const blank = v => v == null || String(v).trim() === '';

let seq = 0;
const rowKey = () => `r${++seq}`;
// Die & pasting a row gets while the common box is blank: typical for its pasting style.
const styleDp = (typical, style) => (style && typical?.dp_by_style?.[style]?.value) ?? '';
const newRow = (common, typical, extra = {}) => {
  const style = extra.style ?? common.style ?? null;
  const dpAuto = blank(common.inputs.dp_rate);
  return {
    key: rowKey(), id: null, product_name: '', size_text: '', style, autofill: false,
    coat_choice: common.coat_choice ?? '',
    inputs: { ...startingInputs({}), ...Object.fromEntries(COMMON.map(c => [c.key, common.inputs[c.key] ?? ''])),
      coat_factor: common.inputs.coat_factor ?? '', dp_rate: dpAuto ? styleDp(typical, style) : common.inputs.dp_rate },
    dp_auto: dpAuto,
    ...extra,
  };
};
const coatChoiceOf = inputs => (num(inputs?.coat_rate) > 0 ? 'rate' : num(inputs?.coat_factor) > 0 ? String(num(inputs.coat_factor)) : 'none');
// A batch's rows as the server holds them, back into the table's shape.
const rowsFromServer = rows => rows.map(r => {
  const row = {
    key: rowKey(), id: r.id, costing_no: r.costing_no, version: r.version, status: r.status, approved_by_name: r.approved_by_name,
    complete: r.complete, product_id: r.product_id, product_name: r.product_name, size_text: r.size_text || r.size_key || '', style: r.style,
    inputs: { ...startingInputs({}), ...r.inputs }, coat_choice: coatChoiceOf(r.inputs), autofill: false, dp_auto: false,
  };
  return answeredNo(r) ? { ...row, skip_library: libraryKey(row) } : row;
});

export default function BulkCosting({ boot, customers }) {
  const [openBatch, setOpenBatch] = useState(null);   // null = list; 'new' or an id
  if (openBatch) return <BatchEditor boot={boot} customers={customers} batchId={openBatch === 'new' ? null : openBatch} onClose={() => setOpenBatch(null)} onOpened={setOpenBatch} />;
  return <BatchList onOpen={setOpenBatch} />;
}

function BatchList({ onOpen }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/costing/batches').then(setRows).catch(() => setRows([])); }, []);
  const columns = [
    { key: 'batch_no', label: 'No.', render: r => <span className="font-bold text-brand-600">{r.batch_no}</span> },
    { key: 'title', label: 'Title', render: r => r.title || '—' },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'rows', label: 'Products', align: 'right', render: r => `${r.complete}/${r.rows} ready` },
    { key: 'cost_value', label: 'Value at cost', align: 'right', render: r => rupees(r.cost_value) },
    { key: 'updated_at', label: 'Last saved', render: r => `${r.updated_at} · ${r.updated_by_name || ''}` },
  ];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-3xl text-sm text-slate-500">Cost several products together — paste them from Excel, set the board and printing once, price every product at several quantities, and approve them together.</p>
        <Button onClick={() => onOpen('new')}><Plus size={15} className="mr-1 inline" />New bulk costing</Button>
      </div>
      <DataTable rows={rows || []} columns={columns} onRowClick={r => onOpen(r.id)} defaultSort={{ key: 'updated_at', dir: 'desc' }}
        empty={rows ? 'No bulk costings yet.' : 'Loading…'} />
    </div>
  );
}

function BatchEditor({ boot, customers, batchId, onClose, onOpened }) {
  const toast = useToast();
  const defaults = boot?.settings?.defaults || {};
  const typical = boot?.typical || {};
  const grades = boot?.board_grades || [];
  const coatings = boot?.settings?.coatings || [];
  const [batch, setBatch] = useState(() => ({
    id: null, batch_no: null, title: '', customer_id: null, customer_name: '',
    // Die & pasting starts blank so it follows each row's pasting style.
    common: { inputs: { ...startingInputs(defaults), dp_rate: '' }, coat_choice: '', style: null, board_grade: '', quantities: [] },
    rows: [],
  }));
  const [loading, setLoading] = useState(!!batchId);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(null);       // row key open in the full editor
  const [pasting, setPasting] = useState(false);
  const [asking, setAsking] = useState(null);         // the new library entries, put to the user on saving
  const [checks, setChecks] = useState({});           // size key → bulk size check
  const [addQty, setAddQty] = useState('');

  const load = id => api.get(`/costing/batches/${id}`).then(b => {
    const { quantities = [], ...saved } = b.common || {};
    const common = { inputs: { ...startingInputs(defaults), ...saved }, coat_choice: b.rows.length ? coatChoiceOf(b.rows[0].inputs) : '', style: null, board_grade: '', quantities };
    // A row whose die & pasting is what its style usually carries, under a blank common box, still follows the style.
    const rows = rowsFromServer(b.rows).map(r => ({ ...r, dp_auto: blank(common.inputs.dp_rate) && String(r.inputs.dp_rate) === String(styleDp(typical, r.style)) }));
    setBatch({ id: b.id, batch_no: b.batch_no, title: b.title || '', customer_id: b.customer_id, customer_name: b.customer_name || '', common, rows });
    setDirty(false);
  });
  useEffect(() => {
    if (!batchId) {
      setBatch(b => ({ ...b, rows: b.rows.length ? b.rows : [newRow(b.common, typical), newRow(b.common, typical), newRow(b.common, typical)] }));
      return;
    }
    load(batchId).catch(() => onClose()).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  const update = fn => { setBatch(b => fn(b)); setDirty(true); };
  const setRow = (key, patch) => update(b => ({ ...b, rows: b.rows.map(r => {
    if (r.key !== key) return r;
    const next = { ...r, ...patch };
    // A row whose die & pasting follows its style takes the new style's figure.
    if (patch.style !== undefined && r.dp_auto) next.inputs = { ...next.inputs, dp_rate: styleDp(typical, next.style) || defaults.dp_rate || '' };
    return next;
  }) }));
  const setRowIn = (key, k, v) => update(b => ({ ...b, rows: b.rows.map(r => (r.key === key ? { ...r, ...(k === 'dp_rate' ? { dp_auto: false } : {}), inputs: { ...r.inputs, [k]: v } } : r)) }));
  // A common setting carries into the rows that still follow it — the box is blank, or holds the common
  // value as it was (die & pasting: or follows the style). A row given its own value keeps it.
  const follows = (r, k, commonWas) => blank(r.inputs[k]) || String(r.inputs[k]) === String(commonWas ?? '') || (k === 'dp_rate' && r.dp_auto);
  const setCommon = (k, v) => update(b => ({
    ...b,
    common: { ...b.common, inputs: { ...b.common.inputs, [k]: v } },
    rows: b.rows.map(r => {
      if (!follows(r, k, b.common.inputs[k])) return r;
      if (k === 'dp_rate' && blank(v)) return { ...r, dp_auto: true, inputs: { ...r.inputs, dp_rate: styleDp(typical, r.style) || defaults.dp_rate || '' } };
      return { ...r, ...(k === 'dp_rate' ? { dp_auto: false } : {}), inputs: { ...r.inputs, [k]: v } };
    }),
  }));
  const applyAll = k => {
    update(b => ({ ...b, rows: b.rows.map(r => (k === 'dp_rate' && blank(b.common.inputs.dp_rate)
      ? { ...r, dp_auto: true, inputs: { ...r.inputs, dp_rate: styleDp(typical, r.style) || defaults.dp_rate || '' } }
      : { ...r, ...(k === 'dp_rate' ? { dp_auto: false } : {}), inputs: { ...r.inputs, [k]: b.common.inputs[k] } })) }));
    toast.info(`${COMMON.find(c => c.key === k)?.label || k} copied into all ${batch.rows.length} rows`);
  };
  const setCoat = v => update(b => {
    const factor = v === 'none' ? '' : v;
    return {
      ...b,
      common: { ...b.common, coat_choice: v, inputs: { ...b.common.inputs, coat_factor: factor } },
      rows: b.rows.map(r => (blank(r.coat_choice) || r.coat_choice === b.common.coat_choice
        ? { ...r, coat_choice: v, inputs: { ...r.inputs, coat_factor: factor, coat_rate: '' } } : r)),
    };
  });
  const applyCoatAll = () => {
    update(b => ({ ...b, rows: b.rows.map(r => ({ ...r, coat_choice: b.common.coat_choice, inputs: { ...r.inputs, coat_factor: b.common.inputs.coat_factor, coat_rate: '' } })) }));
    toast.info(`Coating copied into all ${batch.rows.length} rows`);
  };
  const setQuantities = list => update(b => ({ ...b, common: { ...b.common, quantities: [...new Set(list.map(num).filter(q => q > 0))].sort((x, y) => x - y).slice(0, 6) } }));

  // Library layouts for every size in the batch, one request; an empty layout is filled from the most
  // used one (never over what was typed).
  const sizeKeys = useMemo(() => [...new Set(batch.rows.map(r => parseSize(r.size_text)?.key).filter(Boolean))].sort().join('|'), [batch.rows]);
  const lastKeys = useRef('');
  useEffect(() => {
    if (!sizeKeys || sizeKeys === lastKeys.current) return undefined;
    const t = setTimeout(() => {
      lastKeys.current = sizeKeys;
      api.post('/costing/size-check/bulk', { sizes: sizeKeys.split('|') }).then(map => {
        setChecks(map);
        setBatch(b => ({ ...b, rows: b.rows.map(r => {
          const k = parseSize(r.size_text)?.key;
          const top = k && map[k]?.library?.[0];
          const empty = !r.inputs.sheet_l && !r.inputs.sheet_w && !r.inputs.ups;
          if (!top || !empty) return r;
          const style = r.style || top.style;
          return { ...r, style, layout_note: `layout from the Size Library (used ${top.times_costed}×)`,
            inputs: { ...r.inputs, sheet_l: top.sheet_l ?? '', sheet_w: top.sheet_w ?? '', ups: top.ups ?? '',
              ...(r.dp_auto ? { dp_rate: styleDp(typical, style) || defaults.dp_rate || '' } : {}) } };
        }) }));
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeKeys]);

  const qs = batch.common.quantities || [];
  const priced = batch.rows.map(r => ({ ...r, r: computeCosting(r.inputs), breaks: qs.length ? quantityBreaks(r.inputs, qs) : [] }));
  const ready = priced.filter(x => x.r.ok && x.product_name.trim() && x.coat_choice !== '');
  const totals = ready.reduce((t, x) => ({ cost: t.cost + x.r.cost_value, quote: t.quote + x.r.quote_value }), { cost: 0, quote: 0 });
  const toApprove = batch.rows.filter(r => r.id && r.complete && r.status !== 'approved').length;
  const allApproved = ready.length > 0 && ready.every(x => x.status === 'approved') && !dirty;

  const save = async () => {
    const named = batch.rows.filter(r => r.product_name.trim());
    if (named.length < batch.rows.length) {
      const empty = batch.rows.filter(r => !r.product_name.trim() && !r.size_text.trim() && !r.inputs.qty);
      if (empty.length !== batch.rows.length - named.length) { toast.error('Every row needs a product name (or clear the row).'); return; }
    }
    // Only complete rows can add to the library. The look-up failing never stops a save.
    const fresh = new Map();
    const complete = named.filter(r => computeCosting(r.inputs).ok && !libraryDeclined(r));
    const keys = [...new Set(complete.map(r => parseSize(r.size_text)?.key).filter(Boolean))];
    if (keys.length) {
      try {
        const map = await api.post('/costing/size-check/bulk', { sizes: keys });
        for (const r of complete) {
          const entry = newLibraryEntry(r, map[parseSize(r.size_text)?.key]?.library);
          if (entry) fresh.set(entry.key, entry);
        }
      } catch { fresh.clear(); }
    }
    if (fresh.size) setAsking([...fresh.values()]);
    else await store(named);
  };

  const store = async named => {
    const body = {
      title: batch.title, customer_id: batch.customer_id, customer_name: batch.customer_name,
      common: { ...batch.common.inputs, quantities: qs },
      rows: named.map(r => ({ id: r.id || undefined, product_id: r.product_id || undefined, product_name: r.product_name, size_text: r.size_text, style: r.style, inputs: r.inputs, save_size: !libraryDeclined(r) })),
    };
    const b = batch.id ? await api.post(`/costing/batches/${batch.id}/save`, body) : await api.post('/costing/batches', body);
    toast.success(`${b.batch_no} saved — ${b.rows.length} products`);
    setDirty(false);
    if (!batch.id) onOpened(b.id);
    else setBatch(cur => ({ ...cur, batch_no: b.batch_no,
      rows: rowsFromServer(b.rows).map(r => ({ ...r, dp_auto: blank(cur.common.inputs.dp_rate) && String(r.inputs.dp_rate) === String(styleDp(typical, r.style)) })) }));
  };

  const answer = async yes => {
    const asked = new Set(asking.map(e => e.key));
    const rows = yes ? batch.rows : batch.rows.map(r => (asked.has(libraryKey(r)) ? { ...r, skip_library: libraryKey(r) } : r));
    if (!yes) setBatch(b => ({ ...b, rows }));
    await store(rows.filter(r => r.product_name.trim()));
    setAsking(null);
  };

  const approveAll = async () => {
    const r = await api.post(`/costing/batches/${batch.id}/approve`, {});
    toast.success(`${r.approved} costing${r.approved === 1 ? '' : 's'} approved`);
    await load(batch.id);
  };

  // Pasted rows: a name (or code) that is exactly one Product Master entry fills the row from it.
  const addPasted = async text => {
    const pasted = parsePaste(text);
    if (!pasted.length) { toast.error('Nothing to add — paste rows of Product · Size · Quantity.'); return; }
    setPasting(false);
    let matches = {};
    try { matches = await api.post('/costing/products/match', { names: pasted.map(p => p.product_name).filter(Boolean) }); } catch { matches = {}; }
    // The rows are made here, not inside the state update (React may run an updater later, or twice).
    const common = batch.common;
    let matched = 0;
    const fresh = pasted.map(p => {
        const m = matches[String(p.product_name || '').trim().toLowerCase().replace(/\s+/g, ' ')];
        if (!m) {
          const row = newRow(common, typical, { product_name: p.product_name, size_text: p.size_text });
          return { ...row, inputs: { ...row.inputs, qty: p.qty ?? '' } };
        }
        matched++;
        const style = pastingFromProduct(m.pasting_type) || common.style || null;
        const row = newRow(common, typical, { product_name: m.name, product_id: m.id, style, size_text: p.size_text || parseSize(m.size)?.key || '' });
        const g = gradeFor(m.board_grade, grades);
        const layout = num(m.sheet_l) > 0 && num(m.sheet_w) > 0 && num(m.ups) > 1;
        return {
          ...row,
          layout_note: `from the Product Master (${m.code})`,
          inputs: {
            ...row.inputs, qty: p.qty ?? '',
            ...(layout ? { sheet_l: num(m.sheet_l), sheet_w: num(m.sheet_w), ups: num(m.ups) } : {}),
            ...(num(m.gsm) > 0 ? { gsm: num(m.gsm) } : {}),
            ...(num(m.colours) > 0 ? { colours: num(m.colours) } : {}),
            ...(g ? { board_rate: g.rate_per_kg } : {}),
            ...(+m.emboss !== 1 ? { emb_rate: 0 } : {}),
          },
        };
      });
    update(b => ({ ...b, rows: [...b.rows.filter(r => r.product_name.trim() || r.size_text.trim() || r.inputs.qty), ...fresh] }));
    toast.success(`${pasted.length} row${pasted.length === 1 ? '' : 's'} added${matched ? ` — ${matched} filled from the Product Master` : ''}`);
  };

  const pickCustomer = name => {
    const hit = customers.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
    update(b => ({ ...b, customer_name: name, customer_id: hit ? hit.id : null }));
  };

  if (loading) return <div className="p-8 text-sm text-slate-400">Opening the batch…</div>;
  const cell = 'h-8 !px-2 !py-1 text-[13px]';
  const editingRow = batch.rows.find(r => r.key === editing);
  const exportRows = batch.rows.filter(r => r.product_name.trim());

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onClose} className="text-sm font-semibold text-brand-600 hover:underline">← All bulk costings</button>
        <div className="mr-auto text-sm font-bold">{batch.batch_no || 'New bulk costing'}{dirty && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">Not saved</span>}</div>
        {boot?.can_approve && batch.id && toApprove > 0 && (
          <Button variant="success" onClick={approveAll} disabled={dirty} title={dirty ? 'Save the batch first' : 'Approve every complete row'}>
            <BadgeCheck size={15} className="mr-1.5 inline" />Approve {toApprove} ready
          </Button>
        )}
        <ExportMenu label="Export (internal)" build={() => batchExportSpec(batch, exportRows, { quantities: qs })} />
        <ExportMenu label="Quotation sheet" build={() => batchExportSpec(batch, exportRows, { customer: true, quantities: qs, draft: !allApproved })} />
        <Button onClick={save} disabled={!batch.rows.some(r => r.product_name.trim())}><Save size={15} className="mr-1.5 inline" />Save batch</Button>
      </div>

      <form data-ci-form onSubmit={e => e.preventDefault()} className="space-y-4">
        <section className="ci-form-panel glass rounded-2xl p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Customer">
              <Input list="costing-batch-customers" value={batch.customer_name} onChange={e => pickCustomer(e.target.value)} placeholder="Customer name" />
              <datalist id="costing-batch-customers">{customers.map(c => <option key={c.id} value={c.name} />)}</datalist>
            </Field>
            <Field label="Title" className="sm:col-span-2"><Input value={batch.title} onChange={e => update(b => ({ ...b, title: e.target.value }))} placeholder="e.g. RFQ of 12 cartons, Oct 2026" /></Field>
          </div>
          <div className="mt-4 mb-2 text-sm font-bold">Common settings <span className="font-normal text-slate-500">— rows follow these unless you gave a row its own value; the ↓ button copies one into every row, over what was typed</span></div>
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
            <Field label="Board grade" className="lg:col-span-2">
              <Select value={batch.common.board_grade || ''} placeholder="Choose a grade…" onChange={e => {
                const g = grades.find(x => x.grade === e.target.value);
                const grade = e.target.value;
                update(b => ({ ...b, common: { ...b.common, board_grade: grade } }));
                if (g) setCommon('board_rate', g.rate_per_kg);
              }}>
                <option value="">— type the rate —</option>
                {grades.map(g => <option key={g.grade} value={g.grade}>{g.grade} — ₹{plain(g.rate_per_kg)}/kg</option>)}
              </Select>
            </Field>
            {COMMON.map(c => (
              <div key={c.key} className="relative">
                <NumField label={c.label} value={batch.common.inputs[c.key]} onChange={v => setCommon(c.key, v)} placeholder={c.placeholder}
                  help={c.key === 'dp_rate' ? `Blank: each row takes what your costings usually charge for its pasting — ${Object.entries(typical.dp_by_style || {}).slice(0, 3).map(([s, x]) => `${styleLabel(s)} ₹${plain(x.value)}`).join(', ')}` : undefined} />
                <button type="button" title="Copy into all rows" onClick={() => applyAll(c.key)}
                  className="absolute right-1.5 top-[26px] rounded-md p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600"><ArrowDownToLine size={14} /></button>
              </div>
            ))}
            <div className="relative sm:col-span-2 lg:col-span-4">
              <Field label={<>Coating <span className="text-brand-500">*</span></>}>
                <Select value={batch.common.coat_choice || ''} onChange={e => setCoat(e.target.value)} placeholder="Choose…">
                  <option value="">Choose…</option>
                  <option value="none">No coating</option>
                  {coatingChoices(coatings, batch.common.coat_choice).map(c => <option key={c.factor} value={String(c.factor)}>{coatingLabel(c)}</option>)}
                </Select>
              </Field>
              <button type="button" title="Copy into all rows" onClick={applyCoatAll}
                className="absolute right-9 top-[26px] rounded-md p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600"><ArrowDownToLine size={14} /></button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">Also price at</span>
            {qs.map(q => (
              <span key={q} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700 ring-1 ring-brand-200">
                {plain(q, 0)}<button type="button" title="Remove" onClick={() => setQuantities(qs.filter(x => x !== q))}><X size={12} /></button>
              </span>
            ))}
            <Input className="!h-8 !w-28 text-xs" inputMode="decimal" value={addQty} placeholder="e.g. 25000" onChange={e => setAddQty(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setQuantities([...qs, addQty]); setAddQty(''); } }} />
            <Button size="sm" variant="secondary" onClick={() => { setQuantities([...qs, addQty]); setAddQty(''); }}>Add</Button>
            <span className="text-xs text-slate-500">Every product is also priced at these — the set-up cost spread over each quantity.</span>
          </div>
        </section>

        <section className="glass rounded-2xl p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="mr-auto text-sm font-bold">Products <span className="font-normal text-slate-500">· {ready.length} of {batch.rows.length} ready · {rupees(totals.cost)} at cost · {rupees(totals.quote)} quoted</span></div>
            <Button size="sm" variant="secondary" onClick={() => setPasting(true)}><ClipboardPaste size={14} className="mr-1 inline" />Paste from Excel</Button>
            <Button size="sm" variant="secondary" onClick={() => update(b => ({ ...b, rows: [...b.rows, newRow(b.common, typical)] }))}><Plus size={14} className="mr-1 inline" />Add a row</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" style={{ minWidth: 1180 + qs.length * 96 }}>
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="text-left">
                  <th className="px-1.5 py-1">#</th><th className="px-1.5 py-1">Product</th><th className="px-1.5 py-1">Size (mm)</th><th className="px-1.5 py-1">Pasting</th>
                  <th className="px-1.5 py-1 text-right">Qty</th><th className="px-1.5 py-1">Sheet L × W (in)</th><th className="px-1.5 py-1 text-right">Ups</th>
                  <th className="px-1.5 py-1 text-right">Cost / carton</th><th className="px-1.5 py-1 text-right">Quote</th><th className="px-1.5 py-1 text-right">Value</th>
                  {qs.map(q => <th key={q} className="px-1.5 py-1 text-right text-brand-700">@ {plain(q, 0)}</th>)}
                  <th className="px-1.5 py-1">Before · Die</th><th className="px-1.5 py-1">Status</th><th className="px-1.5 py-1" />
                </tr>
              </thead>
              <tbody>
                {priced.map((x, i) => {
                  const k = parseSize(x.size_text)?.key;
                  const ck = k && checks[k];
                  const needs = [...(x.r.ok ? [] : x.r.missing.map(m => m.label.toLowerCase())), ...(x.product_name.trim() ? [] : ['product name']), ...(x.coat_choice === '' ? ['coating'] : [])];
                  const differs = COMMON.some(c => !(c.key === 'dp_rate' && (x.dp_auto || blank(batch.common.inputs.dp_rate)))
                    && String(x.inputs[c.key] ?? '') !== String(batch.common.inputs[c.key] ?? ''));
                  return (
                    <tr key={x.key} className="border-t border-slate-200/70 align-top">
                      <td className="px-1.5 py-1.5 text-slate-400">{i + 1}{x.costing_no && <div className="text-[10px]">{x.costing_no}</div>}</td>
                      <td className="px-1.5 py-1"><Input className={`${cell} w-56`} value={x.product_name} onChange={e => setRow(x.key, { product_name: e.target.value })} placeholder="Product name" />
                        {x.product_id && <div className="mt-0.5 flex items-center gap-1 text-[10px] text-brand-700"><Sparkles size={10} />Product Master</div>}</td>
                      <td className="px-1.5 py-1"><Input className={`${cell} w-32`} value={x.size_text} onChange={e => setRow(x.key, { size_text: e.target.value, layout_note: null })} placeholder="165x58x73" />
                        {x.layout_note && <div className="mt-0.5 text-[10px] text-emerald-700">{x.layout_note}</div>}</td>
                      <td className="px-1.5 py-1">
                        <select className={`${cell} w-28 rounded-lg border border-slate-200 bg-white/80`} value={x.style || ''} onChange={e => setRow(x.key, { style: e.target.value || null })}>
                          <option value="">—</option>{STYLE_OPTIONS.map(s => <option key={s} value={s}>{styleLabel(s)}</option>)}
                        </select>
                        {x.dp_auto && num(x.inputs.dp_rate) > 0 && <div className="mt-0.5 text-[10px] text-teal-700">D&P ₹{plain(num(x.inputs.dp_rate))} typical</div>}
                      </td>
                      <td className="px-1.5 py-1"><Input inputMode="decimal" className={`${cell} w-24 text-right`} value={x.inputs.qty ?? ''} onChange={e => setRowIn(x.key, 'qty', e.target.value)} /></td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <Input inputMode="decimal" className={`${cell} w-16`} value={x.inputs.sheet_l ?? ''} onChange={e => setRowIn(x.key, 'sheet_l', e.target.value)} /> ×{' '}
                        <Input inputMode="decimal" className={`${cell} w-16`} value={x.inputs.sheet_w ?? ''} onChange={e => setRowIn(x.key, 'sheet_w', e.target.value)} />
                      </td>
                      <td className="px-1.5 py-1"><Input inputMode="decimal" className={`${cell} w-14 text-right`} value={x.inputs.ups ?? ''} onChange={e => setRowIn(x.key, 'ups', e.target.value)} /></td>
                      <td className="px-1.5 py-1.5 text-right font-bold tabular-nums">{x.r.ok ? perUnit(x.r.cost_per_unit) : '—'}</td>
                      <td className="px-1.5 py-1.5 text-right tabular-nums text-brand-700">{x.r.ok ? perUnit(x.r.quote_per_unit) : '—'}</td>
                      <td className="px-1.5 py-1.5 text-right tabular-nums">{x.r.ok ? rupees(x.r.cost_value) : '—'}
                        {x.r.ok && <div className="text-[10px] font-normal text-slate-500" title="Set-up: the same whatever the quantity">set-up {rupees(x.r.split.fixed)}</div>}</td>
                      {qs.map(q => {
                        const b = x.breaks.find(y => y.qty === q);
                        return <td key={q} className="px-1.5 py-1.5 text-right tabular-nums text-brand-700">{b?.ok ? perUnit(b.cost_per_unit) : '—'}</td>;
                      })}
                      <td className="px-1.5 py-1.5 text-[11px] leading-tight">
                        {!ck ? <span className="text-slate-400">—</span> : (
                          <>
                            <div>{ck.history_count ? <>Costed {ck.history_count}× · last {perUnit(ck.last?.cost_per_unit)}</> : <span className="text-amber-700">New size</span>}</div>
                            <div className={ck.dies_exact.length ? 'text-emerald-700' : 'text-slate-500'}>{ck.dies_exact.length ? `Die ${ck.dies_exact.map(d => d.code).join(', ')}` : 'No die'}</div>
                          </>
                        )}
                      </td>
                      <td className="px-1.5 py-1.5 text-[11px] leading-tight">
                        {needs.length ? <span className="text-amber-700">Needs {needs.join(', ')}</span>
                          : x.status === 'approved' && !dirty ? <span className="font-bold text-emerald-700" title={`Approved by ${x.approved_by_name}`}>Approved</span>
                            : <span className="font-bold text-emerald-700">Ready</span>}
                        {x.r.ok && x.r.warnings.length > 0 && <div className="text-amber-700" title={x.r.warnings.map(w => w.text).join('\n')}>{x.r.warnings.length} note{x.r.warnings.length > 1 ? 's' : ''}</div>}
                        {differs && <div className="text-slate-500" title="One of the common settings is different on this row">Own settings</div>}
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <button type="button" title="Open the full costing of this row" onClick={() => setEditing(x.key)} className="rounded-md p-1.5 text-brand-600 hover:bg-brand-50"><FolderOpen size={15} /></button>
                        <button type="button" title="Copy this row" onClick={() => update(b => { const at = b.rows.findIndex(r => r.key === x.key); const copy = { ...b.rows[at], key: rowKey(), id: null, costing_no: null, version: null, status: null }; return { ...b, rows: [...b.rows.slice(0, at + 1), copy, ...b.rows.slice(at + 1)] }; })} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><Copy size={15} /></button>
                        <button type="button" title={x.id ? 'Take out of the batch (the costing is kept, hidden)' : 'Remove the row'} onClick={() => update(b => ({ ...b, rows: b.rows.filter(r => r.key !== x.key) }))} className="rounded-md p-1.5 text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </form>

      <Modal open={!!editingRow} onClose={() => setEditing(null)} size="xl" title={editingRow ? `Row ${batch.rows.indexOf(editingRow) + 1} · ${editingRow.product_name || 'unnamed'}` : ''}
        footer={<Button onClick={() => setEditing(null)}>Done</Button>}>
        {editingRow && (
          <div>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Field label="Product name" required><Input value={editingRow.product_name} onChange={e => setRow(editingRow.key, { product_name: e.target.value })} /></Field>
              <NumField label="Quantity" unit="cartons" value={editingRow.inputs.qty} onChange={v => setRowIn(editingRow.key, 'qty', v)} />
              <p className="self-end text-xs text-slate-500">Changes here apply to this row only.</p>
            </div>
            <CostingEditor hideProductStep boot={boot} customers={customers} excludeId={editingRow.id}
              value={{ ...editingRow, customer_name: batch.customer_name }}
              onChange={v => setRow(editingRow.key, {
                size_text: v.size_text, style: v.style, inputs: v.inputs, coat_choice: v.coat_choice, board_grade: v.board_grade,
                sources: v.sources, autofill: v.autofill, quantities: v.quantities, show_emb: v.show_emb,
                ...(v.sources?.dp_rate?.kind === 'manual' ? { dp_auto: false } : {}),
              })} />
          </div>
        )}
      </Modal>
      <PasteModal open={pasting} onClose={() => setPasting(false)} onAdd={addPasted} />
      <Modal open={!!asking} onClose={() => setAsking(null)}
        title={asking?.length === 1 ? 'Save this new size to the Size Library?' : `Save these ${asking?.length} new sizes to the Size Library?`}
        footer={<><Button variant="secondary" onClick={() => answer(false)}>No, only the costing</Button><Button onClick={() => answer(true)}>{asking?.length === 1 ? 'Yes, save it' : 'Yes, save them'}</Button></>}>
        <ul className="max-h-60 space-y-1 overflow-auto text-sm font-bold text-[#1D1D1F]">
          {asking?.map(e => <li key={e.key}>{e.text}</li>)}
        </ul>
        <p className="mt-2 text-sm text-slate-600">The next costing of a size will offer its sheet and ups.</p>
      </Modal>
    </div>
  );
}

function PasteModal({ open, onClose, onAdd }) {
  const [text, setText] = useState('');
  useEffect(() => { if (open) setText(''); }, [open]);
  const preview = parsePaste(text);
  return (
    <Modal open={open} onClose={onClose} title="Paste products from Excel"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => onAdd(text)} disabled={!preview.length}>Add {preview.length || ''} rows</Button></>}>
      <p className="mb-2 text-sm text-slate-600">In Excel, select three columns — <b>Product</b>, <b>Size</b> (L×W×H mm) and <b>Quantity</b> — copy, and paste below. A product name (or code) that is in the Product Master fills its own size, sheet, board and colours; the common settings fill the rest.</p>
      <Textarea className="!min-h-[160px] font-mono text-xs" value={text} onChange={e => setText(e.target.value)} placeholder={'Tablet carton 10x10\t100x48x48\t10000\nSyrup carton 100 ml\t60x60x120\t5000'} />
      {preview.length > 0 && (
        <div className="mt-2 max-h-40 overflow-auto rounded-xl bg-white/80 p-2 text-xs ring-1 ring-slate-200">
          {preview.map((p, i) => <div key={i}>{i + 1}. {p.product_name || <i>no name</i>} · {p.size_text || <i>no size</i>} · {p.qty != null ? fmt.num(p.qty) : <i>no qty</i>}</div>)}
        </div>
      )}
    </Modal>
  );
}
