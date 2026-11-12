// The KLD of the costing's carton (owner, 12 Nov 2026: "you will create the KLD for the product and save it … in the
// cost sheet itself (which we will be sending to our team to work on the same KLD)"). It lives on the Size Library
// entry for the size + pasting + layout, so every costing of that layout shows the same drawing; a redraw is the
// next revision. Download gives the die maker's 1:1 PDF; Save to Drive puts it in dua.anik@gmail.com's Drive and
// shares it with mppchd@gmail.com (routes/sizing.js).
import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, FileText, PenLine, UploadCloud } from 'lucide-react';
import { api, auth } from '../../api.js';
import { useToast } from '../../components/ui.jsx';
import { kldBlank, kldSvg } from '../../lib/kld.js';
import { READING_LABEL, inferLayout } from '../../lib/sizing.js';
import { num } from '../../lib/costing.js';

const dateText = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function KldPanel({ value, size, entries = [], pending = null, onDrawn }) {
  const toast = useToast();
  const inputs = value.inputs || {};
  const style = value.style || null;
  const same = e => num(e.sheet_l) === num(inputs.sheet_l) && num(e.sheet_w) === num(inputs.sheet_w)
    && num(e.ups) === num(inputs.ups) && (e.style || null) === style;
  const entry = entries.find(same) || null;
  const [shown, setShown] = useState(null);          // { size_id, kld, title }
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let live = true;
    if (entry?.kld_rev) api.get(`/costing/sizes/${entry.id}/kld`).then(d => { if (live) setShown(d); }).catch(() => {});
    else setShown(null);
    return () => { live = false; };
  }, [entry?.id, entry?.kld_rev]);
  const supported = size?.kind === 'carton' && (style === 'SIDE' || style === 'LOCK') && num(inputs.ups) > 0 && num(inputs.sheet_l) > 0 && num(inputs.sheet_w) > 0;
  const proposal = pending && size && pending.sizeKey === size.key && pending.style === style && pending.option.ups === num(inputs.ups)
    && Math.min(pending.option.sheet.long, pending.option.sheet.short) === Math.min(num(inputs.sheet_l), num(inputs.sheet_w)) ? pending : null;
  const svg = useMemo(() => {
    const k = shown?.kld;
    if (!k) return '';
    return kldSvg(kldBlank({ construction: k.construction, tube: k.tube, face: k.face, w: k.w }), { title: `KLD ${shown.title || ''} · rev ${k.rev}` });
  }, [shown]);
  if (!supported && !shown) return null;

  const draw = async () => {
    const pick = proposal ? { reading: proposal.reading, option: proposal.option }
      : (() => { const x = inferLayout({ style, size, sheet_l: inputs.sheet_l, sheet_w: inputs.sheet_w, ups: inputs.ups }); return x && { reading: x.reading.key, option: x.option }; })();
    if (!pick) { toast.error('This sheet and ups do not fit the house rules — pick one of the proposals, or check the size and pasting.'); return; }
    setBusy('draw');
    try {
      const res = await api.put('/costing/sizing/kld', { size_text: value.size_text, style, ...pick });
      const got = await api.get(`/costing/sizes/${res.size_id}/kld`);
      setShown(got);
      toast.success(`KLD rev ${res.kld.rev} saved with this size in the Size Library`);
      onDrawn?.();
    } catch { /* the error is already shown */ } finally { setBusy(''); }
  };
  const download = async () => {
    setBusy('pdf');
    try {
      const res = await fetch(`/api/costing/sizes/${shown.size_id}/kld.pdf`, { headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {} });
      if (!res.ok) throw new Error('The PDF could not be made');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `KLD ${shown.size_key} ${shown.style || ''} rev ${shown.kld.rev}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const toDrive = async () => {
    setBusy('drive');
    try {
      const res = await api.post(`/costing/sizes/${shown.size_id}/kld/drive`);
      setShown(s => ({ ...s, kld: res.kld }));
      toast.success(`Saved to Drive${res.drive.shared_with ? ` and shared with ${res.drive.shared_with}` : ''}`);
    } catch { /* the error is already shown */ } finally { setBusy(''); }
  };

  const k = shown?.kld;
  const drive = Array.isArray(k?.drive) ? [...k.drive].reverse() : [];
  return (
    <div className="mt-3 rounded-xl bg-white/80 p-3 ring-1 ring-slate-200">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <FileText size={14} className="text-brand-600" />
        <b className="text-[#1D1D1F]">KLD</b>
        {k ? <span className="text-slate-500">rev {k.rev} · {READING_LABEL[k.reading] || k.construction} · drawn {dateText(k.drawn_at)} by {k.drawn_by}</span>
          : <span className="text-slate-500">not drawn yet for this layout</span>}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {supported && (
            <button type="button" onClick={draw} disabled={!!busy}
              className="flex items-center gap-1 rounded-lg bg-brand-600 px-2 py-1 font-bold text-white hover:bg-brand-700 disabled:opacity-50">
              <PenLine size={12} />{busy === 'draw' ? 'Drawing…' : k ? 'Redraw' : 'Make KLD'}</button>
          )}
          {k && (
            <>
              <button type="button" onClick={download} disabled={!!busy}
                className="flex items-center gap-1 rounded-lg bg-white px-2 py-1 font-bold text-brand-700 ring-1 ring-brand-300 hover:bg-brand-50 disabled:opacity-50">
                <Download size={12} />{busy === 'pdf' ? 'Making the PDF…' : 'Download PDF'}</button>
              <button type="button" onClick={toDrive} disabled={!!busy}
                className="flex items-center gap-1 rounded-lg bg-white px-2 py-1 font-bold text-brand-700 ring-1 ring-brand-300 hover:bg-brand-50 disabled:opacity-50">
                <UploadCloud size={12} />{busy === 'drive' ? 'Saving…' : 'Save to Drive & share'}</button>
            </>
          )}
        </span>
      </div>
      {svg && <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-100" dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;min-width:520px;height:auto" ') }} />}
      {drive.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-slate-600">
          {drive.map(d => (
            <li key={d.file_id} className={d.rev !== k.rev ? 'text-slate-400' : ''}>
              Rev {d.rev}{d.rev !== k.rev ? ' (an earlier drawing)' : ''} · saved {dateText(d.saved_at)} by {d.saved_by}
              {d.shared_with ? ` · shared with ${d.shared_with}` : ''} ·{' '}
              <a href={d.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-bold text-brand-600 hover:underline">Open in Drive<ExternalLink size={10} /></a>
            </li>
          ))}
        </ul>
      )}
      {!k && proposal && <p className="text-[11px] text-slate-500">Drawn from the proposal you picked: {proposal.option.sheet.short} × {proposal.option.sheet.long} in, {proposal.option.ups} up.</p>}
    </div>
  );
}
