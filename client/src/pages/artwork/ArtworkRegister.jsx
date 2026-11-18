// The artwork register — every artwork mail the office AVS files from the company mailbox, as jobs and versions
// (Artwork Manager P1; owner's brief of 14 Nov 2026). One row per job, carrying its latest version; a job opens to its
// whole history (ArtworkJob.jsx). Since 17 Nov each row also carries its stage (New → … → Released), a tick box, and
// the buttons work on every ticked row at once (only where that row's stage offers the button).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, auth, fmt } from '../../api.js';
import { Button, DataTable, Field, Input, Modal, useToast } from '../../components/ui.jsx';
import { STAGES, summary } from './artworkFlow.js';
import { StageBadge } from './ArtworkVersionFlow.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { RefreshCw } from 'lucide-react';
import ArtworkJob from './ArtworkJob.jsx';

export const VERSION_STATUS = {
  received: { label: 'Received', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  file_to_fetch: { label: 'File to fetch', cls: 'bg-amber-50 text-amber-800 ring-amber-600/30' },
  not_artwork: { label: 'Not artwork', cls: 'bg-slate-100 text-slate-500 ring-slate-400/30' },
};
export function VersionStatus({ status }) {
  const s = VERSION_STATUS[status] || { label: status, cls: 'bg-slate-100 text-slate-600 ring-slate-400/30' };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${s.cls}`}>{s.label}</span>;
}

const CHIPS = [
  { key: '', label: 'All' },
  { key: 'to_sort', label: 'To sort' },
  { key: 'file_to_fetch', label: 'File to fetch' },
  { key: 'deleted', label: 'Deleted' },
];
const STAGE_CHIPS = STAGES.map(s => ({ key: `stage:${s.key}`, label: s.label }));
// A job whose every version is deleted shows only under Deleted (it can be opened and put back there).
const matches = (job, chip) => (chip === 'deleted' ? !!job.latest.deleted_at : !job.latest.deleted_at) && (chip === 'to_sort' ? job.to_sort
  : chip === 'file_to_fetch' ? job.latest.status === 'file_to_fetch' : chip.startsWith('stage:') ? job.latest.stage === chip.slice(6) : true);

// The bulk buttons: label, which row action makes a row eligible, and the call.
const BULK = [
  { key: 'send_for_approval', label: 'Send for approval', call: rows => api.post('/artwork/register/send-for-approval', { version_ids: rows.map(j => j.latest.id) }),
    ok: n => `${n} approval mail(s) drafted — review each, then Send email` },
  { key: 'send_email', label: 'Send email', confirm: true, call: rows => api.post('/artwork/register/send-email', { proof_mail_ids: [...new Set(rows.map(j => j.latest.draft_id).filter(Boolean))] }),
    ok: n => `${n} approval mail(s) sent` },
  { key: 'release', label: 'Send to plates', confirm: 'plates', call: rows => api.post('/artwork/register/release', { version_ids: rows.map(j => j.latest.id) }), ok: n => `${n} released to plates` },
];

// The last "done by the system" notice mail (from mppchd to the two company mailboxes): one quiet line when it went,
// a loud one when it is waiting for mppchd's Gmail or Google refused it — so a notice nobody got is never silent.
function NoticeLine({ notice, onResend }) {
  if (!notice) return null;
  const warn = 'mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900';
  return (
    <>
      {notice.gave_up > 0 && (
        <div className={`${warn} flex flex-wrap items-center gap-2`}>
          <span>{notice.gave_up === 1 ? 'One "done by the system" mail to the designer was NOT sent.' : `${notice.gave_up} "done by the system" mails to the designer were NOT sent.`} {notice.gave_up_error}</span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onResend}>Send again</Button>
        </div>
      )}
      {notice.pending > 0 && notice.status !== 'sent' && (
        <div className={warn}>The "done by the system" mail to the designer is waiting to be sent. {notice.error}</div>
      )}
      {notice.status === 'sent' && (
        <div className="mb-2 text-[12px] text-slate-500">Last "done by the system" mail sent {fmt.date(notice.sent_at)} to {notice.to_text}.</div>
      )}
    </>
  );
}

export default function ArtworkRegister({ focus }) {
  const toast = useToast();
  const [jobs, setJobs] = useState(null);
  const [notice, setNotice] = useState(null);
  const [unmatched, setUnmatched] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const [keysOpen, setKeysOpen] = useState(false);
  const isAdmin = auth.user?.role === 'admin';
  const [chip, setChip] = useState('');
  const [openId, setOpenId] = useState(focus ? Number(focus) : null);

  // The toast and the close handler are read through refs: neither is a stable object, and a loader that depended on
  // them would run again on every render.
  const toastRef = useRef(toast); toastRef.current = toast;
  const load = useCallback(() => Promise.all([api.get('/artwork/register'), api.get('/artwork/register?status=deleted')]).then(([r, d]) => { setJobs([...r.jobs, ...d.jobs]); setNotice(r.notice || null); setUnmatched(r.unmatched_exports || []); }).catch(e => toastRef.current.error(e.message)), []);
  const closeJob = useCallback(() => setOpenId(null), []);
  useEffect(() => { load(); }, [load]);
  // AVS files four times a day; an open register picks a new run up without a reload.
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const counts = useMemo(() => Object.fromEntries([...CHIPS, ...STAGE_CHIPS].map(c => [c.key, (jobs || []).filter(j => matches(j, c.key)).length])), [jobs]);
  // The search is held here (not inside the table), so "select all" ticks exactly the rows on screen.
  const [search, setSearch] = useState('');
  const flat = v => String(v ?? '').toLowerCase();
  const rows = useMemo(() => {
    const words = flat(search).split(/\s+/).filter(Boolean);
    return (jobs || []).filter(j => matches(j, chip))
      .filter(j => { const hay = flat(`${j.job_no} ${j.customer_name} ${j.client_item_code} ${j.product_name} ${j.latest.label}`); return words.every(w => hay.includes(w)); });
  }, [jobs, chip, search]);
  // a different list on screen: nothing stays ticked out of sight
  useEffect(() => { setPicked(new Set()); }, [chip, search]);
  const openTargets = useMemo(() => (jobs || []).filter(j => !j.latest.deleted_at && ['new', 'designer_file', 'changes', 'to_confirm'].includes(j.latest.stage)), [jobs]);
  const [matchTo, setMatchTo] = useState({});

  const shown = rows;
  const chosen = (jobs || []).filter(j => picked.has(j.id));
  const allOn = shown.length > 0 && shown.every(j => picked.has(j.id));
  const toggle = id => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulk = async (b) => {
    const rowsFor = chosen.filter(j => j.latest.actions?.includes(b.key));
    const listed = rowsFor.map(j => `${j.job_no} ${j.latest.label} — ${j.customer_name || ''}`).join('\n');
    if (b.confirm === true && !window.confirm(`Send ${rowsFor.length} approval mail(s) to the clients now?\n\n${listed}`)) return;
    if (b.confirm === 'plates' && !window.confirm(`Release ${rowsFor.length} to plates?\n\n${listed}`)) return;
    setBusy(b.key);
    try {
      const out = await b.call(rowsFor);
      const s = summary(out);
      if (s.done) toast.success(b.ok(s.done));
      if (s.why.length) toast.error(s.why.join(' · '));
      setPicked(new Set());
      load();
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const del = async () => {
    const reason = window.prompt(`Delete ${chosen.length} job(s)' latest version? Hidden, kept with the reason, can be put back.\n\nWhy?`);
    if (!reason || !reason.trim()) return;
    try { await api.post('/artwork/register/delete', { version_ids: chosen.map(j => j.latest.id), reason }); toast.success(`${chosen.length} deleted`); setPicked(new Set()); load(); }
    catch (e) { toast.error(e.message); }
  };

  const columns = [
    { key: 'pick', label: <input type="checkbox" aria-label="Select all shown" checked={allOn} onClick={e => e.stopPropagation()}
        onChange={() => setPicked(allOn ? new Set() : new Set(shown.map(j => j.id)))} />, sortable: false, exportValue: () => '',
      render: j => <input type="checkbox" aria-label={`Select ${j.job_no}`} checked={picked.has(j.id)} onClick={e => e.stopPropagation()} onChange={() => toggle(j.id)} /> },
    { key: 'job_no', label: 'Job', render: j => <span className="font-mono text-[13px] font-semibold">{j.job_no}</span> },
    { key: 'customer_name', label: 'Customer', render: j => j.customer_name || '—' },
    { key: 'client_item_code', label: 'Item code', render: j => (j.client_item_code ? <span className="font-mono text-[13px]">{j.client_item_code}</span> : '—') },
    { key: 'product_name', label: 'Product', render: j => (
      <div>
        <div className="font-semibold">{j.product_name || '—'}</div>
        <div className="text-[11px] text-slate-500">
          {[j.pack_type, j.to_sort ? 'to sort — not yet matched to a product' : !j.product_id ? 'not linked to a product yet' : null].filter(Boolean).join(' · ')}
        </div>
      </div>
    ) },
    { key: 'latest_label', label: 'Latest version', sortValue: j => j.latest.label, exportValue: j => j.latest.label, render: j => (
      <div>
        <span className="font-mono text-[13px] font-semibold">{j.latest.label}</span>
        {j.latest.variant === 'batch' && <span className="ml-1.5 text-[11px] text-slate-500">batch details</span>}
        {j.versions > 1 && <div className="text-[11px] text-slate-500">{j.versions} versions</div>}
      </div>
    ) },
    { key: 'stage', label: 'Stage', sortValue: j => STAGES.findIndex(x => x.key === j.latest.stage), exportValue: j => STAGES.find(x => x.key === j.latest.stage)?.label,
      render: j => <StageBadge stage={j.latest.stage} /> },
    { key: 'status', label: 'Status', sortValue: j => j.latest.status, exportValue: j => VERSION_STATUS[j.latest.status]?.label ?? j.latest.status,
      render: j => <VersionStatus status={j.latest.status} /> },
    { key: 'received_at', label: 'Received', sortValue: j => new Date(j.latest.received_at).toISOString(), exportValue: j => fmt.date(j.latest.received_at),
      render: j => fmt.date(j.latest.received_at) },
    { key: 'waiting_days', label: 'Waiting', sortValue: j => j.waiting_days, render: j => `${j.waiting_days} d` },
  ];

  return (
    <div>
      <FilterRail className="mb-3">
        <FilterGroup label="Show">
          {CHIPS.map(c => (
            <FilterChip key={c.key || 'all'} label={c.label} on={chip === c.key} count={counts[c.key]} onClick={() => setChip(c.key)} />
          ))}
        </FilterGroup>
        <FilterGroup label="Stage">
          {STAGE_CHIPS.map(c => (
            <FilterChip key={c.key} label={c.label} on={chip === c.key} count={counts[c.key]} onClick={() => setChip(chip === c.key ? '' : c.key)} />
          ))}
        </FilterGroup>
        {isAdmin && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setKeysOpen(true)}>Designer PCs</Button>}
        <Button size="sm" variant="secondary" className={isAdmin ? '' : 'ml-auto'} onClick={load}><RefreshCw size={13} className="mr-1 inline" />Refresh</Button>
      </FilterRail>
      {!!unmatched.length && (
        <div className="mb-2 space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <div>{unmatched.length} designer export(s) could not be put on a job by their file name — pick the job, or set it aside:</div>
          {unmatched.map(u => (
            <div key={u.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{u.file_name}</span>
              <span className="text-[11px]">{[u.by_name, fmt.date(u.created_at)].filter(Boolean).join(' · ')}</span>
              {u.drive_url && <a href={u.drive_url} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-[#0064D2] hover:underline">Open</a>}
              <select className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-[12px]" value={matchTo[u.id] || ''} onChange={e => setMatchTo(m => ({ ...m, [u.id]: e.target.value }))}>
                <option value="">Pick the job…</option>
                {openTargets.map(j => <option key={j.id} value={j.latest.id}>{`${j.job_no} ${j.latest.label} — ${j.product_name || j.client_item_code || ''}`}</option>)}
              </select>
              <Button size="sm" disabled={!matchTo[u.id]} onClick={() => api.post(`/artwork/register/exports/${u.id}/match`, { version_id: Number(matchTo[u.id]) })
                .then(() => { toast.success(`${u.file_name} put on its job`); load(); }).catch(e => toast.error(e.message))}>Put on job</Button>
              <Button size="sm" variant="secondary" onClick={() => api.post(`/artwork/register/exports/${u.id}/dismiss`)
                .then(() => { toast.success('Set aside'); load(); }).catch(e => toast.error(e.message))}>Set aside</Button>
            </div>
          ))}
        </div>
      )}
      {picked.size > 0 && (
        <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-[#0064D2]/5 px-3 py-2 ring-1 ring-inset ring-[#0064D2]/20">
          <span className="text-[13px] font-semibold">{picked.size} selected</span>
          {BULK.map(b => {
            const n = chosen.filter(j => j.latest.actions?.includes(b.key)).length;
            return <Button key={b.key} size="sm" disabled={!n || !!busy} onClick={() => bulk(b)}>{busy === b.key ? 'Working…' : `${b.label}${n ? ` (${n})` : ''}`}</Button>;
          })}
          <Button size="sm" variant="danger" disabled={!!busy} onClick={del}>Delete</Button>
          <Button size="sm" variant="secondary" onClick={() => setPicked(new Set())}>Deselect all</Button>
        </div>
      )}
      <NoticeLine notice={notice} onResend={() => api.post('/artwork/register/notices/resend').then(r => { toast.success(r.requeued ? `${r.requeued} sent again${r.sent ? '' : ' — still waiting, see the note'}` : 'Nothing to send again'); load(); }).catch(e => toast.error(e.message))} />
      <DataTable searchValue={search} onSearchChange={setSearch} columns={columns} exportColumns={columns.filter(c => c.key !== 'pick')} rows={rows} onRowClick={j => setOpenId(j.id)}
        defaultSort={{ key: 'received_at', dir: 'desc' }}
        exportName="Artwork register"
        empty={jobs == null ? 'Loading…' : chip ? 'Nothing under this chip.' : 'No artwork has been filed yet. The office AVS files artwork mails from the company mailbox on each of its runs.'} />
      <ArtworkJob jobId={openId} onClose={closeJob} onChanged={load} />
      {isAdmin && <DesignerKeys open={keysOpen} onClose={() => setKeysOpen(false)} />}
    </div>
  );
}

// The designers' PCs: one upload key each for the CorelDRAW button. A key is shown once; switching one off stops that PC.
function DesignerKeys({ open, onClose }) {
  const toast = useToast();
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null);
  // the toast is read through a ref: it changes with every toast, and the one-time key must not be cleared by one
  const toastRef = useRef(toast); toastRef.current = toast;
  const load = useCallback(() => api.get('/artwork/register/keys').then(r => setKeys(r.keys)).catch(e => toastRef.current.error(e.message)), []);
  useEffect(() => { if (open) { setFresh(null); load(); } }, [open, load]);
  return (
    <Modal open={open} onClose={onClose} title="Designer PCs — keys for the CorelDRAW button" footer={<Button onClick={onClose}>Close</Button>}>
      {fresh && (
        <div className="mb-3 rounded-xl bg-green-50 p-3 text-[13px] text-green-900 ring-1 ring-inset ring-green-600/20">
          Key for <b>{fresh.name}</b> — copy it into the button's setup on that PC now; it is not shown again:
          <div className="mt-1 select-all break-all rounded bg-white p-2 font-mono text-[12px]">{fresh.key}</div>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Field label="New key for" hint='e.g. "Designer 1 — office PC"'><Input value={name} onChange={e => setName(e.target.value)} /></Field>
        <Button disabled={!name.trim()} onClick={() => api.post('/artwork/register/keys', { name }).then(r => { setFresh(r); setName(''); load(); }).catch(e => toast.error(e.message))}>Make key</Button>
      </div>
      <div className="mt-3 space-y-1 text-[13px]">
        {(keys || []).map(k => (
          <div key={k.id} className="flex items-center gap-2">
            <span className={`font-semibold ${k.active ? '' : 'text-slate-400 line-through'}`}>{k.name}</span>
            <span className="text-[11px] text-slate-500">{k.last_used_at ? `last used ${fmt.date(k.last_used_at)}` : 'not used yet'}</span>
            {k.active && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => api.post(`/artwork/register/keys/${k.id}/off`).then(load).catch(e => toast.error(e.message))}>Switch off</Button>}
          </div>
        ))}
        {keys && !keys.length && <div className="text-slate-500">No keys yet.</div>}
      </div>
    </Modal>
  );
}
