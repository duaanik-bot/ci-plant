// The whole mail trail of an artwork job, in its window (owner, 18 Nov 2026: "This whole mail, the whole trail, the
// thread, should all be visible so that we actually know what is going on"). Read live from mppchd's Gmail by the
// server (GET /artwork/register/:jobId/thread): every message, the client's and ours, oldest first, with its text and
// attachments. When Gmail cannot be read yet, it says what to do and shows the text the office AVS filed.
import { useEffect, useState } from 'react';
import { api, auth } from '../../api.js';
import { useToast } from '../../components/ui.jsx';
import { ChevronDown, ChevronRight, ExternalLink, Mail, Paperclip } from 'lucide-react';

const when = iso => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const size = n => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const nameOf = from => String(from || '').replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '') || from;

function Message({ m, onOpen }) {
  const [quoted, setQuoted] = useState(false);
  return (
    <div className={`rounded-xl border-l-4 bg-white p-2.5 text-[13px] ring-1 ring-inset ring-slate-200 ${m.ours ? 'border-l-[#0064D2]' : 'border-l-slate-300'}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-slate-900">{nameOf(m.from)}</span>
        {m.ours && <span className="rounded-full bg-[#0064D2]/10 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#0064D2]">ours</span>}
        <span className="text-[11px] text-slate-500">{when(m.at)}</span>
      </div>
      <div className="text-[11px] text-slate-500">
        {m.from && <span className="mr-2">From: {m.from}</span>}
        {m.to && <span className="mr-2">To: {m.to}</span>}
        {m.cc && <span>Cc: {m.cc}</span>}
      </div>
      {m.text
        ? <div className="mt-1.5 whitespace-pre-wrap break-words text-slate-800">{m.text}</div>
        : <div className="mt-1.5 text-[12px] italic text-slate-400">(no text — see the attachments)</div>}
      {m.cut && <div className="text-[11px] text-slate-500">Long mail — the rest is in Gmail.</div>}
      {m.quoted && (
        <div className="mt-1">
          <button type="button" className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-slate-500 hover:text-slate-700" onClick={() => setQuoted(q => !q)}>
            {quoted ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{quoted ? 'Hide the earlier mail' : 'Show the earlier mail'}
          </button>
          {quoted && <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-slate-200 pl-2 text-[12px] text-slate-500">{m.quoted}</div>}
        </div>
      )}
      {!!m.attachments?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {m.attachments.map(a => (
            <button key={a.attachment_id} type="button" onClick={() => onOpen(a)}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-[12px] font-semibold text-[#0064D2] ring-1 ring-inset ring-slate-200 hover:bg-slate-100">
              <Paperclip size={12} />{a.name}<span className="font-normal text-slate-500">{size(a.size)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ArtworkThread({ jobId, filed = [], gmailUrl }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let live = true;
    setData(null);
    api.get(`/artwork/register/${jobId}/thread`).then(d => { if (live) setData(d); }).catch(e => { if (live) setData({ available: false, why: e.message }); });
    return () => { live = false; };
  }, [jobId]);

  // An attachment: fetched with the login and shown from memory; the tab is opened on the click itself (popup rules).
  const openFile = async a => {
    const win = window.open('', '_blank');
    try {
      const res = await fetch(`/api/artwork/register/thread-attachment?${new URLSearchParams({ message: a.message_id, attachment: a.attachment_id, name: a.name })}`,
        { headers: { authorization: `Bearer ${auth.token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `It could not be opened (${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      if (/\.(pdf|jpe?g|png|gif|txt)$/i.test(a.name)) { if (win) win.location.href = url; else window.open(url, '_blank'); }
      else {
        win?.close();
        const link = document.createElement('a');
        link.href = url; link.download = a.name; document.body.appendChild(link); link.click(); link.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) { win?.close(); toast.error(e.message); }
  };

  const count = data?.available ? data.messages.length : filed.length;
  return (
    <div className="rounded-2xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex items-center gap-1 text-[13px] font-semibold text-slate-800" onClick={() => setOpen(o => !o)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Mail size={14} className="text-slate-500" />
          Mail thread{data ? ` · ${count} message${count === 1 ? '' : 's'}` : ''}
        </button>
        {data?.available && <span className="text-[11px] text-slate-500">read now from {data.mailbox}</span>}
        {gmailUrl && <a href={gmailUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-[#0064D2] hover:underline">Open in Gmail<ExternalLink size={11} /></a>}
      </div>
      {open && (
        <div className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
          {!data && <div className="text-[12px] text-slate-500">Reading the thread from Gmail…</div>}
          {data && !data.available && (
            <>
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-900 ring-1 ring-inset ring-amber-600/20">
                The whole thread cannot be read yet: {data.why} Below is what the office AVS filed from the client's mails.
              </div>
              {filed.map(m => (
                <Message key={m.id} onOpen={openFile}
                  m={{ id: m.id, from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email, at: m.received_at, subject: m.subject, text: m.body_text || m.summary || '', attachments: [] }} />
              ))}
              {!filed.length && <div className="text-[12px] text-slate-500">No mail filed yet.</div>}
            </>
          )}
          {data?.available && !data.messages.length && <div className="text-[12px] text-slate-500">No mail in this job's thread yet.</div>}
          {data?.available && data.messages.map(m => <Message key={m.id} m={m} onOpen={openFile} />)}
        </div>
      )}
    </div>
  );
}
