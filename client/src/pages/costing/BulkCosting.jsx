// Bulk costing — several products in one go. A batch is a table, one row per product. The common
// settings (board, printing, coating, charges) fill each NEW row; "↓ all rows" beside a setting copies
// it into every row, only when asked. Every row keeps its own complete inputs, so changing one row never
// changes another. Typing a size fills that row's sheet layout from the Size Library when the row has
// none; "Open" shows the full costing of one row (the single-costing view) to change anything else.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ClipboardPaste, Copy, FolderOpen, Plus, Save, Trash2 } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, ExportMenu, Field, Input, Modal, Select, Textarea, useToast } from '../../components/ui.jsx';
import { computeCosting, parseSize, styleLabel } from '../../lib/costing.js';
import { batchExportSpec, coatingLabel, parsePaste, perUnit, plain, rupees, startingInputs } from '../../lib/costingUi.js';
import CostingEditor, { NumField } from './CostingEditor.jsx';

// The settings a batch shares. Size, layout and quantity are each product's own.
const COMMON = [
  { key: 'gsm', label: 'GSM' },
  { key: 'board_rate', label: 'Board ₹/kg' },
  { key: 'wastage', label: 'Wastage sheets' },
  { key: 'colours', label: 'Colours' },
  { key: 'print_rate', label: 'Printing ₹ per 1,000 sheets per colour' },
  { key: 'print_min', label: 'Minimum printing ₹' },
  { key: 'dp_rate', label: 'Die & pasting ₹/carton' },
  { key: 'emb_rate', label: 'Embossing ₹/carton' },
  { key: 'process', label: 'Process ₹ per job' },
  { key: 'pf_pct', label: 'P&F %' },
  { key: 'misc_pct', label: 'Misc %' },
  { key: 'margin', label: 'Quote margin ₹/carton' },
];
const STYLE_OPTIONS = ['LOCK', 'SIDE', 'LIT', 'CUP', 'DBL PAS', 'DIE CUT', 'NONE'];

let seq = 0;
const rowKey = () => `r${++seq}`;
const newRow = (common, extra = {}) => ({
  key: rowKey(), id: null, product_name: '', size_text: '', style: common.style || null,
  coat_choice: common.coat_choice ?? '',
  inputs: { ...startingInputs({}), ...Object.fromEntries(COMMON.map(c => [c.key, common.inputs[c.key] ?? ''])), coat_factor: common.inputs.coat_factor ?? '' },
  ...extra,
});
const coatChoiceOf = f => (+f > 0 ? String(+f) : 'none');
// A batch's rows as the server holds them, back into the table's shape.
const rowsFromServer = rows => rows.map(r => ({
  key: rowKey(), id: r.id, costing_no: r.costing_no, version: r.version, product_name: r.product_name,
  size_text: r.size_text || r.size_key || '', style: r.style, inputs: { ...startingInputs({}), ...r.inputs },
  coat_choice: coatChoiceOf(r.inputs?.coat_factor),
}));

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
        <p className="mr-auto max-w-3xl text-sm text-slate-500">Cost several products together — paste them from Excel, set the board and printing once, and see every price side by side. Save to come back to it later.</p>
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
  const grades = boot?.board_grades || [];
  const coatings = boot?.settings?.coatings || [];
  const [batch, setBatch] = useState(() => ({
    id: null, batch_no: null, title: '', customer_id: null, customer_name: '',
    common: { inputs: { ...startingInputs(defaults) }, coat_choice: '', style: null, board_grade: '' },
    rows: [],
  }));
  const [loading, setLoading] = useState(!!batchId);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(null);       // row key open in the full editor
  const [pasting, setPasting] = useState(false);
  const [checks, setChecks] = useState({});           // size key → bulk size check

  useEffect(() => {
    if (!batchId) { setBatch(b => ({ ...b, rows: b.rows.length ? b.rows : [newRow(b.common), newRow(b.common), newRow(b.common)] })); return; }
    api.get(`/costing/batches/${batchId}`).then(b => {
      const common = { inputs: { ...startingInputs(defaults), ...(b.common || {}) }, coat_choice: b.common?.coat_factor > 0 ? String(b.common.coat_factor) : (b.rows.length ? coatChoiceOf(b.rows[0].inputs?.coat_factor) : ''), style: null, board_grade: '' };
      setBatch({
        id: b.id, batch_no: b.batch_no, title: b.title || '', customer_id: b.customer_id, customer_name: b.customer_name || '', common,
        rows: rowsFromServer(b.rows),
      });
      setDirty(false);
    }).catch(() => onClose()).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  const update = fn => { setBatch(b => fn(b)); setDirty(true); };
  const setRow = (key, patch) => update(b => ({ ...b, rows: b.rows.map(r => (r.key === key ? { ...r, ...patch } : r)) }));
  const setRowIn = (key, k, v) => update(b => ({ ...b, rows: b.rows.map(r => (r.key === key ? { ...r, inputs: { ...r.inputs, [k]: v } } : r)) }));
  // A common setting carries into the rows that still follow it — the box is blank, or holds the
  // common value as it was. A row given its own value keeps it; only "↓ all rows" overwrites that.
  const blank = v => v == null || String(v).trim() === '';
  const follows = (rowValue, commonWas) => blank(rowValue) || String(rowValue) === String(commonWas ?? '');
  const setCommon = (k, v) => update(b => ({
    ...b,
    common: { ...b.common, inputs: { ...b.common.inputs, [k]: v } },
    rows: b.rows.map(r => (follows(r.inputs[k], b.common.inputs[k]) ? { ...r, inputs: { ...r.inputs, [k]: v } } : r)),
  }));
  const applyAll = k => {
    update(b => ({ ...b, rows: b.rows.map(r => ({ ...r, inputs: { ...r.inputs, [k]: b.common.inputs[k] } })) }));
    toast.info(`${COMMON.find(c => c.key === k)?.label || k} copied into all ${batch.rows.length} rows`);
  };
  const setCoat = v => update(b => {
    const factor = v === 'none' ? '' : v;
    return {
      ...b,
      common: { ...b.common, coat_choice: v, inputs: { ...b.common.inputs, coat_factor: factor } },
      rows: b.rows.map(r => (follows(r.coat_choice, b.common.coat_choice) ? { ...r, coat_choice: v, inputs: { ...r.inputs, coat_factor: factor } } : r)),
    };
  });
  const applyCoatAll = () => {
    update(b => ({ ...b, rows: b.rows.map(r => ({ ...r, coat_choice: b.common.coat_choice, inputs: { ...r.inputs, coat_factor: b.common.inputs.coat_factor } })) }));
    toast.info(`Coating copied into all ${batch.rows.length} rows`);
  };

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
          return { ...r, style: r.style || top.style, layout_note: `from the library (used ${top.times_costed}×)`,
            inputs: { ...r.inputs, sheet_l: top.sheet_l ?? '', sheet_w: top.sheet_w ?? '', ups: top.ups ?? '' } };
        }) }));
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [sizeKeys]);

  const priced = batch.rows.map(r => ({ ...r, r: computeCosting(r.inputs) }));
  const ready = priced.filter(x => x.r.ok && x.product_name.trim() && x.coat_choice !== '');
  const totals = ready.reduce((t, x) => ({ cost: t.cost + x.r.cost_value, quote: t.quote + x.r.quote_value }), { cost: 0, quote: 0 });

  const save = async () => {
    const named = batch.rows.filter(r => r.product_name.trim());
    if (named.length < batch.rows.length) {
      const blank = batch.rows.filter(r => !r.product_name.trim() && !r.size_text.trim() && !r.inputs.qty);
      if (blank.length !== batch.rows.length - named.length) { toast.error('Every row needs a product name (or clear the row).'); return; }
    }
    const body = {
      title: batch.title, customer_id: batch.customer_id, customer_name: batch.customer_name,
      common: { ...batch.common.inputs },
      rows: named.map(r => ({ id: r.id || undefined, product_name: r.product_name, size_text: r.size_text, style: r.style, inputs: r.inputs })),
    };
    const b = batch.id ? await api.post(`/costing/batches/${batch.id}/save`, body) : await api.post('/costing/batches', body);
    toast.success(`${b.batch_no} saved — ${b.rows.length} products`);
    setDirty(false);
    if (!batch.id) onOpened(b.id);
    else setBatch(cur => ({ ...cur, batch_no: b.batch_no, rows: rowsFromServer(b.rows) }));
  };

  const addPasted = text => {
    const rows = parsePaste(text);
    if (!rows.length) { toast.error('Nothing to add — paste rows of Product · Size · Quantity.'); return; }
    update(b => {
      const kept = b.rows.filter(r => r.product_name.trim() || r.size_text.trim() || r.inputs.qty);
      return { ...b, rows: [...kept, ...rows.map(p => {
        const row = newRow(b.common, { product_name: p.product_name, size_text: p.size_text });
        return { ...row, inputs: { ...row.inputs, qty: p.qty ?? '' } };
      })] };
    });
    setPasting(false);
    toast.success(`${rows.length} row${rows.length === 1 ? '' : 's'} added`);
  };

  const pickCustomer = name => {
    const hit = customers.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
    update(b => ({ ...b, customer_name: name, customer_id: hit ? hit.id : null }));
  };

  if (loading) return <div className="p-8 text-sm text-slate-400">Opening the batch…</div>;
  const cell = 'h-8 !px-2 !py-1 text-[13px]';
  const editingRow = batch.rows.find(r => r.key === editing);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onClose} className="text-sm font-semibold text-brand-600 hover:underline">← All bulk costings</button>
        <div className="mr-auto text-sm font-bold">{batch.batch_no || 'New bulk costing'}{dirty && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">Not saved</span>}</div>
        <ExportMenu label="Export (internal)" build={() => batchExportSpec(batch, batch.rows)} />
        <ExportMenu label="Quotation sheet" build={() => batchExportSpec(batch, batch.rows, { customer: true })} />
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
                <NumField label={c.label} value={batch.common.inputs[c.key]} onChange={v => setCommon(c.key, v)} />
                <button type="button" title={`Copy into all rows`} onClick={() => applyAll(c.key)}
                  className="absolute right-1.5 top-[26px] rounded-md p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600"><ArrowDownToLine size={14} /></button>
              </div>
            ))}
            <div className="relative lg:col-span-2">
              <Field label={<>Coating <span className="text-brand-500">*</span></>}>
                <Select value={batch.common.coat_choice || ''} onChange={e => setCoat(e.target.value)} placeholder="Choose…">
                  <option value="">Choose…</option>
                  <option value="none">No coating</option>
                  {coatings.map(c => <option key={c.factor} value={String(c.factor)}>{coatingLabel(c)}</option>)}
                </Select>
              </Field>
              <button type="button" title="Copy into all rows" onClick={applyCoatAll}
                className="absolute right-9 top-[26px] rounded-md p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600"><ArrowDownToLine size={14} /></button>
            </div>
          </div>
        </section>

        <section className="glass rounded-2xl p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="mr-auto text-sm font-bold">Products <span className="font-normal text-slate-500">· {ready.length} of {batch.rows.length} ready · {rupees(totals.cost)} at cost · {rupees(totals.quote)} quoted</span></div>
            <Button size="sm" variant="secondary" onClick={() => setPasting(true)}><ClipboardPaste size={14} className="mr-1 inline" />Paste from Excel</Button>
            <Button size="sm" variant="secondary" onClick={() => update(b => ({ ...b, rows: [...b.rows, newRow(b.common)] }))}><Plus size={14} className="mr-1 inline" />Add a row</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="text-left">
                  <th className="px-1.5 py-1">#</th><th className="px-1.5 py-1">Product</th><th className="px-1.5 py-1">Size (mm)</th><th className="px-1.5 py-1">Pasting</th>
                  <th className="px-1.5 py-1 text-right">Qty</th><th className="px-1.5 py-1">Sheet L × W (in)</th><th className="px-1.5 py-1 text-right">Ups</th>
                  <th className="px-1.5 py-1 text-right">Cost / carton</th><th className="px-1.5 py-1 text-right">Quote</th><th className="px-1.5 py-1 text-right">Value</th>
                  <th className="px-1.5 py-1">Before · Die</th><th className="px-1.5 py-1">Status</th><th className="px-1.5 py-1" />
                </tr>
              </thead>
              <tbody>
                {priced.map((x, i) => {
                  const k = parseSize(x.size_text)?.key;
                  const ck = k && checks[k];
                  const needs = [...(x.r.ok ? [] : x.r.missing.map(m => m.label.toLowerCase())), ...(x.product_name.trim() ? [] : ['product name']), ...(x.coat_choice === '' ? ['coating'] : [])];
                  const differs = COMMON.some(c => String(x.inputs[c.key] ?? '') !== String(batch.common.inputs[c.key] ?? ''));
                  return (
                    <tr key={x.key} className="border-t border-slate-200/70 align-top">
                      <td className="px-1.5 py-1.5 text-slate-400">{i + 1}{x.costing_no && <div className="text-[10px]">{x.costing_no}</div>}</td>
                      <td className="px-1.5 py-1"><Input className={`${cell} w-56`} value={x.product_name} onChange={e => setRow(x.key, { product_name: e.target.value })} placeholder="Product name" /></td>
                      <td className="px-1.5 py-1"><Input className={`${cell} w-32`} value={x.size_text} onChange={e => setRow(x.key, { size_text: e.target.value, layout_note: null })} placeholder="165x58x73" />
                        {x.layout_note && <div className="mt-0.5 text-[10px] text-emerald-700">{x.layout_note}</div>}</td>
                      <td className="px-1.5 py-1">
                        <select className={`${cell} w-28 rounded-lg border border-slate-200 bg-white/80`} value={x.style || ''} onChange={e => setRow(x.key, { style: e.target.value || null })}>
                          <option value="">—</option>{STYLE_OPTIONS.map(s => <option key={s} value={s}>{styleLabel(s)}</option>)}
                        </select>
                      </td>
                      <td className="px-1.5 py-1"><Input inputMode="decimal" className={`${cell} w-24 text-right`} value={x.inputs.qty ?? ''} onChange={e => setRowIn(x.key, 'qty', e.target.value)} /></td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <Input inputMode="decimal" className={`${cell} w-16`} value={x.inputs.sheet_l ?? ''} onChange={e => setRowIn(x.key, 'sheet_l', e.target.value)} /> ×{' '}
                        <Input inputMode="decimal" className={`${cell} w-16`} value={x.inputs.sheet_w ?? ''} onChange={e => setRowIn(x.key, 'sheet_w', e.target.value)} />
                      </td>
                      <td className="px-1.5 py-1"><Input inputMode="decimal" className={`${cell} w-14 text-right`} value={x.inputs.ups ?? ''} onChange={e => setRowIn(x.key, 'ups', e.target.value)} /></td>
                      <td className="px-1.5 py-1.5 text-right font-bold tabular-nums">{x.r.ok ? perUnit(x.r.cost_per_unit) : '—'}</td>
                      <td className="px-1.5 py-1.5 text-right tabular-nums text-brand-700">{x.r.ok ? perUnit(x.r.quote_per_unit) : '—'}</td>
                      <td className="px-1.5 py-1.5 text-right tabular-nums">{x.r.ok ? rupees(x.r.cost_value) : '—'}</td>
                      <td className="px-1.5 py-1.5 text-[11px] leading-tight">
                        {!ck ? <span className="text-slate-400">—</span> : (
                          <>
                            <div>{ck.history_count ? <>Costed {ck.history_count}× · last {perUnit(ck.last?.cost_per_unit)}</> : <span className="text-amber-700">New size</span>}</div>
                            <div className={ck.dies_exact.length ? 'text-emerald-700' : 'text-slate-500'}>{ck.dies_exact.length ? `Die ${ck.dies_exact.map(d => d.code).join(', ')}` : 'No die'}</div>
                          </>
                        )}
                      </td>
                      <td className="px-1.5 py-1.5 text-[11px] leading-tight">
                        {needs.length ? <span className="text-amber-700">Needs {needs.join(', ')}</span> : <span className="font-bold text-emerald-700">Ready</span>}
                        {x.r.ok && x.r.warnings.length > 0 && <div className="text-amber-700" title={x.r.warnings.map(w => w.text).join('\n')}>{x.r.warnings.length} note{x.r.warnings.length > 1 ? 's' : ''}</div>}
                        {differs && <div className="text-slate-500" title="One of the common settings is different on this row">Own settings</div>}
                      </td>
                      <td className="px-1.5 py-1 whitespace-nowrap">
                        <button type="button" title="Open the full costing of this row" onClick={() => setEditing(x.key)} className="rounded-md p-1.5 text-brand-600 hover:bg-brand-50"><FolderOpen size={15} /></button>
                        <button type="button" title="Copy this row" onClick={() => update(b => { const at = b.rows.findIndex(r => r.key === x.key); const copy = { ...b.rows[at], key: rowKey(), id: null, costing_no: null, version: null }; return { ...b, rows: [...b.rows.slice(0, at + 1), copy, ...b.rows.slice(at + 1)] }; })} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><Copy size={15} /></button>
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
              onChange={v => setRow(editingRow.key, { size_text: v.size_text, style: v.style, inputs: v.inputs, coat_choice: v.coat_choice, board_grade: v.board_grade })} />
          </div>
        )}
      </Modal>
      <PasteModal open={pasting} onClose={() => setPasting(false)} onAdd={addPasted} />
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
      <p className="mb-2 text-sm text-slate-600">In Excel, select three columns — <b>Product</b>, <b>Size</b> (L×W×H mm) and <b>Quantity</b> — copy, and paste below. The common settings fill the rest.</p>
      <Textarea className="!min-h-[160px] font-mono text-xs" value={text} onChange={e => setText(e.target.value)} placeholder={'Tablet carton 10x10\t100x48x48\t10000\nSyrup carton 100 ml\t60x60x120\t5000'} />
      {preview.length > 0 && (
        <div className="mt-2 max-h-40 overflow-auto rounded-xl bg-white/80 p-2 text-xs ring-1 ring-slate-200">
          {preview.map((p, i) => <div key={i}>{i + 1}. {p.product_name || <i>no name</i>} · {p.size_text || <i>no size</i>} · {p.qty != null ? fmt.num(p.qty) : <i>no qty</i>}</div>)}
        </div>
      )}
    </Modal>
  );
}
