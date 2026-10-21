// The small pieces the Setup screens share: the chip a status, a role or a flag is drawn as, a form's field error, and a read-only fact.

// One chip language for Setup, drawn like the voucher status chip. A tone is a name, never a colour class, so a screen says what a chip
// MEANS (amber is "look at this", muted is "switched off") and the palette lives here.
const TONES = {
  neutral: 'bg-gray-100 text-gray-600',
  muted: 'bg-gray-100 text-gray-400',
  amber: 'bg-amber-50 text-amber-700',
  good: 'bg-emerald-50 text-emerald-700',
  bad: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
  slate: 'bg-slate-200 text-slate-700',
};

export function Chip({ tone = 'neutral', title, children }) {
  const toneClass = Object.prototype.hasOwnProperty.call(TONES, tone) ? TONES[tone] : TONES.neutral;
  return (
    <span title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset ring-[#1D1D1F]/[0.06] ${toneClass}`}>
      {children}
    </span>
  );
}

// The server's sentence for a field, under that field, when a write was refused on it (the same sentence is in the toast).
export const FieldError = ({ children }) => (children ? <span className="mt-0.5 block text-[11px] text-red-600">{children}</span> : null);

// A read-only fact on a form: what a login may see but not change, set out as text and not as a control (the admin's fields, for an
// accountant). `children` is the value.
export function ReadOnlyFact({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{label}</div>
      <div className="break-words text-sm text-[#1D1D1F]">{children || <span className="text-gray-300">—</span>}</div>
    </div>
  );
}
