import { colourSummary, derivedCounts, totalColoursOf } from './print-colour.js';

export const PHYSICAL_TOOLING_FAMILIES = ['plate', 'die', 'block'];

export const TOOLING_FAMILY_CODE = {
  plate: 'PL',
  die: 'DI',
  block: 'BL',
};

const clean = value => String(value ?? '').trim();
const positive = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

// One printing colour needs one physical plate. The product's `colors` total is
// the canonical count and already includes process, Pantone and metallic inks;
// totalColoursOf also preserves the legacy inference used by Job Cards and
// Print Planning.
export function toolingRequirementQty(family, specification = {}) {
  if (family !== 'plate') return 1;
  const counts = derivedCounts(specification);
  const inferred = counts.cmyk + counts.pantone + counts.metallic;
  return Math.max(1, Math.round(positive(totalColoursOf(specification)) || positive(inferred) || 1));
}

export function toolingMasterShape(family, { productId, productName, productCode, specification = {} } = {}) {
  const productKey = positive(productId) || clean(productCode).toLowerCase() || 'shared';
  const size = clean(specification.plate_size)
    || ([specification.child_l, specification.child_w].every(positive)
      ? `${specification.child_l} x ${specification.child_w}`
      : clean(specification.size));

  if (family === 'plate') {
    const output = clean(specification.output_number);
    const colour = colourSummary(specification);
    return {
      masterKey: ['plate', productKey, output || 'standard'].join('|').toLowerCase(),
      name: `${clean(productName) || 'Shared'} printing plates`,
      specification: [colour !== '—' ? colour : null, output && `Output ${output}`].filter(Boolean).join(' · '),
      size: size || null,
      toolType: clean(specification.plate_type) || 'Offset plate',
      unit: 'nos',
    };
  }

  if (family === 'die') {
    const number = clean(specification.die_number);
    return {
      masterKey: ['die', productKey, number || 'standard'].join('|').toLowerCase(),
      name: number ? `Die ${number}` : `${clean(productName) || 'Shared'} die`,
      specification: [number && `Die ${number}`, positive(specification.ups) && `${specification.ups} ups`].filter(Boolean).join(' · '),
      size: size || null,
      toolType: clean(specification.die_type) || 'Cutting die',
      unit: 'nos',
    };
  }

  const number = clean(specification.block_number);
  const special = clean(specification.special);
  return {
    masterKey: ['block', productKey, number || special || 'standard'].join('|').toLowerCase(),
    name: number ? `Block ${number}` : `${clean(productName) || 'Shared'} block`,
    specification: [number, special && special.replaceAll('_', ' '), clean(specification.leafing_colour)].filter(Boolean).join(' · '),
    size: size || null,
    toolType: special || 'Emboss / foil block',
    unit: 'nos',
  };
}

export function toolingPoStatus(lines = []) {
  if (!lines.length) return 'open';
  const ordered = lines.reduce((sum, line) => sum + (positive(line.qty) || 0), 0);
  const received = lines.reduce((sum, line) => sum + Math.max(0, Number(line.received_qty) || 0), 0);
  if (ordered > 0 && received >= ordered) return 'received';
  if (received > 0) return 'partially_received';
  return 'open';
}

export function toolingRequirementReady(requiredQty, allocatedQty) {
  const required = positive(requiredQty) || 1;
  return Math.max(0, Number(allocatedQty) || 0) >= required;
}
