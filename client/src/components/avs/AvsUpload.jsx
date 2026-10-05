// Upload photos for an AVS check, then Verify.
//
// 1. The job card (printing jobs first) — or several, ticked: the same product in
//    several orders or batches, or a gang — or "no job card" with the product name.
// 2. Photos: taken with the camera or chosen. Each one goes on its own to
//    Google Drive (AVS CHECK/<date>/Set 0012 <job card>) when the Drive link is
//    set up; until then CI Plant keeps it, and Claude files it in the AVS folder
//    when it checks the set. A photo over 4 MB is shrunk first (Vercel's limit);
//    one under it goes as it is, with its camera data.
//    Before Verify a photo can be removed (the cross on it) and taken or chosen
//    again; photos can also be dragged onto the box (5 Oct 2026).
// 2b. Documents (optional): the PO, the approval, the artwork, an e-mail file
//    or link (AvsDocs.jsx). Claude reads them first and still cross-checks them.
// 3. Verify: the set joins the queue and Claude is started. The report then
//    appears in Artwork Verification, where QA decides.
//
// Redo verification (redo = a report that is ready): first why it is redone,
// then new photos for the same job card. The check issues them as the next
// check of the same report number; the earlier check stays on record.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, History, ImagePlus, Loader2, RotateCcw, ScanSearch, Search, Send, Trash2, X, XCircle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Modal, useToast } from '../ui.jsx';
import { AVS_PHOTO_MAX_BYTES, AVS_REMARK_MAX, AVS_SET_MAX_PHOTOS, redoProblem, setLabel } from '../../lib/avs.js';
import AvsDocs from './AvsDocs.jsx';

const LIMIT = AVS_PHOTO_MAX_BYTES - 64 * 1024;

async function fitPhoto(file) {
  if (file.size <= LIMIT) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // a format this browser cannot open: the server says why
  const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.92, 0.86, 0.8, 0.72, 0.64]) {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size <= LIMIT) {
      return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
    }
  }
  return file;
}

export const FIRE_TEXT = {
  fired: 'Claude has started checking. The report appears in Artwork Verification when it is done.',
  // Older sets only: since 1 Oct 2026 every set gets its own run.
  joined: 'Claude is already checking other photos and will check these in the same run.',
  local: 'The office computer is starting Claude now. The report appears in Artwork Verification when it is done.',
};
// Not linked: the set waits for a check started in Cowork (/avs), which also
// files any photos CI Plant kept.
export const fireText = fire => (fire?.ok ? FIRE_TEXT[fire.status] || FIRE_TEXT.fired
  : fire?.status === 'not_linked'
    ? `The set is in the queue. ${fire.error || 'Claude is not linked to CI Plant yet'}, so the check starts when it is run from Cowork (/avs).`
    : `${fire?.error || 'Claude did not start'}. The set waits in the queue; QA can press Try again.`);

// Where the set's photos are: Google Drive, or CI Plant until Claude files them.
export function savedText(saved, keptHere) {
  if (!saved) return 'No photo saved yet.';
  const n = `${saved} photo${saved === 1 ? '' : 's'} saved`;
  if (!keptHere) return `${n} in Google Drive.`;
  if (keptHere === saved) return `${n} in CI Plant; Claude files them in Google Drive when it checks.`;
  return `${n}; ${keptHere} kept in CI Plant until Claude files them in Google Drive.`;
}

// jobCard: { id, jc_number, product_name } to skip the choice (the printing pop-up).
// resume: a set still taking photos (Continue in the list).
// redo: { report_no, label, status, check_no, product, jc_number, set_id } — verify that report again.
export default function AvsUploadDialog({ open, onClose, jobCard = null, resume = null, redo = null, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState('pick');
  const [picked, setPicked] = useState([]); // the job cards ticked, in the order ticked
  const [noCard, setNoCard] = useState(false);
  const [product, setProduct] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [cards, setCards] = useState(null);
  const [set, setSet] = useState(null);
  const [items, setItems] = useState([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [reason, setReason] = useState('');
  const [starting, setStarting] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [removing, setRemoving] = useState(null);

  // The upload queue is worked through outside React's render cycle.
  const form = useRef({});
  form.current = { picked, noCard, product, note };
  const setRef = useRef(null);
  const queue = useRef([]);
  const files = useRef(new Map());
  const previews = useRef([]);
  const busy = useRef(false);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setPicked(jobCard ? [jobCard] : []); setNoCard(false); setProduct(''); setNote(''); setQuery(''); setCards(null);
    setItems([]); setResult(null); setSending(false); setReason(''); setStarting(false);
    setSet(resume); setRef.current = resume;
    queue.current = []; files.current = new Map();
    setStep(resume || jobCard ? 'photos' : redo ? 'redo' : 'pick');
    return () => { previews.current.forEach(u => URL.revokeObjectURL(u)); previews.current = []; };
  }, [open, jobCard, resume, redo]);

  // Redo: the set is made here, with the reason, before any photo — the reason
  // is part of the record even if no photo follows.
  const startRedo = async () => {
    if (starting || redoProblem({ reason })) return;
    setStarting(true);
    try {
      const made = await api.post('/avs/redo', {
        report_no: redo.report_no, set_id: redo.set_id || undefined, reason: reason.trim(), note: note.trim() || undefined,
      });
      if (made.resumed) toast.info(`${setLabel(made.id)} is already redoing ${redo.report_no}. Add the photos to it.`);
      setRef.current = made; setSet(made); setStep('photos');
    } catch { /* api.js said why */ } finally { setStarting(false); }
  };

  const loadCards = useCallback(text => api.get(`/avs/job-cards?q=${encodeURIComponent(text || '')}`)
    .then(setCards).catch(() => setCards([])), []);
  useEffect(() => {
    if (!open || step !== 'pick') return undefined;
    const t = setTimeout(() => loadCards(query), 250);
    return () => clearTimeout(t);
  }, [open, step, query, loadCards]);

  const mark = (key, patch) => setItems(list => list.map(x => (x.key === key ? { ...x, ...patch } : x)));

  // Several job cards: tick them one by one, or all those the search shows.
  const toggleCard = c => {
    setNoCard(false);
    setPicked(cur => (cur.some(x => +x.id === +c.id) ? cur.filter(x => +x.id !== +c.id) : [...cur, c]));
  };
  const shownIds = new Set((cards || []).map(c => +c.id));
  const allShownPicked = !!cards?.length && cards.every(c => picked.some(x => +x.id === +c.id));
  const someShownPicked = picked.some(x => shownIds.has(+x.id));
  const pickShown = on => {
    setNoCard(false);
    setPicked(cur => (on
      ? [...cur, ...(cards || []).filter(c => !cur.some(x => +x.id === +c.id))]
      : cur.filter(x => !shownIds.has(+x.id))));
  };
  const mixedProducts = new Set(picked.map(c => c.product_name || '')).size > 1;

  // The set is made with the first photo, so an abandoned dialog leaves nothing.
  const ensureSet = async () => {
    if (setRef.current) return setRef.current;
    const f = form.current;
    const made = await api.post('/avs/uploads', {
      job_card_ids: f.noCard ? undefined : f.picked.map(c => c.id),
      product_hint: f.noCard ? f.product.trim() : undefined,
      note: f.note.trim() || undefined,
    });
    setRef.current = made; setSet(made);
    return made;
  };

  const pump = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (queue.current.length) {
        const key = queue.current.shift();
        const original = files.current.get(key);
        mark(key, { status: 'uploading' });
        try {
          const s = await ensureSet();
          const file = await fitPhoto(original);
          const out = await api.upload(`/avs/uploads/${s.id}/photos`, file,
            { captured_at: new Date(original.lastModified || Date.now()).toISOString() });
          setRef.current = out; setSet(out);
          const photoId = out.last_photo?.id ?? null;
          mark(key, { status: 'done', stored: out.last_photo?.stored, driveError: out.last_photo?.drive_error, photoId });
        } catch (e) {
          mark(key, { status: 'failed', error: e?.message || 'Upload failed' });
        }
      }
    } finally { busy.current = false; }
  };

  const add = picked => {
    const list = [...(picked || [])].filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!list.length) return;
    const have = (setRef.current?.photos?.length || 0) + queue.current.length;
    const room = Math.max(0, AVS_SET_MAX_PHOTOS - have);
    if (list.length > room) toast.error(`A set holds at most ${AVS_SET_MAX_PHOTOS} photos.`);
    const fresh = list.slice(0, room).map((file, i) => {
      const key = `${Date.now()}-${i}-${file.name}`;
      const preview = URL.createObjectURL(file);
      previews.current.push(preview);
      files.current.set(key, file);
      queue.current.push(key);
      return { key, name: file.name, status: 'waiting', preview };
    });
    setItems(cur => [...cur, ...fresh]);
    pump();
  };

  // Remove a photo before Verify (for good), to take or choose it again.
  const removeItem = async x => {
    if (x.status === 'uploading') return;
    if (x.status === 'waiting') {
      queue.current = queue.current.filter(k => k !== x.key);
      setItems(list => list.filter(i => i.key !== x.key));
      return;
    }
    if (x.status === 'failed' || !x.photoId) { setItems(list => list.filter(i => i.key !== x.key)); return; }
    await removePhoto(x.photoId, x.key);
  };
  const removePhoto = async (photoId, key = null) => {
    if (!setRef.current) return;
    setRemoving(photoId);
    try {
      const out = await api.post(`/avs/uploads/${setRef.current.id}/photos/${photoId}/delete`, {});
      setRef.current = out; setSet(out);
      if (key) setItems(list => list.filter(i => i.key !== key));
    } catch { /* api.js said why */ } finally { setRemoving(null); }
  };
  const onDropPhotos = e => {
    e.preventDefault(); setDropOver(false);
    const list = [...(e.dataTransfer?.files || [])];
    const photos = list.filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (list.length > photos.length) toast.info('Only photos go here. Add a PO, approval or e-mail in the Documents box below.');
    if (photos.length) add(photos);
  };

  const saved = set?.photos?.length || 0;
  const keptHere = set?.photos?.filter(p => p.stored === 'ci_plant').length || 0;
  const earlier = Math.max(0, saved - items.filter(x => x.status === 'done').length);
  const pending = items.some(x => x.status === 'waiting' || x.status === 'uploading');
  // This batch's bar: photos saved (or refused) out of those picked.
  const handled = items.filter(x => x.status === 'done' || x.status === 'failed').length;
  const refused = items.filter(x => x.status === 'failed').length;
  const batchPct = items.length ? Math.round((handled / items.length) * 100) : 0;

  const verify = async () => {
    if (!set || pending || !saved) return;
    setSending(true);
    try {
      const out = await api.post(`/avs/uploads/${set.id}/verify`, {});
      setResult(out); setStep('sent');
      onDone?.(out.set);
    } catch { /* api.js said why */ } finally { setSending(false); }
  };

  const close = () => { if (!pending) onClose?.(); };
  const redoOf = set?.redo_report_no || redo?.report_no || null;
  const jobList = (Array.isArray(set?.job_cards) && set.job_cards.length ? set.job_cards.map(c => c.jc_number)
    : set?.jc_number ? [set.jc_number] : picked.map(c => c.jc_number)).join(', ');

  return (
    <Modal open={open} onClose={close} layer="nested" title={
      <span className="inline-flex items-center gap-2"><ScanSearch size={18} className="text-violet-600" />
        {redoOf ? `Redo verification · ${redoOf}${set ? ` · ${setLabel(set.id)}` : ''}`
          : set ? `AVS photos · ${setLabel(set.id)}` : 'AVS photos'}</span>}
      footer={step === 'sent'
        ? <Button onClick={close}>Done</Button>
        : step === 'photos'
          ? <>
            <Button variant="secondary" repeatable onClick={close} disabled={pending}>{saved ? 'Later' : 'Cancel'}</Button>
            <Button onClick={verify} disabled={!saved || pending || sending}>
              <span className="inline-flex items-center gap-1.5"><Send size={15} /> Verify with Claude</span>
            </Button>
          </>
          : step === 'redo'
            ? <>
              <Button variant="secondary" repeatable onClick={close}>Cancel</Button>
              <Button onClick={startRedo} disabled={starting || !!redoProblem({ reason })}>
                <span className="inline-flex items-center gap-1.5"><RotateCcw size={15} /> {starting ? 'Starting…' : 'Next: new photos'}</span>
              </Button>
            </>
            : <>
              <Button variant="secondary" repeatable onClick={close}>Cancel</Button>
              <Button repeatable onClick={() => setStep('photos')} disabled={noCard ? product.trim().length < 3 : !picked.length}>
                {picked.length > 1 ? `Next: photos (${picked.length} job cards)` : 'Next: photos'}
              </Button>
            </>}>
      {step === 'redo' && redo && (
        <div className="space-y-3">
          <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5 text-sm text-violet-900">
            <div className="font-semibold">{redo.product || 'This product'} · {redo.label || redo.report_no}{redo.status ? ` · ${redo.status}` : ''}</div>
            <div className="mt-0.5 text-xs">Job card <span className="font-mono">{redo.jc_number || 'none'}</span></div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
            <li>Upload new photos of the carton. Claude checks them in full and issues <b>{redo.report_no} Check {(+redo.check_no || 1) + 1}</b>.</li>
            <li>The register then shows only the new check. The current report, its photos and QA's decisions on it stay on record under the report's history.</li>
            <li>QA decides again on the new check.</li>
          </ul>
          <div>
            <label htmlFor="avs-redo-reason" className="block text-xs font-medium text-slate-600">Why is it being checked again? (required, saved with your name)</label>
            <textarea id="avs-redo-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={AVS_REMARK_MAX} autoFocus
              placeholder="e.g. corrected sheets after the plate change; board changed to 350 GSM; first photos were from WhatsApp"
              className="mt-1 min-h-[72px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-[#0071F0] focus:outline-none" />
          </div>
          <div>
            <label htmlFor="avs-redo-note" className="block text-xs font-medium text-slate-600">Note for the check (optional)</label>
            <input id="avs-redo-note" value={note} onChange={e => setNote(e.target.value)} maxLength={AVS_REMARK_MAX}
              placeholder="e.g. PO 01992 PDF forwarded to mppchd today"
              className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-[#0071F0] focus:outline-none" />
          </div>
        </div>
      )}
      {step === 'pick' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Which job are these photos of? Tick every job card they cover — the same product in several orders or batches, or a gang.</p>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <Search size={15} className="text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Job card, product or gang number"
              className="w-full bg-transparent text-sm outline-none" />
          </label>
          {cards?.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-slate-700">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-violet-600"
                  checked={allShownPicked} ref={el => { if (el) el.indeterminate = someShownPicked && !allShownPicked; }}
                  onChange={() => pickShown(!allShownPicked)} />
                {allShownPicked ? 'Deselect all shown' : `Select all shown (${cards.length})`}
              </label>
              <span className="flex items-center gap-2 text-slate-500">
                {picked.length} selected
                {picked.length > 0 && <button type="button" className="font-semibold text-violet-700 hover:underline" onClick={() => setPicked([])}>Clear</button>}
              </span>
            </div>
          )}
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {picked.map(c => (
                <button key={c.id} type="button" onClick={() => toggleCard(c)} title="Remove"
                  className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-violet-800 hover:bg-violet-200">
                  {c.jc_number} <XCircle size={11} />
                </button>
              ))}
            </div>
          )}
          {mixedProducts && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              These job cards are for different products ({[...new Set(picked.map(c => c.product_name || '—'))].join('; ')}).
              One set should show one product — unless they print together in a gang.
            </p>
          )}
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {cards === null && <div className="p-3 text-sm text-slate-400">Loading…</div>}
            {cards?.length === 0 && <div className="p-3 text-sm text-slate-500">No open job card matches.</div>}
            {cards?.map(c => {
              const on = picked.some(x => +x.id === +c.id);
              return (
                <label key={c.id}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ring-1 ${on ? 'bg-violet-50 ring-violet-300' : 'bg-white ring-slate-200 hover:bg-slate-50'}`}>
                  <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-slate-300 text-violet-600" checked={on}
                    onChange={() => toggleCard(c)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-xs font-semibold text-slate-700">{c.jc_number}</span>
                    {c.gang_number && <span className="ml-1 text-[11px] text-slate-500">({c.gang_number})</span>}
                    <span className="block truncate text-slate-800">{c.product_name || '—'}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
                    {['in_progress', 'partially_completed', 'hold'].includes(c.printing_status) && <span className="rounded-full bg-sky-50 px-1.5 py-0.5 font-semibold text-sky-700">Printing</span>}
                    {c.avs_mandatory && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 font-bold text-violet-700">AVS</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={noCard} onChange={e => { setNoCard(e.target.checked); if (e.target.checked) setPicked([]); }} />
            No job card (old stock, a sample, a customer return)
          </label>
          {noCard && (
            <input value={product} onChange={e => setProduct(e.target.value)} maxLength={200} placeholder="Product name as on the carton"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-[#0071F0] focus:outline-none" />
          )}
        </div>
      )}

      {step === 'photos' && (
        <div className="space-y-3">
          {set?.redo_report_no && (
            <div className="flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
              <History size={14} className="mt-0.5 shrink-0" />
              <span>Redo of <b>{set.redo_report_no}</b>. Reason: {set.redo_reason}</span>
            </div>
          )}
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-500">Job: </span>
            <span className="font-mono font-semibold">{jobList || 'no job card'}</span>
            <span className="text-slate-700"> · {set?.product_hint || picked[0]?.product_name || product}</span>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
            <li>One product at a time: a printed sheet, or one carton opened flat.</li>
            <li>Good light, no glare, the whole panel in the frame; 2 to 6 photos that together show every panel and flap with text.</li>
            <li>Include the flap with the artwork code, and a close-up of the small print (batch, MRP, barcode).</li>
          </ul>
          <div onDragOver={e => { e.preventDefault(); setDropOver(true); }} onDragLeave={() => setDropOver(false)} onDrop={onDropPhotos}
            className={`flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2 ${dropOver ? 'border-violet-400 bg-violet-50' : 'border-slate-300'}`}>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
              onChange={e => { add(e.target.files); e.target.value = ''; }} />
            <input ref={galleryRef} type="file" accept="image/*,.heic,.heif" multiple className="hidden"
              onChange={e => { add(e.target.files); e.target.value = ''; }} />
            <Button variant="secondary" repeatable onClick={() => cameraRef.current?.click()}>
              <span className="inline-flex items-center gap-1.5"><Camera size={15} /> Take photo</span>
            </Button>
            <Button variant="secondary" repeatable onClick={() => galleryRef.current?.click()}>
              <span className="inline-flex items-center gap-1.5"><ImagePlus size={15} /> Choose photos</span>
            </Button>
            <span className="text-[11px] text-slate-400">or drag photos here</span>
          </div>
          {earlier > 0 && (
            <div className="text-xs text-slate-500">
              {earlier} photo{earlier === 1 ? '' : 's'} added earlier:
              <ul className="mt-1 flex flex-wrap gap-1">
                {(set?.photos || []).filter(p => !items.some(i => +i.photoId === +p.id)).map(p => (
                  <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                    {p.file_name}
                    {set?.status === 'uploading' && (
                      <button type="button" title="Remove this photo" disabled={removing === p.id} onClick={() => removePhoto(p.id)}
                        className="text-red-600 hover:text-red-800 disabled:opacity-40"><Trash2 size={11} /></button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {items.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {items.map(x => (
                <div key={x.key} className="relative h-24 overflow-hidden rounded-lg bg-slate-100"
                  title={x.status === 'done' && x.stored === 'ci_plant'
                    ? `Saved in CI Plant. Claude files it in the AVS folder in Google Drive when it checks the set.${x.driveError ? ` (${x.driveError})` : ''}`
                    : undefined}>
                  <img src={x.preview} alt={x.name} className="h-full w-full object-cover" />
                  {x.status !== 'uploading' && (
                    <button type="button" onClick={() => removeItem(x)} disabled={!!x.photoId && removing === x.photoId} title="Remove this photo"
                      aria-label={`Remove ${x.name}`}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white hover:bg-red-600 disabled:opacity-40">
                      {x.photoId && removing === x.photoId ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                    </button>
                  )}
                  <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/55 py-0.5 text-[10px] font-semibold text-white">
                    {x.status === 'waiting' && 'Waiting'}
                    {x.status === 'uploading' && <><Loader2 size={11} className="animate-spin" /> Saving…</>}
                    {x.status === 'done' && <><CheckCircle2 size={11} /> {x.stored === 'ci_plant' ? 'Saved' : 'In Drive'}</>}
                    {x.status === 'failed' && <><XCircle size={11} /> Failed</>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-3 text-[11px] text-slate-600">
                <span>
                  {pending ? `Saving photo ${Math.min(handled + 1, items.length)} of ${items.length}…` : `${handled - refused} of ${items.length} saved`}
                  {refused ? <span className="text-red-600"> · {refused} failed</span> : null}
                </span>
                <span className="font-mono font-semibold tabular-nums">{batchPct}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar"
                aria-valuenow={batchPct} aria-valuemin={0} aria-valuemax={100} aria-label="Photos saved">
                <div className={`h-full rounded-full transition-[width] duration-500 ${refused ? 'bg-amber-500' : 'bg-violet-500'}`}
                  style={{ width: `${Math.max(batchPct, 2)}%` }} />
              </div>
            </div>
          )}
          {items.filter(x => x.status === 'failed').map(x => (
            <p key={`e${x.key}`} className="text-xs text-red-600">{x.name}: {x.error}</p>
          ))}
          <AvsDocs set={set} ensureSet={ensureSet} onChange={out => { setRef.current = out; setSet(out); }} />
          {!set && (
            <div>
              <label htmlFor="avs-set-note" className="block text-xs font-medium text-slate-600">Note for the check (optional)</label>
              <textarea id="avs-set-note" value={note} onChange={e => setNote(e.target.value)} maxLength={AVS_REMARK_MAX}
                placeholder="e.g. first sheets off Press No. 3 after the plate change"
                className="mt-1 min-h-[56px] w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-[#0071F0] focus:outline-none" />
            </div>
          )}
          <p className="text-[11px] text-slate-400">{savedText(saved, keptHere)} Press Verify when all are in.</p>
        </div>
      )}

      {step === 'sent' && (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold text-slate-800"><CheckCircle2 size={18} className="text-emerald-600" />
            {setLabel(result?.set?.id)} sent for checking ({result?.set?.photos?.length || 0} photos).</p>
          <p className="text-slate-600">{fireText(result?.fire)}</p>
          <p className="text-xs text-slate-500">Follow it under Photo sets in Artwork Verification.</p>
        </div>
      )}
    </Modal>
  );
}
