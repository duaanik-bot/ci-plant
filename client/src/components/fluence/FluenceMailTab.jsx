// Fluence › From Fluence mail (owner, 18 Nov 2026): everything the office AVS read from Fluence's mails — a kit's
// prescription and MRPs from its artwork, an MRP sheet, a PO's MRPs — and what happened to it: saved to the master
// (signed from the mail, waiting for management to acknowledge), held for a person (and why), only compared (a PO),
// not matched, undone, kept as it was. Server: routes/fluence-mail.js.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, useToast } from '../ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../FilterChip.jsx';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { mrpText, readingOutcome } from '../../lib/fluence.js';

const SOURCE = { artwork: 'Artwork', mrp_sheet: 'MRP sheet', po: 'PO' };
const STATUS = {
  waiting_approval: ['Waiting for approval', 'bg-slate-100 text-slate-700'],
  queued: ['Being saved', 'bg-slate-100 text-slate-700'],
  saved: ['Saved', 'bg-green-50 text-green-800'],
  same: ['Same as master', 'bg-slate-100 text-slate-600'],
  held: ['Held — a person decides', 'bg-amber-50 text-amber-900'],
  not_matched: ['Not matched', 'bg-orange-50 text-orange-800'],
  compared: ['Compared only', 'bg-sky-50 text-sky-800'],
  undone: ['Undone', 'bg-slate-100 text-slate-500'],
  dismissed: ['Kept as it was', 'bg-slate-100 text-slate-500'],
};
const ACKABLE = ['saved', 'compared'];

function Reading({ x }) {
  const rx = x.reading?.prescription;
  const m = x.reading?.mrp;
  return (
    <div className="grid gap-3 p-3 text-[12px] sm:grid-cols-2">
      <div>
        <div className="mb-1 font-semibold text-slate-700">Prescription read{x.read_from ? ` from ${x.read_from}` : ''}</div>
        {!rx && <div className="text-slate-500">— (an MRP-only mail)</div>}
        {rx?.general_instructions && <div className="mb-1 text-slate-700">{rx.general_instructions}</div>}
        {(rx?.lines || []).map((l, i) => (
          <div key={i} className="text-slate-700">
            <b>{l.item}</b>{l.dosage ? ` — ${l.dosage}` : ''}
            {[['M', l.morning_qty], ['A', l.afternoon_qty], ['E', l.evening_qty], ['N', l.night_qty]].filter(([, v]) => v != null).map(([k, v]) => ` ${k}:${v}`).join('')}
            {l.other_timing ? ` · ${l.other_timing}${l.other_qty != null ? ` ${l.other_qty}` : ''}` : ''}{l.instructions ? ` · ${l.instructions}` : ''}
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 font-semibold text-slate-700">MRPs read</div>
        {!m && <div className="text-slate-500">—</div>}
        {m && <div className="text-slate-700">Kit total: <b>{mrpText(m.kit_total)}</b></div>}
        {(m?.items || []).map((it, i) => <div key={i} className="text-slate-700">{it.item}: {mrpText(it.mrp)}{it.qty != null ? ` × ${it.qty}` : ''}</div>)}
        {!x.sure && <div className="mt-1 text-amber-800">The robot was not sure of: {(x.unsure || []).join(', ') || 'what it read'}</div>}
      </div>
    </div>
  );
}

// What the server says it did, said back (a held reading stays held: its reasons are the news).
const appliedSays = out => (out?.status === 'saved' ? ['ok', 'Saved to the Fluence master']
  : out?.status === 'same' ? ['ok', 'The Fluence master already says this']
    : out?.status === 'held' ? ['err', `Still held: ${(out.reasons || []).join('; ') || 'see the reading'}`]
      : ['ok', `Now ${String(out?.status || 'done').replace('_', ' ')}`]);

export default function FluenceMailTab() {
  const toast = useToast();
  const [view, setView] = useState('open');
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(0);
  const load = useCallback(() => api.get(`/fluence/mail-readings?view=${view}`).then(setData).catch(e => toast.error(e.message)), [view, toast]);
  useEffect(() => { load(); }, [load]);
  const act = (id, path, says, ask, body) => {
    if (ask && !window.confirm(ask)) return;
    setBusy(id);
    api.post(`/fluence/mail-readings/${path}`, body)
      .then(out => { const [kind, msg] = says(out); (kind === 'err' ? toast.error : toast.success)(msg); load(); })
      .catch(e => toast.error(e.message))
      .finally(() => setBusy(0));
  };
  const rows = data?.rows || [];
  const ackable = rows.filter(x => !x.ack_at && ACKABLE.includes(x.status));
  return (
    <div>
      <FilterRail className="mb-3">
        <FilterGroup label="Show">
          <FilterChip label="To look at" on={view === 'open'} onClick={() => setView('open')} />
          <FilterChip label="All" on={view === 'all'} onClick={() => setView('all')} />
        </FilterGroup>
        {data?.can_ack && ackable.length > 1 && (
          <Button size="sm" variant="secondary" className="ml-auto" disabled={!!busy}
            onClick={() => act(-1, 'ack', out => ['ok', `${out?.acknowledged ?? 0} acknowledged`], `Acknowledge all ${ackable.length} saved or compared readings shown?`, { ids: ackable.map(x => x.id) })}>
            Acknowledge all ({ackable.length})
          </Button>
        )}
      </FilterRail>
      <p className="mb-2 text-[12px] text-slate-500">
        The office AVS reads Fluence's mails: a kit's prescription and MRPs from its artwork (saved when the client approves that
        version), MRP sheets (saved on arrival) and POs (compared only). An MRP more than 25 % lower or more than double, anything
        the robot was not sure of, a kit or carton MRP a person changed after the mail, or an artwork whose items are not the
        kit's is held here for a person: Apply it, or keep the master as it is.
      </p>
      <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr><th className="p-2" /><th className="p-2">Mail</th><th className="p-2">From</th><th className="p-2">Kit</th><th className="p-2">Status</th><th className="p-2">What it did</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={7} className="p-4 text-center text-slate-500">Loading…</td></tr>}
            {data && !rows.length && <tr><td colSpan={7} className="p-4 text-center text-slate-500">{view === 'open' ? 'Nothing to look at.' : 'Nothing read from Fluence\'s mails yet.'}</td></tr>}
            {rows.map(x => {
              const [label, tone] = STATUS[x.status] || [x.status, ''];
              return (
                <Fragment key={x.id}>
                  <tr className="border-t border-slate-100 align-top">
                    <td className="p-2"><button type="button" aria-label="Show what was read" onClick={() => setOpenId(openId === x.id ? null : x.id)}>{openId === x.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td>
                    <td className="p-2"><div className="font-semibold">{SOURCE[x.source]}</div><div className="text-[11px] text-slate-500">{fmt.date(x.received_at)}</div></td>
                    <td className="p-2 text-[12px]">{x.subject}<div className="text-[11px] text-slate-500">{x.from_email}</div>
                      {x.view_url && <a href={x.view_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0064D2]">Open mail<ExternalLink size={10} /></a>}</td>
                    <td className="p-2"><div className="font-semibold">{x.product_code ? `${x.product_code} ` : ''}{x.product_name || x.kit || x.kit_name || '—'}</div>
                      {x.kit_name && (x.kit || x.product_name) && x.kit_name !== (x.kit || x.product_name) && <div className="text-[11px] text-slate-500">read as “{x.kit_name}”</div>}</td>
                    <td className="p-2"><span className={`inline-block rounded-xl px-2 py-0.5 text-[11px] font-semibold leading-snug ${tone}`}>{label}</span>
                      {x.ack_at && <div className="mt-0.5 text-[11px] text-slate-500">read by {x.ack_by}</div>}</td>
                    <td className="p-2 text-[12px] text-slate-700">{readingOutcome(x)}</td>
                    <td className="whitespace-nowrap p-2 text-right">
                      {data.can_edit && x.status === 'held' && (
                        <Button size="sm" disabled={!!busy} onClick={() => act(x.id, `${x.id}/apply`, appliedSays, 'Save what was read to the Fluence master now, over the hold? It is signed with your name.')}>Apply</Button>)}
                      {data.can_edit && ['held', 'not_matched'].includes(x.status) && (
                        <Button size="sm" variant="secondary" className="ml-1" disabled={!!busy}
                          onClick={() => act(x.id, `${x.id}/keep`, () => ['ok', 'Kept the master as it was'], 'Keep the Fluence master as it is and set this reading aside?')}>Keep the master</Button>)}
                      {data.can_edit && x.status === 'saved' && (
                        <Button size="sm" variant="secondary" className="ml-1" disabled={!!busy}
                          onClick={() => act(x.id, `${x.id}/undo`, out => ['ok', out?.left?.length ? `Put back — left as it is: ${out.left.join('; ')}` : 'Put back as it was'],
                            'Put back what this mail changed? Anything changed since by a person or a later mail is left as it is.')}>Undo</Button>)}
                      {data.can_ack && !x.ack_at && ACKABLE.includes(x.status) && (
                        <Button size="sm" variant="secondary" className="ml-1" disabled={!!busy} onClick={() => act(x.id, `${x.id}/ack`, () => ['ok', 'Acknowledged'])}>Acknowledge</Button>)}
                    </td>
                  </tr>
                  {openId === x.id && <tr className="bg-slate-50/60"><td colSpan={7}><Reading x={x} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
