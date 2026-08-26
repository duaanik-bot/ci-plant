// What a Certificate of Analysis says about a product, drawn from the product
// master. One module so the COA, the sheet and the edit dialog cannot disagree
// about what the plant certifies.

// ── The declared GSM ─────────────────────────────────────────────────────────
// The plant buys board at mill tolerances — 280, 296, 310, 330, 340 all sit in
// the master — but a certificate declares the commercial grade the customer
// ordered. A stock GSM therefore rounds UP to the next grade the plant can
// honestly claim: 296 certifies as 300, 380 as 400.
//
// Below the floor nothing is rounded. A 70 GSM printed label is not a 300 GSM
// carton, and rounding it up would be a misdeclaration rather than a courtesy —
// so light stock certifies at its real figure, and so does anything above the
// top rung.
export const COA_GSM_RUNGS = [300, 320, 350, 360, 400];
export const COA_GSM_FLOOR = 280;

export function declaredGsm(gsm) {
  const n = Number(gsm);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < COA_GSM_FLOOR) return n;
  return COA_GSM_RUNGS.find(rung => rung >= n) ?? n;
}

// Rewrite the grammage inside a free-text board name ("Duplex WB · 296 GSM ·
// 31.5x41.5"). Printed verbatim next to a declared 300 the certificate would
// contradict itself. The `\d+(?:\.\d+)?` is anchored to the GSM word, so a
// sheet size — 31.5x41.5 — is never mistaken for a grammage.
export function withDeclaredGsm(text, declared) {
  if (!text || declared == null) return text ?? null;
  return String(text).replace(/(\d+(?:\.\d+)?)(\s*)(GSM|gsm|Gsm)/g, `${declared}$2$3`);
}

// Move every *standard* on the grid to the declared GSM at once. `observed` is
// left exactly as it stands: QC may have written a real caliper reading there,
// and silently "correcting" a measurement to the sales grade would falsify the
// record rather than tidy it.
export function applyGsmToParams(params, declared) {
  if (!Array.isArray(params)) return [];
  if (declared == null) return params.map(p => ({ ...p }));
  return params.map(p => ({ ...p, standard: withDeclaredGsm(p.standard, declared) }));
}

// ── The parameter grid ───────────────────────────────────────────────────────
const SPECIAL_LABEL = {
  foil: 'Hot foil stamping', emboss: 'Embossing',
  foil_emboss: 'Hot foil stamping + embossing', window: 'Window patching',
};
// products.pasting_type is entered in caps by the plant ('LOCK BOTTOM', 'BSO').
// BSO is an initialism and must not be sentence-cased into "Bso".
const PASTING_LABEL = { 'LOCK BOTTOM': 'Lock bottom', BSO: 'BSO (straight side seam)' };

const txt = v => (v == null ? '' : String(v).trim());
const has = v => txt(v) !== '' && txt(v).toLowerCase() !== 'none';

// products.colour_type is filthy in the master — 'pantone', ' Pantone',
// 'PANTONE ', 'CMYK ', all the same thing typed by different hands.
function colourType(raw) {
  const s = txt(raw);
  if (!s) return '';
  return s.split('+').map(part => {
    const w = part.trim();
    return /^cmyk$/i.test(w) ? 'CMYK' : /^pantone$/i.test(w) ? 'Pantone'
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' + ');
}

// The finish line: `special` is a controlled key, but emboss/leafing are
// separate master flags that a product can carry on their own.
function finishLabel(p) {
  const bits = [];
  if (has(p.special)) bits.push(SPECIAL_LABEL[p.special] || txt(p.special));
  if (p.emboss && !/emboss/i.test(bits.join(' '))) bits.push('Embossing');
  if (p.leafing) bits.push(`${has(p.leafing_colour) ? txt(p.leafing_colour) : 'Foil'} leafing`);
  return bits.join(' · ');
}

// The board this carton is certified on. The plant master's own board_name is
// the statement of record; materials.name is only the board the plan happened
// to draw, and the two do drift. Fall back through both, then to the grade.
function substrate(p, board, declared) {
  const name = txt(p.board_name) || txt(board?.name) || txt(p.board_grade);
  if (!name || /^unspecified/i.test(name)) {
    return declared ? `${declared} GSM ± 5%` : 'As per approved specification';
  }
  const withGsm = withDeclaredGsm(name, declared);
  // A grade with no grammage in it still deserves one on the certificate.
  return declared && !/gsm/i.test(withGsm) ? `${withGsm} · ${declared} GSM ± 5%` : withGsm;
}

// The industry-standard grid for a printed-carton COA. Every specification
// comes from the product master (spec_override already folded in by the
// caller); observed defaults to "Complies" and QC edits before issuing.
export function coaSpecRows(product, board) {
  const p = product || {};
  const declared = declaredGsm(p.gsm);
  const rows = [];
  const add = (parameter, standard) => {
    if (has(standard)) rows.push({ parameter, standard: txt(standard), observed: 'Complies', result: 'Pass' });
  };

  add('Product / carton size', p.size);
  rows.push({ parameter: 'Board substrate', standard: substrate(p, board, declared), observed: 'Complies', result: 'Pass' });
  if (declared != null) add('Grammage', `${declared} GSM ± 5%`);
  add('Printing colours', [p.colors ? `${p.colors} colours` : '', colourType(p.colour_type)]
    .filter(Boolean).join(' · ') || 'As per approved artwork');
  add('Shade matching', has(p.shade_card_number)
    ? `As per approved shade card ${txt(p.shade_card_number)}`
    : 'As per approved shade card');
  add('Artwork reference', txt(p.party_artwork_code) || txt(p.internal_carton_code));
  add('Text matter & artwork', 'As per approved artwork — no deviation');
  add('Print quality', 'No misregister, scumming, set-off or hickies');
  add('Coating / finish', p.coating);
  add('Special finish', finishLabel(p));
  add('Dimensions & creasing', 'Within ±1 mm of approved dimensions; crease lines sharp, no cracking');
  add('Pasting / bonding', has(p.pasting_type)
    ? `${PASTING_LABEL[txt(p.pasting_type).toUpperCase()] || txt(p.pasting_type)} — firm bonding, no glue smear or warping`
    : 'Firm side-seam bonding, no glue smear or warping');
  add('Cleanliness', 'Free from dust, foreign matter and odour');
  return rows;
}
