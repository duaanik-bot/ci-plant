// ─── Design system primitives (macOS Tahoe / Liquid Glass theme) ────────────
import { Children, Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, AlertTriangle, CheckCircle2, Info, Inbox, Check, ChevronDown, ArrowUpDown, ArrowUp, ArrowDown, MoreHorizontal, Download, FileText, FileSpreadsheet, Loader2 } from 'lucide-react';
import { exportPDF, exportXLSX, specRowCount } from '../lib/exporter';
import { squash, matchesTerm } from '../lib/searchKey.js';

// Button
export function Button({ variant = 'primary', size = 'md', className = '', ...props }) {
  const variants = {
    primary: 'btn-brand',
    secondary: 'border border-white/75 bg-white/65 text-[#1D1D1F] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(29,29,31,0.05),0_8px_20px_rgba(29,29,31,0.06)] hover:-translate-y-px hover:bg-white/90 hover:text-[#007AFF] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_2px_4px_rgba(29,29,31,0.06),0_10px_24px_rgba(29,29,31,0.09)] disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
    ghost: 'text-[#515154] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F] disabled:opacity-50',
    danger: 'border border-[#B81F16]/30 bg-gradient-to-b from-[#FF6961] to-[#FF3B30] text-white shadow-[0_8px_20px_rgba(255,59,48,0.30),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(145,25,18,0.25)] hover:-translate-y-px hover:brightness-105 disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
    success: 'border border-[#19813A]/30 bg-gradient-to-b from-[#57CB75] to-[#34C759] text-white shadow-[0_8px_20px_rgba(52,199,89,0.30),inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(20,101,48,0.25)] hover:-translate-y-px hover:brightness-105 disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0',
  };
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
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
      const below = window.innerHeight - r.bottom - 10;
      const above = r.top - 10;
      const maxHeight = Math.max(160, Math.min(280, Math.max(below, above)));
      // Widen past the trigger, then pull `left` back so the wider menu cannot
      // run off the right edge of a narrow viewport.
      const width = Math.min(Math.max(r.width, MENU_MIN), window.innerWidth - MENU_MARGIN * 2);
      const left = Math.max(MENU_MARGIN, Math.min(r.left, window.innerWidth - width - MENU_MARGIN));
      setRect({ left, width, top: below < 210 && above > below ? r.top - maxHeight - 6 : r.bottom + 6, maxHeight });
    };
    update();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
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

  return (
    <div className="relative" ref={ref}>
      <input type="hidden" name={name} value={value ?? ''} readOnly required={required} />
      <input
        className={`${inputCls} h-10 pr-16 ${className}`}
        value={query}
        disabled={disabled}
        placeholder={displayPlaceholder}
        autoComplete="off"
        onFocus={() => { setOpen(true); setActive(0); }}
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

// Modal
export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    const h = e => e.key === 'Escape' && onClose?.();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  // Portal to <body>: a modal opened from inside a panel with backdrop-filter/transform
  // (e.g. .ci-data-panel) would otherwise have its `fixed` positioning trapped by that
  // ancestor's containing block, clipping the footer on short/mobile viewports.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="absolute inset-0 bg-[#1D1D1F]/[0.34] backdrop-blur-[8px] backdrop-saturate-150" onClick={onClose} />
      <div className={`relative flex max-h-[92vh] w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} animate-liquidPop flex-col overflow-hidden rounded-[28px] border border-white/75 bg-white/80 shadow-modal backdrop-blur-2xl`}>
        <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.06] bg-white/40 px-5 py-4">
          <h3 className="min-w-0 break-words text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">{title}</h3>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors duration-150 hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-[#1D1D1F]/[0.06] bg-white/40 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title = 'Are you sure?', message, confirmLabel = 'Confirm', danger }) {
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
export function ActionMenu({ items = [], label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

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
      <button
        ref={btnRef}
        type="button"
        title={label}
        aria-label={label}
        onClick={toggle}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition duration-200 ease-apple ${
          open ? 'bg-[#1D1D1F]/[0.07] text-[#1D1D1F]' : 'text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]'
        }`}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[190px] rounded-2xl border border-white/75 bg-white/95 p-1.5 shadow-lift backdrop-blur-xl"
          style={{ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }}
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
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-semibold transition duration-150 ${
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
  violet: { chip: 'bg-violet-50 text-violet-600', accent: 'text-violet-600' },
};

// KPI card — icon sits in a tinted chip; value carries the accent.
// `compact` is the module-header variant: same card, roughly half the height,
// because a list page pays for that height twice (strip + table) and the tables
// already scroll. `sub` is not decoration — it is where the number gets its
// unit and its breakdown, so a compact card still explains itself.
export function KpiCard({ label, value, sub, accent, icon: Icon, chip, tone, compact = false, title }) {
  const t = KPI_TONES[tone];
  const chipCls = chip || t?.chip || 'bg-brand-50 text-brand-600';
  const accentCls = accent || t?.accent || 'text-slate-900';
  return (
    <div title={title}
      className={`glass transition-[box-shadow,transform] duration-300 ease-apple hover:-translate-y-0.5 hover:shadow-lift ${compact ? 'rounded-2xl px-3 py-2.5' : 'rounded-[22px] p-4'}`}>
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
    </div>
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
};
export function KpiRow({ cols = 6, className = '', children }) {
  return <div className={`mb-3 grid gap-2.5 ${KPI_COLS[cols] || KPI_COLS[6]} ${className}`}>{children}</div>;
}

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

// Search input
export function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-60 rounded-full border border-[#1D1D1F]/[0.10] bg-white/75 py-2 pl-8 pr-3 text-sm font-medium text-[#1D1D1F] shadow-[inset_0_1.5px_3px_rgba(29,29,31,0.07),inset_0_-1px_0_rgba(255,255,255,0.7)] backdrop-blur-md outline-none transition duration-200 ease-apple hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3px] focus:ring-[#0A84FF]/25 focus:shadow-[0_0_18px_rgba(10,132,255,0.25),0_2px_10px_rgba(10,132,255,0.14),inset_0_1px_2px_rgba(29,29,31,0.04)]"
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

// DataTable — search + sort + selectable rows + branded PDF/Excel export.
export function DataTable({
  columns,
  rows,
  onRowClick,
  empty = 'Nothing here yet',
  searchable,
  selectable = false,
  selectedIds = [],
  onToggleRow,
  onToggleAll,
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
  // Row grouping — rows whose groupBy(row) returns the same truthy key are
  // pulled together into one visual block with a full-width header row
  // (renderGroupHeader(rowsOfGroup)) and a shared violet rail, regardless of
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
    const col = columns.find(c => c.key === sort.key);
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
    columns,
    rows: sorted,
    meta: [
      ...(typeof exportMeta === 'function' ? exportMeta() : exportMeta || []),
      q ? `Search: "${q}"` : null,
      `${sorted.length} of ${rows.length} records`,
    ].filter(Boolean),
    summary: typeof exportSummary === 'function' ? exportSummary(sorted) : exportSummary,
  });
  const showToolbar = searchable || exportName;
  return (
    <div className="ci-data-panel">
      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D1D1F]/[0.05] bg-white/30 p-3">
          {searchable ? <SearchInput value={q} onChange={setQ} /> : <span />}
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
                return (
                <th key={c.key} className={`${cellPx} py-2.5 ${right ? 'text-right' : 'text-left'}`}>
                  {c.sortable === false || !c.key || !c.label ? (
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
                  <tr className="border-l-[3px] border-violet-400 bg-violet-50/80">
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
                className={`ci-table-row ${gKey ? `border-l-[3px] border-violet-400 bg-violet-50/40 ${lastOfGroup ? 'border-b border-b-violet-100' : ''}` : checked ? 'bg-indigo-50/55' : i % 2 ? 'bg-[#5B6B8C]/[0.055]' : ''} ${gKey && checked ? '!bg-violet-100/60' : ''} ${onRowClick ? 'cursor-pointer' : ''} ${rowClass?.(r) || ''}`}>
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
                  <td key={c.key} className={`${cellPx} py-3 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.cellClass || ''}`}>
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
          className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all duration-200 ease-apple
            ${active === t.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12),inset_0_1px_0_rgba(255,255,255,0.9)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
          {t.label}{t.count != null && <span className={`ml-1.5 rounded-full px-1.5 text-xs ${active === t.key ? 'bg-[#E1EFFF] text-[#0064D2]' : 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]'}`}>{t.count}</span>}
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
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ease-apple
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
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
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
