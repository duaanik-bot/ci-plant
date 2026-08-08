// CI Messenger — the floating chat dock, the NotificationBell's sibling.
// DMs, group rooms and one thread per RECORD (job cards, orders, POs, lots… —
// anything the server's entity registry addresses); text, hold-to-record voice
// notes, photos/files, `#` job tagging and `@` mentions. Polling transport with
// visible-tab fallbacks matching the app's refresh idiom.
//
// Every module reaches this one dock through the `ci-chat-open` event, which is
// why no page has ever needed a chat drawer of its own — see ThreadCell.jsx.
import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  MessageCircle, X, ChevronLeft, Send, Mic, Paperclip, Plus, Users, Wrench,
  Play, Pause, FileText, Download, Trash2, MoreHorizontal, UserPlus, Hash, AtSign,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { Button, Input, Textarea, Checkbox, SearchInput, searchText, useToast } from './ui.jsx';
import { CountButton, countOf, plural, rung } from './TopBar.jsx';

// My messages ride the sidebar's active-pill recipe (ACTIVE_PILL in
// AppLayout.jsx) — the app's one "this is you" signal, softened a touch for a
// bubble that repeats down a thread.
const MY_PILL =
  'bg-gradient-to-b from-[#2E95FF] to-[#0071F0] text-white ' +
  'shadow-[0_6px_16px_rgba(0,122,255,0.28),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(0,83,173,0.35)]';
const THEIR_PILL =
  'bg-white/70 text-[#1D1D1F] ring-1 ring-inset ring-[#1D1D1F]/[0.06] ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_8px_rgba(29,29,31,0.06)] backdrop-blur-md';

// Postgres timestamps arrive as 'YYYY-MM-DD HH:mm:ss' — same normalisation
// fmt.dt does, kept local so day math never parses an invalid date.
const ts = s => new Date(typeof s === 'string' ? s.replace(' ', 'T') : s);
const mss = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const fileSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);
const dayLabel = d => {
  const dt = ts(d), now = new Date();
  if (dt.toDateString() === now.toDateString()) return 'Today';
  if (dt.toDateString() === new Date(now - 86400000).toDateString()) return 'Yesterday';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const timeOnly = d => ts(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

// The list row's last line — client twin of the server's previewText().
// `last_message` carries no file_name, so files fall back to a generic label.
const preview = lm => {
  if (!lm) return 'No messages yet';
  if (lm.removed_at) return 'Message removed';
  if (lm.kind === 'voice') return 'Voice note';
  if (lm.kind === 'file') return (lm.body || '').trim() || 'Attachment';
  const b = (lm.body || '').trim();
  return b.length > 80 ? `${b.slice(0, 80)}…` : b;
};

// A message the sender can see but the server has not acknowledged yet. Its id
// is minted above every id Postgres will ever hand out, so it sorts to the
// bottom of the thread for free and no real row can ever collide with it.
// `isPending` is the guard every piece of code that treats an id as REAL must
// pass it through first — the read pointer especially, since it is a
// monotonic GREATEST() on the server and one fake id would pin it forever.
const PENDING_BASE = 2 ** 40;
const isPending = m => m.id >= PENDING_BASE;

const REMOVE_WINDOW_MS = 10 * 60 * 1000;
const canRemove = (m, meId) =>
  m.kind !== 'system' && !m.removed_at && !isPending(m) && m.sender_id === meId
  && Date.now() - ts(m.created_at).getTime() <= REMOVE_WINDOW_MS;

// Newest-first merge by id — polls race sends, so the same message can arrive
// twice; the Map collapses duplicates and the sort restores thread order.
//
// A real row also retires the optimistic bubble that stood in for it. Matching
// on sender + text rather than on a nonce is deliberate: the thread poll can
// deliver a message BEFORE the POST that created it returns, and a poll
// response carries no nonce to match on. Sending the same words twice inside
// one poll window still converges — both stand-ins retire and both real rows
// remain. A failed bubble is never retired: it is the only record that those
// words did not make it, and it belongs to the sender until they retry it.
const mergeMessages = (prev, incoming) => {
  if (!incoming?.length) return prev;
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of incoming) {
    byId.set(m.id, m);
    if (isPending(m) || !(m.body || '').trim()) continue;
    for (const [id, p] of byId) {
      if (isPending(p) && !p.failed && p.sender_id === m.sender_id && (p.body || '') === m.body) byId.delete(id);
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
};

// Images > 1 MB are squeezed client-side before upload (max edge 1920, JPEG
// q0.82) so BYTEA blobs stay small; the original name keeps its identity with
// a .jpg extension. Anything that fails to decode uploads as-is.
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const scale = Math.min(1, 1920 / Math.max(img.width, img.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── Attachment renderers — bytes come through fetchUrl (Bearer-auth blob) ──

function ImageThumb({ att, fetchUrl, onZoom }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    fetchUrl(att.id).then(u => { if (live) setUrl(u); }).catch(() => {});
    return () => { live = false; };
  }, [att.id, fetchUrl]);
  if (!url) {
    return <div className="h-32 w-44 animate-pulse rounded-xl bg-[#1D1D1F]/[0.06]" />;
  }
  return (
    <button type="button" onClick={() => onZoom(url)} className="block overflow-hidden rounded-xl">
      <img src={url} alt={att.file_name || 'photo'} className="max-h-48 w-auto max-w-full object-cover" />
    </button>
  );
}

function VoiceNote({ att, fetchUrl, mine }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const total = att.duration_secs || 0;
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  const toggle = async () => {
    if (!audioRef.current) {
      try {
        const a = new Audio(await fetchUrl(att.id));
        a.ontimeupdate = () => setPos(a.currentTime);
        a.onended = () => { setPlaying(false); setPos(0); };
        audioRef.current = a;
      } catch { return; }
    }
    const a = audioRef.current;
    if (a.paused) { a.play().catch(() => {}); setPlaying(true); }
    else { a.pause(); setPlaying(false); }
  };
  const pct = total > 0 ? Math.min(100, (pos / total) * 100) : 0;
  const tone = mine ? 'bg-white/25' : 'bg-[#007AFF]/15';
  const fill = mine ? 'bg-white' : 'bg-[#007AFF]';
  return (
    <div className="flex w-48 items-center gap-2.5 py-0.5">
      <button type="button" onClick={toggle}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${mine ? 'bg-white/25 text-white' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>
        {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={`h-1.5 overflow-hidden rounded-full ${tone}`}>
          <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`mt-1 text-[10px] font-semibold tabular-nums ${mine ? 'text-white/80' : 'text-[#86868B]'}`}>
          {mss(playing || pos ? pos : total)}
        </div>
      </div>
    </div>
  );
}

function FileRow({ att, fetchUrl, mine }) {
  const download = async () => {
    try {
      const a = document.createElement('a');
      a.href = await fetchUrl(att.id);
      a.download = att.file_name || 'file';
      a.click();
    } catch { /* silent — bytes fetch failed */ }
  };
  return (
    <button type="button" onClick={download}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${mine ? 'bg-white/15 hover:bg-white/25' : 'bg-[#1D1D1F]/[0.04] hover:bg-[#1D1D1F]/[0.07]'}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${mine ? 'bg-white/25 text-white' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>
        <FileText size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-xs font-semibold ${mine ? 'text-white' : 'text-[#1D1D1F]'}`}>{att.file_name || 'File'}</span>
        <span className={`block text-[10px] ${mine ? 'text-white/70' : 'text-[#86868B]'}`}>{fileSize(att.size_bytes)}</span>
      </span>
      <Download size={13} className={mine ? 'text-white/80' : 'text-[#86868B]'} />
    </button>
  );
}

// A mention, rendered where it was typed. The body stores only `@[handle]`, so
// what kind of thing that handle is comes from the mention-targets map — and a
// chip renders even before the map lands, because a raw `@[anik]` in a plant
// message would read as a typo.
//
// Three tones, and the loudest is deliberately reserved for a mention of ME:
// "someone needs you" is the entire reason mentions exist, and a thread scrolled
// past on a phone has to give that up at a glance. Colour is not the only cue —
// a team wears the group glyph, a person the @.
function MentionChip({ handle, info, mine }) {
  const Icon = info.team ? Users : AtSign;
  const tone = info.me
    ? (mine ? 'bg-white text-[#0064D2]' : 'bg-[#FF3B30] text-white shadow-[0_1px_5px_rgba(255,59,48,0.35)]')
    : info.team
      ? (mine ? 'bg-white/25 text-white' : 'bg-violet-100 text-violet-700')
      : (mine ? 'bg-white/25 text-white' : 'bg-[#E1EFFF] text-[#0064D2]');
  return (
    <span title={info.label} className={`mx-0.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-px align-baseline text-[11px] font-bold ${tone}`}>
      <Icon size={10} />{handle}
    </span>
  );
}

// One message bubble. `seen` renders the DM read receipt under my newest read
// message; the ⋯ affordance appears on hover (desktop) or long-press (floor
// phones) and only while the 10-minute removal window is open.
function Bubble({ m, mine, showName, onTagClick, fetchUrl, onZoom, removable, onRemove, onRetry, menuOpen, onMenuToggle, seen, mentionInfo = h => ({ label: `@${h}` }) }) {
  const pressTimer = useRef(null);
  if (m.kind === 'system') {
    return (
      <div className="my-1.5 text-center">
        <span className="inline-block rounded-full bg-[#1D1D1F]/[0.05] px-3 py-1 text-[11px] font-medium text-[#86868B]">{m.body}</span>
      </div>
    );
  }
  const removed = !!m.removed_at;
  // Body text with the tagged job numbers and the `@[handle]` mentions turned
  // into live chips in place. One split over both syntaxes, so a message can
  // carry jobs and people at once — and a mention still renders on a message
  // that tagged no job at all.
  const renderBody = () => {
    const body = m.body || '';
    const tags = m.job_tags || [];
    if (!tags.length && !body.includes('@[')) return body;
    const parts = body.split(/(#[A-Za-z0-9-]+|@\[[^\]\s]+\])/g);
    const inline = new Set();
    const nodes = parts.map((p, i) => {
      if (p.startsWith('@[')) {
        const handle = p.slice(2, -1);
        return <MentionChip key={`m${i}`} handle={handle} info={mentionInfo(handle)} mine={mine} />;
      }
      const tag = p.startsWith('#') ? tags.find(t => `#${t.jc_number}` === p) : null;
      if (!tag) return p;
      inline.add(tag.job_card_id);
      return (
        <button key={`t${i}`} type="button" onClick={() => onTagClick(tag)}
          className={`mx-0.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-px align-baseline text-[11px] font-bold ${mine ? 'bg-white/25 text-white hover:bg-white/35' : 'bg-[#E1EFFF] text-[#0064D2] hover:bg-[#CFE5FF]'}`}>
          <Wrench size={10} />{tag.jc_number}
        </button>
      );
    });
    // Tags attached but never typed into the body still deserve a chip.
    const extras = tags.filter(t => !inline.has(t.job_card_id));
    return (
      <>
        {nodes}
        {extras.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {extras.map(t => (
              <button key={t.job_card_id} type="button" onClick={() => onTagClick(t)}
                className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-bold ${mine ? 'bg-white/25 text-white hover:bg-white/35' : 'bg-[#E1EFFF] text-[#0064D2] hover:bg-[#CFE5FF]'}`}>
                <Wrench size={10} />{t.jc_number}
              </button>
            ))}
          </span>
        )}
      </>
    );
  };
  const startPress = () => {
    if (!removable) return;
    pressTimer.current = setTimeout(() => onMenuToggle(), 500);
  };
  const endPress = () => clearTimeout(pressTimer.current);
  return (
    <div className={`group flex ${mine ? 'justify-end' : 'justify-start'} px-3 py-0.5`}>
      <div className={`relative max-w-[82%] ${mine ? 'items-end' : 'items-start'}`}>
        {showName && !mine && (
          <div className="mb-0.5 ml-1 text-[10px] font-bold text-[#86868B]">{m.sender_name}</div>
        )}
        <div
          onTouchStart={startPress} onTouchEnd={endPress} onTouchMove={endPress}
          className={`rounded-[18px] px-3 py-2 text-[13px] leading-snug ${mine ? MY_PILL : THEIR_PILL} ${removed ? 'opacity-70' : ''} ${m.failed ? 'ring-2 ring-red-400' : isPending(m) ? 'opacity-75' : ''}`}>
          {removed ? (
            <span className={`text-xs italic ${mine ? 'text-white/75' : 'text-[#86868B]'}`}>Message removed</span>
          ) : (
            <>
              {(m.attachments || []).map(att => (
                <div key={att.id} className="mb-1 last:mb-0">
                  {att.mime?.startsWith('image/')
                    ? <ImageThumb att={att} fetchUrl={fetchUrl} onZoom={onZoom} />
                    : att.mime?.startsWith('audio/')
                      ? <VoiceNote att={att} fetchUrl={fetchUrl} mine={mine} />
                      : <FileRow att={att} fetchUrl={fetchUrl} mine={mine} />}
                </div>
              ))}
              {!!(m.body || '').trim() && <div className="whitespace-pre-wrap break-words">{renderBody()}</div>}
            </>
          )}
          {/* The bubble reports its own delivery. A send that failed says so on
              the line it failed on and offers the retry there, because a toast
              that has already faded cannot tell you WHICH message was lost. */}
          <div className={`mt-0.5 text-right text-[9px] tabular-nums ${mine ? 'text-white/65' : 'text-[#B4B4B9]'}`}>
            {m.failed ? (
              <button type="button" onClick={onRetry}
                className="font-bold text-white underline decoration-white/50 underline-offset-2">
                Not sent — retry
              </button>
            ) : isPending(m) ? 'Sending…' : timeOnly(m.created_at)}
          </div>
        </div>
        {removable && (
          <button type="button" data-msgmenu onClick={onMenuToggle} title="Message actions"
            className={`absolute top-1 ${mine ? '-left-6' : '-right-6'} rounded-full p-0.5 text-[#86868B] opacity-0 transition-opacity hover:bg-white/70 hover:text-[#1D1D1F] group-hover:opacity-100 ${menuOpen ? 'opacity-100' : ''}`}>
            <MoreHorizontal size={14} />
          </button>
        )}
        {menuOpen && (
          <div data-msgmenu className={`glass absolute top-6 z-10 ${mine ? 'right-full mr-1' : 'left-full ml-1'} animate-liquidPop whitespace-nowrap rounded-xl p-1 shadow-modal`}>
            <button type="button" onClick={onRemove}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
              <Trash2 size={12} /> Remove
            </button>
          </div>
        )}
        {seen && <div className="mt-0.5 pr-1 text-right text-[10px] font-semibold text-[#007AFF]">Seen</div>}
      </div>
    </div>
  );
}

// ─── The dock ───────────────────────────────────────────────────────────────

export default function ChatDock() {
  const nav = useNavigate();
  const toast = useToast();
  const me = auth.user;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState('list');            // list | thread | new
  const [convs, setConvs] = useState([]);
  // Which slice of the inbox the list is showing. DMs by default: a message
  // addressed to YOU is the one nobody else will answer, and the plant's rooms
  // and record threads are noisy enough to bury it in a single flat list.
  const [inboxTab, setInboxTab] = useState('dm');       // dm | group | record | all
  const [activeId, setActiveId] = useState(null);
  const [activeMeta, setActiveMeta] = useState(null);  // ConversationListItem for a thread not (yet) in convs
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [showMembers, setShowMembers] = useState(false);
  const [menuFor, setMenuFor] = useState(null);        // message id with the ⋯ menu open
  const [zoom, setZoom] = useState(null);              // object URL in the image lightbox

  // Composer
  const [text, setText] = useState('');
  const [pendingTags, setPendingTags] = useState([]);  // [{ id, jc_number }]
  const [jobs, setJobs] = useState(null);              // /chat/jobs — fetched lazily once
  const [mentions, setMentions] = useState(null);      // /chat/mention-targets — fetched lazily once
  const [mentionIdx, setMentionIdx] = useState(0);     // highlighted row in the `@` picker
  const [uploading, setUploading] = useState(false);
  const [rec, setRec] = useState(null);                // { secs } while recording

  // New view
  const [users, setUsers] = useState(null);            // /chat/users — fetched on first open
  const [userQ, setUserQ] = useState('');
  const [groupMode, setGroupMode] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupSel, setGroupSel] = useState([]);
  const [memberQ, setMemberQ] = useState('');

  const panelRef = useRef(null);   // the trigger, in the header
  const popRef = useRef(null);     // the panel, portalled to <body> — see below
  const activeIdRef = useRef(null);                    // live copy for async callbacks (voice upload)
  const listRef = useRef(null);                        // messages scroller
  const stickRef = useRef(true);                       // keep pinned to bottom unless the user scrolled up
  const lastMsgIdRef = useRef(0);
  const pendingIdRef = useRef(PENDING_BASE);           // optimistic bubbles awaiting the server
  const lastTrafficRef = useRef(0);                    // when this thread last moved — sets the poll cadence
  const pollingRef = useRef(false);                    // one thread poll in flight at a time
  const lastReadRef = useRef({});                      // convId -> newest id already POSTed to /read
  const typingAtRef = useRef(0);
  const recRef = useRef(null);                         // live MediaRecorder session
  const fileRef = useRef(null);
  const jobsLoadingRef = useRef(false);
  const mentionsLoadingRef = useRef(false);
  // conversation id -> the (entity, entityId) it was opened by, so reading a
  // thread can tell that row's ThreadCell to drop its unread badge. Remembered
  // here rather than read off the conversation payload, which does not have to
  // carry the addressing columns for this to work.
  const threadEntityRef = useRef(new Map());
  // Attachment bytes need the Bearer header, so a plain <img src> can never
  // work — bytes are fetched once per attachment, turned into an object URL,
  // cached for the session and revoked on unmount.
  const blobPromises = useRef(new Map());              // attachment id -> Promise<objectURL>
  const madeUrls = useRef([]);
  const micHeldRef = useRef(false); // is the mic button physically held right now?

  const fetchUrl = useRef(id => {
    let p = blobPromises.current.get(id);
    if (!p) {
      p = fetch(`/api/chat/attachments/${id}`, { headers: { Authorization: `Bearer ${auth.token}` } })
        .then(r => { if (!r.ok) throw new Error(`attachment ${r.status}`); return r.blob(); })
        .then(b => { const u = URL.createObjectURL(b); madeUrls.current.push(u); return u; });
      p.catch(() => blobPromises.current.delete(id)); // failed fetches may retry
      blobPromises.current.set(id, p);
    }
    return p;
  }).current;
  useEffect(() => () => { madeUrls.current.forEach(u => URL.revokeObjectURL(u)); }, []);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const activeConv = convs.find(c => c.id === activeId) || activeMeta;
  // The badge counts the WHOLE inbox, never the visible tab — a filter is a
  // way of looking, not a way of not being told. Same reason the list is
  // filtered here rather than by re-fetching per tab: one poll, one clock, and
  // switching tabs cannot disagree with the number on the bell.
  const unreadTotal = convs.reduce((s, c) => s + (c.muted ? 0 : c.unread || 0), 0);
  // A mention pierces mute — being named is addressed at YOU, and a room you
  // silenced is exactly where an unanswered question goes to die.
  const mentionedAnywhere = convs.some(c => c.mentions_unread > 0);

  // Which bucket a conversation belongs to. 'job' is the legacy synonym of
  // 'record' — a job card's thread is a record thread that predates the name —
  // so both land in the same tab, exactly as the server's own TABS do.
  const bucketOf = c => (c.kind === 'job' ? 'record' : c.kind);
  const shownConvs = inboxTab === 'all' ? convs : convs.filter(c => bucketOf(c) === inboxTab);
  // Per-tab totals from the SAME array the list renders, so a chip can never
  // promise a row the list does not show.
  const tabStats = convs.reduce((acc, c) => {
    const b = bucketOf(c);
    const hit = k => {
      acc[k] = acc[k] || { n: 0, unread: 0 };
      acc[k].n += 1;
      if (!c.muted && c.unread > 0) acc[k].unread += c.unread;
    };
    hit('all');
    if (b === 'dm' || b === 'group' || b === 'record') hit(b);
    return acc;
  }, {});
  const stat = k => tabStats[k] || { n: 0, unread: 0 };
  const INBOX_TABS = [
    { key: 'dm', label: 'DMs', hint: 'Direct messages — one person to one person' },
    { key: 'group', label: 'Groups', hint: 'Rooms like Plant Floor, Cutting and Management' },
    { key: 'record', label: 'Jobs & Orders', hint: 'Threads attached to a record — order lines, job cards, requisitions' },
    { key: 'all', label: 'All', hint: 'Every conversation, unfiltered' },
  ];

  // ── Conversations poll — slow badge fallback, quicker while open ──────────
  useEffect(() => {
    let pending = false;
    const tick = () => {
      if (document.hidden || pending) return;
      pending = true;
      api.get('/chat/conversations').then(setConvs).catch(() => {}).finally(() => { pending = false; });
    };
    tick();
    const t = setInterval(tick, open ? 10000 : 60000);
    const wake = () => tick();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [open]);

  // ── Thread poll — full load on switch, then ?after=<lastId> on a cadence ──
  // Gated on the dock actually SHOWING the thread: a poll that survived the X
  // button would stamp last_seen_at forever — hammering the API and silencing
  // this conversation's bell for the whole shift.
  //
  // The cadence follows the conversation instead of being one fixed number. A
  // live exchange is polled every second, because "wait up to three seconds for
  // his answer" is the whole complaint; a thread nobody has touched in ten
  // minutes drops to eight, because the alternative is every open dock in the
  // plant asking a question all day whose answer is already known to be "no".
  // A self-scheduling timeout, not setInterval: the delay has to be recomputed
  // from what the LAST poll found, and intervals cannot change their minds.
  useEffect(() => {
    if (!activeId || !open || view !== 'thread') return;
    let live = true, timer = null;
    lastMsgIdRef.current = 0;
    lastTrafficRef.current = Date.now();
    stickRef.current = true;
    const tick = async () => {
      if (!live || pollingRef.current) return;
      if (!document.hidden) {
        pollingRef.current = true;
        const after = lastMsgIdRef.current;
        try {
          const r = await api.get(`/chat/conversations/${activeId}/messages${after ? `?after=${after}` : ''}`);
          if (!live) return;
          setMembers(r.members || []);
          if (r.messages?.length) {
            lastMsgIdRef.current = Math.max(after, ...r.messages.map(m => m.id));
            lastTrafficRef.current = Date.now();
            setMessages(prev => mergeMessages(after ? prev : [], r.messages));
          }
        } catch { /* keep prior messages — thread polls fail silently */ } finally { pollingRef.current = false; }
      }
      if (!live) return;
      const quiet = Date.now() - lastTrafficRef.current;
      timer = setTimeout(tick, quiet < 90_000 ? 1000 : quiet < 600_000 ? 3000 : 8000);
    };
    tick();
    // Coming back to the tab must not cost a poll interval — the messages that
    // arrived while it was hidden are exactly the ones being come back for.
    const wake = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      live = false; clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [activeId, open, view]);

  // Pin the scroller to the newest message unless the reader scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, view, showMembers]);

  // ── Read tracking — POST only when the newest visible id advances ─────────
  useEffect(() => {
    if (!open || view !== 'thread' || !activeId || !messages.length || document.hidden) return;
    // The newest REAL id. An optimistic bubble carries a synthetic id above
    // every serial Postgres will ever issue, and the read pointer is a
    // monotonic GREATEST() — posting one would pin this conversation "read"
    // past every future message and silence it for good.
    let newest = 0;
    for (const m of messages) if (!isPending(m) && m.id > newest) newest = m.id;
    if (!newest || newest <= (lastReadRef.current[activeId] || 0)) return;
    lastReadRef.current[activeId] = newest;
    api.post(`/chat/conversations/${activeId}/read`, { message_id: newest }).catch(() => {});
    setConvs(cs => cs.map(c => (c.id === activeId ? { ...c, unread: 0 } : c)));
    // The row that opened this thread painted its badge from a summary the page
    // fetched once. Without this the badge stays lit behind the dock until the
    // page is reloaded — the reader is looking straight at the messages it
    // claims are unread. ThreadCell listens and clears itself.
    const addr = threadEntityRef.current.get(activeId)
      || (activeConv?.entity && activeConv?.entity_id != null
        ? { entity: activeConv.entity, entityId: activeConv.entity_id }
        : activeConv?.job_card_id ? { entity: 'job_card', entityId: activeConv.job_card_id } : null);
    if (addr) window.dispatchEvent(new CustomEvent('ci-thread-read', { detail: addr }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, activeId, messages]);

  // Outside click closes the panel (and any open message menu) — bell idiom.
  useEffect(() => {
    const h = e => {
      // Miss BOTH: the panel is portalled out of the header, so it is not a
      // descendant of the trigger and a contains() check on one alone would
      // close the dock on every click inside it.
      if (!panelRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) { setOpen(false); setMenuFor(null); }
      else if (!e.target.closest?.('[data-msgmenu]')) setMenuFor(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // ── External open — Production's "Discuss", the bell's chat handoff, and
  // ANY record's thread cell. The third path is what lets 17 modules mount
  // discussion without one of them owning a line of chat code: the server
  // find-or-creates the (entity, entityId) thread and this panel shows it.
  useEffect(() => {
    const h = async e => {
      const d = e.detail || {};
      const entityId = d.entityId ?? d.entity_id;
      try {
        if (d.conversationId) {
          openThread(d.conversationId);
        } else if (d.jobCardId) {
          const c = await api.get(`/job-cards/${d.jobCardId}/chat`);
          setConvs(cs => (cs.some(x => x.id === c.id) ? cs : [c, ...cs]));
          openThread(c.id, c);
        } else if (!d.conversationId && !d.jobCardId && !d.entity) {
          // No address at all — the keyboard chord. Open on the list; there is
          // no thread to resolve and guessing one would be worse than the inbox.
          setView('list'); setOpen(true);
        } else if (d.entity && entityId != null) {
          const c = await api.get(`/threads/${d.entity}/${entityId}`);
          threadEntityRef.current.set(c.id, { entity: d.entity, entityId });
          setConvs(cs => (cs.some(x => x.id === c.id) ? cs : [c, ...cs]));
          openThread(c.id, c);
        }
      } catch { /* central handler already toasted */ }
    };
    window.addEventListener('ci-chat-open', h);
    return () => window.removeEventListener('ci-chat-open', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openThread = (id, meta) => {
    // Re-opening the thread that is already active must not wipe its history —
    // the poll effect only re-runs on real changes, so a wipe here would leave
    // an empty pane polling from a stale high-water mark.
    if (id === activeIdRef.current) { setShowMembers(false); setMenuFor(null); setView('thread'); setOpen(true); return; }
    setMessages([]); setMembers([]); setShowMembers(false); setMenuFor(null);
    setText(''); setPendingTags([]);
    setActiveId(id);
    setActiveMeta(meta || null);
    // Follow the conversation into its own tab. A bell handoff or a Discuss
    // button can open a record thread while the list is filtered to DMs, and
    // pressing Back onto a list that does not contain the thread you were just
    // reading reads as "it disappeared". Already on All → nothing to change.
    const scopeTo = conv => {
      if (!conv?.kind || inboxTab === 'all') return;
      const b = bucketOf(conv);
      if (b === 'dm' || b === 'group' || b === 'record') setInboxTab(b);
    };
    if (meta) scopeTo(meta);
    if (!meta) {
      // Opened by bare id (bell handoff) — fetch the detail so the header has
      // a label before the list poll catches up.
      api.get(`/chat/conversations/${id}`).then(d => {
        const conv = d?.conversation || d?.conv || (d?.id ? d : null);
        if (conv?.id) { setActiveMeta(conv); scopeTo(conv); }
        if (d?.members) setMembers(d.members);
      }).catch(() => {});
    }
    setView('thread');
    setOpen(true);
  };
  const backToList = () => { setView('list'); setActiveId(null); setActiveMeta(null); setShowMembers(false); };

  const openNew = () => {
    setView('new'); setGroupMode(false); setGroupName(''); setGroupSel([]); setUserQ(''); setMemberQ('');
    if (!users) api.get('/chat/users').then(setUsers).catch(() => {});
  };
  const startDm = async u => {
    try {
      const c = await api.post('/chat/conversations', { kind: 'dm', user_id: u.id });
      setConvs(cs => (cs.some(x => x.id === c.id) ? cs : [c, ...cs]));
      openThread(c.id, c);
    } catch { /* central toast */ }
  };
  const createGroup = async () => {
    try {
      const c = await api.post('/chat/conversations', { kind: 'group', name: groupName.trim(), member_ids: groupSel });
      setConvs(cs => [c, ...cs]);
      openThread(c.id, c);
      toast.success(`${c.label || groupName} created`);
    } catch { /* central toast */ }
  };

  const openJobTag = () => { setOpen(false); nav('/production'); };

  const removeMessage = async m => {
    setMenuFor(null);
    try {
      await api.post(`/chat/messages/${m.id}/remove`);
      setMessages(prev => prev.map(x => (x.id === m.id ? { ...x, removed_at: new Date().toISOString(), body: null, attachments: [] } : x)));
    } catch { /* central toast */ }
  };

  // ── Composer ──────────────────────────────────────────────────────────────
  const growComposer = el => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`; // 1–4 rows
  };
  useEffect(() => { growComposer(document.getElementById('ci-chat-composer')); }, [text, view]);

  const onType = e => {
    setText(e.target.value);
    // Presence — throttled to one POST per 3s while keys land.
    if (activeId && Date.now() - typingAtRef.current >= 3000) {
      typingAtRef.current = Date.now();
      api.post(`/chat/conversations/${activeId}/typing`).catch(() => {});
    }
  };

  // Paint the bubble, THEN talk to the server. The round trip to Mumbai plus a
  // cold serverless instance can run to a second or more, and for that whole
  // second the old code left the typed text sitting in the box with no feedback
  // — which on a noisy floor reads as "it didn't go", so the operator presses
  // send again. The only honest answer to pressing send is the message
  // appearing. A failure marks that exact bubble rather than raising a toast
  // that leaves you guessing which line was lost.
  const postMessage = (body, tags, reuseId) => {
    const tempId = reuseId ?? (pendingIdRef.current += 1);
    const convId = activeId;
    stickRef.current = true;
    lastTrafficRef.current = Date.now(); // a reply is likely — poll hard for it
    setMessages(prev => mergeMessages(prev.filter(m => m.id !== tempId), [{
      id: tempId, conversation_id: convId, sender_id: me?.id, sender_name: me?.name,
      kind: 'text', body, created_at: new Date().toISOString(),
      attachments: [], job_tags: tags.map(t => ({ job_card_id: t.id, jc_number: t.jc_number })),
    }]));
    api.post(`/chat/conversations/${convId}/messages`, { body, job_tags: tags.map(t => t.id) })
      .then(m => {
        // Landing a reply into a thread the reader has since left would resurrect
        // a closed conversation's state; the message is safely on the server.
        if (activeIdRef.current !== convId) return;
        lastMsgIdRef.current = Math.max(lastMsgIdRef.current, m.id);
        setMessages(prev => mergeMessages(prev.filter(x => x.id !== tempId), [m]));
      })
      .catch(() => setMessages(prev => prev.map(x => (x.id === tempId ? { ...x, failed: true } : x))));
  };

  const send = () => {
    const body = text.trim();
    if (!body || !activeId) return;
    const tags = pendingTags;
    setText(''); setPendingTags([]);
    postMessage(body, tags);
  };

  const retry = m => postMessage(m.body, (m.job_tags || []).map(t => ({ id: t.job_card_id, jc_number: t.jc_number })), m.id);

  const sendFile = async file => {
    if (!file || !activeId) return;
    setUploading(true);
    try {
      let out = file;
      if (file.type.startsWith('image/') && file.size > 1048576) out = await compressImage(file);
      // Pre-flight the 4 MB cap (Vercel's serverless body limit is the real
      // ceiling) so the user hears it BEFORE the bytes leave the phone.
      if (out.size > 4 * 1024 * 1024) {
        toast.error('Files are capped at 4 MB — this one is ' + fmt.num(Math.round(out.size / 1024 / 1024 * 10) / 10) + ' MB');
        return;
      }
      const m = await api.upload(`/chat/conversations/${activeId}/attachments`, out, {
        body: text.trim(),
        job_tags: pendingTags.length ? JSON.stringify(pendingTags.map(t => t.id)) : '',
      });
      lastMsgIdRef.current = Math.max(lastMsgIdRef.current, m.id);
      stickRef.current = true;
      setMessages(prev => mergeMessages(prev, [m]));
      setText(''); setPendingTags([]);
    } catch { /* central toast */ } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // ── `#` job tagging — lazy /chat/jobs, filtered with searchText ───────────
  const tagMatch = /(^|\s)#([^\s#]*)$/.exec(text);
  useEffect(() => {
    if (!tagMatch || jobs || jobsLoadingRef.current) return;
    jobsLoadingRef.current = true;
    api.get('/chat/jobs').then(setJobs).catch(() => { jobsLoadingRef.current = false; });
  }, [tagMatch, jobs]);
  const jobQ = (tagMatch?.[2] || '').toLowerCase();
  const jobMatches = tagMatch && jobs
    ? jobs.filter(j => !jobQ || searchText(j).toLowerCase().includes(jobQ)).slice(0, 8)
    : [];
  const pickJob = j => {
    setText(t => t.replace(/#[^\s#]*$/, `#${j.jc_number} `));
    setPendingTags(tags => (tags.some(t => t.id === j.id) ? tags : [...tags, { id: j.id, jc_number: j.jc_number }]));
    document.getElementById('ci-chat-composer')?.focus();
  };

  // ── `@` mentions — the `#` tagger's twin, over /chat/mention-targets ──────
  // The list is fetched on first need and kept for the session; a thread that
  // merely SHOWS a mention pulls it too, because the chips need the map to tell
  // a team from a person from me.
  const mentionMatch = /(^|\s)@([^\s@]*)$/.exec(text);
  const showsMention = messages.some(m => (m.body || '').includes('@['));
  useEffect(() => {
    if ((!mentionMatch && !showsMention) || mentions || mentionsLoadingRef.current) return;
    mentionsLoadingRef.current = true;
    api.get('/chat/mention-targets').then(setMentions).catch(() => { mentionsLoadingRef.current = false; });
  }, [mentionMatch, showsMention, mentions]);
  const mentionQ = (mentionMatch?.[2] || '').toLowerCase();
  const mentionMatches = mentionMatch && mentions
    ? mentions.filter(t => !mentionQ || searchText(t).toLowerCase().includes(mentionQ)).slice(0, 8)
    : [];
  // The highlight follows the list, never a stale index into a shorter one.
  useEffect(() => { setMentionIdx(0); }, [mentionQ]);
  const activeMention = mentionMatches[Math.min(mentionIdx, mentionMatches.length - 1)];
  // Unlike a job tag there is no pending state to carry: the server parses
  // `@[handle]` out of the body itself, so the text IS the mention.
  const pickMention = t => {
    setText(s => s.replace(/@[^\s@]*$/, `@[${t.handle}] `));
    document.getElementById('ci-chat-composer')?.focus();
  };
  // Whether a handle points at ME decides the loudest chip in the thread, so it
  // reads every signal the endpoint might carry before falling back to the name:
  // under-reporting a mention loses the one thing mentions are for.
  const mentionsMe = t => {
    if (!t || !me) return false;
    if (t.kind === 'team') return Array.isArray(t.member_ids) && t.member_ids.includes(me.id);
    if (t.user_id != null) return t.user_id === me.id;
    return !!me.name && (t.label || '').toLowerCase().startsWith(me.name.toLowerCase());
  };
  const mentionInfo = handle => {
    const t = (mentions || []).find(x => x.handle === handle);
    return { label: t?.label || `@${handle}`, team: t?.kind === 'team', me: mentionsMe(t) };
  };

  // ── Voice — hold-to-record, slide away or Escape to cancel ────────────────
  // `stopping` latches the FIRST stop decision: on touch, pointerup is chased
  // by an immediate pointerleave (the touch pointer ceases to exist), and
  // without the latch that leave would cancel a note the release just sent.
  const stopRecording = cancel => {
    const r = recRef.current;
    if (!r || r.stopping) return;
    r.stopping = true;
    if (cancel) r.cancelled = true;
    try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch { /* already stopped */ }
  };
  const startRecording = async () => {
    if (recRef.current || !activeId) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error('Microphone access denied — allow the mic to send voice notes');
      return;
    }
    // First-time mic use pops the permission prompt mid-press: the finger has
    // long lifted by the time getUserMedia resolves, and starting now would
    // leave an unattended recording that auto-SENDS 3 minutes of plant audio.
    if (!micHeldRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
    // iPhone Safari records mp4, everything else webm/opus.
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      toast.error('Voice notes are not supported on this device');
      return;
    }
    const r = { recorder, stream, chunks: [], cancelled: false, stopping: false, startedAt: Date.now(), timer: null, convId: activeId };
    recorder.ondataavailable = e => { if (e.data?.size) r.chunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(r.timer);
      r.stream.getTracks().forEach(t => t.stop());
      recRef.current = null;
      setRec(null);
      const secs = Math.min(180, Math.max(1, Math.round((Date.now() - r.startedAt) / 1000)));
      if (r.cancelled || !r.chunks.length) return;
      const type = recorder.mimeType || mime || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : 'webm';
      const file = new File(r.chunks, `voice-${Date.now()}.${ext}`, { type });
      setUploading(true);
      api.upload(`/chat/conversations/${r.convId}/attachments`, file, { duration_secs: String(secs) })
        .then(m => {
          // The thread may have changed while the note uploaded — only merge
          // into the messages list if it still shows the recorded conversation.
          if (r.convId === activeIdRef.current) {
            lastMsgIdRef.current = Math.max(lastMsgIdRef.current, m.id);
            stickRef.current = true;
            setMessages(prev => mergeMessages(prev, [m]));
          }
        })
        .catch(() => {})
        .finally(() => setUploading(false));
    };
    recRef.current = r;
    setRec({ secs: 0 });
    recorder.start();
    r.timer = setInterval(() => {
      const secs = Math.round((Date.now() - r.startedAt) / 1000);
      setRec({ secs });
      if (secs >= 180) stopRecording(false); // cap — auto-stop and send
    }, 250);
  };
  // Escape cancels a live recording; unmount discards it and frees the mic.
  useEffect(() => {
    if (!rec) return;
    const h = e => { if (e.key === 'Escape') stopRecording(true); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [rec]);
  useEffect(() => () => {
    const r = recRef.current;
    if (!r) return;
    r.cancelled = true;
    try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch { /* noop */ }
    r.stream.getTracks().forEach(t => t.stop());
    clearInterval(r.timer);
  }, []);

  // ── Members panel (groups) ────────────────────────────────────────────────
  const isGroupAdmin = activeConv?.my_role === 'admin' || me?.role === 'admin';
  const editMembers = async patch => {
    try {
      const d = await api.post(`/chat/conversations/${activeId}/members`, patch);
      if (d?.members) setMembers(d.members);
      else api.get(`/chat/conversations/${activeId}`).then(x => x?.members && setMembers(x.members)).catch(() => {});
    } catch { /* central toast */ }
  };
  const openMembers = () => {
    setShowMembers(s => !s);
    if (!users) api.get('/chat/users').then(setUsers).catch(() => {});
  };

  // DM seen — the other member has read up to my newest message.
  const otherRead = activeConv?.kind === 'dm'
    ? members.find(mm => mm.user_id !== me?.id)?.last_read_message_id || 0
    : 0;
  const lastOwnId = [...messages].reverse().find(m => m.sender_id === me?.id && !m.removed_at && !isPending(m) && m.kind !== 'system')?.id;
  const typers = members.filter(mm => mm.user_id !== me?.id && mm.typing).map(mm => mm.name);

  const label = activeConv?.label || activeConv?.name || 'Conversation';
  const filteredUsers = (users || []).filter(u => !userQ || searchText(u).toLowerCase().includes(userQ.toLowerCase()));
  const filteredMemberPick = (users || []).filter(u => !memberQ || searchText(u).toLowerCase().includes(memberQ.toLowerCase()));

  const avatarFor = c => (
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
      c.kind === 'job' ? 'bg-violet-50 text-violet-600'
      : c.kind === 'group' ? 'bg-[#E1EFFF] text-[#007AFF]'
      : 'bg-gradient-to-b from-[#2E95FF] to-[#007AFF] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]'
    }`}>
      {c.kind === 'job' ? <Wrench size={14} /> : c.kind === 'group' ? <Users size={14} /> : (c.label || '?').slice(0, 1).toUpperCase()}
    </span>
  );

  return (
    // The bell owns bottom-4 — the dock floats one slot above it.
    <div className="no-print relative shrink-0" ref={panelRef}>
      {open && createPortal(
        <div ref={popRef} className="glass fixed inset-0 z-[60] flex origin-top-right animate-liquidPop flex-col overflow-hidden rounded-none shadow-modal sm:inset-auto sm:top-[58px] sm:right-3 sm:h-[min(600px,78vh)] sm:max-h-[78vh] sm:w-[420px] sm:rounded-[22px]">

          {/* ── List view ─────────────────────────────────────────────── */}
          {view === 'list' && (
            <>
              <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.06] px-4 py-3">
                <div>
                  <p className="text-sm font-bold text-[#1D1D1F]">CI Messenger</p>
                  <p className="text-xs text-[#86868B]">DMs, rooms &amp; job threads</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" onClick={openNew}><Plus size={13} /> New</Button>
                  <button onClick={() => setOpen(false)} title="Close"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[#86868B] hover:bg-white/70 hover:text-[#1D1D1F]">
                    <X size={15} />
                  </button>
                </div>
              </div>
              {/* One inbox, four ways in. A plant this size puts a DM from a
                  supervisor, a Plant Floor room and forty record threads in one
                  column, and the DM is the one nobody else will answer — so
                  that is where the messenger opens. A chip carries how many
                  rooms are in its bucket, and a blue dot when something in
                  there is unread, so the tab you are NOT on can still call. */}
              <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[#1D1D1F]/[0.06] px-3 py-2 scrollbar-none">
                {INBOX_TABS.map(t => {
                  const on = inboxTab === t.key;
                  const s = stat(t.key);
                  return (
                    <button key={t.key} type="button" title={t.hint}
                      onClick={() => setInboxTab(t.key)}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors touch:min-h-[36px] ${
                        on ? 'bg-[#007AFF] text-white shadow-sm' : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73] hover:bg-[#1D1D1F]/[0.09]'}`}>
                      {t.label}
                      <span className={`tabular-nums ${on ? 'text-white/70' : 'text-[#B4B4B9]'}`}>{s.n}</span>
                      {s.unread > 0 && (
                        <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-white' : 'bg-[#007AFF]'}`}
                          title={`${s.unread} unread`} />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {shownConvs.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/70 text-[#B8B8BD] ring-1 ring-white/80">
                      <MessageCircle size={20} />
                    </span>
                    <p className="text-sm font-medium text-[#86868B]">
                      {convs.length === 0 ? 'No conversations yet — start one'
                        : inboxTab === 'dm' ? 'No direct messages yet'
                        : inboxTab === 'group' ? 'You are in no rooms yet'
                        : inboxTab === 'record' ? 'No job or order threads yet'
                        : 'No conversations yet — start one'}
                    </p>
                    {/* When the inbox has rooms but this tab does not, the way
                        out is another tab, not a new conversation. */}
                    {convs.length > 0 && inboxTab !== 'all' ? (
                      <Button size="sm" variant="secondary" onClick={() => setInboxTab('all')}>
                        Show all {convs.length}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={openNew}><Plus size={13} /> New message</Button>
                    )}
                  </div>
                )}
                {shownConvs.map(c => (
                  <button key={c.id} onClick={() => openThread(c.id, c)}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/60">
                    {avatarFor(c)}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-[13px] ${c.unread ? 'font-bold text-[#1D1D1F]' : 'font-semibold text-[#3A3A3C]'}`}>{c.label}</span>
                        {c.last_message && <span className="shrink-0 text-[10px] tabular-nums text-[#B4B4B9]">{fmt.dt(c.last_message.created_at)}</span>}
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className={`truncate text-xs ${c.unread ? 'font-semibold text-[#515154]' : 'text-[#86868B]'}`}>
                          {c.kind !== 'dm' && c.last_message?.sender_name && !c.last_message.removed_at
                            ? `${c.last_message.sender_id === me?.id ? 'You' : c.last_message.sender_name}: ` : ''}
                          {preview(c.last_message)}
                        </span>
                        {c.unread > 0 && (
                          <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#007AFF] px-1 text-[10px] font-bold text-white">
                            {c.unread > 99 ? '99+' : c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ── New view — DM picker + group creator ──────────────────── */}
          {view === 'new' && (
            <>
              <div className="flex items-center gap-2 border-b border-[#1D1D1F]/[0.06] px-3 py-3">
                <button onClick={() => (groupMode ? setGroupMode(false) : backToList())} title="Back"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[#515154] hover:bg-white/70">
                  <ChevronLeft size={17} />
                </button>
                <p className="flex-1 text-sm font-bold text-[#1D1D1F]">{groupMode ? 'New group' : 'New message'}</p>
                <button onClick={() => setOpen(false)} title="Close"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[#86868B] hover:bg-white/70 hover:text-[#1D1D1F]">
                  <X size={15} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {!groupMode ? (
                  <>
                    <SearchInput value={userQ} onChange={setUserQ} placeholder="Search people…" />
                    <button onClick={() => setGroupMode(true)}
                      className="mt-2 flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/60">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#E1EFFF] text-[#007AFF]"><Users size={15} /></span>
                      <span className="text-[13px] font-semibold text-[#007AFF]">New group</span>
                    </button>
                    <div className="mt-1 border-t border-[#1D1D1F]/[0.05] pt-1">
                      {users == null && <p className="px-2 py-3 text-xs text-[#86868B]">Loading people…</p>}
                      {users != null && filteredUsers.length === 0 && <p className="px-2 py-3 text-xs text-[#86868B]">No one matches</p>}
                      {filteredUsers.map(u => (
                        <button key={u.id} onClick={() => startDm(u)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/60">
                          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-b from-[#2E95FF] to-[#007AFF] text-xs font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
                            {(u.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-[#1D1D1F]">{u.name}</span>
                            <span className="block text-[11px] capitalize text-[#86868B]">{u.role}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    <Input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="Group name" maxLength={60} autoFocus />
                    <SearchInput value={memberQ} onChange={setMemberQ} placeholder="Search people…" />
                    <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl bg-white/40 p-2">
                      {filteredMemberPick.map(u => (
                        <Checkbox key={u.id} label={`${u.name} — ${fmt.title(u.role)}`}
                          checked={groupSel.includes(u.id)}
                          onChange={e => setGroupSel(s => (e.target.checked ? [...s, u.id] : s.filter(id => id !== u.id)))} />
                      ))}
                      {users != null && filteredMemberPick.length === 0 && <p className="px-1 py-2 text-xs text-[#86868B]">No one matches</p>}
                    </div>
                    <Button className="w-full" disabled={!groupName.trim() || !groupSel.length} onClick={createGroup}>
                      <Users size={14} /> Create group{groupSel.length ? ` (${groupSel.length})` : ''}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Thread view ───────────────────────────────────────────── */}
          {view === 'thread' && (
            <>
              <div className="flex items-center gap-2 border-b border-[#1D1D1F]/[0.06] px-3 py-2.5">
                <button onClick={backToList} title="Back"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#515154] hover:bg-white/70">
                  <ChevronLeft size={17} />
                </button>
                {activeConv && avatarFor(activeConv)}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-[#1D1D1F]">{label}</p>
                  <p className="truncate text-[11px] text-[#86868B]">
                    {typers.length > 0
                      ? `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…`
                      : activeConv?.kind === 'dm' ? 'Direct message'
                      : `${members.length || activeConv?.members || 0} members`}
                  </p>
                </div>
                {activeConv?.kind !== 'dm' && (
                  <button onClick={openMembers} title="Members"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${showMembers ? 'bg-[#E1EFFF] text-[#007AFF]' : 'text-[#86868B] hover:bg-white/70 hover:text-[#007AFF]'}`}>
                    <Users size={15} />
                  </button>
                )}
                <button onClick={() => setOpen(false)} title="Close"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#86868B] hover:bg-white/70 hover:text-[#1D1D1F]">
                  <X size={15} />
                </button>
              </div>

              {showMembers ? (
                <div className="flex-1 overflow-y-auto p-3">
                  <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-[#86868B]">Members · {members.length}</p>
                  {members.map(mm => (
                    <div key={mm.user_id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/60">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#E1EFFF] text-xs font-bold text-[#007AFF]">
                        {(mm.name || '?').slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-[#1D1D1F]">
                          {mm.name}{mm.user_id === me?.id ? ' (you)' : ''}
                        </span>
                        <span className="block text-[10px] capitalize text-[#86868B]">{mm.role}</span>
                      </span>
                      {activeConv?.kind === 'group' && isGroupAdmin && mm.user_id !== me?.id && (
                        <button onClick={() => editMembers({ add: [], remove: [mm.user_id] })} title={`Remove ${mm.name}`}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-[#86868B] hover:bg-red-50 hover:text-red-600">
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                  {activeConv?.kind === 'group' && isGroupAdmin && (
                    <div className="mt-3 border-t border-[#1D1D1F]/[0.05] pt-3">
                      <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-[#86868B]">Add people</p>
                      <SearchInput value={memberQ} onChange={setMemberQ} placeholder="Search people…" />
                      <div className="mt-1.5">
                        {filteredMemberPick.filter(u => !members.some(mm => mm.user_id === u.id)).slice(0, 8).map(u => (
                          <button key={u.id} onClick={() => editMembers({ add: [u.id], remove: [] })}
                            className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-white/60">
                            <UserPlus size={13} className="text-[#007AFF]" />
                            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#1D1D1F]">{u.name}</span>
                            <span className="text-[10px] capitalize text-[#86868B]">{u.role}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div ref={listRef} className="flex-1 overflow-y-auto py-2"
                    onScroll={e => { const el = e.target; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
                    {messages.length === 0 && (
                      <p className="px-6 py-10 text-center text-sm text-[#86868B]">Say hello — this thread is new.</p>
                    )}
                    {messages.map((m, i) => {
                      const prev = messages[i - 1];
                      const newDay = !prev || ts(prev.created_at).toDateString() !== ts(m.created_at).toDateString();
                      const mine = m.sender_id === me?.id;
                      return (
                        <Fragment key={m.id}>
                          {newDay && (
                            <div className="my-2 text-center">
                              <span className="inline-block rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">
                                {dayLabel(m.created_at)}
                              </span>
                            </div>
                          )}
                          <Bubble m={m} mine={mine} showName={activeConv?.kind !== 'dm'}
                            onTagClick={openJobTag} fetchUrl={fetchUrl} onZoom={setZoom}
                            mentionInfo={mentionInfo}
                            removable={canRemove(m, me?.id)}
                            onRemove={() => removeMessage(m)}
                            onRetry={() => retry(m)}
                            menuOpen={menuFor === m.id}
                            onMenuToggle={() => setMenuFor(f => (f === m.id ? null : m.id))}
                            seen={mine && m.id === lastOwnId && otherRead >= m.id} />
                        </Fragment>
                      );
                    })}
                    {typers.length > 0 && (
                      <p className="px-4 pt-1 text-[11px] font-medium text-[#86868B]">
                        {typers.join(', ')} {typers.length > 1 ? 'are' : 'is'} typing…
                      </p>
                    )}
                  </div>

                  {/* `#` job picker — floats over the composer */}
                  {tagMatch && (
                    <div className="max-h-44 overflow-y-auto border-t border-[#1D1D1F]/[0.06] bg-white/70 px-2 py-1.5 backdrop-blur-md">
                      <p className="flex items-center gap-1 px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">
                        <Hash size={10} /> Tag a job card
                      </p>
                      {jobs == null && <p className="px-2 py-1 text-xs text-[#86868B]">Loading jobs…</p>}
                      {jobs != null && jobMatches.length === 0 && <p className="px-2 py-1 text-xs text-[#86868B]">No open jobs match</p>}
                      {jobMatches.map(j => (
                        <button key={j.id} onClick={() => pickJob(j)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[#0A84FF]/[0.08]">
                          <span className="shrink-0 text-xs font-bold text-[#0064D2]">{j.jc_number}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-[#515154]">{j.product_name}</span>
                          <span className="shrink-0 text-[10px] text-[#86868B]">{fmt.title(j.status)}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* `@` mention picker — the same floating list, keyboard-driven
                      because a mention only counts once it lands as `@[handle]` */}
                  {mentionMatch && (
                    <div className="max-h-44 overflow-y-auto border-t border-[#1D1D1F]/[0.06] bg-white/70 px-2 py-1.5 backdrop-blur-md">
                      <p className="flex items-center gap-1 px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">
                        <AtSign size={10} /> Mention a person or team
                      </p>
                      {mentions == null && <p className="px-2 py-1 text-xs text-[#86868B]">Loading people…</p>}
                      {mentions != null && mentionMatches.length === 0 && <p className="px-2 py-1 text-xs text-[#86868B]">Nobody matches</p>}
                      {mentionMatches.map((t, i) => (
                        <button key={t.id ?? t.handle} onClick={() => pickMention(t)} onMouseEnter={() => setMentionIdx(i)}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[#0A84FF]/[0.08] ${t === activeMention ? 'bg-[#0A84FF]/[0.08]' : ''}`}>
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${t.kind === 'team' ? 'bg-violet-100 text-violet-600' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>
                            {t.kind === 'team' ? <Users size={11} /> : <AtSign size={11} />}
                          </span>
                          <span className="shrink-0 text-xs font-bold text-[#0064D2]">{t.handle}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-[#515154]">{t.label}</span>
                          {mentionsMe(t) && <span className="shrink-0 text-[10px] font-bold text-[#86868B]">you</span>}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Pending tag chips — sent as job_tags with the next message */}
                  {pendingTags.length > 0 && !tagMatch && (
                    <div className="flex flex-wrap gap-1 border-t border-[#1D1D1F]/[0.06] bg-white/40 px-3 pt-2">
                      {pendingTags.map(t => (
                        <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-[#E1EFFF] px-2 py-0.5 text-[11px] font-bold text-[#0064D2]">
                          <Wrench size={10} />{t.jc_number}
                          <button onClick={() => setPendingTags(tags => tags.filter(x => x.id !== t.id))} title="Remove tag"
                            className="rounded-full hover:bg-[#0064D2]/10"><X size={10} /></button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Composer — Enter sends, Shift+Enter newline; mic is hold-to-record */}
                  <div className="flex items-end gap-1.5 border-t border-[#1D1D1F]/[0.06] bg-white/40 p-2.5">
                    {rec ? (
                      <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[18px] bg-red-50 px-3 ring-1 ring-inset ring-red-100">
                        <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
                        <span className="shrink-0 text-sm font-bold tabular-nums text-red-600">{mss(rec.secs)}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-red-400">Release to send · slide off or Esc to cancel</span>
                      </div>
                    ) : (
                      <>
                        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} title="Attach a file"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#86868B] transition-colors hover:bg-white/70 hover:text-[#007AFF] disabled:opacity-50">
                          <Paperclip size={16} />
                        </button>
                        <Textarea id="ci-chat-composer" rows={1} value={text} onChange={onType}
                          onInput={e => growComposer(e.target)}
                          onKeyDown={e => {
                            // While the `@` picker is up it owns the arrows and
                            // Enter. A half-typed "@rah" that gets SENT is inert
                            // — the server only sees a mention in `@[handle]` —
                            // so Enter has to complete it, the way every other
                            // messenger behaves. Nothing here fires when the
                            // picker is closed, so plain Enter still sends and
                            // the `#` tagger keeps its own behaviour untouched.
                            if (mentionMatch && activeMention) {
                              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => (i + 1) % mentionMatches.length); return; }
                              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
                              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(activeMention); return; }
                            }
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                          }}
                          placeholder={`Message ${label}…`}
                          className="!min-h-0 max-h-[104px] flex-1 resize-none rounded-[18px] py-2" />
                      </>
                    )}
                    <button type="button" title="Hold to record a voice note"
                      onPointerDown={e => { e.preventDefault(); micHeldRef.current = true; startRecording(); }}
                      onPointerUp={() => { micHeldRef.current = false; stopRecording(false); }}
                      onPointerLeave={() => { micHeldRef.current = false; stopRecording(true); }}
                      onPointerCancel={() => { micHeldRef.current = false; stopRecording(true); }}
                      onPointerMove={e => {
                        // Touch implicitly captures the pointer, so sliding a
                        // finger off the mic never fires pointerleave — track
                        // the coordinates ourselves: leave the button (+pad)
                        // while recording and the note is discarded, exactly
                        // what "slide away to cancel" promises.
                        if (!recRef.current || recRef.current.stopping) return;
                        const b = e.currentTarget.getBoundingClientRect();
                        const pad = 28;
                        if (e.clientX < b.left - pad || e.clientX > b.right + pad
                          || e.clientY < b.top - pad || e.clientY > b.bottom + pad) {
                          micHeldRef.current = false;
                          stopRecording(true);
                        }
                      }}
                      onContextMenu={e => e.preventDefault()}
                      className={`flex h-9 w-9 shrink-0 touch-none select-none items-center justify-center rounded-full transition-colors ${
                        rec ? 'animate-pulse bg-red-500 text-white shadow-[0_6px_16px_rgba(255,59,48,0.35)]'
                        : 'text-[#86868B] hover:bg-white/70 hover:text-[#007AFF]'}`}>
                      <Mic size={16} />
                    </button>
                    <button type="button" onClick={send} disabled={!text.trim() || uploading || !!rec} title="Send"
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all ${
                        text.trim() && !rec
                          ? 'bg-gradient-to-b from-[#2E95FF] to-[#0071F0] text-white shadow-[0_6px_16px_rgba(0,122,255,0.35),inset_0_1px_0_rgba(255,255,255,0.45)]'
                          : 'bg-[#1D1D1F]/[0.05] text-[#B4B4B9]'} disabled:opacity-60`}>
                      <Send size={15} className="-ml-0.5 mt-0.5" />
                    </button>
                    <input ref={fileRef} type="file" className="hidden" onChange={e => sendFile(e.target.files?.[0])} />
                  </div>
                </>
              )}
            </>
          )}
        </div>, document.body)}

      {/* Image lightbox — tap-to-full for photo attachments */}
      {zoom && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#1D1D1F]/80 p-4 backdrop-blur-sm" onClick={() => setZoom(null)}>
          <img src={zoom} alt="attachment" className="max-h-[90vh] max-w-[92vw] rounded-2xl object-contain shadow-modal" />
        </div>
      )}

      {/* The trigger, in the header. `Messages 12` reads across a plant floor;
          the 40px circle this replaced did not, which is why unread work sat
          unread for a whole shift. Being NAMED outranks being counted, so a
          mention turns the capsule red and swaps the icon to an @ — the state
          survives for anyone who cannot separate the two hues. */}
      <CountButton
        icon={mentionedAnywhere ? AtSign : MessageCircle}
        label="Messages"
        count={countOf(unreadTotal)}
        tone={rung({ mentioned: mentionedAnywhere, waiting: 0 })}
        title={[
          unreadTotal ? plural(unreadTotal, 'unread message') : 'No unread messages',
          mentionedAnywhere ? 'you were mentioned' : null,
          'open CI Messenger (g m)',
        ].filter(Boolean).join(' · ')}
        onClick={() => setOpen(o => !o)}
      />
    </div>
  );
}
