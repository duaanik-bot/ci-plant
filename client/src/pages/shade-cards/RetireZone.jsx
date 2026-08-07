// The retire zone for the free-text shade card numbers that used to be typed on
// the product master. Three lists, because the three situations need different
// answers:
//   Orphans     a number with no card behind it → promote it into a real card
//   Duplicates  a number that just repeats its card → retire the column
//   Retired     already moved out → restorable, always
import { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, Checkbox } from '../../components/ui.jsx';
import { Archive, RotateCcw, Wand2, AlertTriangle } from 'lucide-react';
import ProductIdentity, { productExport, productSearchText } from '../../components/ProductIdentity.jsx';

export default function RetireZone({ onChange, toast }) {
  const [zone, setZone] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/shade-cards/legacy')
    .then(z => { setZone(z); setPicked(new Set()); })
    .catch(() => toast.error('Could not load the retire zone'));
  useEffect(() => { load(); }, []);

  const toggle = id => setPicked(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const call = async (path, body, msg) => {
    setBusy(true);
    try {
      const r = await api.post(path, body);
      toast.success(msg(r));
      await load();
      await onChange();
    } catch (e) { toast.error(e.message || 'That did not work'); } finally { setBusy(false); }
  };

  if (!zone) return <p className="text-sm text-slate-400">Loading…</p>;

  const pickedIds = [...picked];
  const pickCol = rows => ({
    key: '_pick', label: '', sortable: false, width: '36px',
    render: r => <Checkbox checked={picked.has(r.product_id)} onChange={() => toggle(r.product_id)} />,
    export: () => '',
  });
  const productCol = () => ({
    key: 'product_name', label: 'Product',
    render: r => <ProductIdentity row={r} compact codesClassName="max-w-[240px]" />,
    searchValue: productSearchText,
    export: productExport,
  });

  return (
    <div className="space-y-5">
      <div className="glass rounded-[22px] border border-amber-200/60 bg-amber-50/50 p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-amber-800">
          <AlertTriangle size={15} /> Why this screen exists
        </p>
        <p className="mt-1 text-xs font-medium text-amber-800/85">
          A shade card number used to be typed by hand onto the product master, separately
          from the card itself — four places to type one number. That field is now read-only
          everywhere and filled in from this module. These are the old hand-typed values.
          Retiring one clears it from the product; nothing is destroyed and anything here can
          be restored.
        </p>
      </div>

      {/* Orphans first: these are the ones that need a decision, not just tidying. */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-slate-800">
            Numbers with no card behind them
            <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-600">
              {zone.candidates.length}</span>
          </h3>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={!pickedIds.length || busy}
              onClick={() => call('/shade-cards/legacy/promote', { product_ids: pickedIds },
                r => `${r.promoted} real shade card${r.promoted === 1 ? '' : 's'} created`)}>
              <Wand2 size={13} /> Create real cards ({pickedIds.length})
            </Button>
            <Button size="sm" variant="secondary" disabled={!pickedIds.length || busy}
              onClick={() => call('/shade-cards/legacy/retire', { product_ids: pickedIds },
                r => `${r.retired} number${r.retired === 1 ? '' : 's'} retired`)}>
              <Archive size={13} /> Retire without a card
            </Button>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          A number here cannot be approved, issued or tracked — nothing in the ERP stands
          behind it. Creating a real card carries the number and its date across, so the age
          alarm starts telling the truth about it.
        </p>
        <DataTable exportName="shade-legacy-orphans" rows={zone.candidates}
          getRowId={r => r.product_id}
          columns={[pickCol(),
            productCol(),
            { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
            { key: 'shade_card_number', label: 'Typed number',
              render: r => <span className="font-mono text-xs font-semibold">{r.shade_card_number}</span> },
            { key: 'shade_card_date', label: 'Typed date', render: r => r.shade_card_date || '—' },
          ]}
          empty="Nothing orphaned — every typed number has a real card behind it" />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-slate-800">
            Numbers that just repeat their card
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
              {zone.duplicates.length}</span>
          </h3>
          <Button size="sm" variant="secondary" disabled={!pickedIds.length || busy}
            onClick={() => call('/shade-cards/legacy/retire', { product_ids: pickedIds },
              r => `${r.retired} duplicate${r.retired === 1 ? '' : 's'} retired`)}>
            <Archive size={13} /> Retire ({pickedIds.length})
          </Button>
        </div>
        <DataTable exportName="shade-legacy-duplicates" rows={zone.duplicates}
          getRowId={r => r.product_id}
          columns={[pickCol(),
            productCol(),
            { key: 'shade_card_number', label: 'Typed number',
              render: r => <span className="font-mono text-xs">{r.shade_card_number}</span> },
            { key: 'sc_number', label: 'Real card',
              render: r => <span className="font-mono text-xs font-semibold text-emerald-700">{r.sc_number}</span> },
          ]}
          empty="No duplicates" />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-extrabold text-slate-800">
          Retired
          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
            {zone.retired.length}</span>
        </h3>
        <DataTable exportName="shade-legacy-retired" rows={zone.retired}
          columns={[
            productCol(),
            { key: 'sc_number', label: 'Retired number',
              render: r => <span className="font-mono text-xs">{r.sc_number}</span> },
            { key: 'sc_date', label: 'Date', render: r => r.sc_date || '—' },
            { key: 'promoted_number', label: 'Became', render: r => r.promoted_number
                ? <span className="font-mono text-xs font-semibold text-emerald-700">{r.promoted_number}</span>
                : <span className="text-slate-300">—</span> },
            { key: 'retired_at', label: 'Retired', render: r => `${fmt.dt(r.retired_at)} · ${r.retired_by || '—'}` },
            { key: '_act', label: '', sortable: false, export: () => '',
              render: r => (
                <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => call(`/shade-cards/legacy/${r.id}/restore`, {}, () => 'Restored to the product master')}>
                  <RotateCcw size={13} /> Restore
                </Button>) },
          ]}
          empty="Nothing retired yet" />
      </section>
    </div>
  );
}
