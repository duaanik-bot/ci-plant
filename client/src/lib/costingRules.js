// The plant's house rules for a NEW costing (owner, 11 Nov 2026). They come before what past costings of
// the size did — "by default take …" — and after what the Product Master says about this very product.
// A box somebody typed is never touched. Pure: the server suite tests it (server/src/costing-rules.test.js).
//
//   board              ₹120 a kg (FBB) unless the Product Master's grade has today's rate. The CFBB family (Saffire,
//                      Sapphire, ITC Cyber, FBB) takes the customer's own rate when Rates › customer rates has one
//                      (20 Nov 2026), never below the buying rate; Met Saffire is its own ₹120
//   printing           ₹500 per 1,000 sheets per colour (Rates & method default)
//   colours            as the enquiry says
//   coating            from the enquiry's words: aqueous varnish → factor 6, UV → 3,
//                      drip-off with UV → 2, spot UV + drip-off → 2, spot UV + AQ → 2 (20 Nov 2026);
//                      on Met Saffire board always factor 1.5 (20 Nov 2026)
//   embossing          ₹0.15 a carton when the enquiry or the Product Master says embossed
//   leafing            ₹0.20 a carton per panel, plus ₹5,000 leafing set-up for the job
//   die & pasting      side pasting ₹0.20, lock bottom ₹0.40 (20 Nov 2026), a big box ₹0.41 (ticked on the costing)
//   process            ₹2,000 for the job; ₹3,000 when the job needs a new die (ticked; on for a product
//                      not in the Product Master yet, unless the Die Master has a usable die of exactly the size)
import { num, runWastage } from './costing.js';

export const HOUSE_RULES = Object.freeze({
  board_rate: 120,
  emb_rate: 0.15,
  leaf_rate: 0.2,
  leaf_process: 5000,
  dp: Object.freeze({ SIDE: 0.2, LOCK: 0.4 }),
  dp_big: 0.41,
  process: 2000,
  process_new_die: 3000,
  coat: Object.freeze({ aqueous: 6, uv: 3, drip_uv: 2, spot_drip: 2, spot_aq: 2, met_saffire: 1.5 }),
  // Owner, 20 Nov 2026: what an enquiry costing takes when the mail does not say — the most used.
  assumed: Object.freeze({ coat_factor: 3, gsm: 300 }),
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
  const aq = /\baq\b|aqueous|aqua|water.?based|varnish/.test(t);
  if (drip) return spot ? { factor: HOUSE_RULES.coat.spot_drip, label: 'Spot UV + drip-off' } : { factor: HOUSE_RULES.coat.drip_uv, label: 'Drip-off with UV' };
  // Owner, 20 Nov 2026: spot UV together with AQ is factor 2 — before plain UV, which would read it as 3.
  if (spot && uv && aq) return { factor: HOUSE_RULES.coat.spot_aq, label: 'Spot UV + AQ' };
  if (uv) return { factor: HOUSE_RULES.coat.uv, label: spot ? 'Spot UV' : 'UV' };
  if (aq) return { factor: HOUSE_RULES.coat.aqueous, label: 'Aqueous varnish' };
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

// The CFBB family (owner, 20 Nov 2026): Saffire / Sapphire, ITC Cyber, Cyber, FBB, CFBB. Met Saffire and the
// non-FBB boards (duplex, kraft …) are not in it. Only this family takes a customer's own board rate.
const CFBB_WORDS = /saff?ire|sapphire|cyber|fbb/i;
export const isCfbbBoard = (...boards) => boards.some(b => CFBB_WORDS.test(String(b ?? '')))
  && !isMetSaffire(...boards) && takesFbbRate(...boards);

// A customer's board rate (Rates › customer rates, data in costing_settings.customer_rates): the first row whose
// word is in the customer's name. Blank name or no rows → null.
export function customerBoardRate(customerName, customerRates) {
  const name = lower(customerName).trim();
  if (!name || !Array.isArray(customerRates)) return null;
  for (const r of customerRates) {
    const word = String(r?.word ?? '').trim();
    const rate = Number(r?.board_rate);
    if (word && name.includes(word.toLowerCase()) && rate > 0) return { word, rate };
  }
  return null;
}

// The rows worth keeping from a settings save: a word of 2–40 characters, a rate above 0 and at most 1,000,
// at most 50 rows, a repeated word (case ignored) only once.
// Why a row of a settings save would be dropped (null = kept), one entry per row, by the same rules as cleanCustomerRates.
export function customerRateProblems(list) {
  const seen = new Set();
  let kept = 0;
  return (Array.isArray(list) ? list : []).map(r => {
    const word = String(r?.word ?? '').trim();
    const rate = Number(r?.board_rate);
    const key = word.toLowerCase();
    let why = null;
    if (word.length < 2 || word.length > 40) why = 'The word needs 2 to 40 characters.';
    else if (!(rate > 0)) why = 'The rate must be above 0.';
    else if (rate > 1000) why = 'The rate can be at most ₹1,000 a kg.';
    else if (seen.has(key)) why = 'This word is already above — only the first is kept.';
    else if (kept >= 50) why = 'Only the first 50 rows are kept.';
    if (!why) { seen.add(key); kept++; }
    return why;
  });
}

export function cleanCustomerRates(list) {
  const why = customerRateProblems(list);
  const out = [];
  (Array.isArray(list) ? list : []).forEach((r, i) => {
    if (!why[i]) out.push({ word: String(r.word).trim(), board_rate: Number(r.board_rate) });
  });
  return out;
}

// The CFBB family is charged the customer's rate (`ratePerKg`, else ₹120) or the buying rate if that is higher;
// other FBB-type grades, Met Saffire included, ₹120 or the buying rate; anything else its buying rate.
export function chargeRateOf(g, ratePerKg = null) {
  const buy = Number(g?.rate_per_kg) || 0;
  if (g && isCfbbBoard(g.grade)) return Math.max(ratePerKg ?? HOUSE_RULES.board_rate, buy);
  if (g && FBB_GRADE.test(g.grade) && takesFbbRate(g.grade)) return Math.max(HOUSE_RULES.board_rate, buy);
  return buy || null;
}
export const chargeGrades = (grades = [], ratePerKg = null) => grades.map(g => ({ ...g, buy_rate: g.buy_rate ?? g.rate_per_kg, rate_per_kg: chargeRateOf(g, ratePerKg) }));
export const gradeLabel = g => `${g.grade} — ₹${g.rate_per_kg}/kg${g.buy_rate != null && g.buy_rate !== g.rate_per_kg ? ` charged (buy ₹${g.buy_rate})` : ''}`;

// Met Saffire board (owner, 11 Nov 2026): its own ₹120 (not the customer's rate), coated at factor 1.5 (20 Nov 2026) whatever the finish words say.
export const isMetSaffire = (...boards) => boards.some(b => /\bmet(alli[sz]ed|allic)?\b[\s.-]*(saff?ire|sapphire)|met[\s.-]*saff?ire|met[\s.-]*sapphire/i.test(String(b ?? '')));

// A new product (not in the Product Master) needs a new die unless somebody said otherwise — or the Die Master has a die
// of exactly this size (owner, 17 Nov 2026, "Die Master only": a die only on the die list does not count, nobody has
// confirmed it is still in the rack). `masterDie` = that Die Master die's code.
// A Die Master die counts only when the Tooling Hub would release it: not Poor (lost or damaged) and not Scrapped.
export const isUsableDie = d => !['poor', 'scrapped'].includes(String(d?.condition ?? '').trim().toLowerCase());
export const masterDieOf = check => (check?.dies?.exact || []).find(isUsableDie)?.code ?? null;
export const newDieDefault = (v, { masterDie = null } = {}) => (v?.new_die != null ? !!v.new_die : !(v?.product_id || v?.product || masterDie));

// The rules as [field, value, note] for one costing. `finish` = finishFromEnquiry (or null when the costing
// has no enquiry); `productEmboss` = the Product Master's emboss flag, when a product is picked.
export function houseRuleValues(v, { finish = null, productEmboss = null, productGrade = null, hasProduct = false, masterDie = null, grades = [], customerRate = null, byRun = false } = {}) {
  const out = [];
  const style = v?.style || null;
  const dp = dpFor(style, !!v?.big_box);
  if (dp != null) out.push(['dp_rate', dp, v?.big_box ? 'big box ₹0.41' : `${style === 'LOCK' ? 'lock bottom' : 'side pasting'} house rate`]);
  const known = !!(v?.product_id || v?.product || hasProduct);
  const newDie = v?.new_die != null ? !!v.new_die : !(known || masterDie);
  const byMaster = v?.new_die == null && !known && !!masterDie;
  out.push(['process', processFor(newDie), newDie ? 'new die — ₹3,000' : byMaster ? `existing die (Die Master ${masterDie}) — ₹2,000` : 'existing die — ₹2,000']);
  // Saffire / ITC Cyber / FBB are costed as CFBB when the Product Master has no grade of its own (20 Nov 2026).
  if (!productGrade && isCfbbBoard(finish?.board)) out.push(['board_grade', 'CFBB', 'Saffire / ITC Cyber / FBB → CFBB']);
  const gradeOf = test => grades.find(g => test(String(g?.grade ?? '').trim()));
  if (isMetSaffire(v?.board_grade, productGrade, finish?.board)) {
    const g = gradeOf(isMetSaffire);
    out.push(['board_rate', g ? g.rate_per_kg : HOUSE_RULES.board_rate, 'Met Saffire — its own rate']);
  } else if (isCfbbBoard(productGrade, finish?.board, v?.board_grade)) {
    const g = gradeOf(x => /^cfbb$/i.test(x));
    const rate = g ? g.rate_per_kg : customerRate?.rate ?? HOUSE_RULES.board_rate;
    const note = customerRate && rate === customerRate.rate ? `₹${rate}/kg — the "${customerRate.word}" customer rate`
      : !customerRate && rate === HOUSE_RULES.board_rate ? 'house rate ₹120/kg'
        : `₹${rate}/kg — the buying rate, which is above the rate`;
    out.push(['board_rate', rate, note]);
  } else if (takesFbbRate(productGrade, finish?.board)) out.push(['board_rate', HOUSE_RULES.board_rate, 'house rate ₹120/kg (FBB)']);
  const embossed = finish?.emboss || productEmboss === 1;
  if (embossed) out.push(['emb_rate', HOUSE_RULES.emb_rate, finish?.emboss ? `embossed (${finish.from || 'enquiry'})` : 'embossed on the Product Master']);
  else if (finish) out.push(['emb_rate', 0, 'no embossing asked']);
  if (isMetSaffire(v?.board_grade, productGrade, finish?.board)) {
    out.push(['coat_factor', HOUSE_RULES.coat.met_saffire, 'Met Saffire board → factor 1.5']);
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
  // Wastage follows the run (owner, 20 Nov 2026): sheets = cartons ÷ ups, rounded up.
  const qty = num(v?.inputs?.qty);
  const ups = num(v?.inputs?.ups);
  if (byRun && qty > 0 && ups > 0) {
    const sheets = Math.ceil(qty / ups);
    const w = runWastage(sheets);
    if (w != null) {
      out.push(['wastage', w, `planning: ${sheets.toLocaleString('en-IN')} sheets → ${w}`]);
      out.push(['wastage_by_run', 1, 'follows the run']);
    }
  }
  return out;
}

// A wastage that follows the run is worked again when the quantity or the ups change; one somebody typed is left.
export function withRunWastage(inputs) {
  if (Number(inputs?.wastage_by_run) !== 1) return inputs;
  const qty = num(inputs.qty);
  const ups = num(inputs.ups);
  if (!(qty > 0 && ups > 0)) return inputs;
  const w = runWastage(Math.ceil(qty / ups));
  return w == null ? inputs : { ...inputs, wastage: w };
}

// What an ENQUIRY costing takes when the mail does not say (owner, 20 Nov 2026): the most used coating (UV), GSM
// (300) and the Rates default colours. Each is shown as Assumed. A costing with no enquiry is left as typed.
export function assumedValues(v, { defaults = {} } = {}) {
  if (!(v?.enquiry_id || v?.finish)) return [];
  const blank = x => x == null || String(x).trim() === '';
  const out = [];
  if (blank(v.coat_choice) && blank(v.inputs?.coat_factor)) {
    const note = 'coating not given — UV, the most used';
    out.push(['coat_factor', HOUSE_RULES.assumed.coat_factor, note], ['coat_choice', String(HOUSE_RULES.assumed.coat_factor), note]);
  }
  if (blank(v.inputs?.gsm)) out.push(['gsm', HOUSE_RULES.assumed.gsm, 'GSM not given — 300, the most used']);
  if (blank(v.inputs?.colours) && !blank(defaults?.colours)) out.push(['colours', defaults.colours, 'colours not given — the Rates default']);
  return out;
}

// The inputs a bulk-costing row from an enquiry takes from the rules (no Product Master / history there).
export function ruleInputsForRow(row, finish, productEmboss = null, productGrade = null, { grades = [], customerRate = null } = {}) {
  const inputs = {};
  let coatChoice = null;
  let boardGrade = null;
  for (const [k, x] of houseRuleValues(row, { finish, productEmboss, productGrade, grades, customerRate })) {
    if (k === 'coat_choice') coatChoice = x;
    else if (k === 'board_grade') boardGrade = x; // a row field, not a costing input
    else inputs[k] = x;
  }
  return { inputs, coat_choice: coatChoice, board_grade: boardGrade };
}

