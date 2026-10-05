// Documents with an AVS photo set (owner's request, 5 Oct 2026): the PO, the
// customer's approval, the artwork, an e-mail (file or link) or anything else
// that helps the check. Added with a button or dropped on the box; removed with
// the bin (for good) until a finished check has used them. Claude reads them
// first and still cross-checks them (runbook 2.4c).
//
// Used in the upload dialog (before Verify; the set is made with the first
// photo or document) and under each set in the list (also after the report:
// those wait for "Re-check with new documents").
import { useRef, useState } from 'react';
import { FileText, Link2, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { api } from '../../api.js';
import { Button, useToast } from '../ui.jsx';
import { AVS_DOC_ACCEPT, AVS_DOC_KINDS, docKindLabel, docMime, docProblem, docRemovable, istStamp } from '../../lib/avs.js';

const sizeText = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

// set: the photo set (may be null in the dialog until ensureSet makes it).
// ensureSet: () => Promise<set> (dialog only). onChange(set): the set as the server now has it.
export default function AvsDocs({ set, ensureSet = null, onChange, editable = true, compact = false }) {
  const toast = useToast();
  const [kind, setKind] = useState('po');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [busy, setBusy] = useState(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const docs = set?.docs || [];

  const target = async () => set || (ensureSet ? ensureSet() : null);

  const addFiles = async list => {
    const files = [...(list || [])];
    for (const file of files) {
      const problem = docProblem({ kind, title, size: file.size, type: docMime(file.name, file.type) });
      if (problem) { toast.error(`${file.name}: ${problem}`); continue; }
      setBusy(`file:${file.name}`);
      try {
        const s = await target();
        if (!s) return;
        const out = await api.upload(`/avs/uploads/${s.id}/docs`, file, { kind, title: title.trim() || undefined });
        onChange?.(out);
        if (out.last_doc?.drive_error) toast.info(`${file.name} is kept in CI Plant; Claude reads it from there. (${out.last_doc.drive_error})`);
      } catch { /* api.js said why */ } finally { setBusy(null); }
    }
    setTitle('');
  };

  const addLink = async () => {
    const problem = docProblem({ kind, url: url.trim(), title });
    if (problem) { toast.error(problem); return; }
    setBusy('link');
    try {
      const s = await target();
      if (!s) return;
      const out = await api.post(`/avs/uploads/${s.id}/docs`, { kind, url: url.trim(), title: title.trim() || undefined });
      onChange?.(out);
      setUrl(''); setTitle(''); setShowLink(false);
    } catch { /* api.js said why */ } finally { setBusy(null); }
  };

  const remove = async d => {
    if (!set) return;
    const what = d.title || d.file_name || d.url;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove "${what}" for good? It cannot be brought back.`)) return;
    setBusy(`del:${d.id}`);
    try {
      const out = await api.post(`/avs/uploads/${set.id}/docs/${d.id}/delete`, {});
      onChange?.(out);
    } catch { /* api.js said why */ } finally { setBusy(null); }
  };

  const onDrop = e => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    if (!editable) return;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    else if (/^https?:\/\//i.test(String(text || '').trim())) { setUrl(String(text).trim().split('\n')[0]); setShowLink(true); }
  };

  return (
    <div className={compact ? 'mt-1.5' : 'space-y-2'}>
      {!compact && (
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <Paperclip size={13} /> Documents for the check <span className="font-normal text-slate-400">(PO, approval, artwork, e-mail — optional)</span>
        </div>
      )}
      {docs.length > 0 && (
        <ul className="space-y-1">
          {docs.map(d => (
            <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs ring-1 ring-slate-200">
              <span className="flex min-w-0 items-center gap-2">
                {d.url ? <Link2 size={13} className="shrink-0 text-sky-600" /> : <FileText size={13} className="shrink-0 text-slate-500" />}
                <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{docKindLabel(d.kind)}</span>
                {(d.url || d.drive_url)
                  ? <a href={d.url || d.drive_url} target="_blank" rel="noreferrer" className="truncate text-sky-700 hover:underline">{d.title || d.file_name || d.url}</a>
                  : <span className="truncate text-slate-800">{d.title || d.file_name}</span>}
                <span className="shrink-0 text-[10px] text-slate-400">
                  {d.size_bytes ? `${sizeText(d.size_bytes)} · ` : ''}{d.added_by || ''}{d.added_at ? ` · ${istStamp(d.added_at)}` : ''}
                  {d.added_after_report && !d.used_in_report ? ' · after the report' : ''}
                  {d.used_in_report ? ` · read in ${d.used_in_report}${d.used_in_check > 1 ? ` Check ${d.used_in_check}` : ''}` : ''}
                  {d.stored === 'ci_plant' ? ' · kept in CI Plant' : ''}
                </span>
              </span>
              {editable && docRemovable(d) && (
                <button type="button" onClick={() => remove(d)} disabled={busy === `del:${d.id}`} title="Remove for good"
                  className="shrink-0 rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-40">
                  {busy === `del:${d.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
          className={`rounded-lg border border-dashed px-2.5 py-2 ${over ? 'border-violet-400 bg-violet-50' : 'border-slate-300 bg-slate-50/60'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <select value={kind} onChange={e => setKind(e.target.value)} aria-label="What the document is"
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs">
              {AVS_DOC_KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="Title (optional), e.g. PO 00538"
              className="h-8 min-w-[10rem] flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs" />
            <input ref={fileRef} type="file" accept={AVS_DOC_ACCEPT} multiple className="hidden"
              onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            <Button size="sm" variant="secondary" repeatable disabled={!!busy} onClick={() => fileRef.current?.click()}>
              <span className="inline-flex items-center gap-1">{busy?.startsWith('file:') ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Add file</span>
            </Button>
            <Button size="sm" variant="secondary" repeatable disabled={!!busy} onClick={() => setShowLink(v => !v)}>
              <span className="inline-flex items-center gap-1"><Link2 size={12} /> Add e-mail / link</span>
            </Button>
          </div>
          {showLink && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://mail.google.com/… or a Drive link"
                className="h-8 min-w-[14rem] flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs" autoFocus />
              <Button size="sm" repeatable disabled={busy === 'link' || !url.trim()} onClick={addLink}>Add</Button>
            </div>
          )}
          <p className="mt-1 text-[10px] text-slate-400">Drop files or a link here. PDF, photo, Excel, Word, e-mail (.eml/.msg) or text, up to 4 MB each.</p>
        </div>
      )}
    </div>
  );
}
