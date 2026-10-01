import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Button, Input, searchText, Select, useToast } from './ui.jsx';

// "Made in parts" — the pieces this carton is printed as. Each part is its own
// Product Master row (its own board, size, ups, die, plate). The PO only ever
// names the carton; Planning covers each part on its own board.
//
// Saved on its own button, not the dialog's own Save: saving re-syncs every
// open order line of the carton (routes/product-parts.js), so its outcome —
// warnings for lines that could not follow, or the row the server refused —
// is shown here, beside the list, and the outcome goes to the page's toast
// too: a dialog closed mid-save must not swallow a warning.

let nextKey = 0;
const withKey = row => ({ ...row, _key: ++nextKey });
const fromServer = parts => parts.map(p => withKey({
  part_product_id: String(p.part_product_id), label: p.label, per_carton: String(p.per_carton),
}));
const sameList = (a, b) => a.length === b.length && a.every((r, i) =>
  r.part_product_id === b[i].part_product_id && r.label.trim() === b[i].label.trim()
  && String(r.per_carton).trim() === String(b[i].per_carton).trim());

// Sent as typed: a blank pick or a 0 is the server's to refuse — it names the
// row (carton-parts.js partsSetError). A blank pieces-per-carton means 1.
const toBody = rows => ({
  parts: rows.map(r => ({
    part_product_id: r.part_product_id === '' ? null : Number(r.part_product_id),
    label: r.label,
    per_carton: String(r.per_carton).trim() === '' ? null : Number(r.per_carton),
  })),
});

// What a saved part is printed on, as GET/PUT /products/:id/parts return it.
const boardsFrom = parts => Object.fromEntries(parts.map(p => [String(p.part_product_id), { board: p.board_name, ups: p.ups }]));

// "Saffire 290 GSM 20 × 38 · 4 ups" — or, for a part whose master has no real
// board yet (none named, or parked on the "Unspecified board" placeholder),
// say so at setup rather than when Planning first reaches the part.
function boardLine(info) {
  const board = String(info?.board ?? '').trim();
  if (!board || /unspecified/i.test(board)) {
    return { warn: true, text: "No board on file — set this part's board in its own Product Master before it is planned" };
  }
  const ups = Math.max(1, Math.round(+info.ups || 1));
  return { warn: false, text: `${board} · ${ups} up${ups === 1 ? '' : 's'}${info.specIncomplete ? ' · spec incomplete' : ''}` };
}

const COLS = 'grid-cols-[minmax(0,1fr)_5.5rem_2.25rem] sm:grid-cols-[minmax(0,1fr)_9rem_7.5rem_2.25rem]';

export default function ProductPartsEditor({ product, customerProducts = [] }) {
  const toast = useToast();
  const productId = product?.id;
  const [rows, setRows] = useState([]);
  const [saved, setSaved] = useState(null);      // the list as the server has it; null until loaded
  const [savedBoards, setSavedBoards] = useState({});
  const [partOf, setPartOf] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState(null);  // { ok, text, warnings }

  useEffect(() => {
    if (!productId) return;
    let current = true;
    setSaved(null);
    setLoadError('');
    setOutcome(null);
    api.get(`/products/${productId}/parts`).then(d => {
      if (!current) return;
      const list = fromServer(d.parts);
      setRows(list);
      setSaved(list);
      setSavedBoards(boardsFrom(d.parts));
      setPartOf(d.part_of);
    }).catch(e => {
      if (current) setLoadError(e.message || 'Could not load the parts list.');
    });
    return () => { current = false; };
  }, [productId, retry]);

  // This customer's products, never the carton itself. Built once per list —
  // each option carries its whole record as search text, and what it is
  // printed on (the master rows both dialogs hold carry the board and ups).
  const choices = useMemo(() => customerProducts
    .filter(p => String(p.id) !== String(productId))
    .map(p => ({
      id: String(p.id), active: p.active, label: `${p.code} · ${p.name}`, search: searchText(p),
      board: p.board_name || p.board_material_name || null, ups: p.ups, specIncomplete: +p.spec_incomplete === 1,
    })),
  [customerProducts, productId]);

  if (!productId) return null;

  const set = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => setRows(rs => [...rs, withKey({ part_product_id: '', label: `Part ${rs.length + 1}`, per_carton: '1' })]);
  const remove = i => setRows(rs => rs.filter((_, j) => j !== i));
  // A product already picked on another row is not offered again, and an
  // inactive one only where it is already chosen.
  const optionsFor = i => choices.filter(p => p.id === rows[i].part_product_id
    || ((p.active == null || p.active) && !rows.some((r, j) => j !== i && r.part_product_id === p.id)));

  // One press: the Button stays busy until this promise settles (ui.jsx).
  const save = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const d = await api.put(`/products/${productId}/parts`, toBody(rows));
      const list = fromServer(d.parts);
      setRows(list);
      setSaved(list);
      setSavedBoards(boardsFrom(d.parts));
      const lines = d.synced ? ` · ${d.synced} part-line change${d.synced === 1 ? '' : 's'} on open orders` : '';
      const text = `Saved — ${list.length ? `made in ${list.length} parts` : 'a normal carton, not made in parts'}${lines}`;
      setOutcome({ ok: true, text, warnings: d.warnings || [] });
      toast.success(text);
      for (const w of d.warnings || []) toast.info(w);
    } catch (e) {
      // The server's reason names the row that is wrong — keep it by the list.
      setOutcome({ ok: false, text: e.message || 'Could not save the parts', warnings: [] });
    } finally {
      setSaving(false);
    }
  };

  const dirty = saved != null && !sameList(rows, saved);
  let body;
  if (loadError) {
    body = (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-red-600">
          <AlertTriangle size={13} className="shrink-0" /> {loadError}
        </p>
        <Button variant="secondary" size="sm" onClick={() => setRetry(v => v + 1)}>Retry</Button>
      </div>
    );
  } else if (saved == null) {
    body = (
      <p className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-500">
        <Loader2 size={14} className="animate-spin" /> Loading parts...
      </p>
    );
  } else if (partOf.length) {
    body = (
      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
        This is a part of {partOf.map(o => o.code).join(', ')} — a part cannot have parts.
      </p>
    );
  } else {
    body = (
      <>
        {rows.length > 0 ? (
          <div className={`mt-3 hidden gap-2 px-0.5 text-[11px] font-semibold text-slate-500 sm:grid ${COLS}`}>
            <span>Part's product</span><span>Label</span><span>Pieces per carton</span><span />
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-400">Not made in parts — a normal carton.</p>
        )}
        {rows.map((r, i) => {
          // The chosen part's board and ups: the master rows first, else the
          // saved part as the server returned it.
          const info = r.part_product_id
            ? (choices.find(p => p.id === r.part_product_id) ?? savedBoards[r.part_product_id]) : null;
          const board = info ? boardLine(info) : null;
          return (
            <div key={r._key} className={`mt-2 grid items-center gap-2 ${COLS}`}>
              <div className="col-span-3 min-w-0 sm:col-span-1">
                <Select value={r.part_product_id} disabled={saving} aria-label={`Part ${i + 1} product`}
                  onChange={e => set(i, { part_product_id: e.target.value })}>
                  <option value="">Pick the part's product...</option>
                  {optionsFor(i).map(p => <option key={p.id} value={p.id} data-search={p.search}>{p.label}</option>)}
                </Select>
              </div>
              <Input value={r.label} placeholder={`Part ${i + 1}`} disabled={saving} aria-label={`Part ${i + 1} label`}
                onChange={e => set(i, { label: e.target.value })} />
              {/* "pcs" in the box itself: on a phone the column header is hidden. */}
              <div className="relative">
                <Input type="number" min="1" max="1000" step="1" value={r.per_carton} disabled={saving} className="pr-10"
                  title="Pieces per carton" aria-label={`Part ${i + 1} pieces per carton`}
                  onChange={e => set(i, { per_carton: e.target.value })} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">pcs</span>
              </div>
              <button type="button" disabled={saving} onClick={() => remove(i)}
                aria-label={`Remove part ${i + 1}`} title="Remove this part"
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50">
                <Trash2 size={15} />
              </button>
              {board && (
                <p className={`col-span-3 -mt-1 flex items-center gap-1 px-1 text-[11px] font-medium sm:col-span-4 ${board.warn ? 'text-amber-700' : 'text-slate-500'}`}>
                  {board.warn && <AlertTriangle size={12} className="shrink-0" />}
                  {board.text}
                </p>
              )}
            </div>
          );
        })}
        {!choices.length && (
          <p className="mt-2 text-xs text-slate-400">This customer has no other product in the master yet — add each part as its own product first.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={add} disabled={saving}>
            <Plus size={14} /> Add part
          </Button>
          <Button size="sm" onClick={save} disabled={saving || (!rows.length && !saved.length)}>
            <Save size={14} /> Save parts
          </Button>
          {dirty && !saving && <span className="text-[11px] font-semibold text-amber-700">Not saved yet</span>}
        </div>
        {outcome && !outcome.ok && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            <AlertTriangle size={13} className="mt-px shrink-0" /> {outcome.text}
          </p>
        )}
        {outcome?.ok && (
          <p className="mt-3 flex items-start gap-1.5 text-xs font-semibold text-emerald-700">
            <CheckCircle2 size={13} className="mt-px shrink-0" /> {outcome.text}
          </p>
        )}
        {outcome?.warnings.length > 0 && (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            <p className="flex items-center gap-1.5">
              <AlertTriangle size={13} className="shrink-0" /> Not every open order could follow:
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 font-medium">
              {outcome.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Made in parts</h4>
        <span className="text-[11px] font-semibold text-slate-400">Saved on its own, with Save parts</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Printed as separate pieces on separate sheets and pasted into one carton at Sort &amp; Paste. Each part is
        its own product in this customer&apos;s master. Leave empty for a normal carton.
      </p>
      {body}
    </section>
  );
}
