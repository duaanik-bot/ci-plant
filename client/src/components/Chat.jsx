// CI Messenger — the floating chat dock, the NotificationBell's sibling.
// DMs, group rooms and one thread per job card; text, hold-to-record voice
// notes, photos/files and `#` job tagging. Polling transport (list 15s closed /
// 5s open, thread 3s incremental) matching the app's refresh idiom.
import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageCircle, X, ChevronLeft, Send, Mic, Paperclip, Plus, Users, Wrench,
  Play, Pause, FileText, Download, Trash2, MoreHorizontal, UserPlus, Hash,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { Button, Input, Textarea, Checkbox, SearchInput, searchText, useToast } from './ui.jsx';

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

const REMOVE_WINDOW_MS = 10 * 60 * 1000;
const canRemove = (m, meId) =>
  m.kind !== 'system' && !m.removed_at && m.sender_id === meId
  && Date.now() - ts(m.created_at).getTime() <= REMOVE_WINDOW_MS;

// Newest-first merge by id — polls race sends, so the same message can arrive
// twice; the Map collapses duplicates and the sort restores thread order.
const mergeMessages = (prev, incoming) => {
  if (!incoming?.length) return prev;
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
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

// One message bubble. `seen` renders the DM read receipt under my newest read
// message; the ⋯ affordance appears on hover (desktop) or long-press (floor
// phones) and only while the 10-minute removal window is open.
function Bubble({ m, mine, showName, onTagClick, fetchUrl, onZoom, removable, onRemove, menuOpen, onMenuToggle, seen }) {
  const pressTimer = useRef(null);
  if (m.kind === 'system') {
    return (
      <div className="my-1.5 text-center">
        <span className="inline-block rounded-full bg-[#1D1D1F]/[0.05] px-3 py-1 text-[11px] font-medium text-[#86868B]">{m.body}</span>
      </div>
    );
  }
  const removed = !!m.removed_at;
  // Body text with the tagged job numbers turned into live chips in place.
  const renderBody = () => {
    const body = m.body || '';
    if (!m.job_tags?.length) return body;
    const parts = body.split(/(#[A-Za-z0-9-]+)/g);
    const inline = new Set();
    const nodes = parts.map((p, i) => {
      const tag = p.startsWith('#') ? m.job_tags.find(t => `#${t.jc_number}` === p) : null;
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
    const extras = m.job_tags.filter(t => !inline.has(t.job_card_id));
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
          className={`rounded-[18px] px-3 py-2 text-[13px] leading-snug ${mine ? MY_PILL : THEIR_PILL} ${removed ? 'opacity-70' : ''}`}>
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
          <div className={`mt-0.5 text-right text-[9px] tabular-nums ${mine ? 'text-white/65' : 'text-[#B4B4B9]'}`}>{timeOnly(m.created_at)}</div>
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
  const [uploading, setUploading] = useState(false);
  const [rec, setRec] = useState(null);                // { secs } while recording

  // New view
  const [users, setUsers] = useState(null);            // /chat/users — fetched on first open
  const [userQ, setUserQ] = useState('');
  const [groupMode, setGroupMode] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupSel, setGroupSel] = useState([]);
  const [memberQ, setMemberQ] = useState('');

  const panelRef = useRef(null);
  const activeIdRef = useRef(null);                    // live copy for async callbacks (voice upload)
  const listRef = useRef(null);                        // messages scroller
  const stickRef = useRef(true);                       // keep pinned to bottom unless the user scrolled up
  const lastMsgIdRef = useRef(0);
  const lastReadRef = useRef({});                      // convId -> newest id already POSTed to /read
  const typingAtRef = useRef(0);
  const recRef = useRef(null);                         // live MediaRecorder session
  const fileRef = useRef(null);
  const jobsLoadingRef = useRef(false);
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
  const unreadTotal = convs.reduce((s, c) => s + (c.muted ? 0 : c.unread || 0), 0);

  // ── Conversations poll — 15s closed (drives the badge), 5s while open ─────
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      api.get('/chat/conversations').then(setConvs).catch(() => {});
    };
    tick();
    const t = setInterval(tick, open ? 5000 : 15000);
    return () => clearInterval(t);
  }, [open]);

  // ── Thread poll — full load on switch, then ?after=<lastId> every 3s ──────
  // Gated on the dock actually SHOWING the thread: a poll that survived the X
  // button would stamp last_seen_at every 3s forever — hammering the API and
  // silencing this conversation's bell for the whole shift.
  useEffect(() => {
    if (!activeId || !open || view !== 'thread') return;
    let live = true;
    lastMsgIdRef.current = 0;
    stickRef.current = true;
    const tick = async () => {
      if (document.hidden) return;
      const after = lastMsgIdRef.current;
      try {
        const r = await api.get(`/chat/conversations/${activeId}/messages${after ? `?after=${after}` : ''}`);
        if (!live) return;
        setMembers(r.members || []);
        if (r.messages?.length) {
          lastMsgIdRef.current = Math.max(after, ...r.messages.map(m => m.id));
          setMessages(prev => mergeMessages(after ? prev : [], r.messages));
        }
      } catch { /* keep prior messages — thread polls fail silently */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { live = false; clearInterval(t); };
  }, [activeId, open, view]);

  // Pin the scroller to the newest message unless the reader scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, view, showMembers]);

  // ── Read tracking — POST only when the newest visible id advances ─────────
  useEffect(() => {
    if (!open || view !== 'thread' || !activeId || !messages.length || document.hidden) return;
    const newest = messages[messages.length - 1].id;
    if (newest <= (lastReadRef.current[activeId] || 0)) return;
    lastReadRef.current[activeId] = newest;
    api.post(`/chat/conversations/${activeId}/read`, { message_id: newest }).catch(() => {});
    setConvs(cs => cs.map(c => (c.id === activeId ? { ...c, unread: 0 } : c)));
  }, [open, view, activeId, messages]);

  // Outside click closes the panel (and any open message menu) — bell idiom.
  useEffect(() => {
    const h = e => {
      if (panelRef.current && !panelRef.current.contains(e.target)) { setOpen(false); setMenuFor(null); }
      else if (!e.target.closest?.('[data-msgmenu]')) setMenuFor(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // ── External open — Production's "Discuss", the bell's chat handoff ───────
  useEffect(() => {
    const h = async e => {
      const d = e.detail || {};
      try {
        if (d.conversationId) {
          openThread(d.conversationId);
        } else if (d.jobCardId) {
          const c = await api.get(`/job-cards/${d.jobCardId}/chat`);
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
    if (!meta) {
      // Opened by bare id (bell handoff) — fetch the detail so the header has
      // a label before the list poll catches up.
      api.get(`/chat/conversations/${id}`).then(d => {
        const conv = d?.conversation || d?.conv || (d?.id ? d : null);
        if (conv?.id) setActiveMeta(conv);
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

  const send = async () => {
    const body = text.trim();
    if (!body || !activeId) return;
    try {
      const m = await api.post(`/chat/conversations/${activeId}/messages`, {
        body, job_tags: pendingTags.map(t => t.id),
      });
      lastMsgIdRef.current = Math.max(lastMsgIdRef.current, m.id);
      stickRef.current = true;
      setMessages(prev => mergeMessages(prev, [m]));
      setText(''); setPendingTags([]);
    } catch { /* central toast */ }
  };

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
  const lastOwnId = [...messages].reverse().find(m => m.sender_id === me?.id && !m.removed_at && m.kind !== 'system')?.id;
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
    <div className="no-print fixed bottom-[68px] right-4 z-40" ref={panelRef}>
      {open && (
        <div className="glass fixed inset-0 z-50 flex origin-bottom-right animate-liquidPop flex-col overflow-hidden rounded-none shadow-modal sm:absolute sm:inset-auto sm:bottom-12 sm:right-0 sm:z-auto sm:h-[min(600px,78vh)] sm:max-h-[78vh] sm:w-[420px] sm:rounded-[22px]">

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
              <div className="flex-1 overflow-y-auto py-1">
                {convs.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/70 text-[#B8B8BD] ring-1 ring-white/80">
                      <MessageCircle size={20} />
                    </span>
                    <p className="text-sm font-medium text-[#86868B]">No conversations yet — start one</p>
                    <Button size="sm" variant="secondary" onClick={openNew}><Plus size={13} /> New message</Button>
                  </div>
                )}
                {convs.map(c => (
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
                            removable={canRemove(m, me?.id)}
                            onRemove={() => removeMessage(m)}
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
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
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
        </div>
      )}

      {/* Image lightbox — tap-to-full for photo attachments */}
      {zoom && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#1D1D1F]/80 p-4 backdrop-blur-sm" onClick={() => setZoom(null)}>
          <img src={zoom} alt="attachment" className="max-h-[90vh] max-w-[92vw] rounded-2xl object-contain shadow-modal" />
        </div>
      )}

      {/* Floating trigger — the bell's sibling, one slot above it */}
      <button onClick={() => setOpen(o => !o)} title="CI Messenger"
        className="glass relative flex h-10 w-10 items-center justify-center rounded-full text-[#515154] transition-all duration-200 ease-apple hover:bg-white/85 hover:text-[#007AFF]">
        <MessageCircle size={17} />
        {unreadTotal > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#007AFF] px-1 text-[10px] font-bold text-white ring-2 ring-white">
            {unreadTotal > 99 ? '99+' : unreadTotal}
          </span>
        )}
      </button>
    </div>
  );
}

