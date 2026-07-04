// Printable job card traveler — modelled on CI-Production's job-card PDF.
// One A4 sheet that walks the floor with the job: spec, materials issued,
// and a stage table with sign-off columns. Browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button } from '../components/ui.jsx';
import { Printer, ArrowLeft } from 'lucide-react';

export default function JobCardPrint() {
  const { id } = useParams();
  const [jc, setJc] = useState(null);
  useEffect(() => { api.get(`/job-cards/${id}`).then(setJc); }, [id]);
  if (!jc) return null;

  const spec = [
    ['Product Code', jc.product_code], ['Carton Size', jc.size || '—'], ['Colours', `${jc.colors}c`],
    ['Board', jc.board_name],
    ['Parent Sheet', jc.sheet_l ? `${jc.sheet_l}×${jc.sheet_w}"` : '—'],
    ['Print Sheet', jc.child_l ? `${jc.child_l}×${jc.child_w}"` : '—'],
    ['Cut Yield', jc.children_per_parent > 1 ? `${jc.children_per_parent} print sheets / parent` : '1:1'],
    ['Die', jc.die_number ? `#${jc.die_number}${jc.die_location ? ` · ${jc.die_location}` : ''}` : '—'],
    ['Ups / Print Sheet', jc.ups], ['Ordered Qty', `${fmt.num(jc.line_qty)} cartons`],
    ['Parent Sheets Issued', fmt.num(jc.sheets_issued)], ['Press', jc.machine_name || '—'],
    ['Delivery', fmt.date(jc.delivery_date)],
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/production"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print Job Card</Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:border-0 print:shadow-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">Production Job Card</div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink-900">{jc.jc_number}</h1>
            <p className="mt-0.5 text-sm text-gray-600">{jc.product_name}</p>
          </div>
          <div className="text-right text-xs text-gray-600">
            <div className="text-sm font-extrabold text-ink-900">COLOUR IMPRESSIONS</div>
            <div>Customer: <b>{jc.customer_name}</b></div>
            <div>PO: <b>{jc.po_number}</b> · Released {fmt.date(jc.created_at)}</div>
            <div className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase">{jc.status}</div>
          </div>
        </div>

        {/* Spec grid */}
        <div className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2.5 text-sm">
          {spec.map(([k, v]) => (
            <div key={k}>
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{k}</div>
              <div className="font-semibold text-gray-900">{v}</div>
            </div>
          ))}
        </div>

        {/* Materials issued */}
        {jc.issues?.length > 0 && (
          <div className="mt-5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Material Issued (FIFO)</div>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200 text-left text-[10px] font-bold uppercase text-gray-400">
                <th className="py-1">Material</th><th className="py-1">Batch</th>
                <th className="py-1 text-right">Qty</th><th className="py-1 text-right">Issued On</th>
              </tr></thead>
              <tbody>
                {jc.issues.map((i, n) => (
                  <tr key={n} className="border-b border-gray-50">
                    <td className="py-1.5">{i.material_name}</td>
                    <td className="py-1.5 font-mono">{i.batch_no || '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(Math.abs(i.qty))} {i.unit}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.date(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Stage table with sign-off blanks */}
        <div className="mt-5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Production Stages — fill at each section</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-ink-900 text-left text-[10px] font-bold uppercase tracking-wide text-white">
                <th className="px-2 py-1.5">#</th><th className="px-2 py-1.5">Stage</th>
                <th className="px-2 py-1.5">Machine</th>
                <th className="px-2 py-1.5 text-right">Received</th><th className="px-2 py-1.5 text-right">Good</th>
                <th className="px-2 py-1.5 text-right">Wastage</th><th className="px-2 py-1.5">Reason</th>
                <th className="px-2 py-1.5">Operator</th><th className="px-2 py-1.5">Sign</th>
              </tr>
            </thead>
            <tbody>
              {jc.stages.map(st => (
                <tr key={st.id} className="border-b border-gray-100">
                  <td className="px-2 py-2 text-gray-400">{st.seq}</td>
                  <td className="px-2 py-2 font-semibold">{fmt.stage(st.stage)} <span className="text-[9px] text-gray-400">({st.unit})</span></td>
                  <td className="px-2 py-2 text-gray-500">{st.stage_machine_name || ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{st.qty_in != null ? fmt.num(st.qty_in) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-semibold">{st.qty_out != null ? fmt.num(st.qty_out) : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-red-600">{st.status === 'completed' ? fmt.num(st.qty_scrap) : ''}</td>
                  <td className="px-2 py-2 text-gray-500">{st.scrap_reason || ''}</td>
                  <td className="px-2 py-2 text-gray-600">{st.operator || ''}</td>
                  <td className="px-2 py-2"><span className="inline-block h-4 w-12 border-b border-gray-300" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pasting manifest + result band */}
        <div className="mt-5 grid grid-cols-3 gap-4 text-sm">
          <div className="rounded-xl border border-gray-200 p-3 text-center">
            <div className="text-[10px] font-bold uppercase text-gray-400">Produced</div>
            <div className="text-lg font-extrabold tabular-nums">{jc.status === 'closed' ? fmt.num(jc.qty_produced) : '—'}</div>
          </div>
          <div className="rounded-xl border border-gray-200 p-3 text-center">
            <div className="text-[10px] font-bold uppercase text-gray-400">Total Wastage</div>
            <div className="text-lg font-extrabold tabular-nums text-red-600">{jc.status === 'closed' ? fmt.num(jc.qty_scrap) : '—'}</div>
          </div>
          <div className="rounded-xl border border-gray-200 p-3 text-center">
            <div className="text-[10px] font-bold uppercase text-gray-400">Packing</div>
            <div className="text-lg font-extrabold tabular-nums">
              {(() => { const p = jc.stages.find(s => s.stage === 'pasting'); return p?.pack_boxes ? `${p.pack_boxes} × ${fmt.num(p.pack_qty_per_box)}` : '—'; })()}
            </div>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-3 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Planned By</div>
          <div className="border-t border-gray-300 pt-2">Production Supervisor</div>
          <div className="border-t border-gray-300 pt-2">QA Release</div>
        </div>
      </div>
    </div>
  );
}
