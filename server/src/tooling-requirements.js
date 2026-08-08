// Pure Tooling Hub requirement rules. The route uses these decisions for both
// the pre-flight dialog and request creation, so the checkboxes cannot disagree
// with what is actually written.

export const TOOLING_REQUEST_FAMILIES = ['plate', 'die', 'block', 'shade_card'];

export const TOOLING_REQUEST_STATUSES = [
  'pending',
  'rack_reserved',
  'in_house',
  'procurement',
  'vendor_assigned',
  'sent_to_vendor',
  'received_from_vendor',
  'grn_completed',
  'ready',
  'issued_to_floor',
  'returned_to_rack',
  'cancelled',
  'replaced',
  'lost_damaged',
];

export const TOOLING_SOURCES = ['rack', 'in_house', 'vendor', 'procurement'];

const truthy = value => value === true || value === 1 || value === '1' || value === 'true';

export function defaultToolingFamilies({ stages = [], products = [] } = {}) {
  const stageSet = new Set(stages.map(s => typeof s === 'string' ? s : s?.stage).filter(Boolean));
  const families = [];
  if (stageSet.has('printing')) families.push('plate');
  if (stageSet.has('die_cutting')) families.push('die');

  const needsBlock = stageSet.has('embossing') || stageSet.has('foiling') || products.some(product => {
    const special = String(product?.special || '').toLowerCase();
    return ['foil', 'emboss', 'foil_emboss'].includes(special)
      || truthy(product?.emboss) || truthy(product?.leafing);
  });
  if (needsBlock) families.push('block');

  // A shade standard is part of the print release. The dedicated Shade Card
  // workflow still decides whether one can be approved and used.
  if (stageSet.has('printing')) families.push('shade_card');
  return families;
}

export function statusForSource(source) {
  return {
    rack: 'rack_reserved',
    in_house: 'in_house',
    vendor: 'vendor_assigned',
    procurement: 'procurement',
  }[source] || 'pending';
}

export function isToolingRequestOpen(status) {
  return !['ready', 'issued_to_floor', 'returned_to_rack', 'cancelled', 'replaced'].includes(status);
}
