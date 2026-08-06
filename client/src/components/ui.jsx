// ─── Design system primitives (macOS Tahoe / Liquid Glass theme) ────────────
import { Children, Fragment, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, AlertTriangle, CheckCircle2, Info, Inbox, Check, ChevronDown, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, MoreHorizontal, Download, FileText, FileSpreadsheet, Loader2, Filter, Zap } from 'lucide-react';
import { exportPDF, exportXLSX, specRowCount } from '../lib/exporter';
import { squash, matchesTerm } from '../lib/searchKey.js';
import { isCardTier, isTouchTier, useTier } from '../lib/tier.js';

// Button
export function Button({ variant = 'primary', size = 'md', className = '', ...props }) {
  const variants = {
    primary: 'btn-brand',
    secondary: 'border border-white/75 bg-white/65 text-[#1D1D1F] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(29,29,31,0.05),0_8px_20px_rgba(29,29,31,0.06)] hover:-translate-y-px hover:bg-white/90 hover:text-[#007AFF] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_2px_4px_rgba(29,29,31,0.06),0_10px_24px_rgba(29,29,31,0.09)] disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
    ghost: 'text-[#515154] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F] disabled:opacity-50',
    // Solid, but the CALLER owns the colour. `primary` paints its brand blue as
    // a background-IMAGE (.btn-brand), and an image covers background-color —
    // so every `!bg-violet-600` / `!bg-teal-600` handed to a primary Button was
    // painted over and rendered brand blue anyway. That is how the planning
    // bulk bar ended up a wall of identical blue. This variant keeps the solid
    // geometry and leaves the image slot empty, so a bg-* utility is the
    // button's real colour. Pass one — without it this renders transparent.
    solid: 'text-white border border-black/10 shadow-[0_8px_20px_rgba(29,29,31,0.18),inset_0_1px_0_rgba(255,255,255,0.28)] hover:-translate-y-px hover:brightness-[1.06] disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
    danger: 'border border-[#B81F16]/30 bg-gradient-to-b from-[#FF6961] to-[#FF3B30] text-white shadow-[0_8px_20px_rgba(255,59,48,0.30),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(145,25,18,0.25)] hover:-translate-y-px hover:brightness-105 disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
    success: 'border border-[#19813A]/30 bg-gradient-to-b from-[#57CB75] to-[#34C759] text-white shadow-[0_8px_20px_rgba(52,199,89,0.30),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(20,101,48,0.25)] hover:-translate-y-px hover:brightness-105 disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
  };
  // Touch tiers float every size to a 40–44pt hit zone; a desktop pointer
  // keeps today's exact geometry (the touch: variants can't match it).
  const sizes = {
    sm: 'px-3 py-1.5 text-xs touch:min-h-[40px] touch:px-3.5',
    md: 'px-4 py-2 text-sm touch:min-h-[44px]',
    lg: 'px-5 py-2.5 text-sm touch:min-h-[44px]',
  };
  return (
    <button
      className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full font-semibold leading-snug transition-all duration-200 ease-apple active:scale-[0.97]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// Form fields
export function Field({ label, children, hint, required, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block max-w-full break-words text-xs font-medium leading-snug text-slate-600">
        {label} {required && <span className="text-brand-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

// Fields read as recessed wells cut into the glass (deeper inset + hairline
// under-shadow), then illuminate on focus: border and ring go systemBlue while
// a soft outer bloom lifts the field forward. Ring + shadow utilities compose,
// so the glow layers onto the inset without replacing it.
const inputCls =
  'w-full rounded-xl border border-[#1D1D1F]/[0.10] bg-white/75 px-3 py-2 text-sm font-medium leading-5 text-[#1D1D1F] placeholder-[#86868B] backdrop-blur-md ' +
  'shadow-[inset_0_1.5px_3px_rgba(29,29,31,0.07),inset_0_-1px_0_rgba(255,255,255,0.7)] outline-none transition duration-200 ease-apple ' +
  'hover:border-[#1D1D1F]/[0.18] hover:bg-white/90 ' +
  'focus:border-[#0A84FF] focus:bg-white focus:ring-[3px] focus:ring-[#0A84FF]/25 focus:shadow-[0_0_18px_rgba(10,132,255,0.25),0_2px_10px_rgba(10,132,255,0.14),inset_0_1px_2px_rgba(29,29,31,0.04)] ' +
  'disabled:bg-[#1D1D1F]/[0.04] disabled:text-[#86868B]';

export function Input({ className = '', ...props }) { return <input className={`${inputCls} h-10 ${className}`} {...props} />; }
export function Textarea({ className = '', ...props }) { return <textarea rows={2} className={`${inputCls} min-h-[72px] ${className}`} {...props} />; }
// Keys nobody types. Ids, timestamps and flags carry digits that would collide
// with real searches — a board is found by "2038", and a row whose id happens to
// be 2038 must not out-rank it inside a list capped at 80.
const NOISE_KEY = /(^|_)(id|ids|at|by|hash|url|token)$|^(active|deleted|created|updated|sort_order|position)$/;

// Everything on a record a person might actually type, flattened to one string —
// the dropdown twin of the haystack rowMatches builds for a table row. This is
// what lets a board be picked by its spec code, a product by its artwork or
// carton code, and a vendor by its GSTIN, none of which fit in the visible label.
// Nested lines/operators are walked one level down, so a machine is findable by
// the operator standing at it.
export function searchText(value, extra = '') {
  const parts = [];
  const walk = (node, depth) => {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) { if (depth > 0) for (const n of node) walk(n, depth); return; }
    if (typeof node === 'object') {
      if (depth <= 0) return;
      for (const [k, v] of Object.entries(node)) if (!NOISE_KEY.test(k)) walk(v, depth - 1);
      return;
    }
    parts.push(String(node));
  };
  walk(value, 2);
  if (extra) parts.push(String(extra));
  return parts.join(' ');
}

// squash() is pure and the same option text is re-squashed on every keystroke
// across lists of 1400+ products, now against a full-record haystack rather than
// a short label. Cache the keys instead of recomputing them; bounded so a long
// shift on the floor cannot grow it without limit.
const squashCache = new Map();
function squashKey(text) {
  let key = squashCache.get(text);
  if (key === undefined) {
    if (squashCache.size > 4000) squashCache.clear();
    key = squash(text);
    squashCache.set(text, key);
  }
  return key;
}

function optionText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionText).join(' ');
  return optionText(node.props?.children);
}

// A dropdown has to be readable even when its trigger is not. A picker squeezed
// into a narrow table cell used to open a menu the width of that cell — ~70px in
// the PO line editor — which wrapped every option character-by-character
// ('Chro / mo / Pape / r'), so the floor could not read the list it was picking
// from. Menus are widened to MENU_MIN regardless of the trigger and then clamped
// to the viewport.
const MENU_MIN = 460;
const MENU_MARGIN = 12;

// `renderOption(item)` is optional. Callers that pass one get full control of the
// row and receive whatever they put in `options` — including the record behind
// it, which is how a board shows its spec code, stock and rate. Omitting it
// renders exactly as before, so the ~46 existing option sites are untouched.
export function SearchableSelect({
  children,
  options,
  value = '',
  onChange,
  placeholder = 'Select...',
  disabled,
  className = '',
  name,
  required,
  renderOption,
  ...props
}) {
  // `data-search` is a data channel, not an attribute: these <option> elements are
  // never rendered (the menu below is built from `items`), so the extra haystack
  // costs nothing in the DOM. Call sites pass searchText(record) to make the whole
  // record findable, not just the label they chose to show.
  const items = options || Children.toArray(children).map(child => ({
    value: child?.props?.value ?? '',
    label: optionText(child?.props?.children),
    search: child?.props?.['data-search'] ?? '',
    disabled: child?.props?.disabled,
  }));
  const tier = useTier();
  const emptyOption = items.find(i => String(i.value) === '');
  const displayPlaceholder = placeholder === 'Select...' && emptyOption?.label ? emptyOption.label : placeholder;
  const selected = value === '' || value == null ? null : items.find(i => String(i.value) === String(value));
  const [query, setQuery] = useState(selected?.label || '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const menuRef = useRef(null);
  const [rect, setRect] = useState(null);

  useEffect(() => { setQuery(selected?.label || ''); }, [selected?.label, value]);
  useEffect(() => {
    if (!open) return;
    const close = e => {
      if (ref.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
      setQuery(selected?.label || '');
    };
    const update = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      // Measure against the VISUAL viewport where there is one: with a tablet
      // keyboard raised, window.innerHeight still reports the full screen, so
      // the menu opened "below" the field and landed behind the keys. The
      // visual viewport is the glass the user can actually see.
      const vv = window.visualViewport;
      const vh = vv?.height ?? window.innerHeight;
      const vw = vv?.width ?? window.innerWidth;
      // Client rects are in layout coords; the visual viewport can be offset
      // from them (pinch-zoom, keyboard scroll), so shift into its frame.
      const top = r.top - (vv?.offsetTop ?? 0);
      const bottom = r.bottom - (vv?.offsetTop ?? 0);
      const left0 = r.left - (vv?.offsetLeft ?? 0);
      const below = vh - bottom - 10;
      const above = top - 10;
      const maxHeight = Math.max(160, Math.min(280, Math.max(below, above)));
      // Widen past the trigger, then pull `left` back so the wider menu cannot
      // run off the right edge of a narrow viewport.
      const width = Math.min(Math.max(r.width, MENU_MIN), vw - MENU_MARGIN * 2);
      const left = Math.max(MENU_MARGIN, Math.min(left0, vw - width - MENU_MARGIN));
      setRect({ left, width, top: below < 210 && above > below ? r.top - maxHeight - 6 : r.bottom + 6, maxHeight });
    };
    update();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, selected?.label]);

  // Same normalization as the tables (rowMatches): typing "2038" resolves a
  // board stored as 'Duplex GB · 296 GSM · 20 x 38'. Terms are ANDed so
  // "duplex 2038" narrows, which matters on a list capped at 80 rows.
  // The haystack spans the label, the value AND the record behind it, so any
  // character of anything stored on the row finds it — not just what is shown.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = (terms.length
    ? items.filter(i => {
        const raw = `${i.label} ${i.value} ${i.search ?? ''}`.toLowerCase();
        const sq = squashKey(raw);
        return terms.every(t => matchesTerm(raw, sq, t));
      })
    : items
  ).filter(i => !i.disabled && String(i.value) !== '').slice(0, 80);
  const emit = next => onChange?.({ target: { name, value: next }, currentTarget: { name, value: next } });
  const choose = item => {
    emit(item.value);
    setQuery(item.label);
    setOpen(false);
    setActive(0);
  };

  // ── Phone: the menu becomes a bottom sheet ─────────────────────────────────
  // A popover anchored to a field is a mouse idiom — under a thumb it sits
  // beneath the keyboard, clipped to whatever sliver the viewport has left.
  // The sheet owns the bottom half of the screen, carries its own search box
  // (autofocused, 16px so iOS doesn't zoom), and its options clear 44pt.
  if (tier === 'phone') {
    return (
      <div className="relative" ref={ref}>
        <input type="hidden" name={name} value={value ?? ''} readOnly required={required} />
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setQuery(''); setOpen(true); }}
          className={`${inputCls} flex h-11 items-center justify-between gap-2 text-left ${className}`}
        >
          <span className={`min-w-0 flex-1 truncate ${selected ? '' : 'text-[#86868B]'}`}>
            {selected?.label || displayPlaceholder}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-slate-400">
            {value !== '' && value != null && !disabled && (
              <span
                role="button" tabIndex={-1}
                onClick={e => { e.stopPropagation(); emit(''); }}
                className="rounded-full p-1 active:bg-slate-100"
              >
                <X size={15} />
              </span>
            )}
            <ChevronDown size={15} />
          </span>
        </button>
        {open && !disabled && createPortal((
          <div className="fixed inset-0 z-[200] flex items-end animate-fadeIn">
            <div className="absolute inset-0 bg-[#1D1D1F]/[0.34] backdrop-blur-[6px]" onClick={() => setOpen(false)} />
            {/* menuRef keeps the document-level outside-tap closer from firing
                on taps INSIDE the sheet — the sheet is portalled, so contains()
                on the field wrapper alone would close it mid-choice. */}
            <div ref={menuRef} className="relative flex max-h-[70dvh] w-full animate-slideUp flex-col overflow-hidden rounded-t-[26px] border border-b-0 border-white/75 bg-white/95 shadow-modal backdrop-blur-2xl">
              <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[#1D1D1F]/[0.14]" />
              <div className="px-3 pb-2 pt-2">
                <input
                  autoFocus
                  className={`${inputCls} h-11`}
                  value={query}
                  placeholder={displayPlaceholder}
                  autoComplete="off"
                  onChange={e => { setQuery(e.target.value); setActive(0); }}
                />
              </div>
              <div className="flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2" style={{ paddingBottom: 'max(0.5rem, var(--sab))' }}>
                {filtered.length ? filtered.map((item, i) => (
                  <button key={`${item.value}-${i}`} type="button" onClick={() => choose(item)}
                    className={`flex min-h-[46px] w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[15px] ${String(item.value) === String(value) ? 'bg-[#0A84FF]/[0.10] font-semibold text-[#0064D2]' : 'text-[#1D1D1F] active:bg-slate-100'}`}>
                    {renderOption
                      ? <span className="min-w-0 flex-1">{renderOption(item)}</span>
                      : <span className="min-w-0 break-words">{item.label}</span>}
                    {String(item.value) === String(value) && <Check size={16} className="shrink-0" />}
                  </button>
                )) : <div className="px-4 py-6 text-center text-sm text-slate-500">No results found</div>}
              </div>
            </div>
          </div>
        ), document.body)}
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <input type="hidden" name={name} value={value ?? ''} readOnly required={required} />
      <input
        className={`${inputCls} h-10 pr-16 ${className}`}
        value={query}
        disabled={disabled}
        placeholder={displayPlaceholder}
        autoComplete="off"
        // Clearing the query on focus is what the touch tier already does two
        // branches up. Without it a field opened on a chosen value filters the
        // menu down to that ONE option, so a picklist with a default reads as a
        // picklist of one until the caret is cleared by hand. The stored value
        // is untouched (no emit) and the close handler restores the label, so
        // this only ever changes what the OPEN menu offers.
        onFocus={() => { setQuery(''); setOpen(true); setActive(0); }}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onBlur={() => window.setTimeout(() => { if (!open) setQuery(selected?.label || ''); }, 150)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, Math.max(filtered.length - 1, 0))); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
          if (e.key === 'Escape') { setOpen(false); setQuery(selected?.label || ''); }
          if (e.key === 'Enter' && open && filtered[active]) { e.preventDefault(); choose(filtered[active]); }
        }}
        {...props}
      />
      <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-slate-400">
        {value !== '' && value != null && !disabled && (
          <button type="button" tabIndex={-1} onMouseDown={e => { e.preventDefault(); emit(''); setQuery(''); }}
            className="pointer-events-auto rounded p-0.5 hover:bg-slate-100 hover:text-slate-700">
            <X size={14} />
          </button>
        )}
        <ChevronDown size={14} />
      </div>
      {open && !disabled && rect && createPortal((
        <div ref={menuRef} className="glass fixed z-[200] overflow-auto rounded-2xl py-1 shadow-modal"
          style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight }}>
          {filtered.length ? filtered.map((item, i) => (
            <button key={`${item.value}-${i}`} type="button" onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-100 ${i === active ? 'bg-[#0A84FF]/[0.10] text-[#0064D2]' : 'text-[#1D1D1F] hover:bg-white/70'}`}>
              {renderOption
                ? <span className="min-w-0 flex-1">{renderOption(item)}</span>
                : <span className="min-w-0 break-words">{item.label}</span>}
              {String(item.value) === String(value) && <Check size={14} className="shrink-0" />}
            </button>
          )) : <div className="px-3 py-3 text-sm text-slate-500">No results found</div>}
        </div>
      ), document.body)}
    </div>
  );
}

export function Select(props) {
  return <SearchableSelect {...props} />;
}

export function Checkbox({ label, ...props }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30" {...props} />
      {label}
    </label>
  );
}

// Modal — centered glass panel on desktop and tablets; on a phone the same
// API renders a bottom sheet: full width, pinned to the bottom edge, drag
// handle, stacked full-width footer buttons, and a height that tracks the
// visual viewport so the on-screen keyboard never buries the focused field.
// `wide` (max-w-5xl) is the long-standing two-column size. `size="xl"` is wider
// again, for the few forms that are genuinely a workspace rather than a dialog —
// the Sort & Paste run, where a row carries three chip rails and a quantity and
// the old width forced every one of them onto its own line.
const MODAL_WIDTH = { default: 'max-w-xl', wide: 'max-w-5xl', xl: 'max-w-[1400px]' };
export function Modal({ open, onClose, title, children, footer, wide, size }) {
  const tier = useTier();
  const phone = tier === 'phone';
  const touch = isTouchTier(tier);
  // The keyboard shrinks the *visual* viewport, not the layout one — a panel
  // sized in vh/dvh sits under the keys. Track the real height while open.
  // EVERY touch tier, not just phones: an iPad's on-screen keyboard eats ~40%
  // of the screen, and a 92vh dialog centred against the layout viewport put
  // its footer buttons — Save, Plan — behind the keys.
  const [vvh, setVvh] = useState(null);
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose?.();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  useEffect(() => {
    if (!open || !touch || !window.visualViewport) return;
    const vv = window.visualViewport;
    const sync = () => setVvh(vv.height);
    sync();
    vv.addEventListener('resize', sync);
    return () => { vv.removeEventListener('resize', sync); setVvh(null); };
  }, [open, touch]);
  if (!open) return null;
  // Portal to <body>: a modal opened from inside a panel with backdrop-filter/transform
  // (e.g. .ci-data-panel) would otherwise have its `fixed` positioning trapped by that
  // ancestor's containing block, clipping the footer on short/mobile viewports.
  if (phone) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-end animate-fadeIn">
        <div className="absolute inset-0 bg-[#1D1D1F]/[0.34] backdrop-blur-[8px] backdrop-saturate-150" onClick={onClose} />
        <div
          className="relative flex w-full animate-slideUp flex-col overflow-hidden rounded-t-[26px] border border-b-0 border-white/75 bg-white/90 shadow-modal backdrop-blur-2xl"
          style={{ maxHeight: vvh ? `${Math.round(vvh * 0.94)}px` : '92dvh' }}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[#1D1D1F]/[0.14]" />
          <div className="flex items-center justify-between px-4 pb-2.5 pt-2">
            <h3 className="min-w-0 break-words text-[17px] font-bold tracking-[-0.01em] text-[#1D1D1F]">{title}</h3>
            <button onClick={onClose} aria-label="Close" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B]">
              <X size={17} />
            </button>
          </div>
          <div className="ci-modal-body flex-1 overflow-y-auto overscroll-contain border-t border-[#1D1D1F]/[0.06] px-4 py-3">{children}</div>
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-[#1D1D1F]/[0.06] bg-white/50 px-4 py-3 [&>button]:h-11 [&>button]:w-full"
              style={{ paddingBottom: 'max(0.75rem, var(--sab))' }}>
              {footer}
            </div>
          )}
          {!footer && <div style={{ paddingBottom: 'var(--sab)' }} />}
        </div>
      </div>,
      document.body
    );
  }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="absolute inset-0 bg-[#1D1D1F]/[0.34] backdrop-blur-[8px] backdrop-saturate-150" onClick={onClose} />
      {/* Height tracks the VISUAL viewport on touch so a raised keyboard never
          buries the footer; falls back to 92vh with a mouse, where there is no
          keyboard to raise. */}
      <div
        className={`relative flex w-full ${MODAL_WIDTH[size] || (wide ? MODAL_WIDTH.wide : MODAL_WIDTH.default)} animate-liquidPop flex-col overflow-hidden rounded-[28px] border border-white/75 bg-white/80 shadow-modal backdrop-blur-2xl`}
        style={{ maxHeight: vvh ? `${Math.round(vvh - 24)}px` : (size === 'xl' ? '96vh' : '92vh') }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#1D1D1F]/[0.06] bg-white/40 px-5 py-4">
          <h3 className="min-w-0 break-words text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">{title}</h3>
          <button onClick={onClose} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors duration-150 hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
            <X size={15} />
          </button>
        </div>
        <div className="ci-modal-body flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-[#1D1D1F]/[0.06] bg-white/40 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// `hideCancel` is for the dialog that only reports something — a refusal with
// its reason, say. There is no choice to make, so a Cancel beside the dismiss
// button offers the same outcome twice and reads as if one of them undoes more.
export function ConfirmDialog({ open, onClose, onConfirm, title = 'Are you sure?', message, confirmLabel = 'Confirm', danger, hideCancel }) {
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        {!hideCancel && <Button variant="secondary" onClick={onClose}>Cancel</Button>}
        <Button variant={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
      </>}>
      <p className="text-sm text-gray-600">{message}</p>
    </Modal>
  );
}

// Status badge — one colour language across the whole app
const STATUS_COLOURS = {
  pending: 'bg-gray-100 text-gray-600',
  planned: 'bg-blue-50 text-blue-700',
  ready: 'bg-violet-50 text-violet-700',
  in_production: 'bg-amber-50 text-amber-700',
  in_progress: 'bg-amber-50 text-amber-700',
  partially_completed: 'bg-cyan-50 text-cyan-700',
  open: 'bg-blue-50 text-blue-700',
  produced: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-emerald-50 text-emerald-700',
  closed: 'bg-slate-200 text-slate-600',
  hold: 'bg-amber-50 text-amber-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  available: 'bg-emerald-50 text-emerald-700',
  approved: 'bg-emerald-50 text-emerald-700',
  received: 'bg-emerald-50 text-emerald-700',
  dispatched: 'bg-[#1D1D1F] text-white',
  converted: 'bg-violet-50 text-violet-700',
  partially_received: 'bg-amber-50 text-amber-700',
  quarantine: 'bg-amber-50 text-amber-700',
  running: 'bg-emerald-50 text-emerald-700',
  idle: 'bg-gray-100 text-gray-600',
  maintenance: 'bg-red-50 text-red-700',
  cancelled: 'bg-red-50 text-red-600',
  rejected: 'bg-red-50 text-red-600',
  exhausted: 'bg-gray-100 text-gray-400',
  pending_verification: 'bg-amber-50 text-amber-700',
  verified: 'bg-emerald-50 text-emerald-700',
  consumed: 'bg-violet-50 text-violet-700',
  issued: 'bg-brand-50 text-brand-700',
};
export function StatusBadge({ status }) {
  // Machined chip: hairline inset ring + top specular line so the capsule reads
  // as a piece of the glass system, and a leading dot in the tone's own colour
  // (bg-current) so status scans by shape+colour, not colour alone.
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] ${STATUS_COLOURS[status] || 'bg-gray-100 text-gray-600'}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      {(status || '').replace(/_/g, ' ')}
    </span>
  );
}

// Saved-but-unlocked plan. Deliberately NOT a StatusBadge status: `plan_draft`
// is not a status, and adding it to STATUS_COLOURS would invent a state the
// server never stores and every other screen would then have to know about.
// So it is a sibling wearing StatusBadge's exact shell — same capsule, same
// inset ring and specular line, same leading dot — with a SOLID fill instead of
// a tint, which is what makes it read as an announcement rather than one more
// resting state in a queue. Blue is the family the 'planned' status already
// owns, saturated because this job is one click short of it. `capitalize` is
// the one class dropped: the label is a sentence, not a status word.
//
// Two lines on purpose, at the status column's own width. On one line this ran
// to ~207px against a column hinted at 104px, so a single saved plan widened it
// and shoved every row's action buttons right. Left to wrap freely it broke into
// three ragged lines and read as a fat lozenge, so the break is explicit and the
// width is fixed at the column's: "Saved ·" over "lock pending", every badge in
// the queue identical. rounded-lg, not rounded-full: a pill is for one line —
// curved into two it stops reading as a badge. items-start keeps the leading dot
// on the first line rather than floating it against the middle of the stack.
//
// Lives HERE, beside the sibling it copies, because two queues wear it now:
// Planning, and Artwork since a saved plan started reaching the designer before
// it is locked. `hint` lets each say what the draft means on ITS screen — the
// planner is told to lock it, the designer is told what can still move.
export function PlanSavedBadge({ hint }) {
  return (
    <span title={hint || 'The plan is saved. Nothing downstream has it yet — open the engine and Lock to schedule it.'}
      className="inline-flex w-[104px] items-start gap-1.5 rounded-lg bg-blue-600 px-2 py-1 text-left text-[11px] font-semibold leading-tight text-white ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
      <span aria-hidden className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      <span>Saved ·<br />lock pending</span>
    </span>
  );
}

// Upstream feed status — every station row wears where its input stands:
// "Cutting · running", "Cutting · counting — 20,000 so far", "Cutting · done".
// One glance answers "is material coming?" without leaving the station.
// Self-contained (no fmt import) so the design kit stays dependency-free.
export function UpstreamChip({ upstream, available, unit }) {
  if (!upstream?.stage) return null;
  const STATES = {
    pending:             { dot: 'bg-slate-300',   text: 'text-slate-500',   label: 'not started' },
    in_progress:         { dot: 'bg-amber-500',   text: 'text-amber-700',   label: 'started', pulse: true },
    partially_completed: { dot: 'bg-cyan-500',    text: 'text-cyan-700',    label: 'counting', pulse: true },
    hold:                { dot: 'bg-red-500',     text: 'text-red-600',     label: 'on hold' },
    completed:           { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'done' },
  };
  const s = STATES[upstream.status] || STATES.pending;
  const stage = upstream.stage === 'qc' ? 'QC'
    : upstream.stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const soFar = upstream.status === 'partially_completed' && available > 0
    ? ` — ${Math.round(available).toLocaleString('en-IN')}${unit ? ` ${unit}` : ''} so far`
    : '';
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] ${s.text}`}
      title={`Previous station: ${stage} — ${s.label}${soFar}`}>
      <span aria-hidden className={`h-1 w-1 shrink-0 rounded-full ${s.dot} ${s.pulse ? 'animate-pulseSoft' : ''}`} />
      <span className="uppercase tracking-wide">{stage}</span>
      <span className="font-semibold text-[10px] normal-case opacity-90">· {s.label}{soFar}</span>
    </span>
  );
}

// Action menu — a "⋯" trigger with a portal dropdown, for overflow row actions.
// Portal + fixed positioning so it escapes the table's overflow-x-auto clipping.
// `trigger` (optional) replaces the ⋯ button with a caller-drawn control —
// it receives ({ toggle, open }) and must spread nothing; the menu still
// positions off the trigger's bounding box. Every existing caller passes no
// trigger and renders exactly as before.
export function ActionMenu({ items = [], label = 'More actions', trigger }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  // Where the panel actually lands, once it has been measured. Null until then.
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  // The menu used to be pinned by its RIGHT edge to the trigger's right edge.
  // That is correct for the ⋯ button it was written for — that button sits at
  // the right end of a row. It is WRONG for a caller-drawn trigger on the LEFT
  // (the set-type chip on a planning card, the Sort chip in a card toolbar):
  // a 190px panel hung off a chip 106px from the left edge of a 393px phone
  // put its own left edge at −84px, so "Move to Gang" rendered as "to Gang".
  // Measure the panel, then clamp it inside the glass — and flip it above the
  // trigger when there is no room below, so the bottom dock cannot bury it.
  useLayoutEffect(() => {
    if (!open || !rect || !menuRef.current) { if (pos) setPos(null); return; }
    const place = () => {
      const el = menuRef.current;
      if (!el) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const vv = window.visualViewport;
      const vw = vv?.width ?? window.innerWidth;
      const vh = vv?.height ?? window.innerHeight;
      const M = 8;
      // Keep the original right-aligned look wherever it fits...
      let left = rect.right - w;
      // ...but never outside the viewport. A panel wider than the screen is
      // pinned to the left margin; max() before min() would push it back off.
      left = Math.min(Math.max(M, left), Math.max(M, vw - w - M));
      let top = rect.bottom + 6;
      if (top + h > vh - M && rect.top - h - 6 >= M) top = rect.top - h - 6;
      top = Math.min(Math.max(M, top), Math.max(M, vh - h - M));
      const next = { left, top, maxWidth: vw - M * 2 };
      // The first pass measures a panel that has not been placed yet, and the
      // placed panel can settle a few pixels wider. Re-running on `pos` lets
      // the position converge on the final width — the equality guard is what
      // stops that becoming an endless render loop.
      setPos(p => (p && p.left === next.left && p.top === next.top && p.maxWidth === next.maxWidth ? p : next));
    };
    place();
    window.visualViewport?.addEventListener('resize', place);
    return () => window.visualViewport?.removeEventListener('resize', place);
  }, [open, rect, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = e => e.key === 'Escape' && setOpen(false);
    const onScroll = e => { if (!menuRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  if (!items.length) return null;

  const toggle = () => {
    setRect(btnRef.current.getBoundingClientRect());
    setOpen(o => !o);
  };

  return (
    <>
      {trigger ? (
        <span ref={btnRef} className="inline-flex">{trigger({ toggle, open })}</span>
      ) : (
        <button
          ref={btnRef}
          type="button"
          title={label}
          aria-label={label}
          onClick={toggle}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition duration-200 ease-apple touch:h-10 touch:w-10 ${
            open ? 'bg-[#1D1D1F]/[0.07] text-[#1D1D1F]' : 'text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]'
          }`}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[190px] rounded-2xl border border-white/75 bg-white/75 p-1.5 shadow-lift backdrop-blur-2xl"
          // Rendered once off-screen to be measured, then placed. Hiding it for
          // that first frame is what stops the panel flashing at the wrong
          // corner before it settles — the "bubble" jump.
          style={pos
            ? { top: pos.top, left: pos.left, maxWidth: pos.maxWidth }
            : { top: rect.bottom + 6, left: rect.right, visibility: 'hidden' }}
        >
          {items.map((item, i) => (
            // Destructive items are fenced off with a hairline the moment they
            // follow a non-destructive one. Rollback and Delete used to live in
            // a SECOND ⋯ menu of their own, which is how they stayed separated;
            // now that everything shares one menu the rule has to be drawn.
            <Fragment key={item.key || item.label}>
              {item.tone === 'danger' && i > 0 && items[i - 1].tone !== 'danger' && (
                <div className="my-1 border-t border-[#1D1D1F]/[0.07]" />
              )}
              <button
                type="button"
                onClick={() => { setOpen(false); item.onClick?.(); }}
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-semibold transition duration-150 touch:min-h-[44px] touch:text-[13px] ${
                  item.tone === 'danger'
                    ? 'text-red-600 hover:bg-red-50'
                    : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                }`}
              >
                {item.icon && <item.icon size={13} className={item.tone === 'danger' ? 'text-red-400' : 'text-slate-400'} />}
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// Named tones so a page says what a number MEANS ("bad") instead of restating
// the palette twice per card. `chip`/`accent` still win when passed explicitly,
// which keeps every pre-tone caller rendering exactly as before.
const KPI_TONES = {
  neutral: { chip: 'bg-slate-100 text-slate-500', accent: 'text-slate-900' },
  info: { chip: 'bg-brand-50 text-brand-600', accent: 'text-slate-900' },
  good: { chip: 'bg-emerald-50 text-emerald-600', accent: 'text-emerald-600' },
  warn: { chip: 'bg-amber-50 text-amber-600', accent: 'text-amber-600' },
  bad: { chip: 'bg-red-50 text-red-500', accent: 'text-red-600' },
  // `alarm` is `bad` with the volume up — a SOLID fill instead of a tint. It
  // exists so a page can put two red states side by side and still say which
  // one needs a person to move: `bad` = trouble someone has already acted on,
  // `alarm` = trouble nobody has. Additive on purpose; no existing card that
  // says `bad` changes.
  alarm: { chip: 'bg-red-600 text-white', accent: 'text-red-700' },
  violet: { chip: 'bg-violet-50 text-violet-600', accent: 'text-violet-600' },
};

// KPI card — icon sits in a tinted chip; value carries the accent.
// `compact` is the module-header variant: same card, roughly half the height,
// because a list page pays for that height twice (strip + table) and the tables
// already scroll. `sub` is not decoration — it is where the number gets its
// unit and its breakdown, so a compact card still explains itself.
// The ring a selected card wears. Per tone, so a selected "Board Short" reads
// red and a selected "Ready to Run" reads green — the card keeps its meaning
// while it is acting as a filter.
const KPI_ACTIVE = {
  neutral: 'ring-slate-300 bg-slate-50/70',
  info: 'ring-[#0A84FF]/45 bg-[#E1EFFF]/70',
  good: 'ring-emerald-300 bg-emerald-50/70',
  warn: 'ring-amber-300 bg-amber-50/70',
  bad: 'ring-red-300 bg-red-50/70',
  alarm: 'ring-red-500 bg-red-50',
  violet: 'ring-violet-300 bg-violet-50/70',
};

// KPI card — icon sits in a tinted chip; value carries the accent.
// `compact` is the module-header variant: same card, roughly half the height,
// because a list page pays for that height twice (strip + table) and the tables
// already scroll. `sub` is not decoration — it is where the number gets its
// unit and its breakdown, so a compact card still explains itself.
//
// Pass `onClick` to make the card a filter for the list beneath it: it becomes
// a real <button> (keyboard-reachable, aria-pressed) and wears a ring while
// selected. A card is only given an onClick when it names a genuine SUBSET —
// a total like "Order Value" covers every row, so clicking it could only ever
// be a no-op, and a control that does nothing is worse than a plain tile.
export function KpiCard({ label, value, sub, accent, icon: Icon, chip, tone, compact = false, title, onClick, active = false }) {
  const t = KPI_TONES[tone];
  const chipCls = chip || t?.chip || 'bg-brand-50 text-brand-600';
  const accentCls = accent || t?.accent || 'text-slate-900';
  const activeCls = KPI_ACTIVE[tone] || KPI_ACTIVE.info;
  const Tag = onClick ? 'button' : 'div';
  const interactive = onClick
    ? `w-full cursor-pointer text-left hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.99] ${active ? `ring-2 ${activeCls}` : 'ring-0'}`
    : 'hover:-translate-y-0.5 hover:shadow-lift';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick, 'aria-pressed': active } : {})}
      title={title || (onClick ? `${active ? 'Showing only' : 'Show only'} ${label}` : undefined)}
      className={`glass transition-[box-shadow,transform,background-color] duration-300 ease-apple ${interactive} ${compact ? 'rounded-2xl px-3 py-2.5' : 'rounded-[22px] p-4'}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`font-semibold uppercase tracking-wider text-[#86868B] ${compact ? 'text-[10px] leading-tight' : 'text-[11px]'}`}>{label}</span>
        {Icon && (
          <span className={`flex shrink-0 items-center justify-center rounded-full ${chipCls} ${compact ? 'h-6 w-6' : 'h-7 w-7'}`}>
            <Icon size={compact ? 12 : 14} />
          </span>
        )}
      </div>
      <div className={`font-extrabold tracking-[-0.03em] tabular-nums ${accentCls} ${compact ? 'mt-0.5 text-xl leading-tight' : 'mt-1 text-3xl'}`}>{value}</div>
      {sub && <div className={`text-[#6E6E73] ${compact ? 'mt-0.5 text-[11px] leading-snug' : 'mt-0.5 text-xs'}`}>{sub}</div>}
    </Tag>
  );
}

// The strip of compact KPIs that sits between a module's tabs and its table.
// Column counts are spelled out per size because Tailwind only keeps classes it
// can see as literals — an interpolated `grid-cols-${n}` compiles to nothing.
const KPI_COLS = {
  3: 'grid-cols-2 sm:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-5',
  6: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6',
  7: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-7',
  8: 'grid-cols-2 sm:grid-cols-4 xl:grid-cols-8',
};
export function KpiRow({ cols = 6, className = '', children }) {
  // .ci-kpi-rail has rules only under (max-width: 767.98px) — on a phone the
  // grid becomes one horizontal swipe rail (cards ~45vw, snap-aligned) so six
  // KPIs cost one row of viewport instead of three. Inert on desktop.
  return <div className={`ci-kpi-rail mb-3 grid gap-2.5 ${KPI_COLS[cols] || KPI_COLS[6]} ${className}`}>{children}</div>;
}

// Selected KPI cards, and the list below reads them. Two modes:
//
//   single (default) — one card at a time; picking a different card REPLACES
//   the selection, clicking the live one turns it off. The clearest view for
//   operational screens (Warehouse and the rest), where a second filter
//   fighting the strip is how two numbers on one screen start disagreeing.
//
//   multi — each click toggles that card independently and the active set
//   INTERSECTS: a row must pass every selected card. For analysis screens
//   (Planning) where "ready AND customer-WIP" is a real question. A card only
//   leaves the set when it is clicked again.
//
// `scope` clears the selection whenever the page changes what it is listing —
// pass the tab key. Without it a card selected on one tab silently keeps
// filtering the next, and the strip would be describing a set the user cannot
// see. It is a value, not a dependency array, so callers join their own.
export function useKpiFilter(scope, { multi = false } = {}) {
  // One shape for both modes: the selection is an array (length ≤ 1 when
  // single). `key` stays the single-mode reading so existing callers and the
  // notice keep working untouched.
  const [keys, setKeys] = useState([]);
  // React's documented "adjust state when a prop changes" shape. Deliberately
  // state and not a ref: a ref written during render is not rolled back when
  // React throws a render away, so under StrictMode's double invoke the scope
  // would look already-seen and the stale selection would survive.
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    if (keys.length) setKeys([]);
  }
  return {
    key: keys[0] ?? null,
    keys,
    is: k => keys.includes(k),
    toggle: k => setKeys(cur => (cur.includes(k)
      ? cur.filter(x => x !== k)
      : multi ? [...cur, k] : [k])),
    clear: () => setKeys([]),
    // Rows filtered by the selected card(s) — every selected predicate must
    // pass. `predicates` maps a card key to a row test; a key with no
    // predicate leaves the list untouched, so adding a card is never able to
    // silently empty the table.
    apply: (rows, predicates) => {
      const ps = keys.map(k => predicates[k]).filter(Boolean);
      return ps.length ? rows.filter(r => ps.every(p => p(r))) : rows;
    },
  };
}

// The line that admits the list is not showing everything. Without it a KPI
// filter is indistinguishable from a page that has lost rows.
export function KpiFilterNotice({ filter, label, shown, total, className = '' }) {
  if (!filter.key) return null;
  // A card whose key has no label still gets a sentence rather than the word
  // "undefined" — the notice is the only thing telling the user why the list
  // shrank, so it must never be the confusing part.
  const what = label || 'the selected KPI';
  return (
    <div className={`mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-[#0A84FF]/20 bg-[#E1EFFF]/60 px-3 py-1.5 text-xs font-semibold text-[#0064D2] backdrop-blur-xl ${className}`}>
      <Filter size={13} className="shrink-0" />
      <span>{shown === 0 ? 'No rows here match' : `Showing ${fmtNum(shown)} of ${fmtNum(total)} —`} {what}</span>
      <button type="button" onClick={filter.clear}
        className="ml-auto inline-flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-0.5 text-[11px] font-bold text-[#0064D2] transition-colors hover:bg-white">
        <X size={11} /> Clear
      </button>
    </div>
  );
}
const fmtNum = n => (n ?? 0).toLocaleString('en-IN');

// Signed whole-day distance to a due date: POSITIVE means that many days
// overdue, negative means that many days still to run, null when undated.
// Date-only strings are read as local calendar days on purpose — Date.parse
// puts '2026-07-15' at UTC midnight, which reads as "yesterday" for the whole
// IST working day and would report every job due today as one day late.
export function dueDelta(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  const due = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(dateStr);
  if (Number.isNaN(+due)) return null;
  const n = new Date();
  return Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - due) / 86400000);
}

// Page header
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="module-page-title max-w-full">{title}</h1>
        {subtitle && <p className="module-page-subtitle max-w-full">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// Search boxes RISE off the page — every other control recedes into the glass,
// so the one thing a user hunts for first gets the opposite treatment: a soft
// white→blue gradient, a lifted shadow with a faint blue halo, and a blue
// glyph. One string so LaneSearch, the TopBar, the Timeline drawer and every
// bespoke box render the identical raise; sites using it must not add their
// own border/bg/shadow classes on top.
export const SEARCH_FX =
  'border-[#0A84FF]/25 bg-gradient-to-b from-white to-[#EDF4FF] ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_2px_5px_rgba(29,29,31,0.08),0_5px_16px_rgba(10,132,255,0.14)] ' +
  'hover:to-[#E3EEFF] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_3px_8px_rgba(29,29,31,0.10),0_7px_20px_rgba(10,132,255,0.18)] ' +
  'focus:border-[#0A84FF] focus:from-white focus:to-white focus:ring-[3px] focus:ring-[#0A84FF]/25 ' +
  'focus:shadow-[0_0_18px_rgba(10,132,255,0.25),0_2px_10px_rgba(10,132,255,0.14)]';

// Search input
// `className` replaces the default width (w-72) when given — the phone card
// list stretches the box across its toolbar, pages with long placeholders go
// wider still. Wide enough by default that a typical placeholder reads whole.
export function SearchInput({ value, onChange, placeholder = 'Search…', className = '' }) {
  return (
    <div className={`relative ${className || 'w-72'}`}>
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#0A84FF]/80" />
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full rounded-full border py-2 pl-8 pr-3 text-sm font-medium text-[#1D1D1F] outline-none transition duration-200 ease-apple ${SEARCH_FX}`}
      />
    </div>
  );
}

// Deep row search — the single source of truth for "search matches ANY cell".
// Builds a haystack from every value on the row (JSON.stringify walks nested
// line arrays / objects too, so a product or artwork buried inside a line still
// matches) plus any caller-supplied extra text. Space-separated terms are ANDed,
// so "carton 380" narrows across fields. Used by DataTable and by the pages that
// filter their own rows (queue boards, FG, extra sheets, track).
//
// Every term is tried against the raw haystack AND its squashed key, so the
// floor shorthand "2038" finds a board stored as 'Duplex GB · 296 GSM · 20 x 38'
// without anyone reproducing the spacing. See searchKey.js — squashing only ever
// widens the match, so punctuation-dependent searches still work.
export function rowMatches(row, query, extra = '') {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = (JSON.stringify(Object.values(row)) + ' ' + extra).toLowerCase();
  const squashed = squash(haystack);
  return terms.every(t => matchesTerm(haystack, squashed, t));
}

// Export menu — branded PDF / Excel download for any tabular view.
// `build` returns (or resolves to) an exporter spec at click time, so it always
// captures the currently filtered data.
export function ExportMenu({ build, size = 'sm', variant = 'secondary', label = 'Export', className = '' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = e => e.key === 'Escape' && setOpen(false);
    const onScroll = e => { if (!menuRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const run = async kind => {
    setOpen(false);
    setBusy(kind);
    try {
      const spec = await build();
      if (!spec || !specRowCount(spec)) { toast?.info('Nothing to export'); return; }
      if (kind === 'pdf') await exportPDF(spec); else await exportXLSX(spec);
      toast?.success(`${kind === 'pdf' ? 'PDF' : 'Excel'} downloaded`);
    } catch (e) {
      console.error('Export failed', e);
      toast?.error(`Export failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const items = [
    { kind: 'pdf', icon: FileText, label: 'PDF document', sub: 'Branded A4 report' },
    { kind: 'xlsx', icon: FileSpreadsheet, label: 'Excel workbook', sub: 'Filtered rows, live table' },
  ];

  return (
    <>
      <span ref={btnRef} className="inline-flex">
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          disabled={!!busy}
          onClick={() => { setRect(btnRef.current.getBoundingClientRect()); setOpen(o => !o); }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {label}
          <ChevronDown size={13} className="opacity-60" />
        </Button>
      </span>
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[120] w-56 animate-scaleIn rounded-2xl border border-white/75 bg-white/95 p-1.5 shadow-lift backdrop-blur-xl"
          style={{ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }}
        >
          {items.map(item => (
            <button key={item.kind} type="button" onClick={() => run(item.kind)}
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition duration-150 hover:bg-[#0A84FF]/[0.08]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#E1EFFF] text-[#0064D2]">
                <item.icon size={15} />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[#1D1D1F]">{item.label}</span>
                <span className="block text-[11px] text-[#86868B]">{item.sub}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function normalizeSortValue(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  const numeric = Number(text.replace(/[₹,\s]/g, ''));
  if (Number.isFinite(numeric) && /\d/.test(text)) return numeric;
  const date = Date.parse(text);
  if (Number.isFinite(date) && /[-/]|[A-Za-z]{3}/.test(text)) return date;
  return text.toLowerCase();
}

// How many rows mount at once before scrolling pulls in the next slice.
const ROW_WINDOW = 60;

// ─── Phone cards — how a DataTable reads on a handset ────────────────────────
// A column may declare its card role explicitly (`card: 'title' | 'subtitle' |
// 'status' | 'metric' | 'detail' | 'actions' | 'hide'`); columns that don't are
// classified by shape — first column titles the card, right-aligned columns are
// metrics, a key smelling of status wears the chip, trailing render-only
// columns are actions. Every page therefore gets a sane card for free, and any
// page can then say exactly what it means.
function classifyColumns(columns, faceLimit = 4) {
  const metrics = [], actions = [], details = [], face = [];
  let title = null, subtitle = null, status = null;
  for (const c of columns) {
    const role = c.card;
    if (role === 'hide') continue;
    if (role === 'title') { title = c; continue; }
    if (role === 'subtitle') { subtitle = c; continue; }
    if (role === 'status') { status = c; continue; }
    // 'face' is for a CONTROL or chip that must be reachable without opening
    // Details — a set-type menu, a gang chip. It renders bare (no caption) in
    // a wrap-flow band under the title, so a chip stays a chip.
    if (role === 'face') { face.push(c); continue; }
    if (role === 'metric') { metrics.push(c); continue; }
    if (role === 'actions') { actions.push(c); continue; }
    if (role === 'detail') { details.push(c); continue; }
    const key = String(c.key || '');
    const label = String(c.label || '');
    if (!title) { title = c; continue; }
    if (key.startsWith('_') || label === '' || /^actions?$/i.test(label)) { actions.push(c); continue; }
    if (!status && /status|stage|state/.test(key.toLowerCase())) { status = c; continue; }
    if (c.align === 'right') { metrics.push(c); continue; }
    if (!subtitle) { subtitle = c; continue; }
    details.push(c);
  }
  // A card face holds four figures comfortably; the rest wait behind Details.
  // A page whose card IS the working surface (Planning) raises the limit.
  const faceMetrics = metrics.slice(0, faceLimit);
  const moreMetrics = metrics.slice(faceLimit);
  return { title, subtitle, status, face, metrics: faceMetrics, actions, details: [...moreMetrics, ...details] };
}

const cellValue = (c, r) => (c.render ? c.render(r) : r[c.key] ?? '—');

// DataTable — search + sort + selectable rows + branded PDF/Excel export.
// Literal class strings per tone — Tailwind only keeps classes it can see, so
// these can never be built by interpolation.
const GROUP_RAIL = {
  violet: {
    head: 'border-violet-400 bg-violet-50/80',
    body: 'border-violet-400 bg-violet-50/40',
    edge: 'border-b-violet-100',
    picked: '!bg-violet-100/60',
  },
  teal: {
    head: 'border-teal-400 bg-teal-50/80',
    body: 'border-teal-400 bg-teal-50/40',
    edge: 'border-b-teal-100',
    picked: '!bg-teal-100/60',
  },
};

export function DataTable({
  columns,
  rows,
  onRowClick,
  empty = 'Nothing here yet',
  // How many figures the card face carries before the rest fall behind
  // Details. Four suits a browsing list; a board that IS the working surface
  // (Planning) raises it so the planner never taps to see the basics.
  faceMetrics = 4,
  // Full, unmerged columns for the PDF/Excel when the screen shows merged ones.
  exportColumns,
  searchable,
  // Controlled search — the page owns the query and does its own filtering
  // (because a KPI strip or a filter notice has to count the SAME searched
  // set), but the box itself renders in the table toolbar where every other
  // search lives. Passing `onSearchChange` supersedes `searchable`: the table
  // shows the box, wires it to the caller, and filters nothing itself. Kills
  // the half-empty band pages used to float above the table for their own bar.
  searchValue,
  onSearchChange,
  searchPlaceholder,
  selectable = false,
  selectedIds = [],
  onToggleRow,
  onToggleAll,
  // Column knobs beyond the basics: `width` puts a Tailwind width/min-width
  // class on BOTH the th and every td of that column (e.g. 'w-[168px]'), so a
  // table can set its own proportions instead of letting the widest cell win;
  // `headClass` styles only the heading. Both are optional — a column without
  // them behaves exactly as before.
  //
  // Per-row decoration. There was no hook for this, so a row could never carry
  // a state of its own — which is exactly what an unread-conversation tint
  // needs. It APPENDS to the class the table computes, so the group rail, the
  // selected tint and the zebra stripe all keep working underneath it.
  rowClass,
  getRowId = r => r.id,
  serialNumber = true,
  exportName,
  exportSubtitle,
  exportMeta,
  exportSummary,
  dense = false,
  defaultSort,
  // Group rail tone. A grouped run is violet when it is a GANG (different
  // products, splits after die cutting) and teal when it is a COMBINED RUN
  // (one carton, one pile, never splits) — the same two languages the chips
  // use. Supplied per row so one table can hold both; defaults to violet, so
  // every existing caller is unchanged.
  groupTone,
  // Extra class for each card in the card-tier renderer — a page's way of
  // giving ITS cards an identity (Planning's gradient edge). Gang cards are
  // exempt: their violet rail is already their identity.
  cardClass = '',
  // Row grouping — rows whose groupBy(row) returns the same truthy key are
  // pulled together into one visual block with a full-width header row
  // (renderGroupHeader(rowsOfGroup)) and a shared coloured rail, regardless of
  // the active sort. Rows returning null stay independent. Used for gang runs.
  groupBy,
  renderGroupHeader,
}) {
  // Horizontal padding is the single biggest consumer of table width: it is paid
  // TWICE per column, so on a 16-column board px-4 spent 512px — a quarter of the
  // table — on empty gutters and pushed the last columns off the screen. px-2
  // still leaves 16px between one column's text and the next, which is enough
  // separation without a rule, and buys back ~256px of real content.
  const cellPx = dense ? 'px-1.5' : 'px-2';
  const tier = useTier();
  // Which phone cards are open to their full detail grid. Keyed by row id so an
  // open card survives a re-sort; a stale id after a data refresh is inert.
  const [openCards, setOpenCards] = useState(() => new Set());
  const [q, setQ] = useState('');
  // The input keeps the typed value so the caret never stalls; the expensive
  // filter runs against the deferred copy, which React is free to interrupt.
  const deferredQ = useDeferredValue(q);
  const [sort, setSort] = useState(() => {
    if (defaultSort) return defaultSort;
    const first = columns.find(c => c.sortable !== false && c.key && c.label && !String(c.key).startsWith('_'));
    return first ? { key: first.key, dir: 'asc' } : null;
  });
  // Search matches ANY field of the row — every raw value (so hidden/form-only
  // fields count) plus each column's rendered/derived text via col.searchValue
  // (so what you SEE in a formatted cell is searchable too). See rowMatches.
  const filtered = useMemo(() => {
    if (!deferredQ.trim()) return rows;
    const searchCols = columns.filter(c => typeof c.searchValue === 'function');
    const rowExtra = r => {
      let extra = '';
      for (const c of searchCols) {
        const sv = c.searchValue(r);
        if (sv != null && sv !== '') extra += ' ' + sv;
      }
      return extra;
    };
    return rows.filter(r => rowMatches(r, deferredQ, rowExtra(r)));
  }, [rows, columns, deferredQ]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    // A merged column carries several facts, and each of them still has to be
    // sortable — combining cells must not cost the planner a sort. `sortKeys`
    // declares those sub-sorts; the active one is resolved here exactly like a
    // real column, so the comparator below needs to know nothing about it.
    const col = columns.find(c => c.key === sort.key)
      || columns.flatMap(c => c.sortKeys || []).find(s => s.key === sort.key);
    return [...filtered].sort((a, b) => {
      const av = normalizeSortValue(col?.sortValue ? col.sortValue(a) : a[sort.key]);
      const bv = normalizeSortValue(col?.sortValue ? col.sortValue(b) : b[sort.key]);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filtered, columns, sort]);
  // Cluster grouped rows: each group appears once, at its first row's sorted
  // position, with every member directly beneath it — the group never scatters.
  // Bucketing by key keeps this linear; a filter-per-group was quadratic.
  const { display, groupMembers } = useMemo(() => {
    if (!groupBy) return { display: sorted, groupMembers: null };
    const buckets = new Map();
    for (const r of sorted) {
      const g = groupBy(r);
      if (!g) continue;
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(r);
    }
    const seen = new Set();
    const out = [];
    for (const r of sorted) {
      const g = groupBy(r);
      if (!g) { out.push(r); continue; }
      if (seen.has(g)) continue;
      seen.add(g);
      out.push(...buckets.get(g));
    }
    return { display: out, groupMembers: buckets };
  }, [sorted, groupBy]);
  // Windowing — a plant master can hold thousands of rows, and mounting them
  // all at once buries the page in DOM nodes. Render a screenful and extend as
  // the operator scrolls. Export and select-all still act on every match.
  const [limit, setLimit] = useState(ROW_WINDOW);
  useEffect(() => { setLimit(ROW_WINDOW); }, [deferredQ, sort, rows]);
  const visible = display.length > limit ? display.slice(0, limit) : display;
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (display.length <= limit) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setLimit(l => l + ROW_WINDOW);
    }, { rootMargin: '400px' });
    io.observe(node);
    return () => io.disconnect();
  }, [display.length, limit]);
  const selectedSet = new Set(selectedIds.map(String));
  const visibleIds = sorted.map(getRowId).filter(id => id != null).map(String);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedSet.has(id));
  const toggleSort = key => setSort(current => ({
    key,
    dir: current?.key === key && current.dir === 'asc' ? 'desc' : 'asc',
  }));
  // Export exactly what the user is looking at — current search filter + sort.
  const buildExport = () => ({
    name: exportName,
    title: exportName || 'Report',
    subtitle: exportSubtitle,
    // A sheet has room a screen does not. Where columns are merged so the board
    // fits without scrolling, `exportColumns` keeps the PDF and the workbook
    // one-fact-per-column — the merge is a screen decision, not a data one.
    columns: exportColumns || columns,
    rows: sorted,
    meta: [
      ...(typeof exportMeta === 'function' ? exportMeta() : exportMeta || []),
      (onSearchChange ? searchValue : q) ? `Search: "${onSearchChange ? searchValue : q}"` : null,
      `${sorted.length} of ${rows.length} records`,
    ].filter(Boolean),
    summary: typeof exportSummary === 'function' ? exportSummary(sorted) : exportSummary,
  });
  const showToolbar = searchable || exportName || onSearchChange;

  // ── Card tiers: the table becomes a card list ──────────────────────────────
  // Same data pipeline (search → sort → group → window), different final form:
  // a column grid built for a mouse has no honest 390px rendering, so each row
  // becomes a card — title, status, the figures that matter, and everything
  // else one tap behind Details. Phones stack them; a tablet held upright
  // lays them two abreast. Desktop and landscape tablets keep the table.
  if (isCardTier(tier)) {
    const shape = classifyColumns(columns, faceMetrics);
    const sortItems = columns
      .filter(c => c.sortable !== false && c.key && c.label && !String(c.key).startsWith('_'))
      .map(c => ({
        key: c.key,
        label: sort?.key === c.key ? `${c.label} ${sort.dir === 'asc' ? '↑' : '↓'}` : c.label,
        onClick: () => toggleSort(c.key),
      }));
    const toggleCard = id => setOpenCards(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    return (
      <div className="ci-data-panel">
        {(showToolbar || selectable || sortItems.length > 0) && (
          <div className="space-y-2 border-b border-[#1D1D1F]/[0.05] bg-white/30 p-2.5">
            {onSearchChange
              ? <SearchInput value={searchValue || ''} onChange={onSearchChange} placeholder={searchPlaceholder} className="w-full" />
              : searchable && <SearchInput value={q} onChange={setQ} className="w-full" />}
            <div className="flex flex-wrap items-center gap-2">
              {sortItems.length > 0 && (
                <ActionMenu items={sortItems} label="Sort" trigger={({ toggle: t, open: o }) => (
                  <button type="button" onClick={t}
                    className={`flex h-9 items-center gap-1.5 rounded-full border border-white/70 px-3 text-xs font-semibold ${o ? 'bg-white text-[#007AFF]' : 'bg-white/60 text-[#515154]'}`}>
                    <ArrowUpDown size={13} />
                    {sort?.key ? (columns.find(c => c.key === sort.key)?.label || 'Sort') : 'Sort'}
                    {sort?.key && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                )} />
              )}
              {selectable && (
                <label className="flex h-9 items-center gap-2 rounded-full border border-white/70 bg-white/60 px-3 text-xs font-semibold text-[#515154]">
                  <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                    checked={allVisibleSelected}
                    onChange={e => onToggleAll?.(sorted, e.target.checked)} />
                  All{selectedIds.length > 0 ? ` · ${selectedIds.length}` : ''}
                </label>
              )}
              <span className="ml-auto flex items-center gap-2">
                {exportName && <ExportMenu build={buildExport} />}
              </span>
            </div>
          </div>
        )}
        <div className="ci-card-grid grid grid-cols-1 gap-2 p-2.5">
          {sorted.length === 0 && (
            <div className="ci-card-span flex flex-col items-center gap-2.5 py-12">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/70 text-[#B8B8BD] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_6px_16px_rgba(29,29,31,0.06)] ring-1 ring-white/80">
                <Inbox size={20} />
              </span>
              <span className="text-sm font-medium text-[#86868B]">{empty}</span>
            </div>
          )}
          {visible.map((r, i) => {
            const rowId = getRowId(r) ?? i;
            const checked = selectedSet.has(String(getRowId(r)));
            const gKey = groupBy ? groupBy(r) : null;
            const firstOfGroup = gKey && (i === 0 || groupBy(display[i - 1]) !== gKey);
            const open = openCards.has(rowId);
            const hasDetails = shape.details.length > 0;
            return (
              <Fragment key={rowId}>
                {firstOfGroup && renderGroupHeader && (
                  <div className="ci-card-span rounded-2xl border-l-[3px] border-violet-400 bg-violet-50/80 px-3 py-2">
                    {renderGroupHeader(groupMembers?.get(gKey) ?? [])}
                  </div>
                )}
                <div
                  className={`rounded-2xl border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,.9),0_1px_2px_rgba(29,29,31,.04)] ${gKey ? 'border-violet-200 bg-violet-50/50' : checked ? 'border-[#0A84FF]/30 bg-indigo-50/60' : `border-white/70 bg-white/70 ${cardClass}`} ${rowClass?.(r) || ''}`}
                  onClick={onRowClick ? e => {
                    if (e.target.closest('button, a, input, select, label, [role="button"]')) return;
                    onRowClick(r);
                  } : undefined}
                >
                  <div className="flex items-start gap-2.5">
                    {selectable && (
                      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                        checked={checked}
                        onClick={e => e.stopPropagation()}
                        onChange={e => onToggleRow?.(r, e.target.checked)} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-[15px] font-bold leading-snug text-[#1D1D1F]">
                        {shape.title ? cellValue(shape.title, r) : '—'}
                      </div>
                      {shape.subtitle && (
                        <div className="mt-0.5 break-words text-[13px] leading-snug text-[#6E6E73]">
                          {cellValue(shape.subtitle, r)}
                        </div>
                      )}
                    </div>
                    {/* Status only — actions get their own row below, so a pair
                        of labelled buttons can never crush the title into a
                        one-character column. */}
                    {shape.status && (
                      <span className="max-w-[150px] shrink-0" onClick={e => e.stopPropagation()}>{cellValue(shape.status, r)}</span>
                    )}
                  </div>
                  {/* Controls, one band: chips the finger reaches for (set
                      type, gang) on the left, the row's verbs on the right.
                      They shared a card but not a line before, which left a
                      dead stripe across every card between them. `ml-auto`
                      keeps the verbs hard right whether or not a chip is
                      present, so a card with actions alone reads as it did. */}
                  {(shape.face.length > 0 || shape.actions.length > 0) && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={e => e.stopPropagation()}>
                      {shape.face.map(f => <span key={f.key} className="min-w-0 [&>*]:align-middle">{cellValue(f, r)}</span>)}
                      {shape.actions.length > 0 && (
                        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                          {shape.actions.map(a => <span key={a.key} className="[&>*]:align-middle">{cellValue(a, r)}</span>)}
                        </span>
                      )}
                    </div>
                  )}
                  {(() => {
                    // A metric that is '—' for THIS row says nothing — a film
                    // has no GSM, a bench job no machine. Dead values stay in
                    // Details; the card face only carries live figures.
                    const live = shape.metrics
                      .map(m => [m, cellValue(m, r)])
                      .filter(([, v]) => !(v == null || v === '' || v === '—'));
                    return live.length > 0 && (
                      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
                        {live.map(([m, v]) => (
                          <div key={m.key} className="min-w-0">
                            <div className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{m.label}</div>
                            {/* Wraps, never truncates. A clipped value on a card
                                is information LOST — there is no hover title on
                                a touch screen to recover it, and a board grade
                                or a date that ends in an ellipsis is exactly
                                the "text rendering issue" this card must not
                                have. Two short lines cost nothing. */}
                            <div className="text-[13px] font-semibold tabular-nums text-[#1D1D1F] [overflow-wrap:anywhere]">{v}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  {open && hasDetails && (
                    <div className="mt-2.5 space-y-1.5 border-t border-[#1D1D1F]/[0.06] pt-2.5">
                      {shape.details.map(d => (
                        <div key={d.key} className="flex items-baseline justify-between gap-3">
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{d.label}</span>
                          <span className="min-w-0 text-right text-[13px] font-medium text-[#1D1D1F] [overflow-wrap:anywhere]">{cellValue(d, r)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {hasDetails && (
                    <button type="button"
                      onClick={e => { e.stopPropagation(); toggleCard(rowId); }}
                      className="mt-2 flex h-8 w-full items-center justify-center gap-1 rounded-xl text-[11px] font-bold text-[#007AFF] active:bg-[#0A84FF]/[0.08]">
                      <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                      {open ? 'Less' : `Details (${shape.details.length})`}
                    </button>
                  )}
                </div>
              </Fragment>
            );
          })}
          {display.length > limit && (
            <div ref={sentinelRef} className="ci-card-span pt-1 text-center">
              <button type="button" onClick={() => setLimit(l => l + ROW_WINDOW)}
                className="rounded-full px-4 py-2 text-xs font-semibold text-slate-500 active:bg-white">
                Showing {visible.length} of {display.length} — show more
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ci-data-panel">
      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D1D1F]/[0.05] bg-white/30 p-3">
          {onSearchChange
            ? <SearchInput value={searchValue || ''} onChange={onSearchChange} placeholder={searchPlaceholder} className="w-full max-w-md" />
            : searchable ? <SearchInput value={q} onChange={setQ} /> : <span />}
          {exportName && <ExportMenu build={buildExport} />}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="ci-table-head">
              {selectable && (
                <th className={`w-8 ${cellPx} py-2.5`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30"
                    checked={allVisibleSelected}
                    onChange={e => onToggleAll?.(sorted, e.target.checked)}
                  />
                </th>
              )}
              {serialNumber && (
                // "S.No." is four glyphs and a period wider than the counter it
                // labels, and on a crowded board the heading — not the numbers —
                // was setting this column's width. "#" says the same thing.
                <th className={`w-8 ${cellPx} py-2.5 text-right`}>
                  <span className="text-xs font-bold text-slate-400">#</span>
                </th>
              )}
              {columns.map(c => {
                const right = c.align === 'right';
                const subSorts = c.sortKeys || null;
                const activeSub = subSorts?.find(s => s.key === sort?.key);
                return (
                <th key={c.key} className={`${cellPx} py-2.5 ${right ? 'text-right' : 'text-left'} ${c.headClass || c.width || ''} ${c.colClass || ''}`}>
                  {subSorts ? (
                    // A merged column's heading offers the sorts of every fact
                    // inside it. The label still names the column; the menu is
                    // how you choose which of its figures the board is ordered
                    // by, so nothing lost a sort when the cells were combined.
                    <ActionMenu
                      label={`Sort by ${c.label}`}
                      items={subSorts.map(s => ({
                        key: s.key,
                        label: sort?.key === s.key ? `${s.label} ${sort.dir === 'asc' ? '↑' : '↓'}` : s.label,
                        onClick: () => toggleSort(s.key),
                      }))}
                      trigger={({ toggle }) => (
                        <button
                          type="button"
                          onClick={toggle}
                          className={`inline-flex max-w-full items-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-bold uppercase tracking-[0.02em] transition hover:bg-white hover:text-indigo-700
                            ${activeSub ? 'text-indigo-700' : 'text-slate-500'} ${right ? '-mr-1 flex-row-reverse text-right' : '-ml-1 text-left'}`}
                        >
                          {activeSub ? `${c.label} · ${activeSub.label}` : c.label}
                          {activeSub
                            ? sort.dir === 'asc' ? <ArrowUp size={11} className="shrink-0" /> : <ArrowDown size={11} className="shrink-0" />
                            : <ArrowUpDown size={11} className="shrink-0 text-slate-300" />}
                        </button>
                      )}
                    />
                  ) : c.sortable === false || !c.key || !c.label ? (
                    c.label
                  ) : (
                    // A heading has to sit flush over the column it names, and it
                    // is the LABEL that names it, not the sort glyph. So the glyph
                    // leads on a right-aligned column and trails on a left-aligned
                    // one, and the hover lozenge's own padding is cancelled by an
                    // equal negative margin on that same side. Without this the
                    // label floated ~20px inboard of its own figures — every
                    // number in the table read as belonging to the column over.
                    // text-right also carries the alignment into a heading long
                    // enough to wrap ("Sheets / Packet"), whose second line would
                    // otherwise sit left under a right-aligned first.
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={`inline-flex max-w-full items-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-bold uppercase tracking-[0.02em] text-slate-500 transition hover:bg-white hover:text-indigo-700
                        ${right ? '-mr-1 flex-row-reverse text-right' : '-ml-1 text-left'}`}
                    >
                      {c.label}
                      {/* shrink-0 so the glyph is never the thing that squeezes a
                          wrapping label, and 11px because on a narrow numeric
                          column the heading — not the figures — was setting the
                          column's minimum width. */}
                      {sort?.key === c.key
                        ? sort.dir === 'asc' ? <ArrowUp size={11} className="shrink-0" /> : <ArrowDown size={11} className="shrink-0" />
                        : <ArrowUpDown size={11} className="shrink-0 text-slate-300" />}
                    </button>
                  )}
                </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={columns.length + (selectable ? 1 : 0) + (serialNumber ? 1 : 0)} className="px-4 py-12">
                <div className="flex flex-col items-center gap-2.5">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/70 text-[#B8B8BD] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_6px_16px_rgba(29,29,31,0.06)] ring-1 ring-white/80">
                    <Inbox size={20} />
                  </span>
                  <span className="text-sm font-medium text-[#86868B]">{empty}</span>
                </div>
              </td></tr>
            )}
            {visible.map((r, i) => {
              const rowId = getRowId(r);
              const checked = selectedSet.has(String(rowId));
              const totalCols = columns.length + (selectable ? 1 : 0) + (serialNumber ? 1 : 0);
              const gKey = groupBy ? groupBy(r) : null;
              // Group edges are measured against the full list, so a group split
              // by the window boundary does not draw a false closing border.
              const firstOfGroup = gKey && (i === 0 || groupBy(display[i - 1]) !== gKey);
              const lastOfGroup = gKey && (i === display.length - 1 || groupBy(display[i + 1]) !== gKey);
              return (
              // Keyed by the table's OWN identity, not r.id: several pages key
              // rows on line_id and carry no `id` at all, so those rows used to
              // key by array index — and any state a cell held (an open
              // popover, a just-cleared unread badge) would follow the position
              // rather than the record whenever the list re-sorted.
              <Fragment key={getRowId(r) ?? r.id ?? i}>
                {firstOfGroup && renderGroupHeader && (
                  <tr className={`border-l-[3px] ${GROUP_RAIL[groupTone?.(r) || 'violet'].head}`}>
                    <td colSpan={totalCols} className={`${cellPx} py-2`}>
                      {renderGroupHeader(groupMembers?.get(gKey) ?? [])}
                    </td>
                  </tr>
                )}
              <tr
                onClick={onRowClick ? e => {
                  // Bubbling guard — clicks on interactive cells must not fire row navigation.
                  if (e.target.closest('button, a, input, select, label, [role="button"]')) return;
                  onRowClick(r);
                } : undefined}
                className={`ci-table-row ${gKey ? `border-l-[3px] ${GROUP_RAIL[groupTone?.(r) || 'violet'].body} ${lastOfGroup ? `border-b ${GROUP_RAIL[groupTone?.(r) || 'violet'].edge}` : ''}` : checked ? 'bg-indigo-50/55' : i % 2 ? 'bg-[#5B6B8C]/[0.055]' : ''} ${gKey && checked ? GROUP_RAIL[groupTone?.(r) || 'violet'].picked : ''} ${onRowClick ? 'cursor-pointer' : ''} ${rowClass?.(r) || ''}`}>
                {selectable && (
                  // align-top, like every other cell: the default middle
                  // alignment floated the tick halfway down a three-line board
                  // row while its own row's text sat at the top, so the ticks
                  // read as a ragged column of their own. mt-0.5 optically
                  // centres the 16px box against the first line of text.
                  <td className={`${cellPx} py-3 align-top`} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF] focus:ring-[#0A84FF]/30"
                      checked={checked}
                      onChange={e => onToggleRow?.(r, e.target.checked)}
                    />
                  </td>
                )}
                {serialNumber && (
                  <td className={`${cellPx} py-3 align-top text-right tabular-nums text-slate-400`}>{i + 1}</td>
                )}
                {columns.map(c => (
                  <td key={c.key} className={`${cellPx} py-3 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.width || ''} ${c.cellClass || ''} ${c.colClass || ''}`}>
                    {c.render ? c.render(r) : r[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
              </Fragment>
              );
            })}
            {display.length > limit && (
              <tr ref={sentinelRef}>
                <td colSpan={columns.length + (selectable ? 1 : 0) + (serialNumber ? 1 : 0)}
                    className={`${cellPx} py-3 text-center`}>
                  {/* Scrolling pulls the next slice in automatically; the button
                      is the guaranteed path, so every row stays reachable even
                      where the observer cannot run. */}
                  <button
                    type="button"
                    onClick={() => setLimit(l => l + ROW_WINDOW)}
                    className="rounded-full px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-white hover:text-indigo-700"
                  >
                    Showing {visible.length} of {display.length} — show {Math.min(ROW_WINDOW, display.length - limit)} more
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Tabs
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-1 shadow-[inset_0_1px_2px_rgba(29,29,31,0.05)] backdrop-blur-xl scrollbar-none">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all duration-200 ease-apple touch:min-h-[40px]
            ${active === t.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12),inset_0_1px_0_rgba(255,255,255,0.9)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
          {t.label}{t.count != null && (
            /* `tone: 'danger'` lets a tab whose count MEANS something bad read
               that way at a glance — a shortage of 3 is not the same kind of 3
               as three invoices. Absent tone keeps the original neutral chip. */
            <span className={`ml-1.5 rounded-full px-1.5 text-xs ${t.tone === 'danger'
              ? 'bg-red-100 font-bold text-red-700'
              : active === t.key ? 'bg-[#E1EFFF] text-[#0064D2]' : 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]'}`}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// GroupedTabs — primary navigation for a page carrying too many tabs to read as
// one row (Masters: ten). Groups are [{ label, items: [{ key, label }] }]; an
// empty group renders nothing, so role-filtered items (admin-only masters) can
// be dropped without leaving a stray band.
//
// ONE rail, not a stack of bands. The banded form — caption column on the left,
// pills on the right, a rule under each row — draws a table, and a table reads
// as data rather than as chrome. Here every group is a column in a single
// segmented rail: its name sits as a small cap directly above its own cluster,
// and the clusters are parted by a hairline that fades out at both ends rather
// than a hard border. Four stacked rows collapse to one, the ragged right edge
// disappears, and the whole control is a third of its former height.
//
// The rail spans the FULL content column rather than hugging its pills. Sized to
// content it stopped ~450px short of the panel below it, so the page opened on a
// stubby control floating over a full-width table — the one element out of step
// with every other block on the page. Claiming the whole width also gives the
// spare space to the pills themselves, which is why they are comfortable to hit
// on the floor. Each group grows in proportion to how many pills it holds, so a
// pill stays the same size whether its group carries two or three.
//
// The selected tab wears the SIDEBAR's active pill — the blue gradient lozenge
// with its glow — because that is already this app's "you are here" signal, and
// a page holding ten destinations needs a stronger one than white-on-white.
// Idle tabs use the sidebar's Liquid Glass hover: a translucent lozenge rising
// under the cursor. Kept in step with ACTIVE_PILL / IDLE_PILL in AppLayout.jsx
// (inlined rather than imported — AppLayout imports this module).
//
// Group captions stay at #6E6E73 rather than dimming further: at 10px they are
// below the large-text threshold, so anything lighter drops under AA on the
// glass. Their subordination comes from size and position, not from low contrast.
const GT_ACTIVE =
  'bg-gradient-to-b from-[#2E95FF] to-[#0071F0] text-white ' +
  'shadow-[0_8px_20px_rgba(0,122,255,0.38),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(0,83,173,0.35)]';
const GT_IDLE =
  'text-[#515154] hover:bg-white/55 hover:text-[#1D1D1F] hover:backdrop-blur-md hover:ring-1 hover:ring-white/60 ' +
  'hover:shadow-[0_5px_14px_-5px_rgba(29,29,31,0.16),inset_0_1px_0_rgba(255,255,255,1),inset_0_-1px_1px_rgba(66,88,120,0.06)]';
// Only the ends with hidden content fade, so a rail scrolled hard right keeps a
// crisp right edge and vice versa.
const EDGE_FADE = ({ l, r }) =>
  `linear-gradient(to right, transparent 0, #000 ${l ? '28px' : '0px'}, #000 calc(100% - ${r ? '28px' : '0px'}), transparent 100%)`;

export function GroupedTabs({ groups, active, onChange, className = '' }) {
  const shown = groups.filter(g => g.items.length);
  const railRef = useRef(null);
  const activeRef = useRef(null);
  // Which ends have content hidden past them. Drives a soft fade at that edge, so
  // a rail too wide for the column reads as "there is more, scroll" instead of a
  // pill sliced off by a hard border. Desktop fits, so usually neither is set.
  const [edge, setEdge] = useState({ l: false, r: false });

  const syncEdges = () => {
    const el = railRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdge(e => {
      const l = el.scrollLeft > 1, r = max - el.scrollLeft > 1;
      return e.l === l && e.r === r ? e : { l, r };
    });
  };
  useEffect(() => {
    syncEdges();
    window.addEventListener('resize', syncEdges);
    return () => window.removeEventListener('resize', syncEdges);
  });

  // Once the rail overflows (tablet and narrower) the selected master can sit
  // entirely off-screen, so the page would open with no visible "you are here".
  // Nudge it into view — by writing the rail's own scrollLeft, never
  // scrollIntoView, which would also scroll every ancestor and jump the page.
  // No-ops when the pill is already visible, so desktop never moves.
  useEffect(() => {
    const rail = railRef.current, pill = activeRef.current;
    if (!rail || !pill) return;
    const r = rail.getBoundingClientRect(), p = pill.getBoundingClientRect();
    if (p.left >= r.left && p.right <= r.right) return;
    rail.scrollLeft += p.left - r.left - (r.width - p.width) / 2;
  }, [active]);

  return (
    // Same recessed trough as <Tabs/>, just tall enough for a caption line, so
    // primary navigation reads as one family across the app. Narrow screens
    // scroll the rail horizontally exactly as Tabs and SubTabs do.
    <div ref={railRef} onScroll={syncEdges}
      style={edge.l || edge.r ? { maskImage: EDGE_FADE(edge), WebkitMaskImage: EDGE_FADE(edge) } : undefined}
      className={`mb-4 flex w-full items-stretch gap-1 overflow-x-auto rounded-[20px] border border-white/60 bg-[#1D1D1F]/[0.05] p-1.5 shadow-[inset_0_1px_2px_rgba(29,29,31,0.05)] backdrop-blur-xl scrollbar-none ${className}`}>
      {shown.map((g, gi) => (
        <Fragment key={g.label}>
          {gi > 0 && (
            // Hairline that fades at both ends — a hard rule would re-introduce
            // the table edge this layout exists to remove.
            <div aria-hidden className="my-1 w-px shrink-0 self-stretch bg-gradient-to-b from-transparent via-[#1D1D1F]/[0.11] to-transparent" />
          )}
          {/* grow, but never shrink and never min-w-0: the rail claims the whole
              content column so it stops short of the panel beneath it, and the
              spare width is handed out in proportion to how many pills a group
              carries, so a pill is the same size in every group. Shrinking stays
              off because the caption is nowrap — a shrinkable column would spill
              it over the next group's pills instead of letting the rail scroll. */}
          <div style={{ flexGrow: g.items.length }}
            className="flex shrink-0 basis-auto flex-col gap-1.5 px-1">
            <div className="whitespace-nowrap px-1 text-[10px] font-bold uppercase tracking-[0.09em] text-[#6E6E73]">
              {g.label}
            </div>
            <div className="flex flex-1 gap-1">
              {g.items.map(t => (
                <button key={t.key} type="button" onClick={() => onChange(t.key)}
                  ref={active === t.key ? activeRef : undefined}
                  aria-current={active === t.key ? 'true' : undefined}
                  className={`grow whitespace-nowrap rounded-full px-3 py-2 text-[13px] font-semibold transition-all duration-300 ease-spring active:scale-[0.97]
                    ${active === t.key ? GT_ACTIVE : GT_IDLE}`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// SubTabs — the standard secondary pill switcher used INSIDE a page section
// (pendency views, board/ledger toggles…). One component = one geometry:
// same padding, radius and tokens everywhere, so sub-navigation never drifts
// from module to module. Primary navigation stays on <Tabs/>.
export function SubTabs({ views, active, onChange, className = '' }) {
  return (
    <div className={`flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-1 backdrop-blur-xl scrollbar-none ${className}`}>
      {views.map(v => {
        const Icon = v.icon;
        return (
          <button key={v.key} type="button" onClick={() => onChange(v.key)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ease-apple touch:min-h-[40px] touch:text-[13px]
              ${active === v.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
            {Icon && <Icon size={13} />} {v.label}
            {v.count != null && <span className={`rounded-full px-1.5 text-[11px] ${active === v.key ? 'bg-[#E1EFFF] text-[#0064D2]' : 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]'}`}>{v.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Fulfillment rate bar — ported from Pureflix IMS: bold percentage over a thin
// progress track. Emerald once fully fulfilled, blue while moving, slate at 0.
// `done`/`total` render the "x / y" sub-line when provided.
export function FulfillmentBar({ pct, done, total, unit = '', className = '' }) {
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  return (
    <div className={`min-w-[92px] ${className}`}>
      <div className="text-center text-xs font-bold tabular-nums text-slate-800">{p.toFixed(1)}%</div>
      <div className="mx-auto mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${p >= 100 ? 'bg-emerald-500' : p > 0 ? 'bg-blue-500' : 'bg-slate-300'}`}
          style={{ width: `${p}%` }} />
      </div>
      {done != null && total != null && (
        <div className="mt-0.5 text-center text-[10px] tabular-nums text-slate-400">
          {new Intl.NumberFormat('en-IN').format(done)} / {new Intl.NumberFormat('en-IN').format(total)}{unit ? ` ${unit}` : ''}
        </div>
      )}
    </div>
  );
}

// Shade-card age — the 1-year lifecycle (365 days = obsolete). One helper,
// one chip, reused wherever a shade card shows: Product Master row + form,
// Planning Engine, Artwork form, Job Card (screen + print).
export const SHADE_CARD_LIFE_DAYS = 365;
export function shadeAge(dateStr) {
  const t = Date.parse(dateStr);
  if (!dateStr || !Number.isFinite(t)) return null;
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  const months = Math.floor(days / 30.44);
  const label = days < 30 ? `${days} d`
    : months < 12 ? `${months} mo${days % 30 >= 15 ? '+' : ''}`
    : `${Math.floor(months / 12)} yr ${months % 12} mo`;
  return {
    days, label,
    expired: days >= SHADE_CARD_LIFE_DAYS,          // ≥ 1 year — renewal required
    aging: days >= 270 && days < SHADE_CARD_LIFE_DAYS, // last quarter of its life
  };
}
// The output (plate / positive) number a job is CALLED by on the floor. One
// component so the identity looks the same in every queue it appears in —
// station rows, the planning queue, wherever a row has to say which plate set
// it is. A gang's own run number arrives here exactly like a single carton's
// master number does: by the time a row renders, the server has already
// decided which of the two this job answers to.
export function OutputChip({ number, className = '' }) {
  if (!number) return null;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded bg-slate-100 px-1.5 py-px text-[10px] font-bold tabular-nums text-slate-600 ${className}`}
      title={`Output no. ${number}`}>
      <span className="font-semibold uppercase tracking-wide text-slate-400">Out</span>{number}
    </span>
  );
}

// Customer WIP — the customer is chasing this item. One chip everywhere the
// job appears (status sheet, planning, the press board, every station), so
// urgency looks the same at every desk and needs no phone call. Blue on
// purpose: it marks WHOSE urgency this is (the customer's), not a fault —
// amber and red stay reserved for things that are wrong.
export function WipChip({ on, date, className = '' }) {
  if (!on) return null;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#0A84FF] px-1.5 py-px text-[9.5px] font-bold text-white shadow-sm ${className}`}
      title={`Customer WIP — the customer is waiting on this item${date ? ` (marked ${date})` : ''}`}>
      <Zap size={9} fill="currentColor" /> WIP
    </span>
  );
}

export function ShadeAge({ date, className = '' }) {
  const a = shadeAge(date);
  if (!a) return <span className="text-gray-300">—</span>;
  const cls = a.expired ? 'bg-red-50 text-red-700'
    : a.aging ? 'bg-amber-50 text-amber-700'
    : 'bg-emerald-50 text-emerald-700';
  return (
    <span title={`Shade card age: ${a.days} days (1-year life)`}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${cls} ${className}`}>
      {a.days}d · {a.label}{a.expired ? ' · EXPIRED' : a.aging ? ' · renew soon' : ''}
    </span>
  );
}

// Stock aging chip — 0–30 green · 31–60 amber · 61–90 orange · 90+ red.
export function AgeChip({ date, days }) {
  const d = days ?? Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
  const cls = d <= 30 ? 'bg-emerald-50 text-emerald-700'
    : d <= 60 ? 'bg-amber-50 text-amber-700'
    : d <= 90 ? 'bg-orange-50 text-orange-700'
    : 'bg-red-50 text-red-700';
  return <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}>{d}d</span>;
}

// ─── OD — how long a job has been waiting since its customer PO ──────────────
// The ageing the planner actually plans by. Delivery dates are missing on 117
// of the 127 open lines (live book, 2026-08-04), so the PO date is the only
// clock most of this queue has: OD is days elapsed since orders.po_date.
//
// Deliberately NOT the AgeChip 30/60/90 bands. Those were cut for board sitting
// in a warehouse, where a month is nothing. On the live order book the median
// open line is 20 days old and 87% are under 30 — a 30-day amber would have
// painted almost the whole board and told the planner nothing. Measured against
// that same book, the bands below colour ~13% of rows: amber past a month, red
// past two. Everything else stays plain, so the few that light up mean it.
const OD_AMBER = 31;
const OD_RED = 61;

// Calendar-day difference, matching the server's (now()::date - po_date::date).
// po_date is a plain 'YYYY-MM-DD' string, so its UTC parts ARE the intended
// date; comparing instants instead would drift a day either side of midnight.
export function odDays(poDate) {
  if (!poDate) return null;
  const d = new Date(poDate);
  if (!Number.isFinite(d.getTime())) return null;
  const then = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = new Date();
  const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}

// `count` > 1 marks a gang: the row reads its OLDEST member, because a run is
// as overdue as the longest-waiting PO in it.
export function OverdueDays({ days, count = 1 }) {
  if (days == null) return <span className="text-gray-300">—</span>;
  const hot = days >= OD_RED ? 'bg-red-50 text-red-700'
    : days >= OD_AMBER ? 'bg-amber-50 text-amber-700'
    : null;
  return (
    <div title={`${days} day${days === 1 ? '' : 's'} since the customer PO was raised`
      + (count > 1 ? ` — the oldest of ${count} POs in this run` : '')}>
      {hot
        ? <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${hot}`}>{days}d</span>
        : <span className="text-xs font-semibold tabular-nums text-gray-500">{days}d</span>}
      {count > 1 && <div className="text-[10px] font-semibold text-gray-400">oldest of {count}</div>}
    </div>
  );
}

// Toast system
const ToastCtx = createContext(null);
export function useToast() { return useContext(ToastCtx); }
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const push = (type, msg) => {
    const id = ++idRef.current;
    setToasts(t => [...t, { id, type, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3800);
  };
  const toast = {
    success: m => push('success', m),
    error: m => push('error', m),
    info: m => push('info', m),
  };
  const icons = { success: CheckCircle2, error: AlertTriangle, info: Info };
  const colors = { success: 'text-[#19813A]', error: 'text-[#B81F16]', info: 'text-[#0064D2]' };
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="ci-toast-stack fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map(t => {
          const I = icons[t.type];
          return (
            <div key={t.id} className={`glass flex animate-slideUp items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold shadow-lift ${colors[t.type]}`}>
              <I size={16} /> <span className="text-[#1D1D1F]">{t.msg}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
