export function resolvePlateRate(rates = [], plateMasterId, vendorId = null, onDate = new Date()) {
  const masterId = Number(plateMasterId);
  const wantedVendor = vendorId == null || vendorId === '' ? null : Number(vendorId);
  const date = typeof onDate === 'string' ? onDate.slice(0, 10) : onDate.toISOString().slice(0, 10);
  const candidates = rates.filter(row => Number(row.plate_master_id) === masterId
    && Number(row.active) === 1
    && (!row.effective_from || String(row.effective_from).slice(0, 10) <= date)
    && (row.vendor_id == null || Number(row.vendor_id) === wantedVendor));
  candidates.sort((a, b) => {
    const aSpecific = a.vendor_id != null && Number(a.vendor_id) === wantedVendor ? 1 : 0;
    const bSpecific = b.vendor_id != null && Number(b.vendor_id) === wantedVendor ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    const byDate = String(b.effective_from || '').localeCompare(String(a.effective_from || ''));
    return byDate || Number(b.id) - Number(a.id);
  });
  return candidates[0] || null;
}
