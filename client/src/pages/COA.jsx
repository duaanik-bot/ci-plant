// Printable Certificate of Analysis with editable draft fields.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, Textarea, useToast } from '../components/ui.jsx';
import { ArrowLeft, CheckCircle2, Printer, Save } from 'lucide-react';

function CoaSheet({ coa }) {
  const co = coa.company || {};
  const params = Array.isArray(coa.params) ? coa.params : [];
  const sampling = coa.sampling || {};
  return (
    <div className="print-sheet rounded-xl border border-slate-200 bg-white p-8 shadow-card print:break-before-page print:p-0 print:border-0 print:shadow-none">
      <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
        <div>
          <h1 className="text-xl font-extrabold tracking-wide text-ink-900">{(co.name || 'Colour Impressions').toUpperCase()}</h1>
          <p className="text-xs text-gray-500">Manufacturers of Printed Packaging Cartons — Pharma & FMCG</p>
          <p className="mt-1 text-xs text-gray-600">{co.address}</p>
          {co.gstin && <p className="text-xs text-gray-600">GSTIN: <b>{co.gstin}</b></p>}
        </div>
        <div className="text-right">
          <div className="text-sm font-extrabold text-brand-600">CERTIFICATE OF ANALYSIS</div>
          <div className="mt-1 text-xs text-gray-600">No: <b>{coa.coa_number}</b></div>
          <div className="text-xs text-gray-600">Status: <b>{fmt.title(coa.status)}</b></div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-gray-400">Customer</div>
          <div className="mt-1 font-bold">{coa.customer_name}</div>
          <div className="text-gray-600">{coa.city}{coa.state ? `, ${coa.state}` : ''}</div>
          {coa.gstin && <div className="text-xs text-gray-500">GSTIN: {coa.gstin}</div>}
        </div>
        <div className="text-right text-xs text-gray-600">
          <div>Product: <b>{coa.product_name}</b></div>
          <div>Code: <b>{coa.product_code || '—'}</b></div>
          <div>Batch / JC: <b>{coa.batch_no || coa.jc_number || '—'}</b></div>
          <div>Qty: <b>{fmt.num(coa.qty)}</b></div>
          <div>Challan: <b>{coa.challan_number}</b>{coa.invoice_number ? ` · Invoice ${coa.invoice_number}` : ''}</div>
        </div>
      </div>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="bg-ink-900 text-left text-xs font-bold uppercase tracking-wide text-white">
            <th className="px-3 py-2">Parameter</th>
            <th className="px-3 py-2">Standard</th>
            <th className="px-3 py-2">Observed</th>
            <th className="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p, i) => (
            <tr key={`${p.parameter}-${i}`} className="border-b border-gray-100">
              <td className="px-3 py-2.5 font-semibold">{p.parameter}</td>
              <td className="px-3 py-2.5 text-gray-600">{p.standard}</td>
              <td className="px-3 py-2.5 text-gray-600">{p.observed}</td>
              <td className="px-3 py-2.5 font-bold text-emerald-700">{p.result}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 grid grid-cols-2 gap-4 text-xs text-gray-600">
        <div className="rounded-xl bg-slate-50 p-3">
          <div className="font-bold uppercase tracking-wide text-gray-400">Sampling</div>
          <div className="mt-1">Lot size: <b>{fmt.num(sampling.lot_size)}</b></div>
          <div>Sample size: <b>{sampling.sample_size || 'As per plan'}</b></div>
          <div>AQL: <b>{sampling.aql || 'As applicable'}</b></div>
          <div>Accepted / Rejected: <b>{sampling.accepted ?? '—'} / {sampling.rejected ?? '—'}</b></div>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <div className="font-bold uppercase tracking-wide text-gray-400">Conclusion</div>
          <p className="mt-1">{coa.remarks || 'The above material has been inspected and conforms to the approved specification and customer artwork.'}</p>
        </div>
      </div>

      <div className="mt-12 grid grid-cols-2 gap-10 text-center text-xs text-gray-500">
        <div className="border-t border-gray-300 pt-2">Inspected By: {coa.inspected_by || 'QC'}</div>
        <div className="border-t border-gray-300 pt-2">Approved By: {coa.approved_by || 'Authorised Signatory'}</div>
      </div>
    </div>
  );
}

export { CoaSheet };

export default function COA() {
  const { id } = useParams();
  const toast = useToast();
  const [coa, setCoa] = useState(null);
  const [editing, setEditing] = useState(false);

  const load = () => api.get(`/coas/${id}`).then(setCoa);
  useEffect(() => { load(); }, [id]);
  if (!coa) return null;

  const save = async () => {
    const saved = await api.put(`/coas/${coa.id}`, {
      qty: +coa.qty,
      batch_no: coa.batch_no || null,
      mfg_date: coa.mfg_date || null,
      po_number: coa.po_number || null,
      params: coa.params,
      sampling: coa.sampling,
      remarks: coa.remarks || null,
      inspected_by: coa.inspected_by || null,
      approved_by: coa.approved_by || null,
    });
    setCoa(saved);
    setEditing(false);
    toast.success('COA saved');
  };

  const issue = async () => {
    const saved = await api.post(`/coas/${coa.id}/issue`, { approved_by: coa.approved_by || undefined });
    setCoa(saved);
    toast.success(`${saved.coa_number} issued`);
  };

  const setParam = (idx, key, value) =>
    setCoa(c => ({ ...c, params: c.params.map((p, i) => (i === idx ? { ...p, [key]: value } : p)) }));
  const setSampling = (key, value) => setCoa(c => ({ ...c, sampling: { ...(c.sampling || {}), [key]: value } }));

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex flex-wrap justify-between gap-2">
        <Link to={coa.invoice_id ? `/invoices/${coa.invoice_id}` : `/dispatch/challan/${coa.dispatch_id}`}>
          <Button variant="secondary"><ArrowLeft size={14} /> Back</Button>
        </Link>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}><Save size={14} /> Edit COA</Button>
          {coa.status !== 'issued' && <Button variant="secondary" onClick={issue}><CheckCircle2 size={14} /> Issue</Button>}
          <Button onClick={() => window.print()}><Printer size={14} /> Export PDF</Button>
        </div>
      </div>

      <CoaSheet coa={coa} />

      <Modal wide open={editing} onClose={() => setEditing(false)} title={`Edit ${coa.coa_number}`}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          <Button onClick={save}>Save COA</Button>
        </>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity"><Input type="number" value={coa.qty || ''} onChange={e => setCoa({ ...coa, qty: e.target.value })} /></Field>
            <Field label="Batch / JC"><Input value={coa.batch_no || ''} onChange={e => setCoa({ ...coa, batch_no: e.target.value })} /></Field>
            <Field label="Mfg Date"><Input type="date" value={coa.mfg_date || ''} onChange={e => setCoa({ ...coa, mfg_date: e.target.value })} /></Field>
            <Field label="PO Number"><Input value={coa.po_number || ''} onChange={e => setCoa({ ...coa, po_number: e.target.value })} /></Field>
            <Field label="Inspected By"><Input value={coa.inspected_by || ''} onChange={e => setCoa({ ...coa, inspected_by: e.target.value })} /></Field>
            <Field label="Approved By"><Input value={coa.approved_by || ''} onChange={e => setCoa({ ...coa, approved_by: e.target.value })} /></Field>
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head"><th className="px-3 py-2">Parameter</th><th className="px-3 py-2">Standard</th><th className="px-3 py-2">Observed</th><th className="px-3 py-2">Result</th></tr></thead>
              <tbody>
                {coa.params.map((p, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {['parameter', 'standard', 'observed', 'result'].map(k => (
                      <td key={k} className="px-2 py-2"><Input value={p[k] || ''} onChange={e => setParam(i, k, e.target.value)} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lot Size"><Input type="number" value={coa.sampling?.lot_size || ''} onChange={e => setSampling('lot_size', +e.target.value || null)} /></Field>
            <Field label="Sample Size"><Input value={coa.sampling?.sample_size || ''} onChange={e => setSampling('sample_size', e.target.value)} /></Field>
            <Field label="Accepted"><Input type="number" value={coa.sampling?.accepted ?? ''} onChange={e => setSampling('accepted', +e.target.value || null)} /></Field>
            <Field label="Rejected"><Input type="number" value={coa.sampling?.rejected ?? ''} onChange={e => setSampling('rejected', +e.target.value || null)} /></Field>
          </div>
          <Field label="Remarks"><Textarea value={coa.remarks || ''} onChange={e => setCoa({ ...coa, remarks: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
