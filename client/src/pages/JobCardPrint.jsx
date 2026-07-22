// Printable job card traveler — modelled on CI-Production's job-card PDF.
// One A4 sheet that walks the floor with the job: spec, materials issued,
// and a stage table with sign-off columns. Browser print = PDF.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, shadeAge } from '../components/ui.jsx';
import { Printer, ArrowLeft } from 'lucide-react';

export default function JobCardPrint() {
  const { id } = useParams();
  const [jc, setJc] = useState(null);
  useEffect(() => { api.get(`/job-cards/${id}`).then(setJc); }, [id]);
  if (!jc) return null;

  const t = (fam) => (jc.tools || []).filter(x => x.family === fam);
  const block = t('block')[0]; const plate = t('plate')[0];
  // Shade card is LIVE from the Shade Card Management module (jc.shade_card):
  // number, revision, approval status and colour details flow straight onto the
  // traveler so the floor prints against the approved card, never a stale copy.
  const shade = jc.shade_card;
  // Shade-card age on the printed traveler — plain text (the chip is UI-only).
  // The module's creation date wins; the master date is the fallback.
  const shadeAgeInfo = shadeAge(shade?.creation_date || jc.shade_card_date);
  const shadeCardAgeText = shadeAgeInfo
    ? `${shadeAgeInfo.days} days (${shadeAgeInfo.label})${shadeAgeInfo.expired ? ' — EXPIRED' : ''}`
    : '—';
  const scStatusText = shade
    ? fmt.title(shade.status) + (shade.revision_no ? ` · Rev ${shade.revision_no}` : '')
    : '—';
  const colorMode = jc.colors === 4 ? 'CMYK' : jc.colors ? `${jc.colors}C` : '—';
  const yieldTxt = jc.children_per_parent > 1 ? `${jc.children_per_parent} print sheets / parent` : '1:1';

  const planning = [
    ['Ordered Qty', `${fmt.num(jc.line_qty)} cartons`],
    ['Planned Qty', fmt.num(jc.qty_planned)],
    ['Parent Sheets Issued', fmt.num(jc.sheets_issued)],
    ['Sheets Required', jc.sheets_required != null ? fmt.num(jc.sheets_required) : '—'],
    ['Print Sheets / Parent', yieldTxt],
    ['Press', jc.machine_name || '—'],
    ['Planned Date', fmt.date(jc.planned_date) || '—'],
    ['Delivery', fmt.date(jc.delivery_date)],
  ];
  const artwork = [
    ['Customer Approval', jc.artwork_customer_ok ? 'Approved' : 'Pending'],
    ['QA Approval', jc.artwork_qa_ok ? 'Approved' : 'Pending'],
    ['Lock', jc.artwork_locked ? 'Locked' : 'Open'],
    ['Colours', colorMode],
    ['Shade Card No', shade?.sc_number || jc.shade_card_number || '—'],
    ['Shade Approval', scStatusText],
    ['Shade Card Age', shadeCardAgeText],
    ['Shade Ref', shade?.print_reference || shade?.colour_details || '—'],
    ['Block No', block?.code || '—'],
    ['Output No', plate?.output_no || '—'],
    ['Cylinder No', plate?.cylinder_no || block?.cylinder_no || '—'],
    ['Emboss', jc.emboss ? 'Yes' : 'No'],
    ['Leafing', jc.leafing ? 'Yes' : 'No'],
    ...(jc.leafing ? [['Leafing Colour', jc.leafing_colour ? fmt.title(jc.leafing_colour) : '—']] : []),
  ];
  const product = [
    ['Product Code', jc.product_code],
    ['Board', jc.board_name || '—'],
    ['Parent Sheet', jc.sheet_l ? `${jc.sheet_l}×${jc.sheet_w}"` : '—'],
    ['Print Sheet', jc.child_l ? `${jc.child_l}×${jc.child_w}"` : '—'],
    ['Carton Size', jc.size || '—'],
    ['Coating / Lamination', jc.coating && jc.coating !== 'none' ? fmt.title(jc.coating) : 'None'],
    ['Pasting', jc.pasting_type ? fmt.title(jc.pasting_type) : '—'],
    ['Die', jc.die_number ? `#${jc.die_number}${jc.die_location ? ` · ${jc.die_location}` : ''}` : '—'],
    ['Ups / Print Sheet', jc.ups],
  ];

  const Block = ({ title, caption, rows }) => (
    <div className="mt-5">
      <div className="mb-2 flex items-baseline justify-between border-b border-gray-200 pb-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-600">{title}</div>
        <div className="text-[10px] text-gray-400">{caption}</div>
      </div>
      <div className="grid grid-cols-4 gap-x-6 gap-y-2.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{k}</div>
            <div className="font-semibold text-gray-900">{v ?? '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );

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
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">
              {jc.gang_parent ? 'Gang Production Job Card' : 'Production Job Card'}
            </div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink-900">{jc.jc_number}</h1>
            <p className="mt-0.5 text-sm text-gray-600">
              {jc.gang_parent && jc.gang_members?.length
                ? `${jc.gang_number} — ${jc.gang_members.length} jobs on one run (until die cutting)`
                : jc.product_name}
            </p>
          </div>
          <div className="text-right text-xs text-gray-600">
            <div className="text-sm font-extrabold text-ink-900">COLOUR IMPRESSIONS</div>
            <div>Customer: <b>{jc.customer_name}</b></div>
            <div>PO: <b>{jc.po_number}</b> · Released {fmt.date(jc.created_at)}</div>
            <div className="mt-1 inline-flex gap-1.5">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase">{jc.status}</span>
              {jc.finalised_at && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">Finalised</span>}
            </div>
          </div>
        </div>

        {/* Gang run — every product travelling on this one physical card.
            The run stays combined through cutting → printing → die cutting,
            then splits into product-specific child job cards. */}
        {jc.gang_parent && jc.gang_members?.length > 0 && (
          <div className="mt-5">
            <div className="mb-1 flex items-baseline justify-between">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-600">Gang Run — {jc.gang_number}</div>
              <div className="text-[10px] text-gray-400">travels together · separates after die cutting</div>
            </div>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200 text-left text-[10px] font-bold uppercase text-gray-400">
                <th className="py-1">Product</th><th className="py-1">Code</th>
                <th className="py-1">Customer</th><th className="py-1">PO</th>
                <th className="py-1 text-right">Qty (pcs)</th><th className="py-1 text-right">Print Sheets</th>
              </tr></thead>
              <tbody>
                {jc.gang_members.map((m, n) => (
                  <tr key={n} className="border-b border-gray-50">
                    <td className="py-1.5 font-semibold">{m.product_name}</td>
                    <td className="py-1.5 font-mono">{m.product_code}</td>
                    <td className="py-1.5">{m.customer_name}</td>
                    <td className="py-1.5">{m.po_number}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(m.qty)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.sheets_required != null ? fmt.num(m.sheets_required) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Block title="Planning Engine" caption={`Plan ${fmt.date(jc.planned_date) || '—'}`} rows={planning} />
        <Block title="Artwork Module" caption={jc.artwork_locked ? 'Locked' : 'Open'} rows={artwork} />
        <Block title="Product Master" caption={`Source #${jc.product_id}`} rows={product} />

        {/* Material Issued — compact traceability strip */}
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

        {/* Sign-off */}
        <div className="mt-10 grid grid-cols-3 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Planned By</div>
          <div className="border-t border-gray-300 pt-2">Finalised By</div>
          <div className="border-t border-gray-300 pt-2">QA Release</div>
        </div>
      </div>
    </div>
  );
}
