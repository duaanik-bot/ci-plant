// One artwork job from the register: every version the customer sent, newest first, each with its files (open in
// Drive) and the mails that carried it (open in Gmail). Two things a person can do here: say which product a job is,
// and mark a version that was filed by mistake as not artwork (it is kept, and can be put back).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, Field, Input, Modal, Textarea, useToast } from '../../components/ui.jsx';
import { ExternalLink, FileText, Link2, Mail } from 'lucide-react';
import { VersionStatus } from './ArtworkRegister.jsx';

const size = n => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ACTION = { received: 'Received', received_again: 'Sent again (same files)', mapped: 'Matched to a product', not_artwork: 'Marked not artwork', restored: 'Put back' };

function Out({ href, children }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#0064D2] hover:underline">{children}<ExternalLink size={11} /></a>;
}

export default function ArtworkJob({ jobId, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [mapping, setMapping] = useState(false);
  const [products, setProducts] = useState(null);
  const [find, setFind] = useState('');
  const [rejecting, setRejecting] = useState(null);   // the version being marked not artwork
  const [reason, setReason] = useState('');

  // Read through refs so the loader depends on the job alone (see ArtworkRegister.jsx).
  const toastRef = useRef(toast); toastRef.current = toast;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const load = useCallback(() => {
    if (!jobId) { setData(null); return; }
    api.get(`/artwork/register/${jobId}`).then(setData).catch(e => { toastRef.current.error(e.message); closeRef.current(); });
  }, [jobId]);
  useEffect(() => { setData(null); setMapping(false); setRejecting(null); load(); }, [load]);

  const done = say => { toast.success(say); load(); onChanged?.(); };
  const startMapping = () => {
    setMapping(true); setFind('');
    if (!products) api.get('/products').then(setProducts).catch(e => toast.error(e.message));
  };
  const found = useMemo(() => {
    const words = find.toLowerCase().split(/\s+/).filter(Boolean);
    if (!products || !words.length) return [];
    return products.filter(p => { const hay = `${p.name} ${p.party_item_code || ''} ${p.internal_carton_code || ''}`.toLowerCase(); return words.every(w => hay.includes(w)); }).slice(0, 30);
  }, [products, find]);

  const job = data?.job;
  return (
    <>
      <Modal open={!!jobId} onClose={onClose} wide
        title={job ? `${job.job_no} — ${job.product_name || job.client_item_code || 'artwork'}` : 'Artwork job'}
        footer={<>
          {job && <Button variant="secondary" onClick={startMapping}>{job.product_id ? 'Change product' : 'Match to a product'}</Button>}
          <Button onClick={onClose}>Close</Button>
        </>}>
        {!data ? <div className="py-8 text-center text-sm text-slate-500">Loading…</div> : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div><div className="text-[11px] text-slate-500">Customer</div><div className="font-semibold">{job.customer_name || '—'}</div></div>
              <div><div className="text-[11px] text-slate-500">Item code</div><div className="font-mono font-semibold">{job.client_item_code || '—'}</div></div>
              <div><div className="text-[11px] text-slate-500">Pack</div><div className="font-semibold">{job.pack_type || '—'}</div></div>
              <div><div className="text-[11px] text-slate-500">Our product</div><div className="font-semibold">{job.product_id ? job.product_name : 'not linked yet'}</div></div>
            </div>
            {job.to_sort && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-[13px] text-amber-900 ring-1 ring-inset ring-amber-600/20">
                To sort: the mail did not say clearly which product this is. Match it to a product, or mark the version as not artwork.
              </div>
            )}

            {data.versions.map(v => (
              <div key={v.id} className={`rounded-2xl border border-slate-200 p-3 ${v.status === 'not_artwork' ? 'opacity-60' : ''}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-base font-bold">{v.label}</span>
                  <VersionStatus status={v.status} />
                  {v.variant === 'batch' && <span className="text-[11px] font-semibold text-slate-500">batch details</span>}
                  <span className="text-[12px] text-slate-500">received {fmt.date(v.received_at)}</span>
                  <span className="ml-auto">
                    {v.status === 'not_artwork'
                      ? <Button size="sm" variant="secondary" onClick={() => api.post(`/artwork/register/versions/${v.id}/restore`).then(() => done(`${v.label} is back in the register`)).catch(e => toast.error(e.message))}>Put back</Button>
                      : <Button size="sm" variant="secondary" onClick={() => { setRejecting(v); setReason(''); }}>Not artwork</Button>}
                  </span>
                </div>
                <div className="space-y-1">
                  {v.files.map(f => (f.link_url
                    ? <div key={f.id} className="flex flex-wrap items-center gap-2 text-[13px]"><Link2 size={13} className="text-amber-700" />
                        <span className="break-all">{f.link_url}</span><Out href={f.link_url}>Open link</Out>
                        <span className="text-[11px] text-amber-800">sent as a link — download the files by hand</span></div>
                    : <div key={f.id} className="flex flex-wrap items-center gap-2 text-[13px]"><FileText size={13} className="text-slate-400" />
                        <span className="font-semibold">{f.file_name || 'file'}</span>
                        <span className="text-[11px] text-slate-500">{size(f.size_bytes)}</span>
                        {f.drive_url ? <Out href={f.drive_url}>Open in Drive</Out> : <span className="text-[11px] text-amber-800">not saved in Drive — open the mail</span>}</div>))}
                  {!v.files.length && <div className="text-[13px] text-amber-800">No file was saved for this version — open the mail.</div>}
                </div>
                <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                  {v.mails.map(m => (
                    <div key={m.id} className="flex flex-wrap items-center gap-2 text-[12px] text-slate-600"><Mail size={12} className="text-slate-400" />
                      <span className="font-semibold text-slate-800">{m.subject || '(no subject)'}</span>
                      <span>{m.from_name || m.from_email}</span><span>{fmt.date(m.received_at)}</span>
                      {m.view_url && <Out href={m.view_url}>Open in Gmail</Out>}</div>))}
                </div>
              </div>
            ))}

            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">History</div>
              <div className="space-y-0.5 text-[12px] text-slate-600">
                {data.events.map(e => {
                  const v = data.versions.find(x => x.id === e.version_id);
                  return <div key={e.id}>{fmt.date(e.at)} · {ACTION[e.action] || e.action}{v ? ` · ${v.label}` : ''}{e.detail?.product_name ? ` · ${e.detail.product_name}` : ''}{e.detail?.reason ? ` · ${e.detail.reason}` : ''} · {e.by_name || '—'}</div>;
                })}
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={mapping} onClose={() => setMapping(false)} title="Which product is this artwork for?" layer={2}
        footer={<Button variant="secondary" onClick={() => setMapping(false)}>Cancel</Button>}>
        <Field label="Find the product" hint="Name, customer item code or our carton code">
          <Input autoFocus value={find} onChange={e => setFind(e.target.value)} placeholder="Type to search" />
        </Field>
        <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
          {!products && <div className="text-sm text-slate-500">Loading products…</div>}
          {products && find && !found.length && <div className="text-sm text-slate-500">No product matches.</div>}
          {found.map(p => (
            <button key={p.id} type="button" className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-100"
              onClick={() => api.post(`/artwork/register/${jobId}/map`, { product_id: p.id }).then(() => { setMapping(false); done(`Matched to ${p.name}`); }).catch(e => toast.error(e.message))}>
              <span className="font-semibold">{p.name}</span>
              <span className="ml-2 font-mono text-[11px] text-slate-500">{[p.party_item_code, p.internal_carton_code].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title={`${rejecting?.label || ''} is not artwork`} layer={2}
        footer={<>
          <Button variant="secondary" onClick={() => setRejecting(null)}>Keep</Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => api.post(`/artwork/register/versions/${rejecting.id}/not-artwork`, { reason })
            .then(() => { const l = rejecting.label; setRejecting(null); done(`${l} marked not artwork`); }).catch(e => toast.error(e.message))}>Mark not artwork</Button>
        </>}>
        <p className="mb-2 text-sm text-slate-600">It stays in the register, greyed out, and can be put back.</p>
        <Field label="Why" required><Textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. a purchase order, not artwork" /></Field>
      </Modal>
    </>
  );
}
