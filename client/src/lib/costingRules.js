// The plant's house rules for a NEW costing (owner, 11 Nov 2026). They come before what past costings of
// the size did — "by default take …" — and after what the Product Master says about this very product.
// A box somebody typed is never touched. Pure: the server suite tests it (server/src/costing-rules.test.js).
//
//   board              ₹120 a kg (FBB) unless the Product Master's grade has today's rate
//   printing           ₹500 per 1,000 sheets per colour (Rates & method default)
//   colours            as the enquiry says
//   coating            from the enquiry's words: aqueous varnish → factor 6, UV → 3,
//                      drip-off with UV → 2, spot UV + drip-off → 2; on Met Saffire board always factor 1
//   embossing          ₹0.15 a carton when the enquiry or the Product Master says embossed
//   leafing            ₹0.20 a carton per panel, plus ₹5,000 leafing set-up for the job
//   die & pasting      side pasting ₹0.20, lock bottom ₹0.30, a big box ₹0.41 (ticked on the costing)
//   process            ₹2,000 for the job; ₹3,000 when the job needs a new die (ticked; on for a product
//                      not in the Product Master yet)
import { num } from './costing.js';

export const HOUSE_RULES = Object.freeze({
  board_rate: 120,
  emb_rate: 0.15,
  leaf_rate: 0.2,
  leaf_process: 5000,
  dp: Object.freeze({ SIDE: 0.2, LOCK: 0.3 }),
  dp_big: 0.41,
  process: 2000,
  process_new_die: 3000,
  coat: Object.freeze({ aqueous: 6, uv: 3, drip_uv: 2, spot_drip: 2, met_saffire: 1 }),
});

const lower = x => String(x ?? '').toLowerCase();

// The coating an enquiry asks for, from its words. Drip-off is always printed with UV, so any drip-off is
// factor 2; UV without drip-off is 3; a varnish (aqueous / aqua / AQ / water-based) is 6. Nothing → null.
export function coatingFromText(text) {
  const t = lower(text);
  if (!t.trim()) return null;
  const drip = /drip/.test(t);
  const uv = /\buv\b|u\.v\./.test(t);
  const spot = /spot/.test(t);
  if (drip) return spot ? { factor: HOUSE_RULES.coat.spot_drip, label: 'Spot UV + drip-off' } : { factor: HOUSE_RULES.coat.drip_uv, label: 'Drip-off with UV' };
  if (uv) return { factor: HOUSE_RULES.coat.uv, label: spot ? 'Spot UV' : 'UV' };
  if (/\baq\b|aqueous|aqua|water.?based|varnish/.test(t)) return { factor: HOUSE_RULES.coat.aqueous, label: 'Aqueous varnish' };
  return null;
}

// What an enquiry's words say about the finish: coating, embossing, leafing (and on how many panels).
// "Embossed" anywhere in the coating, specifications or notes counts; "no embossing" does not.
export function finishFromEnquiry(e) {
  if (!e) return null;
  const words = [e.coating, e.specs, e.notes].filter(Boolean).join(' · ');
  const t = lower(words);
  const coat = coatingFromText([e.coating, e.specs].filter(Boolean).join(' · '));
  const emboss = /emboss/.test(t) && !/(no|without|non)[\s-]*emboss/.test(t);
  const leaf = /\bleaf|\bfoil|hot[\s-]*stamp/.test(t) && !/(no|without)[\s-]*(leaf|foil)/.test(t);
  const pm = t.match(/(\d+)\s*(?:panels?|sides?)\b[^.;]*?(?:leaf|foil)|(?:leaf|foil)[^.;]*?(\d+)\s*(?:panels?|sides?)\b/);
  const panels = leaf ? (pm ? Number(pm[1] || pm[2]) : 1) : 0;
  return { coat, emboss, leaf, leaf_panels: panels, leaf_panels_given: !!pm, board: e.board || null, from: e.enquiry_no || null };
}

// Die & pasting for a pasting style: a big box first, then the style's rate. A style without a rule → null.
export const dpFor = (style, bigBox = false) => (bigBox ? HOUSE_RULES.dp_big : HOUSE_RULES.dp[style] ?? null);
export const processFor = newDie => (newDie ? HOUSE_RULES.process_new_die : HOUSE_RULES.process);

// The ₹120 house rate is for FBB-type board (FBB, SBS, Saffire, ITC Cyber XL …). A board named as something
// else — duplex, kraft, paper — is not given it.
const NOT_FBB = /duplex|kraft|paper|maplitho|chromo|grey\s*back|\bgb\b|\bwb\b/i;
export const takesFbbRate = (...boards) => !boards.some(b => NOT_FBB.test(String(b ?? '')));

// What a costing CHARGES for a board grade (owner, 11 Nov 2026: "100 is our buying price, but we will charge
// customers 120 … this should not affect my warehouse"). FBB-type grades are charged at the house rate, or the
// buying rate if that is ever higher; other grades at their buying rate. Masters → Board Rates (the warehouse's
// buying rate) is never changed — `buy_rate` keeps it beside the charge.
const FBB_GRADE = /fbb|sbs|saff?ire|sapphire|cyber|ivory/i;
export const chargeRateOf = g => (g && FBB_GRADE.test(g.grade) && takesFbbRate(g.grade)
  ? Math.max(HOUSE_RULES.board_rate, Number(g.rate_per_kg) || 0) : Number(g?.rate_per_kg) || null);
export const chargeGrades = (grades = []) => grades.map(g => ({ ...g, buy_rate: g.buy_rate ?? g.rate_per_kg, rate_per_kg: chargeRateOf(g) }));
export const gradeLabel = g => `${g.grade} — ₹${g.rate_per_kg}/kg${g.buy_rate != null && g.buy_rate !== g.rate_per_kg ? ` charged (buy ₹${g.buy_rate})` : ''}`;

// Met Saffire board (owner, 11 Nov 2026): charged ₹120 like FBB, coated at factor 1 whatever the finish words say.
export const isMetSaffire = (...boards) => boards.some(b => /\bmet(alli[sz]ed|allic)?\b[\s.-]*(saff?ire|sapphire)|met[\s.-]*saff?ire|met[\s.-]*sapphire/i.test(String(b ?? '')));

// A new product (not in the Product Master) needs a new die unless somebody said otherwise.
export const newDieDefault = v => (v?.new_die != null ? !!v.new_die : !(v?.product_id || v?.product));

// The rules as [field, value, note] for one costing. `finish` = finishFromEnquiry (or null when the costing
// has no enquiry); `productEmboss` = the Product Master's emboss flag, when a product is picked.
export function houseRuleValues(v, { finish = null, productEmboss = null, productGrade = null, hasProduct = false } = {}) {
  const out = [];
  const style = v?.style || null;
  const dp = dpFor(style, !!v?.big_box);
  if (dp != null) out.push(['dp_rate', dp, v?.big_box ? 'big box ₹0.41' : `${style === 'LOCK' ? 'lock bottom' : 'side pasting'} house rate`]);
  const newDie = v?.new_die != null ? !!v.new_die : !(v?.product_id || v?.product || hasProduct);
  out.push(['process', processFor(newDie), newDie ? 'new die — ₹3,000' : 'existing die — ₹2,000']);
  if (takesFbbRate(productGrade, finish?.board)) out.push(['board_rate', HOUSE_RULES.board_rate, 'house rate ₹120/kg (FBB)']);
  const embossed = finish?.emboss || productEmboss === 1;
  if (embossed) out.push(['emb_rate', HOUSE_RULES.emb_rate, finish?.emboss ? `embossed (${finish.from || 'enquiry'})` : 'embossed on the Product Master']);
  else if (finish) out.push(['emb_rate', 0, 'no embossing asked']);
  if (isMetSaffire(v?.board_grade, productGrade, finish?.board)) {
    out.push(['coat_factor', HOUSE_RULES.coat.met_saffire, 'Met Saffire board → factor 1']);
    out.push(['coat_choice', String(HOUSE_RULES.coat.met_saffire), 'Met Saffire board']);
  } else if (finish?.coat) {
    out.push(['coat_factor', finish.coat.factor, `${finish.coat.label} → factor ${finish.coat.factor}`]);
    out.push(['coat_choice', String(finish.coat.factor), finish.coat.label]);
  }
  if (finish?.leaf) {
    out.push(['leaf_panels', finish.leaf_panels, finish.leaf_panels_given ? 'panels from the enquiry' : '1 panel assumed — check the artwork']);
    out.push(['leaf_rate', HOUSE_RULES.leaf_rate, '₹0.20 a panel']);
    out.push(['leaf_process', HOUSE_RULES.leaf_process, 'leafing set-up ₹5,000']);
  }
  return out;
}

// The inputs a bulk-costing row from an enquiry takes from the rules (no Product Master / history there).
export function ruleInputsForRow(row, finish, productEmboss = null, productGrade = null) {
  const inputs = {};
  let coatChoice = null;
  for (const [k, x] of houseRuleValues(row, { finish, productEmboss, productGrade })) {
    if (k === 'coat_choice') coatChoice = x;
    else inputs[k] = x;
  }
  return { inputs, coat_choice: coatChoice };
}

