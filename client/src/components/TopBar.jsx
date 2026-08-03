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
import { createPortal } from 'react-dom';
import { LogOut, Menu, Search } from 'lucide-react';
import { SEARCH_FX } from './ui.jsx';

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
//
// `key` names the rung for the code that has to branch on it rather than paint
// with it — the attention nudge below throws the red capsule harder than the
// other two, and identity-comparing frozen objects breaks the moment one of
// these is ever spread or cloned.
const TONE = {
  blue: { key: 'blue', from: '#2E95FF', to: '#0071F0', wash: 'rgba(0,122,255,0.10)', rim: 'rgba(0,122,255,0.34)', glow: 'rgba(0,122,255,0.30)', text: '#0064D2' },
  amber: { key: 'amber', from: '#FFAB38', to: '#FF9500', wash: 'rgba(255,149,0,0.13)', rim: 'rgba(255,149,0,0.38)', glow: 'rgba(255,149,0,0.32)', text: '#B05F00' },
  red: { key: 'red', from: '#FF6961', to: '#FF3B30', wash: 'rgba(255,59,48,0.11)', rim: 'rgba(255,59,48,0.34)', glow: 'rgba(255,59,48,0.34)', text: '#B81F16' },
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

  // The nudge rides an OUTER wrapper, never the button. The button owns a hover
  // lift and a press that sinks it, both transforms; a looping transform
  // animation on the same element wins outright and the control would go dead
  // under the cursor for exactly as long as there was something to report.
  const nudge = !lit ? '' : tone.key === 'red' ? 'animate-nudgeUrgent' : 'animate-nudge';

  // Both capsules light at once often enough, and two of them hopping in perfect
  // lockstep reads as one mechanical glitch rather than two independent things
  // asking for attention. A negative delay offsets each one into a different
  // part of the cycle — derived from the label so it is identical on every
  // render and every reload, where a random offset would re-jitter the pair
  // each time a poll came back.
  const stagger = -([...(label || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 1700) / 1000;

  return (
    <span
      // will-change only while it is actually moving. Left on permanently it
      // holds a composited layer for both capsules for the whole shift, and on
      // the plant's monitors that is a layer bought for nothing 90% of the time.
      className={`inline-flex origin-bottom ${nudge ? `will-change-transform ${nudge}` : ''}`}
      style={nudge ? { animationDelay: `${stagger}s` } : undefined}
    >
      <button
        ref={innerRef}
        type="button"
        onClick={onClick}
        title={title}
        aria-label={title}
        className="emboss-btn flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-semibold leading-none backdrop-blur-xl sm:gap-2 sm:px-3"
        style={lit
          ? {
            '--emb-rim': tone.rim,
            '--emb-top': 'rgba(255,255,255,0.92)',
            '--emb-bot': tone.wash,
            '--emb-glow': tone.glow,
            color: tone.text,
          }
          : { color: '#515154' }}
      >
        <Icon size={16} strokeWidth={2.25} className="shrink-0" />
        {label && <span className="hidden lg:inline">{label}</span>}
        {count != null && (
          <span
            className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full px-1.5 text-[12px] font-bold leading-none tabular-nums text-white"
            style={{
              backgroundImage: `linear-gradient(180deg, ${tone.from}, ${tone.to})`,
              // Lit from above and seated in its own well — the badge is the one
              // thing read from across the hall, so it gets the deepest relief.
              boxShadow: `0 2px 8px ${tone.glow}, inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.16)`,
            }}
          >
            {shown(count)}
          </span>
        )}
      </button>
    </span>
  );
}

export default function TopBar({
  onToggleSidebar, collapsed,
  actions,
  user, onSignOut,
  q, onSearch,
  // Touch shells (phone / tablet) pass true: the handle is always a hamburger
  // there — the desktop's panel-collapse glyphs describe a rail those tiers
  // don't have. Desktop never passes it, so its behaviour is untouched.
  touchShell = false,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(false);
  const menuRef = useRef(null);      // the avatar trigger, in the header
  const menuPopRef = useRef(null);   // the menu itself, portalled to <body>
  const searchRef = useRef(null);
  const chordRef = useRef(0); // when a pending `g` was pressed, 0 for none

  // Close the account menu on an outside click or Escape — the same two exits
  // every other menu in this app honours.
  useEffect(() => {
    if (!menuOpen) return;
    // Miss BOTH — the menu is portalled, so it is not a descendant of the
    // trigger and a single contains() would close it on its own first click.
    const onDown = e => {
      if (menuRef.current?.contains(e.target) || menuPopRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
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
    // Inset by the same 12px the sidebar rail uses and cornered to match it, so
    // the two panels' top edges sit level and read as one family. What changed
    // from the old floating band is the MATERIAL, not the shape: it carries the
    // page's own light at a fraction of the strength and floats shallowly, so
    // it belongs to the workspace instead of being parked above it.
    <div className="no-print sticky top-0 z-30 px-3 pb-2 pt-3 sm:px-4 lg:px-5">
      {/* The band leaves 12px of air above it, and page content scrolling up
          would otherwise slide through that gap in full focus. This scrim blurs
          whatever passes behind and fades out below the band, so content
          dissolves under the header instead of peeking over it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-full backdrop-blur-md"
        style={{
          maskImage: 'linear-gradient(180deg,#000 0%,#000 62%,transparent 100%)',
          WebkitMaskImage: 'linear-gradient(180deg,#000 0%,#000 62%,transparent 100%)',
        }}
      />
      <header className="app-header relative flex h-[54px] items-center gap-2 rounded-[26px] px-3 sm:gap-3 sm:px-4">
        {/* PHONE ONLY. The desktop panel-toggle icon that used to live here is
            gone: on a large screen the rail already carries both directions of
            the same action — click the "Colour Impressions" wordmark to slide it
            away, click the tab on the left edge to bring it back — so a third
            control in the header was a button explaining a thing the panel
            itself already says. Below `lg` the rail is a drawer with no visible
            edge, so the hamburger is the only way in and stays. */}
        <button
          type="button"
          onClick={onToggleSidebar}
          title="Menu"
          aria-label="Open menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#515154] transition-all duration-200 ease-apple hover:bg-white/80 hover:text-[#007AFF] active:scale-95 lg:hidden"
        >
          <Menu size={18} />
        </button>

        {/* No wordmark here. The sidebar rail carries "Colour Impressions" at 22px
            and its top edge sits level with this band, so a 15px copy of the name
            a few pixels to its right told the operator nothing they could not
            already read — it only crowded the one strip the two communication
            centres share. The brand lives in the rail; this bar is for doing. */}

        {/* Search — the shell's own box. It holds no state: `q` in, `onSearch` out,
            so whatever mounts the bar decides what searching the plant means. */}
        <div className="min-w-0 flex-1">
          {/* Rendered only when a handler is supplied. A search box that accepts
              typing and answers nothing is worse than no search box: it spends the
              operator's trust once and they stop trying. The slot stays so wiring
              it later is one prop. */}
          <div className={`relative max-w-[520px] md:block ${onSearch ? 'hidden' : 'hidden md:hidden'}`}>
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#0A84FF]/80" />
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
              className={`h-9 w-full rounded-full border pl-9 pr-9 text-sm font-medium text-[#1D1D1F] placeholder-[#86868B] outline-none transition duration-200 ease-apple ${SEARCH_FX}`}
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
              // No chevron. The avatar was already the only thing anyone aimed at,
              // and the arrow beside it spent 13px of the bar restating that a
              // button is a button. What it did carry — "this menu is open" — the
              // ring below now says louder, in the accent the rest of the app
              // already uses for an active control.
              className={`emboss-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${menuOpen ? 'is-open' : ''}`}
            >
              <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#2E95FF] to-[#007AFF] text-xs font-bold text-white shadow-[0_4px_10px_rgba(0,122,255,0.34),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(0,60,130,0.35)]">
                {initial}
              </span>
            </button>
            {/* Portalled for the same reason the two centre panels are: this
                header IS a backdrop-filtered element, so it becomes the backdrop
                root for anything inside it and a frosted menu rendered here has
                only the 54px strip to sample — it comes out see-through, with the
                page's own controls legible straight through the words. This menu
                is now the only way to sign out, so it has to be readable.

                Hung off the band's new geometry: 12px of top inset + a 54px bar
                + 8px of air = 74px, and the right edge tracks the same gutter the
                header floats in at each breakpoint. */}
            {menuOpen && createPortal(
              <div ref={menuPopRef} role="menu" className="glass fixed right-3 top-[74px] z-[60] w-[232px] origin-top-right animate-liquidPop overflow-hidden rounded-2xl py-1 shadow-modal sm:right-4 lg:right-5">
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
              </div>, document.body)}
          </div>
        </div>
      </header>
    </div>
  );
}
