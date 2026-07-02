// Procurement — PR → PO → GRN → QC. Every arrow is a real record.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Plus } from 'lucide-react';

export default function Procurement() {
  const toast = useToast();
  const [tab, setTab] = useState('prs');
  const [prs, setPrs] = useState([]);
  const [pos, setPos] = useState([]);
  const [grns, setGrns] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [vendors, setVendors] = useState([]);

  const [newPr, setNewPr] = useState(null);
  const [convertPr, setConvertPr] = useState(null);
  const [receivePo, setReceivePo] = useState(null);
  const [qcGrn, setQcGrn] = useState(null);

  const load = () => {
    api.get('/requisitions').then(setPrs);
    api.get('/purchase-orders').then(setPos);
    api.get('/grns').then(setGrns);
  };
  useEffect(() => { load(); api.get('/materials').then(setMaterials); api.get('/vendors').then(setVendors); }, []);

  return (
    <div>
      <PageHeader title="Procurement" subtitle="Requisition → Purchase Order → GRN → QC → stock"
        actions={<Button onClick={() => setNewPr({ material_id: '', qty: '', needed_by: '', reason: '' })}><Plus size={15} /> New Requisition</Button>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'prs', label: 'Requisitions', count: prs.filter(p => p.status === 'pending').length },
        { key: 'pos', label: 'Purchase Orders', count: pos.filter(p => p.status !== 'received' && p.status !== 'closed').length },
        { key: 'grns', label: 'GRN / QC', count: grns.filter(g => g.status === 'quarantine').length },
      ]} />

      {tab === 'prs' && (
        <DataTable searchable
          columns={[
            { key: 'pr_number', label: 'PR No', render: p => <span className="font-semibold">{p.pr_number}</span> },
            { key: 'material_name', label: 'Material' },
            { key: 'qty', label: 'Qty', align: 'right', render: p => `${fmt.num(p.qty)} ${p.unit}` },
            { key: 'needed_by', label: 'Needed By', render: p => fmt.date(p.needed_by) },
            { key: 'reason', label: 'Reason', render: p => <span className="text-xs text-gray-500">{p.reason}</span> },
            { key: 'status', label: 'Status', render: p => <StatusBadge status={p.status} /> },
            { key: 'po_number', label: 'PO', render: p => p.po_number || '—' },
            { key: 'act', label: '', render: p => (
              <div className="flex justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                {p.status === 'pending' && <>
                  <Button size="sm" variant="success" onClick={async () => { await api.post(`/requisitions/${p.id}/approve`); toast.success('Approved'); load(); }}>Approve</Button>
                  <Button size="sm" variant="secondary" onClick={async () => { await api.post(`/requisitions/${p.id}/reject`); toast.info('Rejected'); load(); }}>Reject</Button>
                </>}
                {p.status === 'approved' && <Button size="sm" onClick={() => setConvertPr({ pr: p, vendor_id: '', rate: '' })}>Convert to PO</Button>}
              </div>) },
          ]}
          rows={prs} empty="No requisitions" />
      )}

      {tab === 'pos' && (
        <div className="space-y-3">
          {pos.length === 0 && <p className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-gray-400">No purchase orders.</p>}
          {pos.map(po => (
            <div key={po.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-card">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <span className="text-sm font-extrabold">{po.po_number}</span>
                  <span className="ml-2 text-xs text-gray-500">{po.vendor_name}{po.pr_number ? ` · from ${po.pr_number}` : ''}</span>
                </div>
                <StatusBadge status={po.status} />
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                  <th className="px-3 py-1.5">Material</th><th className="px-3 py-1.5 text-right">Ordered</th>
                  <th className="px-3 py-1.5 text-right">Received</th><th className="px-3 py-1.5 text-right">Rate</th><th className="px-3 py-1.5 text-right"></th>
                </tr></thead>
                <tbody>
                  {po.lines.map(l => (
                    <tr key={l.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2">{l.material_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.received_qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">₹{l.rate}</td>
                      <td className="px-3 py-2 text-right">
                        {l.received_qty < l.qty && (
                          <Button size="sm" variant="secondary" onClick={() => setReceivePo({ po, line: l, qty: '', batch_no: '' })}>Receive</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {tab === 'grns' && (
        <DataTable searchable
          columns={[
            { key: 'grn_number', label: 'GRN', render: g => <span className="font-semibold">{g.grn_number}</span> },
            { key: 'po_number', label: 'Against PO' },
            { key: 'vendor_name', label: 'Vendor' },
            { key: 'material_name', label: 'Material' },
            { key: 'qty', label: 'Qty', align: 'right', render: g => `${fmt.num(g.qty)} ${g.unit}` },
            { key: 'batch_no', label: 'Batch', render: g => <span className="font-mono text-xs">{g.batch_no}</span> },
            { key: 'received_at', label: 'Received', render: g => fmt.date(g.received_at) },
            { key: 'status', label: 'QC', render: g => <StatusBadge status={g.status} /> },
            { key: 'act', label: '', render: g => g.status === 'quarantine' && (
              <div className="flex justify-end" onClick={e => e.stopPropagation()}>
                <Button size="sm" onClick={() => setQcGrn({ grn: g, note: '' })}>QC Decision</Button>
              </div>) },
          ]}
          rows={grns} empty="No goods receipts yet" />
      )}

      {/* New PR */}
      <Modal open={!!newPr} onClose={() => setNewPr(null)} title="New Purchase Requisition"
        footer={<>
          <Button variant="secondary" onClick={() => setNewPr(null)}>Cancel</Button>
          <Button disabled={!newPr?.material_id || !newPr?.qty} onClick={async () => {
            await api.post('/requisitions', { ...newPr, material_id: +newPr.material_id, qty: +newPr.qty });
            toast.success('Requisition raised'); setNewPr(null); load();
          }}>Raise PR</Button>
        </>}>
        {newPr && <div className="space-y-3">
          <Field label="Material" required>
            <Select value={newPr.material_id} onChange={e => setNewPr({ ...newPr, material_id: e.target.value })}>
              <option value="">Select material…</option>
              {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity" required><Input type="number" value={newPr.qty} onChange={e => setNewPr({ ...newPr, qty: e.target.value })} /></Field>
            <Field label="Needed By"><Input type="date" value={newPr.needed_by} onChange={e => setNewPr({ ...newPr, needed_by: e.target.value })} /></Field>
          </div>
          <Field label="Reason"><Textarea value={newPr.reason} onChange={e => setNewPr({ ...newPr, reason: e.target.value })} /></Field>
        </div>}
      </Modal>

      {/* Convert PR → PO */}
      <Modal open={!!convertPr} onClose={() => setConvertPr(null)} title={convertPr ? `Convert ${convertPr.pr.pr_number} to PO` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setConvertPr(null)}>Cancel</Button>
          <Button disabled={!convertPr?.vendor_id} onClick={async () => {
            const po = await api.post(`/requisitions/${convertPr.pr.id}/convert`, { vendor_id: +convertPr.vendor_id, rate: +convertPr.rate || 0 });
            toast.success(`${po.po_number} created`); setConvertPr(null); load(); setTab('pos');
          }}>Create PO</Button>
        </>}>
        {convertPr && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {convertPr.pr.material_name} · {fmt.num(convertPr.pr.qty)} {convertPr.pr.unit}
          </div>
          <Field label="Vendor" required>
            <Select value={convertPr.vendor_id} onChange={e => setConvertPr({ ...convertPr, vendor_id: e.target.value })}>
              <option value="">Select vendor…</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </Field>
          <Field label="Rate (₹ per unit)"><Input type="number" step="0.01" value={convertPr.rate} onChange={e => setConvertPr({ ...convertPr, rate: e.target.value })} /></Field>
        </div>}
      </Modal>

      {/* Receive against PO line */}
      <Modal open={!!receivePo} onClose={() => setReceivePo(null)} title={receivePo ? `Receive — ${receivePo.po.po_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setReceivePo(null)}>Cancel</Button>
          <Button disabled={!receivePo?.qty} onClick={async () => {
            await api.post('/grns', { po_line_id: receivePo.line.id, qty: +receivePo.qty, batch_no: receivePo.batch_no || undefined });
            toast.success('GRN created — material in quarantine until QC'); setReceivePo(null); load(); setTab('grns');
          }}>Create GRN</Button>
        </>}>
        {receivePo && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {receivePo.line.material_name} — ordered {fmt.num(receivePo.line.qty)}, received so far {fmt.num(receivePo.line.received_qty)}
          </div>
          <Field label="Quantity Received" required><Input type="number" value={receivePo.qty} onChange={e => setReceivePo({ ...receivePo, qty: e.target.value })} /></Field>
          <Field label="Supplier Batch No"><Input value={receivePo.batch_no} onChange={e => setReceivePo({ ...receivePo, batch_no: e.target.value })} placeholder="auto if blank" /></Field>
        </div>}
      </Modal>

      {/* QC decision */}
      <Modal open={!!qcGrn} onClose={() => setQcGrn(null)} title={qcGrn ? `QC — ${qcGrn.grn.grn_number}` : ''}
        footer={<>
          <Button variant="danger" onClick={async () => {
            await api.post(`/grns/${qcGrn.grn.id}/qc`, { accept: false, note: qcGrn.note });
            toast.info('Batch rejected'); setQcGrn(null); load();
          }}>Reject</Button>
          <Button variant="success" onClick={async () => {
            await api.post(`/grns/${qcGrn.grn.id}/qc`, { accept: true, note: qcGrn.note });
            toast.success('Accepted — batch released to stock'); setQcGrn(null); load();
          }}>Accept & Release</Button>
        </>}>
        {qcGrn && <div className="space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {qcGrn.grn.material_name} · {fmt.num(qcGrn.grn.qty)} {qcGrn.grn.unit} · batch {qcGrn.grn.batch_no}
          </div>
          <Field label="QC Note"><Textarea value={qcGrn.note} onChange={e => setQcGrn({ ...qcGrn, note: e.target.value })} placeholder="GSM check, shade, moisture…" /></Field>
        </div>}
      </Modal>
    </div>
  );
}
