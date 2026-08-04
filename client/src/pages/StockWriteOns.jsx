// Stock Write-Ons — the warehouse's recount queue and register. A write-on is
// the system admitting its own book was wrong: more board physically left the
// warehouse than the book said existed, so the balance was clamped at nil
// instead of going negative. Every row is an open question the shelf has to
// answer — it stays open until a storekeeper walks over, counts the board,
// and reconciles it. This page is that queue, and the register of settled ones.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, KpiCard, Modal, PageHeader, rowMatches, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { AlertTriangle, Boxes, Layers, PackageCheck } from 'lucide-react';

export default function StockWriteOns() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('open');

  // Recount modal — `counting` holds the full row (board identity, the
  // written-on amount, book_now) so the modal has everything to show without
  // a second fetch. Prefilled with the live book_now: the common case is "the
  // shelf matches what the book shows now", and typing over a prefill is
  // easier than starting from a blank box for a queue counted many times a day.
  const [counting, setCounting] = useState(null);
  const [count, setCount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Extracted (not inlined in the effect) because the recount submit needs to
  // force a reload too — the effect's poll alone would leave the just-closed
  // row sitting in the open tab for up to 20 seconds.
  const load = () => api.get('/stock-writeons')
    .then(d => { setRows(d); setLoadError(false); })
    .catch(() => setLoadError(true));
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const openRows = rows.filter(r => !r.reconciled_at);
  const reconciledRows = rows.filter(r => r.reconciled_at);
  const kpis = {
    open: openRows.length,
    reconciled: reconciledRows.length,
    // Scoped to the open queue, like the two counts beside it — "how much is
    // outstanding right now", not a running lifetime total.
    openQty: openRows.reduce((s, r) => s + (+r.qty || 0), 0),
    boards: new Set(openRows.map(r => r.material_id)).size,
  };

  const base = tab === 'open' ? openRows : reconciledRows;
  const shown = q ? base.filter(r => rowMatches(r, q)) : base;

  const openCount = r => { setCounting(r); setCount(String(r.book_now ?? 0)); setNote(''); };
  const closeCount = () => { setCounting(null); setCount(''); setNote(''); };

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/stock-writeons/${counting.id}/reconcile`, {
        counted_qty: Number(count),
        note: note.trim() || undefined,
      });
      toast.success(`${counting.material_name} recounted — ledger updated`);
      closeCount();
      await load();
    } finally { setBusy(false); }
  };

  const countNum = count === '' ? null : Number(count);
  const countInvalid = count === '' || countNum < 0 || Number.isNaN(countNum);
  const delta = counting && !countInvalid ? countNum - (+counting.book_now || 0) : null;

  const columns = [
    { key: 'created_at', label: 'When', export: r => fmt.dt(r.created_at), render: r => fmt.dt(r.created_at) },
    { key: 'material_name', label: 'Board', render: r => <span>{r.material_name} <span className="text-slate-400">{r.material_code}</span></span> },
    { key: 'qty', label: 'Written on', align: 'right', export: r => `+${fmt.num(r.qty)}`, render: r => <span className="font-semibold text-red-600">+{fmt.num(r.qty)}</span> },
    { key: 'book_before', label: 'Book was', align: 'right', export: r => fmt.num(r.book_before), render: r => fmt.num(r.book_before) },
    { key: 'issued_qty', label: 'Issued', align: 'right', export: r => fmt.num(r.issued_qty), render: r => fmt.num(r.issued_qty) },
    { key: 'book_now', label: 'Book now', align: 'right', export: r => fmt.num(r.book_now), render: r => fmt.num(r.book_now) },
    { key: 'reason', label: 'Reason', render: r => r.reason || (r.ref_id ? `${r.ref_type} #${r.ref_id}` : '—') },
    { key: 'created_by', label: 'By', render: r => r.created_by || '—' },
    ...(tab === 'reconciled' ? [
      { key: 'counted_qty', label: 'Counted', align: 'right', export: r => fmt.num(r.counted_qty), render: r => fmt.num(r.counted_qty) },
      { key: 'reconciled_by', label: 'Counted by', render: r => (
        <div>{r.reconciled_by || '—'}{r.reconciled_at && <div className="text-[11px] font-normal text-slate-400">{fmt.dt(r.reconciled_at)}</div>}</div>
      ) },
    ] : [
      { key: 'recount', label: '', align: 'right', render: r => <Button size="sm" onClick={() => openCount(r)}>Recount</Button> },
    ]),
  ];

  return (
    <div>
      <PageHeader title="Stock Write-Ons"
        subtitle="Board that left the warehouse beyond what the book held — clamped to nil instead of going negative. Each one stays open until the shelf gets counted." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={AlertTriangle} tone="warn" label="Open" value={fmt.num(kpis.open)} />
        <KpiCard icon={PackageCheck} tone="good" label="Reconciled" value={fmt.num(kpis.reconciled)} />
        <KpiCard icon={Layers} label="Sheets written on" value={fmt.num(kpis.openQty)} sub="open write-ons" />
        <KpiCard icon={Boxes} label="Boards affected" value={fmt.num(kpis.boards)} sub="currently open" />
      </div>

      <div className="mb-4 mt-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'open', label: 'Open', count: openRows.length },
          { key: 'reconciled', label: 'Reconciled', count: reconciledRows.length },
        ]} />
      </div>

      {loadError && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the write-on queue can’t load'}. Retrying every 20 seconds…
        </div>
      )}

      {/* Search rides in the table toolbar, same as every other list — no
          floating band above the table just to hold a search box. */}
      <DataTable
        exportName={tab === 'open' ? 'stock-writeons-open' : 'stock-writeons-reconciled'}
        exportSubtitle={tab === 'open' ? 'Warehouse · Open write-ons awaiting recount' : 'Warehouse · Reconciled write-ons'}
        searchValue={q} onSearchChange={setQ}
        searchPlaceholder="Search board, reason, by…"
        rows={shown}
        empty={loadError
          ? 'Server unreachable — nothing to show until it reconnects.'
          : tab === 'open'
            ? 'Nothing to recount. Every board matches its book.'
            : 'No reconciled write-ons yet.'}
        columns={columns}
      />

      <Modal open={!!counting} onClose={closeCount}
        title={counting ? `Recount — ${counting.material_name}` : ''}
        footer={<>
          <Button variant="secondary" onClick={closeCount}>Cancel</Button>
          <Button onClick={submit} disabled={busy || countInvalid}>{busy ? 'Booking…' : 'Book Physical Count'}</Button>
        </>}>
        {counting && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              <b>{counting.material_name}</b> <span className="text-slate-400">{counting.material_code}</span>
              <div className="mt-1 text-slate-500">
                Written on {fmt.num(counting.qty)} {counting.unit || 'sheets'} on {fmt.dt(counting.created_at)}
                {counting.reason ? ` — ${counting.reason}` : ''}{counting.created_by ? ` · ${counting.created_by}` : ''}
              </div>
              <div className="mt-1 text-slate-500">
                Book was {fmt.num(counting.book_before)} · issued {fmt.num(counting.issued_qty)} · book now {fmt.num(counting.book_now)}
              </div>
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-grid">
                <Field label="Physical count" required hint="What's actually on the shelf, right now">
                  <Input type="number" min="0" autoFocus value={count} onChange={e => setCount(e.target.value)} />
                </Field>
                <Field label="Note"><Textarea value={note} placeholder="Optional — where/how it was counted" onChange={e => setNote(e.target.value)} /></Field>
              </div>
            </section>
            {delta != null && (
              <p className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${delta === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                {delta === 0 ? <PackageCheck size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
                {delta === 0
                  ? 'Matches the book exactly — this closes the write-on with no ledger change.'
                  : `Booked as ${delta > 0 ? 'an addition of' : 'a further write-on of'} ${fmt.num(Math.abs(delta))} ${counting.unit || 'sheets'} against the ledger when you submit.`}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
