// Record threads in a table cell — the doorbell, never the phone. The dock
// (Chat.jsx) already owns every conversation, so a module mounts discussion by
// adding ONE column: this cell paints what the batched `/threads/summary` said
// and fires `ci-chat-open`. No drawer, no thread state, no chat code per page.
//
// Three signals in a fixed priority, because §4's whole point is that being
// named outranks a plain unread: a red @ badge (someone needs YOU), a blue
// bubble (new messages), a grey bubble (a discussion exists, all read). A record
// nobody has spoken about wears the quietest mark on the page — this cell
// repeats on every row of every table in the ERP, and an empty state that shouts
// would be thousands of rows of noise at once.
import { useEffect, useState } from 'react';
import { AtSign, MessageSquare } from 'lucide-react';

// The row tints, painted on the CELLS rather than the row. A `bg-*` on the <tr>
// lands in the same specificity fight the group rail already loses (which is why
// it needs `!bg-violet-100/60`), and winning that fight would REPLACE the zebra
// stripe and the selected-row tint rather than sit on them. A translucent cell
// background composites over whatever the row is already wearing — stripe,
// selection, gang rail and the row's hover all still read through.
const UNREAD_ROW = '[&>td]:bg-[#007AFF]/[0.05]';
const MENTION_ROW = '[&>td]:bg-[#FF3B30]/[0.07]';

// Rows are keyed differently across the app — Orders' Pendency table and Status
// Sheet carry `line_id` and no `id` at all — so the accessor is never defaulted:
// a wrong id attaches a record's comments to a different record, or to nothing,
// with no visible symptom. In dev that is a hard stop the first time the page
// renders. In the plant it degrades to no column, because there is no error
// boundary in this app and a throw would blank the whole ERP mid-shift.
function badIdOf(idOf, where) {
  if (typeof idOf === 'function') return false;
  const msg = `${where}: idOf(row) is required and must be a function — pages key rows on id, line_id, lot_number…; there is no safe default`;
  if (import.meta.env.DEV) throw new Error(msg);
  console.error(msg);
  return true;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ThreadCell({ entity, id, summary, className = '' }) {
  // The page fetched its summaries once. Opening this very thread would leave
  // the badge lit until the page reloads, so the dock broadcasts `ci-thread-read`
  // when the watermark advances and the cell believes it — until the next
  // summary refresh carries a newer message and lights it again.
  const [read, setRead] = useState(false);
  useEffect(() => { setRead(false); }, [summary?.last_at, summary?.unread]);
  useEffect(() => {
    const h = e => {
      const d = e.detail || {};
      if (d.entity === entity && d.entityId != null && String(d.entityId) === String(id)) setRead(true);
    };
    window.addEventListener('ci-thread-read', h);
    return () => window.removeEventListener('ci-thread-read', h);
  }, [entity, id]);

  const comments = summary?.comments || 0;
  const unread = read ? 0 : summary?.unread || 0;
  // Mention outranks unread, and is only a live signal while something IS
  // unread — a mention you have already read is history, not a summons.
  const mentioned = unread > 0 && !!summary?.mentioned;
  // A summary can only ever be as stale as the page's last fetch, so the total
  // is taken as the larger of the two rather than trusting `comments` to have
  // counted the messages `unread` already knows about.
  const total = Math.max(comments, unread);
  const count = unread || total;

  const title = total === 0
    ? 'No comments yet — start a discussion'
    : [plural(total, 'comment'), unread ? `${unread} unread` : null, mentioned ? 'you were mentioned' : null]
      .filter(Boolean).join(' · ');

  const tone = mentioned
    ? 'bg-[#FF3B30] text-white shadow-[0_2px_6px_rgba(255,59,48,0.32)]'
    : unread
      ? 'bg-[#007AFF] text-white shadow-[0_2px_6px_rgba(0,122,255,0.28)]'
      : total
        ? 'bg-[#1D1D1F]/[0.06] text-[#515154] hover:bg-[#1D1D1F]/[0.1]'
        : 'text-[#C7C7CC] hover:bg-white/70 hover:text-[#007AFF]';

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={e => {
        // A row opens the record and a kanban card opens the press chooser.
        // Asking to TALK about a record must never also open it. DataTable's own
        // guard already skips clicks on a <button>, but the hand-mounted card
        // surfaces have no such guard.
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('ci-chat-open', { detail: { entity, entityId: id } }));
      }}
      className={`inline-flex h-6 min-w-[24px] shrink-0 items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-bold tabular-nums transition-all duration-200 ease-apple hover:scale-105 active:scale-95 ${tone} ${className}`}
    >
      {/* Colour never carries the fact alone — the @ is a different SHAPE at a
          glance, and the title spells all three states out in words. */}
      {mentioned
        ? <AtSign size={12} strokeWidth={2.75} />
        : <MessageSquare size={12} strokeWidth={total ? 1.5 : 2} fill={total ? 'currentColor' : 'none'} />}
      {count > 0 && <span>{count > 99 ? '99+' : count}</span>}
    </button>
  );
}

// One line per page: `columns={[…, threadColumn({ entity: 'order', threads, idOf: r => r.id })]}`.
// `_thread` is load bearing twice over — DataTable skips `_`-prefixed keys when
// choosing a default sort, and exportableColumns() drops them from PDF/XLSX, so
// a React element can never reach the export grid.
export function threadColumn({ entity, threads, idOf }) {
  const broken = badIdOf(idOf, 'threadColumn');
  return {
    key: '_thread',
    label: '',
    sortable: false,
    exportable: false,
    render: broken ? () => null : r => {
      const id = idOf(r);
      // A row with no identity gets no doorbell rather than a thread on `null`.
      return id == null ? null : <ThreadCell entity={entity} id={id} summary={threads?.[id]} />;
    },
  };
}

// `rowClass={unreadRowClass(threads, r => r.id)}` — §4's "the whole row is
// lightly highlighted", with a mention tinted distinctly stronger than a plain
// unread. Read rows return '' so the table looks exactly as it does today.
export function unreadRowClass(threads, idOf) {
  if (badIdOf(idOf, 'unreadRowClass')) return () => '';
  return r => {
    const id = idOf(r);
    const s = id == null ? null : threads?.[id];
    if (!s?.unread) return '';
    return s.mentioned ? MENTION_ROW : UNREAD_ROW;
  };
}
