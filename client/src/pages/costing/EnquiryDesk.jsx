// Costing → Enquiry desk: customer enquiries from the mailbox, through costing and a person's final price,
// to a quotation answered in the customer's own thread (docs/superpowers/specs/2026-11-03-enquiry-desk-design.md).
//
//   Pending · Sent · All — and, to the side, Orders · Dropped · Settings (admin)
//
// One list (owner, 21 Nov 2026: "consolidation required — enquiries land in one, being costed there itself, there only we
// get the counters"): a row stays in Pending while it is costed, priced, approved and countered, and its STATUS BAND says
// where it stands — Pending · Sent · Mailed · Counter · Finalised. The buttons under a ticked row are the ones its own
// stage allows, so nothing hops tabs. "Send back" moves a row one step back, keeping its costing and
// prices; every move can be undone from the bar above the table (owner, 5 Nov 2026). Costing happens here,
// in place: "Cost it" opens the enquiry and its costing on this screen, one at a time with Previous / Next,
// or several together in one bulk costing — nothing moves until a costing is saved for it.
//
// "Fetch enquiries from mail" asks the enquiry desk robot (Claude, with the mailbox's own Gmail) to read new
// mail and file the enquiries here. A reply is only ever saved as a Gmail draft — CI Plant never sends; the
// person sends it from Gmail. With the mailbox's Gmail connected (Settings › Connect Gmail, 11 Nov 2026) CI Plant's
// server saves that draft itself the moment Send quotation is pressed — no robot for drafts. Finalise and Mark as sent need the Management right.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Check, Copy, ExternalLink, Inbox, Layers, Lock, LockOpen, Mail, PackageCheck, Plus, RefreshCw, RotateCcw, Send, Settings, Trash2, X } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Checkbox, DataTable, Field, Input, Modal, Select, SelectionDock, SubTabs, Textarea, useToast } from '../../components/ui.jsx';
import {
  BANDS, COST_STAGES, DESK_STAGES, DESK_TABS, PILL_TONE, PRICE_STAGES, QUOTE_LABEL, QUOTE_TONE, STAGE_BACKWARD, adjustPrice, bandOf, rowsOfTab, approveSummary, approveTone, autoCostLines, autoCostTone, autoPill, dateText, fetchQueuedText, fetchWaitText, heldLine, mailboxNote, mailboxTag,
  moveSummary, moveTone, quantitiesText, replyLine, qtyText, rupees, startsFresh, whereText,
} from '../../lib/enquiryUi.js';
import COMPANY_ROUTINE_PROMPT from '../../lib/enquiry-robot/company-routine-prompt.md?raw';
import EnquiryDetail from './EnquiryDetail.jsx';
import QuotationPanel from './QuotationPanel.jsx';
import DeskCosting from './DeskCosting.jsx';
import { quoteAndDraft, sendSummary } from '../../lib/quoteFlow.js';
import CounterPanel from './CounterPanel.jsx';
import OrderPanel, { OrdersList } from './OrderPanel.jsx';
import { canOrder } from '../../lib/orderUi.js';

// A row the customer can decide on: its quotation has gone out (band Sent, Mailed or Counter) and it can go on an order.
const orderable = e => canOrder(e) && ['sent', 'mailed', 'counter'].includes(bandOf(e));
import { NEW_ENQUIRY_ROW } from '../../components/EnquiryBadge.jsx';

const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const nos = list => list.map(m => m.enquiry_no).join(', ');

function MailboxBadge({ box }) {
  const tag = mailboxTag(box);
  if (!box) return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tag.tone}`}>{tag.text}</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${tag.tone}`} title={tag.title}>
      <Mail size={13} />{tag.text}
      {box.gmail ? (box.gmail.last_error ? ' · Gmail needs connecting again' : ' · drafts saved by CI Plant') : ''}
    </span>
  );
}

// The desk's mailbox addresses, for the Fetch buttons' tips.
const mailboxEmail = (desk, key) => (desk?.mailboxes || []).find(b => b.key === key)?.email || '';

// New enquiries stand out as new POs do (14 Nov 2026): "New" until someone starts on it; "Asked again" when the
// customer has asked for the same item again since it came in (no new row is made for that).
function NewTags({ e }) {
  return (
    <>
      {e.status === 'new' && (
        <span title="Not started yet — cost it, or send it to Costing"
          className="inline-flex items-center gap-1 rounded-full bg-orange-500 px-2 py-px text-[10px] font-bold text-white">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/80" />New
        </span>
      )}
      {e.asked_again_count > 0 && (
        <span title={`The customer asked for this again${e.asked_again_at ? ` (last ${dateText(e.asked_again_at)})` : ''} — no new row was made`}
          className="rounded-full bg-amber-100 px-2 py-px text-[10px] font-bold text-amber-900 ring-1 ring-inset ring-amber-300">
          Asked again{e.asked_again_count > 1 ? ` ×${e.asked_again_count}` : ''}
        </span>
      )}
    </>
  );
}

// Who has a fetch in hand: the office AVS takes it as "AVS (office)", a cloud routine as "Claude (cloud)".
const readerOf = (job, start = 'the') => (job.claimed_by === 'AVS (office)' ? `${start} office computer` : job.claimed_by || 'Claude');

// The last fetch, in words: who reads it and when (fetchWaitText; `cloud` = the desk's { trial, business } links).
function JobLine({ job, cloud }) {
  if (!job) return <span className="text-xs text-slate-500">No fetch yet.</span>;
  const r = job.result || {};
  const text = {
    queued: fetchWaitText(job, cloud),
    working: `${readerOf(job, 'The')} is reading the mailbox…`,
    done: `Done ${dateText(job.finished_at)}${r.filed != null ? ` — ${plural(r.filed, 'mail')} filed${r.skipped ? `, ${r.skipped} filed before` : ''}` : ''}.`,
    failed: `Failed: ${job.error}`,
    cancelled: 'Cancelled.',
  }[job.status];
  return (
    <span className={`text-xs ${job.status === 'failed' || job.fire_status === 'cloud_failed' ? 'text-red-700' : 'text-slate-600'}`}>
      Last fetch (job {job.id}, {job.mailbox_email}{job.queued_by_name ? `, by ${job.queued_by_name}` : ''}): {text}
      {job.session_url && ['queued', 'working'].includes(job.status) && (
        <a href={job.session_url} target="_blank" rel="noreferrer" className="ml-1 font-bold text-brand-600 hover:underline">Watch the run</a>
      )}
    </span>
  );
}

// What was just done, with Undo (and, once undone, Redo). It stays until the next action or ✕.
// One mail is one bucket of products (owner, 11 Nov 2026): every row carries its mail's tag — the same colour
// for the same mail — and "3 of 13", so nothing in a mail is missed.
const MAIL_TONES = ['bg-sky-100 text-sky-800 ring-sky-200', 'bg-violet-100 text-violet-800 ring-violet-200', 'bg-amber-100 text-amber-800 ring-amber-200',
  'bg-emerald-100 text-emerald-800 ring-emerald-200', 'bg-rose-100 text-rose-800 ring-rose-200', 'bg-teal-100 text-teal-800 ring-teal-200'];
export const mailTone = id => MAIL_TONES[(Number(id) || 0) % MAIL_TONES.length];
// Clicking the tag ticks every product of that mail (owner, 11 Nov 2026: "select the whole batch at once").
function MailTag({ e, onPickMail }) {
  if (!e.mail_id) return <span className="text-[11px] text-slate-400">typed in</span>;
  return (
    <button type="button" onClick={ev => { ev.stopPropagation(); onPickMail?.(e.mail_id); }}
      title={`Tick every product of this mail — ${[e.mail_subject && `“${e.mail_subject}”`, e.mail_from_name || e.mail_from_email, dateText(e.mail_received_at)].filter(Boolean).join(' · ')}`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 hover:brightness-95 ${mailTone(e.mail_id)}`}>
      <Mail size={11} />M{e.mail_id} · {e.mail_pos} of {e.mail_items}
    </button>
  );
}

// The mails on this tab, newest first: each a chip that ticks (or unticks) all its products here.
export function mailBuckets(rows = []) {
  const by = new Map();
  for (const e of rows) {
    if (!e.mail_id) continue;
    const b = by.get(e.mail_id) || { mail_id: e.mail_id, ids: [], of: e.mail_items, customer: e.customer_name || e.contact_email || '',
      subject: e.mail_subject || '', received: e.mail_received_at || e.created_at };
    b.ids.push(e.id);
    by.set(e.mail_id, b);
  }
  return [...by.values()].sort((a, b) => String(b.received).localeCompare(String(a.received)) || b.mail_id - a.mail_id);
}
function MailChips({ buckets, picked, onToggle, onClear }) {
  if (!buckets.length) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Tick a whole mail</span>
      {buckets.map(b => {
        const n = b.ids.filter(id => picked.includes(id)).length;
        const all = n === b.ids.length;
        return (
          <button key={b.mail_id} type="button" onClick={() => onToggle(b)} title={`${b.subject ? `“${b.subject}” · ` : ''}${dateText(b.received)} — ${all ? 'untick' : 'tick'} all ${b.ids.length} here`}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ring-1 transition ${all ? 'bg-brand-600 text-white ring-brand-600' : mailTone(b.mail_id)}`}>
            <Mail size={12} />M{b.mail_id}
            <span className="max-w-[14rem] truncate font-semibold">{b.customer}</span>
            <span className={`rounded-full px-1.5 text-[10px] ${all ? 'bg-white/25' : 'bg-white/70'}`}>{n ? `${n}/` : ''}{b.ids.length}{b.ids.length < b.of ? ` of ${b.of}` : ''}</span>
          </button>
        );
      })}
      {picked.length > 0 && <button type="button" onClick={onClear} className="text-xs font-semibold text-slate-500 hover:underline">Clear ticks</button>}
    </div>
  );
}
// The mails a ticked set leaves products out of: [{ mail_id, picked, of }].
export function mailGaps(pickedRows) {
  const by = new Map();
  for (const e of pickedRows) if (e.mail_id) by.set(e.mail_id, { mail_id: e.mail_id, picked: (by.get(e.mail_id)?.picked || 0) + 1, of: e.mail_items });
  return [...by.values()].filter(g => g.picked < g.of);
}

// Under a row's costing: a priced row — whether it waits for approval, the costing's remarks, what its mail's reply waits
// on; a row still to be costed — why CI Plant could not cost it by itself.
function AutoNotes({ e }) {
  const priced = PRICE_STAGES.includes(e.stage);
  const pill = priced ? autoPill(e) : null;
  const line = priced ? replyLine(e) : null;
  const held = COST_STAGES.includes(e.stage) ? heldLine(e) : null;
  if (!pill && !line && !held && !(priced && e.costing_remarks)) return null;
  return (
    <div className="max-w-[16rem] space-y-1">
      {pill && <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${PILL_TONE[pill.tone]}`}>{pill.text}</span>}
      {priced && e.costing_remarks && <div className="truncate text-[11px] text-slate-500" title={e.costing_remarks}>{e.costing_remarks}</div>}
      {line && <div className="text-[11px] font-semibold text-sky-800">{line}</div>}
      {held && <div className="text-[11px] font-semibold text-amber-800">{held}</div>}
    </div>
  );
}

// The status band (21 Nov 2026): where a row stands — Pending · Sent · Mailed · Counter · Finalised — as a coloured pill
// over five steps, and under it the finer word (Costing in progress, the quotation's number, the order's number).
function StatusBand({ e, statuses }) {
  const band = bandOf(e);
  const at = BANDS.findIndex(b => b.key === band);
  const b = BANDS[at];
  const fine = band === 'finalised' ? e.order_no : ['sent', 'mailed'].includes(band) ? e.quotation_no : statuses?.[e.stage];
  if (!b) return <span className="whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{statuses?.[e.stage] || e.stage}</span>;
  return (
    <div className="w-28 space-y-1" title={BANDS.map(x => x.label).join(' → ')}>
      <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${b.on}`}>{b.label}</span>
      <div className="flex gap-0.5">
        {BANDS.map((x, i) => <span key={x.key} className={`h-1.5 flex-1 rounded-full ${i <= at ? b.on.split(' ')[0] : 'bg-slate-200'}`} />)}
      </div>
      {fine && <div className="truncate text-[10px] text-slate-500">{fine}</div>}
    </div>
  );
}

function UndoBar({ last, onUndo, onClose }) {
  if (!last) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-[#1D1D1F]/90 px-3 py-2 text-sm text-white shadow-lg" role="status">
      <RotateCcw size={14} className="shrink-0 text-sky-300" />
      <span className="min-w-0 flex-1">{last.text}</span>
      {(last.undo || last.quotations || last.run) && (
        <button type="button" onClick={onUndo} className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold text-sky-200 hover:bg-white/25">
          {last.redo ? 'Redo' : 'Undo'}
        </button>
      )}
      <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1 text-white/70 hover:bg-white/15 hover:text-white"><X size={14} /></button>
    </div>
  );
}

export default function EnquiryDesk({ boot, customers = [], focus = null }) {
  const toast = useToast();
  const [desk, setDesk] = useState(null);
  // Pending · Sent · All (21 Nov 2026); Orders, Dropped and Settings to the side.
  const [tab, setTab] = useState('pending');
  const [deleting, setDeleting] = useState(null);   // Delete: { ids, reason }
  const [rows, setRows] = useState(null);
  const [quotes, setQuotes] = useState([]);
  // Order finalised (13 Nov 2026): the rows in the panel, and a nudge for the Orders list to load again
  const [ordering, setOrdering] = useState(null);
  const [ordersSignal, setOrdersSignal] = useState(0);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState([]);
  const [open, setOpen] = useState(null);         // enquiry id or 'new'
  const [openQuote, setOpenQuote] = useState(null);
  const [prices, setPrices] = useState({});       // `${id}|${qty}` → the box's text
  const [unlocked, setUnlocked] = useState(() => new Set());   // locked rows opened again to change the price
  // Boxes the person typed in (or adjusted) keep their text; every other box follows the latest proposal —
  // a row costed in place arrives with its proposal, not the blank it had before it was costed.
  const typed = useRef(new Set());
  const [adjust, setAdjust] = useState({ mode: 'add', amount: '' });
  const [work, setWork] = useState(null);         // costing in place: { mode: 'one', ids, at } | { mode: 'together', ids, batchId }
  const [last, setLast] = useState(null);         // the undo bar
  const [seen, setSeen] = useState(0);            // the costing in place reads its enquiry again
  const poll = useRef(null);

  const loadDesk = useCallback(() => api.get('/costing/enquiry-desk').then(setDesk), []);
  // Every tab reads the one list (every live stage and Dropped); a tab is a filter of it, so the counts are always right.
  const stages = ['pending', 'sent', 'all', 'dropped'].includes(tab) ? DESK_TABS.find(t => t.key === tab) : null;
  const loadRows = useCallback(() => {
    return api.get(`/costing/enquiries?stage=${[...DESK_STAGES, 'dropped'].join(',')}`).then(rs => {
      setRows(rs);
      setPrices(cur => {
        const next = { ...cur };
        for (const e of rs) for (const p of e.prices || []) {
          const k = `${e.id}|${p.qty}`;
          if (!typed.current.has(k)) next[k] = p.final != null ? String(p.final) : p.suggested != null ? String(p.suggested) : '';
        }
        return next;
      });
    });
  }, []);
  const loadQuotes = useCallback(() => {
    if (tab === 'sent') return api.get('/costing/quotations?status=ready,queued,drafted,sent').then(setQuotes);
    return Promise.resolve();
  }, [tab]);
  const reload = useCallback(() => {
    setSeen(n => n + 1);
    return Promise.all([loadDesk(), loadRows(), loadQuotes()]).catch(() => {});
  }, [loadDesk, loadRows, loadQuotes]);

  useEffect(() => { loadDesk().catch(() => {}); }, [loadDesk]);
  // Back from Google's Gmail page (routes/gmail-link.js): say how it went, open Settings, tidy the address.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const g = p.get('gmail');
    if (!g) return;
    // named by role, never "Trial" (owner, 13 Nov 2026)
    const box = p.get('mb') === 'business' ? 'Business' : 'Desk';
    const said = {
      connected: [toast.success, `${box} mailbox: Gmail connected — CI Plant now saves quotation drafts itself`],
      denied: [toast.info, 'Gmail was not connected — Google\'s page was closed or refused'],
      wrong: [toast.error, `That Google account (${p.get('as') || '?'}) is not the ${box} mailbox's address — sign in to Google as the mailbox and connect again`],
      refused: [toast.error, 'Only an admin connects Gmail'],
      expired: [toast.error, 'The Connect Gmail link had expired — press Connect Gmail again'],
      failed: [toast.error, `Gmail was not connected: ${p.get('why') || 'Google refused'}`],
    }[g] || [toast.info, `Gmail: ${g}`];
    said[0](said[1]);
    setTab('settings');
    window.history.replaceState(null, '', '/costing?tab=enquiries');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadRows().catch(() => setRows([])); }, [loadRows]);
  useEffect(() => { setPicked([]); loadQuotes().catch(() => {}); }, [tab, loadQuotes]);
  // Opened from a costing (Saved costings → its enquiry): that enquiry's card.
  useEffect(() => { if (focus) setOpen(Number(focus)); }, [focus]);

  // While a fetch is with Claude, look again every few seconds.
  const lastFetch = desk?.jobs?.find(j => j.kind === 'fetch');
  useEffect(() => {
    clearInterval(poll.current);
    if (!lastFetch || !['queued', 'working'].includes(lastFetch.status)) return undefined;
    poll.current = setInterval(() => { reload(); }, 6000);
    return () => clearInterval(poll.current);
  }, [lastFetch?.id, lastFetch?.status, reload]);

  // Fetch from mail = the company mailbox (its cloud routine when linked, else the office computer's next AVS run);
  // Fetch from dua.anik = the trial mailbox (the Mac).
  const fetchMail = async mailbox => {
    const r = await api.post('/costing/enquiry-desk/fetch', { mailbox });
    const c = r.cloud;
    const j = r.job;
    if (c?.ok) toast.success(`Fetch started (job ${j.id}) — Claude is reading the mailbox in the cloud; the enquiries land here in a few minutes`);
    else if (c && c.status !== 'not_linked') toast.error(`Job ${j.id} is queued, but Claude in the cloud did not start: ${c.error}`);
    else if (r.already) toast.success(`Job ${j.id}: ${j.status === 'working' ? `${readerOf(j, 'The')} is reading the mailbox` : fetchWaitText(j, desk?.cloud)}`);
    else toast.success(fetchQueuedText(mailbox, j.id));
    await loadDesk();
  };

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    const inTab = rowsOfTab(tab, rows);
    if (!s) return inTab;
    return inTab.filter(e => [e.enquiry_no, e.customer_name, e.product_name, e.size_text, e.contact_email, e.mail_subject, e.quotation_no, e.costing_no]
      .some(x => String(x || '').toLowerCase().includes(s)));
  }, [rows, search, tab]);
  const pickedRows = shown.filter(e => picked.includes(e.id));
  const toggle = (r, on) => setPicked(p => (on ? [...new Set([...p, r.id])] : p.filter(x => x !== r.id)));
  const toggleAll = (rs, on) => setPicked(on ? rs.map(r => r.id) : []);
  // A whole mail at once: ticks all its rows on this tab, or unticks them when all are ticked already.
  const buckets = useMemo(() => mailBuckets(shown), [shown]);
  const toggleMail = b => setPicked(p => (b.ids.every(id => p.includes(id)) ? p.filter(id => !b.ids.includes(id)) : [...new Set([...p, ...b.ids])]));
  const pickMail = mailId => { const b = buckets.find(x => x.mail_id === mailId); if (b) toggleMail(b); };

  // A move's answer: { moved, skipped, undo } — and after a Management drop or delete, what the mail's reply did (replies,
  // later, waiting), which the server makes once the mail has nothing left waiting (final review I5). What moved and the
  // reply's lines go on the bar, with Undo when the server gave one; the reply's lines also in a toast, in Approve's tone;
  // what could not move, in a note.
  const after = async (promise, say) => {
    const r = await promise;
    const moved = r?.moved || [];
    if (r?.skipped?.length) toast.info(`Not moved: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
    const lines = moveSummary(r, moved.length ? say(moved) : null);
    const tone = moveTone(r);
    if (tone) toast[tone](lines.join(' · '));
    if (lines.length) setLast({ text: lines.join(' · '), undo: r?.undo || null });
    setPicked([]);
    await reload();
    return r;
  };
  const move = (path, say, body = {}) => after(api.post(`/costing/enquiries/${path}`, { ids: picked, ...body }), say);

  const undo = async () => {
    // A counter action brings its own way back (CounterPanel: fill, their prices, lock, revised quotation).
    if (last.run) {
      const said = await last.run();
      setLast(said ? { text: said } : null);
      await reload();
      return;
    }
    if (last.quotations) {
      // A revised quotation goes back to the one it replaced (rows back on Counter); a first one is cancelled.
      for (const q of last.quotations) await api.post(`/costing/quotations/${q.id}/${q.revision > 0 ? 'unrevise' : 'cancel'}`, {});
      setLast({ text: `${last.quotations.map(q => q.quotation_no).join(', ')} cancelled — the enquiries are back in Quotations, ready to quote again.` });
      await reload();
      return;
    }
    const r = await api.post('/costing/enquiries/undo', { group: last.undo });
    if (r.skipped?.length) toast.info(`Not undone: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
    setLast(r.moved.length ? { text: `${last.redo ? 'Redone' : 'Undone'}: ${nos(r.moved)}.`, undo: r.undo, redo: !last.redo } : null);
    await reload();
  };
  // Saved in place: the costing went onto its enquiry (or a bulk costing onto several).
  const costingMoved = ({ kind, costing, batch, enquiry }) => {
    if (kind === 'costing' && costing?.desk) {
      const stage = costing.complete ? 'costed' : 'costing';
      setLast({ text: `${costing.costing_no} saved for ${costing.desk.enquiry_no} — it is now ${(desk?.statuses?.[stage] || whereText(stage)).toLowerCase()}.`, undo: costing.desk.group });
    } else if (kind === 'costing' && costing) {
      setLast({ text: `${costing.costing_no} saved${enquiry ? ` for ${enquiry.enquiry_no}` : ''}.` });
    } else if (kind === 'batch' && batch) {
      setLast({ text: `${batch.batch_no} saved${batch.desk ? ` — ${plural(batch.desk.moved, 'enquiry')} moved on (complete rows wait for their price)` : ''}.`, undo: batch.desk?.group || null });
    }
    reload();
  };

  const startOne = (ids, at = 0) => { setOpen(null); setWork({ mode: 'one', ids, at }); };
  const startTogether = list => {
    setOpen(null);
    // All already costed in one bulk costing: open it; else a new bulk costing of them.
    const batches = [...new Set(list.map(e => (e.costing_live ? e.costing_batch_id : null)))];
    const shared = batches.length === 1 && batches[0] ? batches[0] : null;
    setWork({ mode: 'together', ids: list.map(e => e.id), batchId: shared });
  };
  const costRow = e => startOne(shown.map(x => x.id), Math.max(shown.findIndex(x => x.id === e.id), 0));

  const counts = desk?.counts || {};
  // Pending and Sent count their rows; All carries no count.
  const views = DESK_TABS.filter(t => !t.side).map(t => ({ key: t.key, label: t.label, count: (t.key !== 'all' && rows && rowsOfTab(t.key, rows).length) || null }));
  const stageName = st => desk?.statuses?.[st] || whereText(st);

  const costButton = e => (
    <button type="button" onClick={ev => { ev.stopPropagation(); costRow(e); }}
      className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100">
      <Calculator size={12} />{e.costing_live ? 'Open costing' : 'Cost it'}
    </button>
  );
  const baseCols = [
    { key: 'enquiry_no', label: 'No.', sortValue: e => `${String(e.mail_id || 0).padStart(6, '0')}|${String(e.mail_pos || 0).padStart(3, '0')}`,
      render: e => (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5"><span className="font-bold text-brand-600">{e.enquiry_no}</span><NewTags e={e} /></div>
          <MailTag e={e} onPickMail={pickMail} />
        </div>
      ) },
    // Newest first, and the products of one mail together in the mail's own order.
    { key: 'received', label: 'Received', sortValue: e => `${new Date(e.mail_received_at || e.created_at).toISOString()}|${String(e.mail_id || 0).padStart(8, '0')}|${String(1000 - (e.mail_pos || 0)).padStart(4, '0')}`,
      render: e => dateText(e.mail_received_at || e.created_at) },
    { key: 'customer_name', label: 'Customer', render: e => <div><div className="font-semibold">{e.customer_name || '—'}</div><div className="text-[11px] text-slate-500">{e.contact_email || ''}</div><MailboxNote e={e} desk={desk} /></div> },
    { key: 'product_name', label: 'Product', render: e => <div><div className="font-semibold">{e.product_name || '—'}</div><div className="text-[11px] text-slate-500">{[e.size_text && `${e.size_text} mm`, e.mail_subject && `“${e.mail_subject}”`].filter(Boolean).join(' · ')}</div></div> },
    { key: 'quantities', label: 'Quantities', render: e => quantitiesText(e.quantities) },
    { key: 'band', label: 'Status', sortValue: e => `${BANDS.findIndex(b => b.key === bandOf(e)) + 1}|${e.stage}`, render: e => <StatusBand e={e} statuses={desk?.statuses} /> },
  ];
  const costingCol = {
    key: 'costing_no', label: 'Costing', sortValue: e => e.costing_no || '', render: e => (
      <div className="space-y-1">
        {e.costing_no ? (
          <div className="text-xs">
            <span className={`font-bold ${e.costing_live ? 'text-[#1D1D1F]' : 'text-slate-400 line-through'}`}>{e.costing_no}</span>
            <span className="ml-1 text-slate-500">{e.costing_hidden ? 'hidden' : e.costing_complete ? (e.costing_status === 'approved' ? 'approved' : 'complete') : 'not finished'}</span>
            {e.batch_no && e.costing_live && <div className="text-[10px] text-slate-500">bulk {e.batch_no}</div>}
          </div>
        ) : <div className="text-xs text-slate-400">none yet</div>}
        <AutoNotes e={e} />
        {[...COST_STAGES, ...PRICE_STAGES].includes(e.stage) && costButton(e)}
      </div>
    ),
  };

  // Locked = every quantity has a saved final price, the boxes show it, and nobody opened it again.
  const isLocked = e => (e.prices || []).length > 0 && !unlocked.has(e.id)
    && (e.prices || []).every(p => p.final != null && String(p.final) === String(prices[`${e.id}|${p.qty}`]) && !p.changed);
  const lockRow = async e => {
    await savePrices([e]);
    setUnlocked(u => { const n = new Set(u); n.delete(e.id); return n; });
  };
  // The price boxes, on a row waiting for its price.
  const priceCell = e => {
      const locked = isLocked(e);
      return (
        <div className="space-y-1" onClick={ev => ev.stopPropagation()}>
          {(e.prices || []).map(p => {
            const k = `${e.id}|${p.qty}`;
            return (
              <div key={p.qty} className="flex items-center gap-2 text-xs">
                <span className="w-16 text-right font-semibold">{qtyText(p.qty)}</span>
                <span className="w-20 text-right text-slate-500" title="Worked out by the costing — the box starts at it">{rupees(p.proposed, 3)}</span>
                <Input className={`!h-8 w-24 text-right ${locked ? '!bg-emerald-50 font-bold text-emerald-900' : ''}`} inputMode="decimal" value={prices[k] ?? ''} readOnly={locked}
                  title={locked ? 'Locked — press Unlock to change it' : 'Type the price to quote'}
                  onChange={ev => { typed.current.add(k); setPrices(x => ({ ...x, [k]: ev.target.value })); }} />
                {p.changed && <span className="font-semibold text-amber-700" title={`Set against ${rupees(p.set_against, 3)}`}>costing changed</span>}
              </div>
            );
          })}
          {(e.prices || []).length > 0 && (locked ? (
            <button type="button" onClick={() => setUnlocked(u => new Set(u).add(e.id))}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-200">
              <Lock size={11} />Locked · Unlock
            </button>
          ) : (
            <button type="button" onClick={() => lockRow(e)}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100">
              <LockOpen size={11} />Lock this price
            </button>
          ))}
        </div>
      );
  };
  // Quantities — and, from costed on, the prices: boxes while the price is being set, the quoted price after.
  const priceCol = { key: 'prices', label: 'Quantity · costing proposes · price a carton', render: e => {
    if (PRICE_STAGES.includes(e.stage)) return priceCell(e);
    const fin = (e.prices || []).filter(p => p.final != null);
    if (!fin.length) return quantitiesText(e.quantities);
    return <div className="space-y-0.5 text-xs">{fin.map(p => <div key={p.qty}><b>{qtyText(p.qty)}</b> @ {rupees(p.final, 3)}</div>)}</div>;
  } };
  // Order finalised, on the row (Management): from Final price on, a row with a complete costing (13 Nov 2026).
  // Order finalised waits for the customer's decision (owner, 21 Nov 2026): only once the quotation has gone out — Sent,
  // Mailed or Counter on the band — never on a row still pending with us.
  const orderButton = e => (desk?.can_finalise && orderable(e) ? (
    <button type="button" onClick={ev => { ev.stopPropagation(); setOrdering([e.id]); }}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100">
      <PackageCheck size={12} />Order finalised
    </button>
  ) : null);
  const orderCol = { key: 'order', label: '', render: orderButton };
  const whyCol = { key: 'dropped_reason', label: 'Why', render: e => <span className="text-xs text-slate-600">{e.dropped_reason || '—'}</span> };
  const columns = tab === 'dropped' ? [...baseCols.slice(0, 5), whyCol]
    : tab === 'sent' ? [...baseCols.slice(0, 4), priceCol, baseCols[5], orderCol]
      : [...baseCols.slice(0, 4), priceCol, costingCol, baseCols[5], orderCol];
  // Pending: a counter-offer is worked in its own panel above the table, so the table holds the rest.
  const tableRows = tab === 'pending' ? shown.filter(e => e.stage !== 'countered') : shown;

  const savePrices = async (list, { quiet = false } = {}) => {
    const items = list.map(e => ({ id: e.id, prices: (e.prices || []).map(p => ({ qty: p.qty, final: Number(prices[`${e.id}|${p.qty}`]) })) }));
    const bad = items.find(it => it.prices.some(p => !(p.final > 0)));
    if (bad) { toast.error('Every quantity needs a final price above zero.'); return; }
    const r = await api.put('/costing/enquiries/prices', { items });
    // Saved: the boxes show what is saved from now on.
    for (const e of list) for (const p of e.prices || []) typed.current.delete(`${e.id}|${p.qty}`);
    if (quiet) return r;
    setLast({ text: `Final prices saved for ${r.saved.join(', ')}.`, undo: r.undo });
    setPicked([]);
    await reload();
  };
  // Approve (Management): the costing approved, the price fixed, and a mail with nothing left waiting gets its ONE reply as a
  // Gmail draft. Never sent. The answer is read line by line (approveSummary); an Undo only when no reply was made.
  const approve = async () => {
    const r = await api.post('/costing/enquiries/approve', { ids: picked });
    const lines = approveSummary(r);
    toast[approveTone(r)](lines.join(' · '));
    // kept on the bar (it stays until closed), so the reasons outlive the toast; Undo only when the server gave one
    setLast({ text: lines.join(' · '), undo: r.undo });
    setPicked([]);
    await reload();
  };
  const costForMe = async () => {
    const r = await api.post('/costing/enquiries/auto-cost', { ids: picked });
    const lines = autoCostLines(r);
    toast[autoCostTone(r)](lines.join(' · '));
    setLast({ text: lines.join(' · ') });
    setPicked([]);
    await reload();
  };
  const applyAdjust = () => {
    setPrices(cur => {
      const next = { ...cur };
      for (const e of pickedRows) for (const p of e.prices || []) {
        const k = `${e.id}|${p.qty}`;
        const v = adjustPrice(next[k] || p.suggested, adjust);
        if (v != null) { next[k] = String(v); typed.current.add(k); }
      }
      return next;
    });
  };

  const quoteCols = [
    { key: 'quotation_no', label: 'No.', render: x => <span className="font-bold text-brand-600">{x.quotation_no}</span> },
    { key: 'customer_name', label: 'Customer', render: x => <div><div className="font-semibold">{x.customer_name || '—'}</div><div className="text-[11px] text-slate-500">{x.contact_email || ''}</div><MailboxNote e={x} desk={desk} /></div> },
    { key: 'items', label: 'Items', render: x => `${new Set(x.lines.map(l => l.enquiry_no)).size}` },
    { key: 'total', label: 'Total', align: 'right', render: x => rupees(x.total) },
    { key: 'status', label: 'Status', render: x => <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${QUOTE_TONE[x.status]}`}>{QUOTE_LABEL[x.status]}</span> },
    { key: 'when', label: 'Made or sent', sortValue: x => x.sent_at || x.created_at, render: x => `${dateText(x.sent_at || x.created_at)} · ${x.sent_by_name || x.created_by_name || ''}` },
    // a sent quotation the customer has agreed: all its items in one Order finalised panel
    ...(desk?.can_finalise ? [{ key: 'order', label: '', render: x => (x.status !== 'sent' ? null : (
      <button type="button" onClick={ev => { ev.stopPropagation(); setOrdering([...new Set((x.lines || []).map(l => l.enquiry_id).filter(Boolean))]); }}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100">
        <PackageCheck size={12} />Order finalised
      </button>
    )) }] : []),
  ];

  if (!desk) return <div className="p-8 text-sm text-slate-400">Loading the enquiry desk…</div>;
  const mgmt = desk.can_finalise;
  const one = pickedRows.length === 1 ? pickedRows[0] : null;
  const several = pickedRows.length > 1;
  // What the ticked rows allow — by each row's own stage, not by the tab.
  const has = list => pickedRows.some(e => list.includes(e.stage));
  const pCost = has(COST_STAGES);
  const pPrice = has(PRICE_STAGES);
  const pQuote = has(['quote_ready']);
  const pAnswered = has(['costed', 'price_pending', 'quote_ready', 'sent']);
  const pOrder = pickedRows.some(orderable);
  const pBack = pickedRows.some(e => STAGE_BACKWARD[e.stage]);
  const pDelete = has(['new', 'ready', 'costing', 'costed', 'price_pending', 'quote_ready', 'dropped']);
  const detail = (
    <EnquiryDetail id={open} statuses={desk.statuses} onClose={() => setOpen(null)} onChanged={reload} canSend={!!desk.can_finalise}
      onSaved={x => x?.undo && setLast({ text: `${x.enquiry_no}: what was asked is saved.`, undo: x.undo })}
      onCost={e => (work?.mode === 'one' && work.ids[work.at] === e.id ? setOpen(null) : startOne([e.id]))}
      onMove={(path, e) => after(api.post(`/costing/enquiries/${path}`, { ids: [e.id] }), moved => `${nos(moved)} sent back to ${stageName(moved[0].to)}.`).then(() => setOpen(null))}
      onUndo={async (group, e) => {
        const r = await api.post('/costing/enquiries/undo', { group, ids: [e.id] });
        if (r.skipped?.length) toast.info(`Not undone: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
        if (r.moved.length) setLast({ text: `Undone: ${nos(r.moved)}.`, undo: r.undo, redo: true });
        await reload();
      }} />
  );

  // Costing in place: the enquiry and its costing fill the desk; ← Back to the desk returns to the same tab.
  if (work) {
    return (
      <div>
        <UndoBar last={last} onUndo={undo} onClose={() => setLast(null)} />
        <DeskCosting boot={boot} customers={customers} work={work} statuses={desk.statuses} reloadSignal={seen}
          onClose={() => { setWork(null); reload(); }} onMoved={costingMoved} onEditEnquiry={id => setOpen(id)} />
        {detail}
      </div>
    );
  }

  return (
    <div>
      <div className="glass mb-4 flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <MailboxBadge box={desk.in_use} />
        <div className="min-w-0 flex-1"><JobLine job={lastFetch} cloud={desk.cloud} /></div>
        <Button variant="secondary" size="sm" onClick={() => setOpen('new')}><Plus size={14} className="mr-1 inline" />Add an enquiry</Button>
        <Button variant="secondary" size="sm" onClick={() => fetchMail('trial')}
          title={`Only the mail that came to ${mailboxEmail(desk, 'trial') || 'the trial mailbox'} — read by the Claude on the owner's Mac`}>
          <Mail size={13} className="mr-1 inline" />Fetch from dua.anik
        </Button>
        <Button onClick={() => fetchMail('business')}
          title={`The company mailbox ${mailboxEmail(desk, 'business') || ''} — ${desk.cloud?.business?.linked ? 'Claude in the cloud reads it at once (the office AVS still reads it at its own hours)' : "read at the office computer's next AVS run; link Claude in the cloud in Settings to read it at once"}`}>
          <Inbox size={15} className="mr-1.5 inline" />Fetch from mail
        </Button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SubTabs views={views} active={tab} onChange={k => { setTab(k); setSearch(''); }} />
        {stages && <Input className="!h-9 w-64" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, product, size, number…" />}
        {stages && <Button size="sm" variant="secondary" onClick={reload}><RefreshCw size={13} className="mr-1 inline" />Refresh</Button>}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => { setTab('orders'); setSearch(''); }}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${tab === 'orders' ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
            Orders
          </button>
          <button type="button" onClick={() => { setTab('dropped'); setSearch(''); }}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold ${tab === 'dropped' ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
            Dropped{counts.dropped ? ` · ${counts.dropped}` : ''}
          </button>
          {desk.can_admin && (
            <button type="button" onClick={() => setTab('settings')} title="Desk settings" aria-label="Desk settings"
              className={`rounded-full p-2 ${tab === 'settings' ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
              <Settings size={15} />
            </button>
          )}
        </div>
      </div>
      <UndoBar last={last} onUndo={undo} onClose={() => setLast(null)} />

      {tab === 'settings' && <DeskSettings desk={desk} onSaved={loadDesk} />}

      {tab === 'pending' && (
        <p className="mb-2 text-xs text-slate-500">Everything waiting on us, in one list: new enquiries (<b>orange rows</b>), costing, pricing, approval — and, on top, any customer's counter-offer. The <b>Status</b> band says where each row stands; tick rows and the buttons below are the ones their stage allows: <b>Cost it</b>, <b>Approve</b>, <b>Send quotation</b> (the reply goes to Gmail as a draft), <b>Customer counter</b>, <b>Order finalised</b>.</p>
      )}
      {tab === 'sent' && (
        <p className="mb-2 text-xs text-slate-500">With the customer. <b>Sent</b> = the quotation's reply is a draft in Gmail, to be sent from there; <b>Mailed</b> = it went to the customer. When they answer with their own prices, tick and press <b>Customer counter</b> — the rows go back to Pending; when they agree, <b>Order finalised</b>. The quotations are listed below.</p>
      )}
      {tab === 'all' && <p className="mb-2 text-xs text-slate-500">Every enquiry on the desk, finalised orders too, with its status band.</p>}
      {tab === 'orders' && (
        <p className="mb-2 text-xs text-slate-500">Orders the customer agreed. <b>Order finalised</b> keeps the order with the rate agreed and the loss where it was booked below our cost, and sends the order sheet — the table of items, rates, output sheets, ups, boards and dies, with the KLDs — to the company mailbox. Click an order to see it line by line.</p>
      )}
      {tab === 'orders' && <OrdersList canSend={!!mgmt} signal={ordersSignal} />}
      {tab === 'pending' && rows && counterGroups(shown.filter(e => e.stage === 'countered')).map(g => (
        <div key={g.key} className="mb-4"><CounterPanel rows={g.rows} canSend={!!mgmt} onChanged={reload} onUndoable={setLast} title={`${g.customer} — counter on ${g.rows.length} item${g.rows.length === 1 ? '' : 's'}`} /></div>
      ))}
      {stages && <MailChips buckets={buckets} picked={picked} onToggle={toggleMail} onClear={() => setPicked([])} />}
      {stages && (
        <DataTable rows={tableRows} columns={columns} onRowClick={e => setOpen(e.id)}
          selectable selectedIds={picked} onToggleRow={toggle} onToggleAll={toggleAll}
          rowClass={e => (e.status === 'new' ? NEW_ENQUIRY_ROW : '')}
          defaultSort={{ key: 'received', dir: 'desc' }} serialNumber={false}
          empty={rows ? (tab === 'pending' ? 'Nothing pending. Press "Fetch from mail" for new enquiries.' : 'Nothing here.') : 'Loading…'} />
      )}

      {tab === 'sent' && (
        <div className="mt-6">
          <div className="mb-2 text-sm font-bold text-[#1D1D1F]">Quotations</div>
          <DataTable rows={quotes} columns={quoteCols} onRowClick={x => setOpenQuote(x.id)} defaultSort={{ key: 'when', dir: 'desc' }} serialNumber={false}
            empty="No quotation yet — tick finalised enquiries above and press Send quotation." />
        </div>
      )}

      <SelectionDock open={pickedRows.length > 0} count={pickedRows.length} onClear={() => setPicked([])}
        summary={[[...new Set(pickedRows.map(e => e.customer_name || e.contact_email).filter(Boolean))].join(' · '),
          ...mailGaps(pickedRows).map(g => `⚠ M${g.mail_id}: ${g.picked} of ${g.of} ticked`)].filter(Boolean).join(' · ')}>
        {pCost && <>
          {/* CI Plant's own incomplete draft opens as a fresh costing (startsFresh): "Cost it" */}
          {one && <Button size="sm" onClick={() => startOne([one.id])}><Calculator size={13} className="mr-1 inline" />{one.costing_live && !startsFresh(one) ? 'Open costing' : 'Cost it'}</Button>}
          {several && <Button size="sm" onClick={() => startOne(pickedRows.map(e => e.id))}><Calculator size={13} className="mr-1 inline" />Cost one by one</Button>}
          {several && <Button size="sm" variant="secondary" onClick={() => startTogether(pickedRows)}><Layers size={13} className="mr-1 inline" />Cost together (bulk)</Button>}
        </>}
        {pCost && pickedRows.some(e => e.status === 'new') && (
          <Button size="sm" variant="secondary" onClick={() => move('ready', m => `${nos(m)} marked ready for costing.`)}
            title="Takes the orange off: someone has seen it and will cost it later">Mark ready for costing</Button>
        )}
        {pCost && <Button size="sm" variant="secondary" onClick={() => move('to-price', m => `${nos(m)} costed — waiting for the price.`)}
          title="For rows whose costing is complete: they wait for their price">Costing done</Button>}
        {pCost && (
          <Button size="sm" variant="secondary" onClick={costForMe}
            title="CI Plant costs the ticked rows itself, as a draft a manager approves"><Calculator size={13} className="mr-1 inline" />Cost it for me</Button>
        )}
        {pPrice && mgmt && (
          <Button size="sm" variant="success" onClick={approve}
            title="Approves the costing and fixes the price; a mail with nothing left waiting gets its quotation and a Gmail draft — nothing is sent"><Check size={13} className="mr-1 inline" />Approve</Button>
        )}
        {pPrice && <>
          {one && !pCost && <Button size="sm" variant="secondary" onClick={() => startOne([one.id])}><Calculator size={13} className="mr-1 inline" />Open costing</Button>}
          <Select value={adjust.mode} onChange={e => setAdjust(a => ({ ...a, mode: e.target.value }))} className="!h-8 w-44">
            <option value="add">+ ₹ a carton</option><option value="pct">+ %</option><option value="round">Round up to ₹0.05</option>
          </Select>
          {adjust.mode !== 'round' && <Input className="!h-8 w-20" inputMode="decimal" value={adjust.amount} onChange={e => setAdjust(a => ({ ...a, amount: e.target.value }))} placeholder={adjust.mode === 'pct' ? '5' : '0.10'} />}
          <Button size="sm" variant="secondary" onClick={applyAdjust}>Apply to ticked</Button>
          <Button size="sm" variant="secondary" onClick={() => savePrices(pickedRows)}><Lock size={13} className="mr-1 inline" />Lock ticked prices</Button>
          {mgmt && <Button size="sm" variant="success" onClick={async () => {
            // Seamless: the prices in the boxes are locked as shown, then ONE server step finalises, quotes and
            // queues the reply draft in the customer's thread (owner, 11 Nov 2026).
            const open = pickedRows.filter(e => !isLocked(e));
            if (open.length) await savePrices(open, { quiet: true });
            const q = await quoteAndDraft(api, pickedRows.map(e => e.id));
            if (q.failed.length) toast.error(q.failed.join('; '));
            setLast({ text: sendSummary(q), quotations: q.quotations });
            setPicked([]); await reload();
          }} title="Locks the prices shown, makes the quotation and saves the reply as a Gmail draft in the customer's thread"><Send size={13} className="mr-1 inline" />Send quotation</Button>}
        </>}
        {!pPrice && pQuote && <Button size="sm" onClick={async () => {
          // The quotation and, straight on, its reply draft in the customer's thread.
          const r = await quoteAndDraft(api, picked);
          if (r.failed.length) toast.error(r.failed.join('; '));
          setLast({ text: sendSummary(r), quotations: r.quotations });
          setPicked([]); await reload();
        }}><Send size={13} className="mr-1 inline" />Send quotation</Button>}
        {pAnswered && (
          <Button size="sm" variant="secondary" title="The customer came back with their own prices: these rows go to the top of Pending, to work out the revised quotation"
            onClick={async () => {
              await after(api.put('/costing/enquiries/counter', { items: picked.map(id => ({ id, prices: [] })) })
                .then(r => ({ moved: (r.saved || []).map(no => ({ enquiry_no: no, to: 'countered' })), skipped: r.skipped, undo: r.undo })),
              m => `${nos(m)} moved to the counter-offers on Pending — type the customer's prices there.`);
              setTab('pending');
            }}>Customer counter</Button>
        )}
        {pOrder && mgmt && (
          <Button size="sm" variant="success" title="The customer agreed: keep the order with its rates and any loss, and send the order sheet to the team"
            onClick={() => {
              const list = pickedRows.filter(orderable).map(e => e.id);
              if (!list.length) { toast.info('None of the ticked rows can go on an order — its quotation must go to the customer first.'); return; }
              setOrdering(list);
            }}><PackageCheck size={13} className="mr-1 inline" />Order finalised</Button>
        )}
        {pBack && <Button size="sm" variant="secondary" title="One step back — the costing and prices stay with it"
          onClick={() => move('back', m => `${nos(m)} sent back to ${[...new Set(m.map(x => stageName(x.to)))].join(' and ')}.`)}>Send back a step</Button>}
        {(pCost || pPrice) && <Button size="sm" variant="secondary" onClick={() => move('drop', m => `${nos(m)} dropped.`, { reason: 'Not to be quoted' })}>Drop</Button>}
        {has(['dropped']) && <Button size="sm" onClick={() => move('restore', m => `${nos(m)} brought back to ${[...new Set(m.map(x => stageName(x.to)))].join(' and ')}.`)}>Bring back</Button>}
        {pDelete && (
          <Button size="sm" variant="danger" onClick={() => setDeleting({ ids: [...picked], reason: 'Duplicate' })}
            title="Take a duplicate, or a mail that was no enquiry, off the desk — Undo brings it back"><Trash2 size={13} className="mr-1 inline" />Delete</Button>
        )}
      </SelectionDock>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting?.ids.length === 1 ? 'this enquiry' : `${deleting?.ids.length || 0} enquiries`}`}
        footer={<>
          <Button variant="secondary" onClick={() => setDeleting(null)}>Keep</Button>
          <Button variant="danger" onClick={async () => {
            const d = deleting;
            setDeleting(null);
            await after(api.post('/costing/enquiries/delete', { ids: d.ids, reason: d.reason }), m => `${nos(m)} deleted.`);
          }}><Trash2 size={13} className="mr-1 inline" />Delete</Button>
        </>}>
        <p className="mb-3 text-sm text-slate-600">It goes off the desk — out of every tab and count — and stays on record with the reason. <b>Undo</b> on the bar brings it back. A row on a quotation or an order is kept: cancel the quotation first.</p>
        <Field label="Why">
          <Input value={deleting?.reason || ''} onChange={e => setDeleting(d => ({ ...d, reason: e.target.value }))} placeholder="Duplicate of CI-ENQ-…" />
        </Field>
      </Modal>
      {detail}
      <QuotationPanel id={openQuote} canMarkSent={mgmt} onClose={() => setOpenQuote(null)} onChanged={reload} />
      <OrderPanel ids={ordering} onClose={() => setOrdering(null)}
        onDone={() => { setOrdering(null); setPicked([]); setOrdersSignal(s => s + 1); setTab('orders'); reload(); }} />
    </div>
  );
}

// Admin: which mailbox is in use, who each replies to, and the quotation's standard words.
// Under the customer: the mailbox a row's mail came to, when it is not the desk's mailbox in use (the office AVS files
// the business mailbox) — its reply is drafted there.
function MailboxNote({ e, desk }) {
  const note = mailboxNote(e, desk);
  return note ? <div className="text-[11px] font-semibold text-sky-700" title="This mail came to this mailbox; its reply is drafted there">{note}</div> : null;
}

function DeskSettings({ desk, onSaved }) {
  const toast = useToast();
  const [boxes, setBoxes] = useState(desk.mailboxes);
  const [inUse, setInUse] = useState(desk.in_use?.key || 'trial');
  const [s, setS] = useState(desk.settings);
  const setBox = (key, patch) => setBoxes(bs => bs.map(b => (b.key === key ? { ...b, ...patch } : b)));
  const save = async () => {
    await api.put('/costing/enquiry-desk/settings', { mailboxes: boxes, in_use: inUse, settings: s });
    toast.success('Enquiry desk settings saved');
    onSaved();
  };
  return (
    <div className="glass max-w-4xl space-y-5 rounded-2xl p-4">
      <div>
        <div className="mb-1 text-sm font-bold">Mailboxes</div>
        <p className="mb-3 text-xs text-slate-500">With a mailbox's Gmail connected, CI Plant saves each quotation reply as a draft in the customer's thread the moment Send quotation is pressed — it never sends; you send it from Gmail. New enquiry mails are still read by the Claude robot. A mailbox set to reply only to itself is a trial: its drafts are addressed back to it.</p>
        {boxes.map(b => (
          <div key={b.key} className="mb-2 grid items-end gap-3 sm:grid-cols-[120px_1fr_220px_110px]">
            <div className="text-sm font-bold">{b.email || b.label}{b.send_to !== 'customers' && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900">trial — replies go only to itself</span>}</div>
            <Field label="Gmail address"><Input value={b.email} onChange={e => setBox(b.key, { email: e.target.value })} /></Field>
            <Field label="Replies go to">
              <Select value={b.send_to} onChange={e => setBox(b.key, { send_to: e.target.value })}>
                <option value="own">Its own address only</option><option value="customers">The customer</option>
              </Select>
            </Field>
            <Checkbox label="In use" checked={inUse === b.key} onChange={() => setInUse(b.key)} />
            <div className="sm:col-span-4 -mt-1 mb-2"><GmailLink box={b} ready={desk.gmail_ready} onChanged={onSaved} /></div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Opening words of a reply"><Textarea value={s.opening} onChange={e => setS({ ...s, opening: e.target.value })} /></Field>
        <Field label="Closing words of a reply"><Textarea value={s.closing} onChange={e => setS({ ...s, closing: e.target.value })} /></Field>
        <Field label="Terms on every quotation"><Textarea rows={4} value={s.terms} onChange={e => setS({ ...s, terms: e.target.value })} /></Field>
        <Field label="First fetch looks back (days)"><Input inputMode="numeric" value={s.fetch_days} onChange={e => setS({ ...s, fetch_days: e.target.value })} /></Field>
      </div>
      <Checkbox label="Cost new enquiries by themselves" checked={!!s.auto_cost} onChange={e => setS({ ...s, auto_cost: e.target.checked })} />
      <p className="-mt-3 text-xs text-slate-500">Each new enquiry is costed by CI Plant as an Auto draft; a manager approves it in To price. What it cannot cost stays in To cost, with the reason.</p>
      <div className="text-xs text-slate-500">The robot that reads and drafts mail is Claude with the mailbox's own Gmail, running the enquiry desk skill — not the AVS photo-check routine.</div>
      <Button onClick={save}>Save settings</Button>
      <CloudLink mailbox="business" cloud={desk.cloud?.business} onSaved={onSaved} />
      <details className="rounded-xl border border-slate-200 bg-white/40 p-3">
        <summary className="cursor-pointer text-xs font-semibold text-slate-600">
          Trial mailbox in the cloud — optional: the Mac already starts a Fetch from dua.anik within a minute
        </summary>
        <div className="mt-3"><CloudLink mailbox="trial" cloud={desk.cloud?.trial} onSaved={onSaved} /></div>
      </details>
    </div>
  );
}

function CopyButton({ text, label }) {
  const toast = useToast();
  return (
    <Button size="sm" variant="secondary" repeatable onClick={async () => {
      try { await navigator.clipboard.writeText(text); toast.success(`${label} copied`); }
      catch { toast.error('Copy did not work here. Select the text and copy it by hand.'); }
    }}>
      <span className="inline-flex items-center gap-1"><Copy size={12} /> {label}</span>
    </Button>
  );
}

// Claude in the cloud (admin): a mailbox's own routine on claude.ai, on the Claude account whose Gmail is that mailbox,
// started by CI Plant when Fetch is pressed — with this computer and the office computer off (server/src/enquiry-cloud.js).
// Its API URL and token come from the routine's API trigger on claude.ai; the token is shown there once, and never comes
// back here. The company mailbox's routine lives on the company account beside the AVS check routine (14 Nov 2026).
function CloudLink({ mailbox, cloud, onSaved }) {
  const toast = useToast();
  const [url, setUrl] = useState(cloud?.fire_url || '');
  const [token, setToken] = useState('');
  const company = mailbox === 'business';
  const save = async () => {
    await api.put('/costing/enquiry-desk/cloud', { mailbox, fire_url: url.trim(), token: token.trim() });
    setToken('');
    toast.success(`Claude in the cloud is linked — press ${company ? 'Fetch from mail' : 'Fetch from dua.anik'} to try it`);
    onSaved?.();
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div className="text-sm font-bold">Claude in the cloud — {company ? 'company mailbox' : 'trial mailbox'}</div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${cloud?.linked ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>
          {cloud?.linked ? `Linked${cloud.token_hint ? ` · token ${cloud.token_hint}` : ''}` : 'Not linked'}
        </span>
      </div>
      {company ? (
        <>
          <p className="mb-2 text-xs text-slate-500">
            Once linked, <b>Fetch from mail</b> starts Claude in the cloud at once — with the office computer off — instead of waiting for
            the office computer's next AVS run. Each press is one routine run on the company Claude plan. The office AVS still reads the
            mailbox at its own hours, and still takes a Fetch the cloud could not start.
          </p>
          <ol className="mb-2 list-decimal space-y-1 pl-5 text-xs text-slate-600">
            <li>Open <a className="text-[#0071F0] underline" href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">claude.ai/code/routines <ExternalLink size={11} className="inline" /></a>,
              signed in to Claude as <b>dua.anik15@gmail.com</b> (the company account that runs AVS), and press <b>New routine</b>. Name it <b>Enquiry fetch (mppchd)</b>.</li>
            <li>Instructions: paste the prompt (<b>Copy prompt</b>, below). Model: <b>Sonnet 5.5</b>.</li>
            <li>Environment: <b>AVS</b> — it already allows motionci.in.</li>
            <li>Connectors: keep only <b>Gmail</b> (signed in as mppchd@gmail.com) and remove the rest. If it lets you choose Gmail's tools,
              keep only the ones that search and read. No repository is needed; if the form insists on one, pick <b>duaanik-bot/ci-plant</b> (the fetch never changes it).</li>
            <li>Trigger: <b>API</b>. Save the routine, open it again → the API trigger → copy the URL, press <b>Generate token</b> and copy the
              token (it is shown once). Use this new routine's, not the AVS check routine's.</li>
            <li>Paste both here and press <b>Save the link</b>. Then press <b>Fetch from mail</b> to try it.</li>
          </ol>
          <div className="mb-2"><CopyButton text={COMPANY_ROUTINE_PROMPT} label="Copy prompt" /></div>
        </>
      ) : (
        <p className="mb-2 text-xs text-slate-500">
          The trial mailbox's routine is on the owner's Claude account, whose Gmail is dua.anik@gmail.com; once linked, Fetch from dua.anik
          starts it at once. On claude.ai/code/routines open the enquiry desk routine → Edit → Trigger → + → API, copy the Fire URL, press
          Generate token, and paste both here. In the same dialog allow <b>motionci.in</b> under Advanced settings → Cloud environment → Allowed domains.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_260px_auto] sm:items-end">
        <Field label="Fire URL"><Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" /></Field>
        <Field label={cloud?.linked ? 'Token (blank keeps the saved one)' : 'Token'}>
          <Input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="sk-ant-…" />
        </Field>
        <Button onClick={save} disabled={!url.trim() || (!cloud?.linked && !token.trim())}>Save the link</Button>
      </div>
    </div>
  );
}

// One mailbox's Gmail line to CI Plant: Connect (Google's page, once) or Connected · Disconnect.
function GmailLink({ box, ready, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const g = box.gmail;
  const connect = async () => {
    setBusy(true);
    try { const { url } = await api.post(`/costing/enquiry-desk/gmail/${box.key}/connect`, {}); window.location.assign(url); }
    catch { setBusy(false); }
  };
  const disconnect = async () => {
    if (!window.confirm(`Disconnect Gmail for ${box.email}? Drafts then wait for the Claude robot again.`)) return;
    setBusy(true);
    try { await api.del(`/costing/enquiry-desk/gmail/${box.key}`); toast.success('Gmail disconnected'); onChanged?.(); } finally { setBusy(false); }
  };
  if (!ready) return <span className="text-xs text-slate-500">Gmail drafts by CI Plant: not set up on the server yet.</span>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {g ? (
        <>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-bold ring-1 ${g.last_error ? 'bg-red-50 text-red-800 ring-red-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200'}`}>
            <Mail size={12} />{g.last_error ? 'Gmail needs connecting again' : `Gmail connected · ${g.email}`}
          </span>
          <span className="text-slate-500">by {g.connected_by_name || '—'} · {dateText(g.connected_at)}{g.last_used_at ? ` · last draft ${dateText(g.last_used_at)}` : ''}</span>
          {g.last_error && <span className="text-red-700">{g.last_error}</span>}
          {!g.last_error && !g.can_read && <span className="text-amber-800">Reading mail is not allowed yet — needed to show artwork mail threads.</span>}
          {(g.last_error || !g.can_read) && <Button size="sm" onClick={connect} disabled={busy}>Connect Gmail again</Button>}
          <button type="button" onClick={disconnect} disabled={busy} className="font-semibold text-slate-500 underline hover:text-red-700">Disconnect</button>
        </>
      ) : (
        <>
          <Button size="sm" onClick={connect} disabled={busy}><Mail size={13} className="mr-1 inline" />Connect Gmail</Button>
          <span className="text-slate-500">Sign in to Google as {box.email} and press Allow — then drafts are saved by CI Plant, no robot, and artwork mail threads can be read.</span>
        </>
      )}
    </div>
  );
}

// The Counter tab: one panel per counter mail (else per enquiry mail), so a customer's whole answer is worked as one.
function counterGroups(rows = []) {
  const groups = new Map();
  for (const e of rows) {
    const key = e.counter_mail_id ? `c${e.counter_mail_id}` : e.mail_id ? `m${e.mail_id}` : `e${e.id}`;
    if (!groups.has(key)) groups.set(key, { key, customer: e.customer_name || e.contact_email || 'Customer', rows: [] });
    groups.get(key).rows.push(e);
  }
  return [...groups.values()];
}
