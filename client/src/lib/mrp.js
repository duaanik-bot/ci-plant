// A carton's MRP as the designer reads it: to the paisa when it has paise, and
// nothing at all when the master has none, so a blank can never read as ₹0.
export function mrpText(v) {
  const n = v == null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
