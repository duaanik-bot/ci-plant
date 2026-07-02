// Planning — one screen, one action per line: assign machine + date, gates go
// green, then "Create Job Card". Shortages are visible immediately with a
// one-click "Raise PR".
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Checkbox, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, useToast } from '../components/ui.jsx';
import { CheckCircle2, XCircle, Wrench } from 'lucide-react';

function Gate({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${ok ? 'text-emerald-600' : 'text-gray-400'}`}>
      {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{label}
    </span>
  );
}

export default function Planning() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [machines, setMachines] = useState([]);
  const [planLine, setPlanLine] = useState(null);
  const [form, setForm] = useState({ machine_id: '', planned_date: '', tooling_ok: false });

  const load = () => api.get('/planning').then(setLines);
  useEffect(() => { load(); api.get('/machines').then(setMachines); }, []);

  const openPlan = l => {
    setPlanLine(l);
    setForm({ machine_id: l.machine_id || '', planned_date: l.planned_date || '', tooling_ok: !!l.tooling_ok });
  };

  const savePlan = async () => {
    await api.post(`/order-lines/${planLine.id}/plan`, { ...form, machine_id: +form.machine_id });
    toast.success('Line planned — sent to artwork queue');
    setPlanLine(null); load();
  };

  const createJC = async l => {
    await api.post(`/order-lines/${l.id}/job-card`);
    toast.success('Job card created — see Production');
    load();
  };

  const raisePR = async l => {
    const pr = await api.post(`/order-lines/${l.id}/raise-pr`);
    toast.success(`${pr.pr_number} raised for board shortage`);
  };

  return (
    <div>
      <PageHeader title="Planning" subtitle="Assign machine & date → gates go green → release to production" />
      <DataTable searchable
        columns={[
          { key: 'po_number', label: 'PO / Customer', render: l => (<div><div className="font-semibold text-gray-900">{l.po_number}</div><div className="text-xs text-gray-500">{l.customer_name}</div></div>) },
          { key: 'product_name', label: 'Product', render: l => (<div><div>{l.product_name}</div><div className="text-xs text-gray-400">{l.product_code} · {l.colors}c · {fmt.title(l.coating)}{l.special !== 'none' ? ` · ${fmt.title(l.special)}` : ''}</div></div>) },
          { key: 'qty', label: 'Qty', align: 'right', render: l => fmt.num(l.qty) },
          { key: 'sheets_required', label: 'Sheets', align: 'right', render: l => l.sheets_required ? fmt.num(l.sheets_required) : '—' },
          { key: 'delivery_date', label: 'Delivery', render: l => fmt.date(l.delivery_date) },
          { key: 'machine_name', label: 'Machine / Date', render: l => l.machine_name ? (<div><div className="text-xs font-semibold">{l.machine_name}</div><div className="text-xs text-gray-400">{fmt.date(l.planned_date)}</div></div>) : <span className="text-xs text-gray-400">unplanned</span> },
          { key: 'gates', label: 'Readiness', render: l => (
            <div className="flex flex-col gap-0.5">
              <Gate ok={l.readiness.artwork} label="Artwork" />
              <Gate ok={l.readiness.tooling} label="Tooling" />
              <Gate ok={l.readiness.material} label={l.readiness.material ? 'Material' : `Short ${fmt.num(l.readiness.needed_sheets - l.readiness.available_sheets)}`} />
            </div>) },
          { key: 'status', label: 'Status', render: l => <StatusBadge status={l.status} /> },
          { key: 'act', label: '', render: l => (
            <div className="flex justify-end gap-1.5" onClick={e => e.stopPropagation()}>
              {!l.readiness.material && l.status !== 'pending' && (
                <Button size="sm" variant="secondary" onClick={() => raisePR(l)}>Raise PR</Button>
              )}
              {l.status === 'ready'
                ? <Button size="sm" variant="success" onClick={() => createJC(l)}>Create Job Card</Button>
                : <Button size="sm" variant="secondary" onClick={() => openPlan(l)}><Wrench size={13} /> Plan</Button>}
            </div>) },
        ]}
        rows={lines} empty="No lines waiting for planning" />

      <Modal open={!!planLine} onClose={() => setPlanLine(null)}
        title={planLine ? `Plan — ${planLine.product_name}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setPlanLine(null)}>Cancel</Button>
          <Button onClick={savePlan} disabled={!form.machine_id || !form.planned_date}>Save Plan</Button>
        </>}>
        {planLine && (
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              {fmt.num(planLine.qty)} cartons · {planLine.ups} ups · {planLine.board_name}
              {planLine.sheets_required ? <> · needs <b>{fmt.num(planLine.sheets_required)}</b> sheets</> : null}
            </div>
            <Field label="Printing Machine" required>
              <Select value={form.machine_id} onChange={e => setForm({ ...form, machine_id: e.target.value })}>
                <option value="">Select machine…</option>
                {machines.filter(m => m.type === 'printing').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </Field>
            <Field label="Planned Date" required>
              <Input type="date" value={form.planned_date} onChange={e => setForm({ ...form, planned_date: e.target.value })} />
            </Field>
            <Checkbox label="Die & tooling ready" checked={form.tooling_ok} onChange={e => setForm({ ...form, tooling_ok: e.target.checked })} />
          </div>
        )}
      </Modal>
    </div>
  );
}
