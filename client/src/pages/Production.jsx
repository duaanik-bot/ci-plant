// Production — job cards as cards, stages as a rail. One button per moment:
// Start → Complete (with qty out + scrap). Final completion closes the job,
// credits FG stock and feeds Dispatch automatically.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, PageHeader, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { Play, Check, ChevronRight, Printer } from 'lucide-react';
import WorkflowControls from '../components/WorkflowControls.jsx';

export default function Production() {
  const toast = useToast();
  const [jobs, setJobs] = useState([]);
  const [tab, setTab] = useState('active');
  const [completing, setCompleting] = useState(null); // {stage, jc}
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0', operator: '' });

  const load = () => api.get('/job-cards').then(setJobs);
  useEffect(() => { load(); }, []);

  const active = jobs.filter(j => j.status !== 'closed');
  const closed = jobs.filter(j => j.status === 'closed');
  const shown = tab === 'active' ? active : closed;

  const startStage = async (jc, st) => {
    await api.post(`/job-stages/${st.id}/start`, {});
    toast.success(`${fmt.stage(st.stage)} started on ${jc.jc_number}`);
    load();
  };

  const openComplete = (jc, st) => {
    setCompleting({ jc, st });
    setForm({ qty_out: st.qty_in ?? '', qty_scrap: '0', operator: st.operator || '' });
  };

  const complete = async () => {
    const { st, jc } = completing;
    await api.post(`/job-stages/${st.id}/complete`, { qty_out: +form.qty_out, qty_scrap: +form.qty_scrap });
    const isLast = st.seq === Math.max(...jc.stages.map(s => s.seq));
    toast.success(isLast ? `${jc.jc_number} closed — FG added to stock, ready for dispatch` : `${fmt.stage(st.stage)} completed`);
    setCompleting(null); load();
  };

  return (
    <div>
      <PageHeader title="Job Cards" subtitle="Every job with its stage rail — strictly one running stage per job. Run the day from Live Floor." />
      <Tabs tabs={[{ key: 'active', label: 'On the Floor', count: active.length }, { key: 'closed', label: 'Closed', count: closed.length }]} active={tab} onChange={setTab} />

      {shown.length === 0 && <p className="rounded-xl border border-dashed border-white/70 bg-white/65 backdrop-blur-xl py-14 text-center text-sm text-gray-400">No job cards here.</p>}

      <div className="space-y-4">
        {shown.map(jc => (
          <div key={jc.id} className="ci-form-panel">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-gray-900">{jc.jc_number}</span>
                  <StatusBadge status={jc.status} />
                  <Link to={`/production/jobcard/${jc.id}`} title="Print job card"
                    className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-brand-600">
                    <Printer size={13} />
                  </Link>
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  {jc.product_name} · {jc.customer_name} · PO {jc.po_number} · delivery {fmt.date(jc.delivery_date)}
                </div>
              </div>
              <div className="flex gap-5 text-right text-xs text-gray-500">
                <div><div className="font-bold text-gray-900 tabular-nums">{fmt.num(jc.qty_planned)}</div>ordered</div>
                <div><div className="font-bold text-gray-900 tabular-nums">{fmt.num(jc.sheets_issued)}</div>sheets issued</div>
                {jc.status === 'closed' && <>
                  <div><div className="font-bold text-emerald-600 tabular-nums">{fmt.num(jc.qty_produced)}</div>produced</div>
                  <div><div className="font-bold text-red-500 tabular-nums">{fmt.num(jc.qty_scrap)}</div>scrap</div>
                </>}
              </div>
            </div>
            <div className="mb-3 flex justify-end">
              <WorkflowControls jobCard={jc} context="jobcard" onDone={load} />
            </div>

            {/* Stage rail */}
            <div className="rounded-2xl border border-slate-100 bg-white/80 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {jc.stages.map((st, i) => (
                <div key={st.id} className="flex items-center gap-1.5">
                  <div className={`rounded-xl border px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,.04)] ${
                    st.status === 'completed' ? 'border-emerald-200 bg-emerald-50'
                    : st.status === 'in_progress' ? 'border-amber-300 bg-amber-50 ring-2 ring-amber-200'
                    : 'border-gray-200 bg-gray-50'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold ${st.status === 'completed' ? 'text-emerald-700' : st.status === 'in_progress' ? 'text-amber-700' : 'text-gray-400'}`}>
                        {fmt.stage(st.stage)}
                      </span>
                      {st.status === 'pending' && jc.status !== 'closed' && (
                        <button onClick={() => startStage(jc, st)}
                          className="rounded bg-white p-1 text-gray-500 shadow-sm hover:text-brand-600" title="Start stage">
                          <Play size={12} />
                        </button>
                      )}
                      {st.status === 'in_progress' && (
                        <button onClick={() => openComplete(jc, st)}
                          className="rounded bg-amber-500 p-1 text-white shadow-sm hover:bg-amber-600" title="Complete stage">
                          <Check size={12} />
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] tabular-nums text-gray-500">
                      {st.status === 'completed' ? `${fmt.num(st.qty_out)} ${st.unit}${st.qty_scrap ? ` · ${fmt.num(st.qty_scrap)} scrap` : ''}`
                        : st.status === 'in_progress' ? `${fmt.num(st.qty_in)} ${st.unit} in`
                        : '—'}
                    </div>
                  </div>
                  {i < jc.stages.length - 1 && <ChevronRight size={13} className="text-gray-300" />}
                </div>
              ))}
            </div>
            </div>
          </div>
        ))}
      </div>

      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `Complete ${fmt.stage(completing.st.stage)} — ${completing.jc.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          <Button variant="success" onClick={complete} disabled={form.qty_out === ''}>Complete Stage</Button>
        </>}>
        {completing && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              Input: <b>{fmt.num(completing.st.qty_in)} {completing.st.unit}</b>
              {completing.st.seq === Math.max(...completing.jc.stages.map(s => s.seq)) &&
                <span className="ml-2 font-semibold text-emerald-600">Final stage — closing this completes the job and adds finished goods.</span>}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Stage output</span><span>{fmt.stage(completing.st.stage)}</span></div>
              <div className="ci-form-grid">
              <Field label={`Good output (${completing.st.unit})`} required>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setForm({ ...form, qty_out: e.target.value })} />
              </Field>
              <Field label={`Scrap (${completing.st.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
              </div>
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
