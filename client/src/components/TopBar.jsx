// Top bar — the app shell's one always-visible band, and the whole reason this
// wave exists. Today the two communication centres are 40px circles floating in
// the bottom-right corner: on a plant monitor across the hall they are a smudge,
// so pending work sits unread for a shift. Here they are LABELLED, COUNTED
// buttons on the header, sized for the same three-metre design distance
// Readiness.jsx works at — `Messages 12`, not a bare dot.
//
// It fetches NOTHING. Every count arrives as a prop, because AppLayout already
// polls /notifications and /approvals/pending for the bell; a second poller
// living in the shell would double the request rate for the whole shift and the
// two would drift apart within a minute of each other. This component renders
// and it reports — the centres it opens keep owning their own state.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';

// One ladder, three rungs, and it is the same ladder ThreadCell paints on a
// table row (blue unread → red mention) fused with the one the bell already
// speaks (amber = an approval is waiting). Highest applicable rung wins WITHIN
// each button: a waiting approval is a fact about the notification centre, so
// lighting the Messages capsule amber for it would state something untrue about
// the operator's messages. There is deliberately no fourth colour — a count with
// nothing behind it wears no badge at all.
//
// `from`/`to` are the ramp's 400 → 500 shades, so a badge is lit from above like
// every other capsule in the theme instead of reading as a flat sticker.
const TONE = {
  blue: { from: '#2E95FF', to: '#0071F0', wash: 'rgba(0,122,255,0.10)', rim: 'rgba(0,122,255,0.34)', glow: 'rgba(0,122,255,0.30)', text: '#0064D2' },
  amber: { from: '#FFAB38', to: '#FF9500', wash: 'rgba(255,149,0,0.13)', rim: 'rgba(255,149,0,0.38)', glow: 'rgba(255,149,0,0.32)', text: '#B05F00' },
  red: { from: '#FF6961', to: '#FF3B30', wash: 'rgba(255,59,48,0.11)', rim: 'rgba(255,59,48,0.34)', glow: 'rgba(255,59,48,0.34)', text: '#B81F16' },
};

// The ladder is applied PER BUTTON, not across the bar. A waiting approval is a
// fact about the notification centre; turning the Messages capsule amber for it
// would tell an operator something about their messages that is not true, and a
// colour that lies is worse than no colour.
export function rung({ mentioned, waiting }) {
  if (mentioned) return TONE.red;
  if (waiting > 0) return TONE.amber;
  return TONE.blue; // a badge only renders when there is something to report
}

// A count that has not arrived yet is NOT zero. AppLayout's pollers start empty
// on every page load, and a badge that flashes "0" then jumps to 12 teaches the
// floor to distrust the number — so undefined and zero both mean "no badge".
// Numeric strings are coerced, because an API that returns '12' must not blank
// the one signal this bar exists to carry.
export function countOf(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

const shown = n => (n > 99 ? '99+' : String(n));
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A `g` chord that never expires is a trap: `g` typed a minute ago and `m` typed
// now is not a shortcut, it is someone hunting for a row.
const CHORD_MS = 1200;

// Anything that swallows a keystroke. An operator typing a waste note must never
// be teleported to the messenger by the `g` in "gsm", so the guard is deliberately
// wide — the element itself OR any editable ancestor, because a rich-text caret
// sits on a text node inside the contenteditable, not on it.
function editable(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName || '')) return true;
  return typeof el.closest === 'function'
    && el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]') != null;
}

// The counted controls. Below `lg` the words go and the NUMBER stays: a narrow
// screen can lose the label, it can never lose the signal.
//
// Exported because the notification bell and the messenger each render their
// own capsule into the bar. One component, so the two centres cannot drift into
// looking like different species of control.
export function CountButton({ icon: Icon, label, count, tone, title, onClick, innerRef }) {
  const lit = count != null && tone;
  return (
    <button
      ref={innerRef}
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-semibold leading-none backdrop-blur-xl transition-all duration-200 ease-apple hover:-translate-y-px active:scale-[0.97] sm:gap-2 sm:px-3"
      style={lit
        ? {
          borderColor: tone.rim,
          color: tone.text,
          backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.86), ${tone.wash})`,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.95), 0 1px 2px rgba(29,29,31,0.05), 0 8px 20px ${tone.glow}`,
        }
        : {
          borderColor: 'rgba(255,255,255,0.72)',
          color: '#515154',
          backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.82), rgba(255,255,255,0.55))',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 2px rgba(29,29,31,0.05)',
        }}
    >
      <Icon size={16} strokeWidth={2.25} className="shrink-0" />
      {label && <span className="hidden lg:inline">{label}</span>}
      {count != null && (
        <span
          className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full px-1.5 text-[12px] font-bold leading-none tabular-nums text-white"
          style={{
            backgroundImage: `linear-gradient(180deg, ${tone.from}, ${tone.to})`,
            boxShadow: `0 2px 8px ${tone.glow}, inset 0 1px 0 rgba(255,255,255,0.42)`,
          }}
        >
          {shown(count)}
        </span>
      )}
    </button>
  );
}

export default function TopBar({
  onToggleSidebar, collapsed,
  actions,
  user, onSignOut,
  q, onSearch,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(false);
  const menuRef = useRef(null);
  const searchRef = useRef(null);
  const chordRef = useRef(0); // when a pending `g` was pressed, 0 for none

  // Close the account menu on an outside click or Escape — the same two exits
  // every other menu in this app honours.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = e => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    const onKey = e => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // `/` focuses search, `g m` opens messages, `g n` opens notifications (§15,
  // keyboard-friendly). Every shortcut bails when focus is anywhere editable and
  // when a modifier is down — Cmd+/ and Ctrl+N belong to the browser, and a
  // shortcut that fires mid-sentence is worse than no shortcut at all.
  useEffect(() => {
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (editable(e.target) || editable(document.activeElement)) return;

      if (e.key === '/') {
        // Below `md` the field is display:none and focus() is a harmless no-op —
        // a phone has no `/` to press anyway.
        e.preventDefault();
        chordRef.current = 0;
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      const k = String(e.key).toLowerCase();
      if (k === 'g') { chordRef.current = Date.now(); return; }

      // Any other key ends the chord, whether or not it completes one.
      const pending = chordRef.current > 0 && Date.now() - chordRef.current < CHORD_MS;
      chordRef.current = 0;
      if (!pending) return;
      // Broadcast rather than call down: the centres are children passed in as
      // `actions`, so the bar holds no handle on them. They already listen for
      // `ci-chat-open`, which is how every module in the ERP opens a thread.
      if (k === 'm') { e.preventDefault(); window.dispatchEvent(new CustomEvent('ci-chat-open', { detail: {} })); }
      else if (k === 'n') { e.preventDefault(); window.dispatchEvent(new CustomEvent('ci-notifications-open')); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const initial = (user?.name || user?.email || '?').trim().slice(0, 1).toUpperCase();

  return (
    <header className="no-print glass sticky top-0 z-30 flex h-[52px] items-center gap-2 rounded-none border-x-0 border-t-0 px-2.5 sm:gap-3 sm:px-4">
      {/* Sidebar handle. `collapsed` is the DESKTOP rail's window state, and below
          `lg` this same button opens the drawer instead — where that state means
          nothing. So the phone gets a plain hamburger and only the desktop icon
          reports which way the panel is about to move. */}
      <button
        type="button"
        onClick={onToggleSidebar}
        title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#515154] transition-all duration-200 ease-apple hover:bg-white/75 hover:text-[#007AFF] active:scale-95"
      >
        <Menu size={18} className="lg:hidden" />
        <span className="hidden lg:block">
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </span>
      </button>

      <span className="hidden min-w-0 shrink truncate text-[15px] font-bold leading-none tracking-[-0.02em] text-[#1D1D1F] sm:block">
        Colour<span className="text-[#007AFF]"> Impressions</span>
      </span>

      {/* Search — the shell's own box. It holds no state: `q` in, `onSearch` out,
          so whatever mounts the bar decides what searching the plant means. */}
      <div className="min-w-0 flex-1">
        {/* Rendered only when a handler is supplied. A search box that accepts
            typing and answers nothing is worse than no search box: it spends the
            operator's trust once and they stop trying. The slot stays so wiring
            it later is one prop. */}
        <div className={`relative max-w-[520px] md:block ${onSearch ? 'hidden' : 'hidden md:hidden'}`}>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#86868B]" />
          <input
            ref={searchRef}
            value={q ?? ''}
            onChange={e => onSearch?.(e.target.value)}
            onFocus={() => setSearchFocus(true)}
            onBlur={() => setSearchFocus(false)}
            onKeyDown={e => {
              if (e.key !== 'Escape') return;
              // Escape empties the box and hands focus back to the page, so the
              // `g` chords work again without reaching for the mouse.
              e.stopPropagation();
              onSearch?.('');
              e.currentTarget.blur();
            }}
            placeholder="Search orders, job cards, boards, people…"
            aria-label="Search"
            className="h-9 w-full rounded-full border border-[#1D1D1F]/[0.10] bg-white/75 pl-9 pr-9 text-sm font-medium text-[#1D1D1F] placeholder-[#86868B] shadow-[inset_0_1.5px_3px_rgba(29,29,31,0.07),inset_0_-1px_0_rgba(255,255,255,0.7)] outline-none backdrop-blur-md transition duration-200 ease-apple hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:shadow-[0_0_18px_rgba(10,132,255,0.25),0_2px_10px_rgba(10,132,255,0.14),inset_0_1px_2px_rgba(29,29,31,0.04)] focus:ring-[3px] focus:ring-[#0A84FF]/25"
          />
          {/* A shortcut nobody can see is a shortcut nobody uses. */}
          {!searchFocus && !(q ?? '') && (
            <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center rounded-md border border-[#1D1D1F]/[0.12] bg-white/80 px-1.5 py-0.5 font-sans text-[10px] font-bold leading-none text-[#86868B] xl:flex">
              /
            </kbd>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {/* The two communication centres mount HERE as children rather than as
            counts passed down. Each already polls its own feed and owns its own
            panel; lifting those counts into this bar would mean a second poller
            for numbers that already exist, and two clocks that disagree within a
            minute. The bar owns placement and the capsule; they own the truth. */}
        {actions}

        {/* Account — the user block and sign-out, moved up out of the sidebar
            footer so the rail can collapse without taking the exit with it. */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={user?.name ? `${user.name} — account` : 'Account'}
            className="flex h-9 items-center gap-1 rounded-full pl-0.5 pr-1 transition-colors duration-150 hover:bg-white/70"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#2E95FF] to-[#007AFF] text-xs font-bold text-white shadow-[0_8px_18px_rgba(0,122,255,0.28),inset_0_1px_0_rgba(255,255,255,0.4)]">
              {initial}
            </span>
            <ChevronDown size={13} className={`shrink-0 text-[#86868B] transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`} />
          </button>
          {menuOpen && (
            <div role="menu" className="glass absolute right-0 top-full z-40 mt-2 w-[232px] origin-top-right animate-liquidPop overflow-hidden rounded-2xl py-1 shadow-modal">
              <div className="border-b border-[#1D1D1F]/[0.06] px-3 py-2.5">
                <div className="truncate text-xs font-bold text-[#1D1D1F]">{user?.name || 'Signed in'}</div>
                {user?.email && <div className="truncate text-[11px] text-[#86868B]">{user.email}</div>}
                {user?.role && <div className="mt-0.5 text-[11px] font-semibold capitalize text-[#86868B]">{user.role}</div>}
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onSignOut?.(); }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold text-red-600 transition-colors duration-150 hover:bg-red-50"
              >
                <LogOut size={13} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
