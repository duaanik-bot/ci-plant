// Upload photos for an AVS check, then Verify.
//
// 1. The job card (printing jobs first), or "no job card" with the product name.
// 2. Photos: taken with the camera or chosen. Each one goes on its own to
//    Google Drive (AVS CHECK/<date>/Set 0012 <job card>) when the Drive link is
//    set up; until then CI Plant keeps it, and Claude files it in the AVS folder
//    when it checks the set. A photo over 4 MB is shrunk first (Vercel's limit);
//    one under it goes as it is, with its camera data.
// 3. Verify: the set joins the queue and Claude is started. The report then
//    appears in Artwork Verification, where QA decides.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, ImagePlus, Loader2, ScanSearch, Search, Send, XCircle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Modal, useToast } from '../ui.jsx';
import { AVS_PHOTO_MAX_BYTES, AVS_REMARK_MAX, AVS_SET_MAX_PHOTOS, setLabel } from '../../lib/avs.js';

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
  joined: 'Claude is already checking other photos and will check these in the same run.',
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
export default function AvsUploadDialog({ open, onClose, jobCard = null, resume = null, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState('pick');
  const [card, setCard] = useState(null);
  const [noCard, setNoCard] = useState(false);
  const [product, setProduct] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [cards, setCards] = useState(null);
  const [set, setSet] = useState(null);
  const [items, setItems] = useState([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  // The upload queue is worked through outside React's render cycle.
  const form = useRef({});
  form.current = { card, noCard, product, note };
  const setRef = useRef(null);
  const queue = useRef([]);
  const files = useRef(new Map());
  const previews = useRef([]);
  const busy = useRef(false);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setCard(jobCard); setNoCard(false); setProduct(''); setNote(''); setQuery(''); setCards(null);
    setItems([]); setResult(null); setSending(false);
    setSet(resume); setRef.current = resume;
    queue.current = []; files.current = new Map();
    setStep(resume || jobCard ? 'photos' : 'pick');
    return () => { previews.current.forEach(u => URL.revokeObjectURL(u)); previews.current = []; };
  }, [open, jobCard, resume]);

  const loadCards = useCallback(text => api.get(`/avs/job-cards?q=${encodeURIComponent(text || '')}`)
    .then(setCards).catch(() => setCards([])), []);
  useEffect(() => {
    if (!open || step !== 'pick') return undefined;
    const t = setTimeout(() => loadCards(query), 250);
    return () => clearTimeout(t);
  }, [open, step, query, loadCards]);

  const mark = (key, patch) => setItems(list => list.map(x => (x.key === key ? { ...x, ...patch } : x)));

  // The set is made with the first photo, so an abandoned dialog leaves nothing.
  const ensureSet = async () => {
    if (setRef.current) return setRef.current;
    const f = form.current;
    const made = await api.post('/avs/uploads', {
      job_card_id: f.noCard ? undefined : f.card?.id,
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
          mark(key, { status: 'done', stored: out.last_photo?.stored, driveError: out.last_photo?.drive_error });
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

  return (
    <Modal open={open} onClose={close} layer="nested" title={
      <span className="inline-flex items-center gap-2"><ScanSearch size={18} className="text-violet-600" />
        {set ? `AVS photos · ${setLabel(set.id)}` : 'AVS photos'}</span>}
      footer={step === 'sent'
        ? <Button onClick={close}>Done</Button>
        : step === 'photos'
          ? <>
            <Button variant="secondary" repeatable onClick={close} disabled={pending}>{saved ? 'Later' : 'Cancel'}</Button>
            <Button onClick={verify} disabled={!saved || pending || sending}>
              <span className="inline-flex items-center gap-1.5"><Send size={15} /> Verify with Claude</span>
            </Button>
          </>
          : <>
            <Button variant="secondary" repeatable onClick={close}>Cancel</Button>
            <Button repeatable onClick={() => setStep('photos')} disabled={noCard ? product.trim().length < 3 : !card}>Next: photos</Button>
          </>}>
      {step === 'pick' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Which job are these photos of?</p>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <Search size={15} className="text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Job card, product or gang number"
              className="w-full bg-transparent text-sm outline-none" />
          </label>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {cards === null && <div className="p-3 text-sm text-slate-400">Loading…</div>}
            {cards?.length === 0 && <div className="p-3 text-sm text-slate-500">No open job card matches.</div>}
            {cards?.map(c => (
              <button key={c.id} type="button" onClick={() => { setCard(c); setNoCard(false); }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ring-1 ${card?.id === c.id ? 'bg-violet-50 ring-violet-300' : 'bg-white ring-slate-200 hover:bg-slate-50'}`}>
                <span className="min-w-0">
                  <span className="font-mono text-xs font-semibold text-slate-700">{c.jc_number}</span>
                  {c.gang_number && <span className="ml-1 text-[11px] text-slate-500">({c.gang_number})</span>}
                  <span className="block truncate text-slate-800">{c.product_name || '—'}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
                  {['in_progress', 'partially_completed', 'hold'].includes(c.printing_status) && <span className="rounded-full bg-sky-50 px-1.5 py-0.5 font-semibold text-sky-700">Printing</span>}
                  {c.avs_mandatory && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 font-bold text-violet-700">AVS</span>}
                </span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={noCard} onChange={e => { setNoCard(e.target.checked); if (e.target.checked) setCard(null); }} />
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
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-500">Job: </span>
            <span className="font-mono font-semibold">{set?.jc_number || card?.jc_number || 'no job card'}</span>
            <span className="text-slate-700"> · {set?.product_hint || card?.product_name || product}</span>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
            <li>One product at a time: a printed sheet, or one carton opened flat.</li>
            <li>Good light, no glare, the whole panel in the frame; 2 to 6 photos that together show every panel and flap with text.</li>
            <li>Include the flap with the artwork code, and a close-up of the small print (batch, MRP, barcode).</li>
          </ul>
          <div className="flex flex-wrap gap-2">
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
          </div>
          {earlier > 0 && <p className="text-xs text-slate-500">{earlier} photo{earlier === 1 ? '' : 's'} added earlier.</p>}
          {items.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {items.map(x => (
                <div key={x.key} className="relative h-24 overflow-hidden rounded-lg bg-slate-100"
                  title={x.status === 'done' && x.stored === 'ci_plant'
                    ? `Saved in CI Plant. Claude files it in the AVS folder in Google Drive when it checks the set.${x.driveError ? ` (${x.driveError})` : ''}`
                    : undefined}>
                  <img src={x.preview} alt={x.name} className="h-full w-full object-cover" />
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
