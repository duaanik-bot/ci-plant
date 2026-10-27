// Size Library — every size the plant has costed, with the sheet layout used, how often, and whether
// a die of that size is in the Die Master. Kept apart from the Die Master: a size here needs no die,
// and nothing here changes a die. "Possible duplicates" lists entries a person should look at — the
// same size with several layouts or pastings, or typed in another order — never merged automatically.
import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, Field, Input, Modal, Select, Textarea, useToast } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { styleLabel } from '../../lib/costing.js';
import { plain } from '../../lib/costingUi.js';
import { NumField } from './CostingEditor.jsx';

const KIND = { carton: 'Carton', flat: 'Flat (leaflet / label)', other: 'Other' };
const SOURCE = { size_chart: 'Size chart', costing: 'A costing', manual: 'Added here' };
const STYLE_OPTIONS = ['LOCK', 'SIDE', 'LIT', 'CUP', 'DBL PAS', 'DIE CUT', 'NONE'];

export default function SizeLibrary({ onCostSize }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('all');
  const [groups, setGroups] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  const load = () => api.get(`/costing/sizes${showRetired ? '?all=1' : ''}`).then(setRows).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showRetired]);
  useEffect(() => { if (view === 'dups' && !groups) api.get('/costing/sizes/duplicates').then(setGroups).catch(() => setGroups([])); }, [view, groups]);

  const counts = useMemo(() => ({
    all: rows.length,
    die: rows.filter(r => r.dies.length).length,
    nodie: rows.filter(r => !r.dies.length && r.kind !== 'other').length,
    never: rows.filter(r => !r.times_costed).length,
  }), [rows]);
  const shown = rows.filter(r => view === 'die' ? r.dies.length : view === 'nodie' ? !r.dies.length && r.kind !== 'other' : view === 'never' ? !r.times_costed : true);

  const columns = [
    { key: 'size_key', label: 'Size (mm)', render: r => <span className={`whitespace-nowrap font-bold ${r.active ? '' : 'text-slate-400 line-through'}`}>{r.size_key.replace(/x/g, ' × ')}</span> },
    { key: 'kind', label: 'Kind', render: r => KIND[r.kind] || r.kind, export: r => KIND[r.kind] || r.kind },
    { key: 'style', label: 'Pasting', render: r => styleLabel(r.style), export: r => r.style || '' },
    { key: '_sheet', label: 'Sheet (in)', sortValue: r => (r.sheet_l || 0) * (r.sheet_w || 0),
      render: r => (r.sheet_l ? `${plain(r.sheet_l)} × ${plain(r.sheet_w)}` : '—'), export: r => (r.sheet_l ? `${r.sheet_l} x ${r.sheet_w}` : '') },
    { key: 'ups', label: 'Ups', align: 'right', render: r => plain(r.ups), export: r => r.ups ?? '' },
    { key: 'times_costed', label: 'Costed', align: 'right', render: r => (r.times_costed ? `${r.times_costed}×` : '—'), export: r => r.times_costed },
    { key: 'last_costed', label: 'Last costed', render: r => (r.last_costed ? fmt.date(r.last_costed) : '—'), export: r => r.last_costed || '' },
    { key: '_dies', label: 'Die in factory', sortValue: r => r.dies.length, export: r => r.dies.join(', '),
      render: r => (r.dies.length ? <span className="text-emerald-700">{r.dies.slice(0, 3).join(', ')}{r.dies.length > 3 ? ` +${r.dies.length - 3}` : ''}</span> : <span className="text-slate-400">None</span>) },
    { key: 'source', label: 'From', render: r => SOURCE[r.source] || r.source, export: r => SOURCE[r.source] || r.source },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-3xl text-sm text-slate-500">Every size costed so far, with its sheet layout. Separate from the Die Master: a size here may never have had a die, and a die may never have been costed.</p>
        <Button onClick={() => setAdding(true)}><Plus size={15} className="mr-1 inline" />Add a size</Button>
      </div>
      <FilterRail className="mb-3">
        <FilterGroup label="Show" divider={false}>
          <FilterChip label="All" count={counts.all} on={view === 'all'} onClick={() => setView('all')} />
          <FilterChip label="Die in factory" count={counts.die} on={view === 'die'} onClick={() => setView('die')} />
          <FilterChip label="No die" count={counts.nodie} on={view === 'nodie'} onClick={() => setView('nodie')} />
          <FilterChip label="Never costed" count={counts.never} on={view === 'never'} onClick={() => setView('never')} />
          <FilterChip label="Possible duplicates" count={groups?.length} on={view === 'dups'} onClick={() => setView('dups')} />
        </FilterGroup>
        <FilterGroup label="Retired">
          <FilterChip label="Show retired" on={showRetired} onClick={() => setShowRetired(!showRetired)} />
        </FilterGroup>
      </FilterRail>

      {view === 'dups' ? <Duplicates groups={groups} onOpen={setOpen} /> : (
        <DataTable rows={shown} columns={columns} onRowClick={setOpen} searchable defaultSort={{ key: 'times_costed', dir: 'desc' }}
          searchPlaceholder="Search a size, pasting or die…" exportName="size-library" exportSubtitle="Costing Size Library"
          empty={loading ? 'Loading…' : 'No sizes.'} />
      )}

      <EntryModal entry={open} onClose={() => setOpen(null)} onCostSize={onCostSize}
        onSaved={() => { setOpen(null); setGroups(null); load(); }} toast={toast} />
      <AddSize open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); setGroups(null); load(); }} toast={toast} />
    </div>
  );
}

const DUP_WORDS = {
  layout: 'Same size and pasting, more than one sheet layout',
  style: 'Same size, more than one pasting',
  order: 'The same three numbers in another order',
};
function Duplicates({ groups, onOpen }) {
  if (!groups) return <div className="p-6 text-sm text-slate-400">Looking for possible duplicates…</div>;
  if (!groups.length) return <div className="p-6 text-sm text-slate-500">No possible duplicates.</div>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Nothing here is merged by itself. Two layouts of one carton can both be right (a different board size); retire an entry only when it is wrong.</p>
      {groups.map((g, i) => (
        <div key={i} className="glass rounded-2xl p-3">
          <div className="mb-1.5 text-sm font-bold">{(g.size_key || g.size_keys.join(' · ')).replace(/x/g, ' × ')} <span className="font-normal text-slate-500">— {DUP_WORDS[g.kind]}</span></div>
          <div className="flex flex-wrap gap-1.5">
            {g.entries.map(e => (
              <button key={e.id} type="button" onClick={() => onOpen({ ...e, dies: e.dies || [] })}
                className="rounded-xl bg-white/80 px-2.5 py-1 text-left text-xs ring-1 ring-slate-200 hover:ring-brand-400">
                <b>{e.size_key.replace(/x/g, ' × ')}</b> · {styleLabel(e.style)} · {e.sheet_l ? `${plain(e.sheet_l)} × ${plain(e.sheet_w)} in` : 'no sheet'} · {plain(e.ups)} ups
                <span className="text-slate-500"> · costed {e.times_costed}×</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EntryModal({ entry, onClose, onSaved, onCostSize, toast }) {
  const [notes, setNotes] = useState('');
  useEffect(() => { setNotes(entry?.notes || ''); }, [entry]);
  if (!entry) return null;
  const save = async active => {
    await api.put(`/costing/sizes/${entry.id}`, { notes, active });
    toast.success(active === false ? 'Retired — it stays on the costings that used it' : 'Saved');
    onSaved();
  };
  return (
    <Modal open onClose={onClose} title={`${entry.size_key.replace(/x/g, ' × ')} · ${styleLabel(entry.style)}`}
      footer={(
        <>
          {entry.active ? <Button variant="secondary" onClick={() => save(false)}>Retire</Button> : <Button variant="secondary" onClick={() => save(true)}>Bring back</Button>}
          <Button variant="secondary" onClick={() => save(entry.active)}>Save notes</Button>
          <Button onClick={() => onCostSize(entry)}>Cost this size</Button>
        </>
      )}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-xs text-slate-500">Sheet</dt><dd className="font-semibold">{entry.sheet_l ? `${plain(entry.sheet_l)} × ${plain(entry.sheet_w)} in` : '—'}</dd></div>
        <div><dt className="text-xs text-slate-500">Ups</dt><dd className="font-semibold">{plain(entry.ups)}</dd></div>
        <div><dt className="text-xs text-slate-500">Costed</dt><dd className="font-semibold">{entry.times_costed ? `${entry.times_costed} times, last ${entry.last_costed || '—'}` : 'Never'}</dd></div>
        <div><dt className="text-xs text-slate-500">Die in factory</dt><dd className="font-semibold">{entry.dies?.length ? entry.dies.join(', ') : 'None of this size'}</dd></div>
        <div className="col-span-2"><dt className="text-xs text-slate-500">Where it came from</dt>
          <dd className="text-xs text-slate-600">{SOURCE[entry.source] || entry.source}{(entry.source_refs || []).length ? ` — ${(entry.source_refs).map(r => `${r.sheet} row ${r.row}${r.raw ? ` (“${r.raw}”)` : ''}`).join('; ')}` : ''}</dd></div>
      </dl>
      <Field label="Notes" className="mt-3"><Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. use only on 19 × 25 board" /></Field>
    </Modal>
  );
}

function AddSize({ open, onClose, onAdded, toast }) {
  const [f, setF] = useState({ size_text: '', style: '', sheet_l: '', sheet_w: '', ups: '', notes: '' });
  useEffect(() => { if (open) setF({ size_text: '', style: '', sheet_l: '', sheet_w: '', ups: '', notes: '' }); }, [open]);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const add = async () => {
    await api.post('/costing/sizes', f);
    toast.success('Added to the Size Library');
    onAdded();
  };
  return (
    <Modal open={open} onClose={onClose} title="Add a size to the library"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={add} disabled={!f.size_text.trim()}>Add</Button></>}>
      <form data-ci-form className="grid gap-3 sm:grid-cols-2" onSubmit={e => e.preventDefault()}>
        <Field label="Size (mm)" required hint="L × W × H, e.g. 165 x 58 x 73 (L × W for flat work)"><Input value={f.size_text} onChange={e => set('size_text', e.target.value)} /></Field>
        <Field label="Pasting">
          <Select value={f.style} onChange={e => set('style', e.target.value)} placeholder="Choose…">
            <option value="">Not set</option>
            {STYLE_OPTIONS.map(s => <option key={s} value={s}>{styleLabel(s)}</option>)}
          </Select>
        </Field>
        <NumField label="Sheet length" unit="inch" value={f.sheet_l} onChange={v => set('sheet_l', v)} />
        <NumField label="Sheet width" unit="inch" value={f.sheet_w} onChange={v => set('sheet_w', v)} />
        <NumField label="Ups" value={f.ups} onChange={v => set('ups', v)} />
        <Field label="Notes"><Input value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
