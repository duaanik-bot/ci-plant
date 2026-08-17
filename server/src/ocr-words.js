// Tidying OCR output into the kind of positioned tokens a text layer would
// have given.
//
// An OCR engine reading a ruled table does three things a PDF text layer never
// does, and each one silently corrupts a purchase order:
//
//   1. It reads the table's own RULES as characters. A vertical rule comes back
//      as "|", and it gets glued onto whichever cell it touches — "1|PMC-A220",
//      "52800.000(", "09/05/2026]".
//   2. Worse, a rule between two cells can weld them into ONE token:
//      "20000.000|{NOS" spans the Qty and UOM columns at once. Placed by its
//      centre it lands in UOM, and the quantity of the line disappears — on the
//      real PO that turned 20,000 cartons into 2,640.
//   3. It double-reads the same glyphs, emitting a ghost token sitting inside a
//      real one ("ipti" inside "Description", "y" inside "ty.").
//
// All three are repairable from the SYMBOL boxes the engine already returns:
// a rule glyph is either a lone bracket or an unbalanced one, and a ghost is a
// box contained in a box.
//
// This runs on the SERVER, not in the browser that did the OCR. The repair
// decides which column a quantity belongs to, so it is not something to take on
// trust from a client; and here it is covered by the suite that CI actually
// runs. The client's job is only to render, recognise, and post what the engine
// said — symbols included.

// Characters that are never part of a word on these documents — they are the
// table's rules being read as text. Parentheses are NOT here: "(SALES)-R5" and
// "(10X15)-R0" are real. A parenthesis is only a rule when it is unbalanced.
const RULE_CHARS = new Set(['|', '[', ']', '{', '}', '¦', '︱', 'ǀ']);
const BRACKETS = new Set(['(', ')']);

const textOf = w => String(w?.text ?? '').trim();
const isPunctOnly = s => !/[A-Za-z0-9]/.test(s);

// A vertical rule read as a character is tall and narrow — far more so than any
// glyph. Measured on real pages: rules come back ~11px wide by ~64px tall.
const isVerticalRule = w => {
  const width = w.x1 - w.x0, height = w.y1 - w.y0;
  return width > 0 && height > width * 2.5 && isPunctOnly(textOf(w));
};

function unbalancedBrackets(chars) {
  // Returns the set of indices holding a bracket with no partner.
  const open = [];
  const bad = new Set();
  chars.forEach((c, i) => {
    if (c === '(') open.push(i);
    else if (c === ')') { if (open.length) open.pop(); else bad.add(i); }
  });
  for (const i of open) bad.add(i);
  return bad;
}

// One OCR word -> one or more tokens, split wherever a rule glyph interrupts it.
function splitOnRules(word) {
  const text = textOf(word);
  const symbols = Array.isArray(word.symbols) ? word.symbols.filter(s => String(s?.t ?? '').length) : [];
  const hasRule = [...text].some(c => RULE_CHARS.has(c) || BRACKETS.has(c));
  if (!hasRule) return [{ text, x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, conf: word.conf }];

  // Without symbol boxes the only safe repair is to shave rule characters off
  // the ENDS, where the geometry is unchanged for the part we keep. Splitting
  // an interior weld would need to invent an x, and a guessed boundary is
  // exactly what puts a quantity in the wrong column.
  if (!symbols.length) {
    const trimmed = text.replace(/^[|[\]{}¦]+/, '').replace(/[|[\]{}¦]+$/, '');
    return isPunctOnly(trimmed) ? [] : [{ text: trimmed, x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, conf: word.conf }];
  }

  const chars = symbols.map(s => String(s.t));
  const loose = unbalancedBrackets(chars);
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const t = run.map(s => String(s.t)).join('').trim();
    if (t && !isPunctOnly(t)) {
      out.push({
        text: t,
        x0: Math.min(...run.map(s => s.x0)), x1: Math.max(...run.map(s => s.x1)),
        y0: Math.min(...run.map(s => s.y0)), y1: Math.max(...run.map(s => s.y1)),
        conf: word.conf,
      });
    }
    run = [];
  };
  symbols.forEach((s, i) => {
    const c = chars[i];
    if (RULE_CHARS.has(c) || (BRACKETS.has(c) && loose.has(i))) flush();
    else run.push(s);
  });
  flush();
  return out;
}

const area = t => Math.max(0, t.x1 - t.x0) * Math.max(0, t.y1 - t.y0);
function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

// The same glyphs recognised twice leave a smaller box sitting inside a larger
// one. Keep the larger; it is the one that carries the whole cell.
//
// Two tests, because area alone is not enough. A ghost's box is drawn around
// the glyphs it re-read, so it can sit a few pixels proud of its parent and
// score only ~0.74 containment — the ghost "y" inside "ty." did exactly that,
// survived, and turned the heading "Qty." into "Q ty. y", which matches no
// heading pattern and cost the whole column model. When the smaller token's
// text is also a substring of the larger's, that is a re-read and not a
// coincidence, so a weaker overlap is enough to condemn it.
// Overlap ALONE is not enough to condemn a token — dropping a real word loses a
// figure, which is the failure this whole file exists to prevent. A ghost is a
// re-read of glyphs that are already accounted for, so its text is part of its
// parent's; both ghosts seen on the real pages are ("ipti" inside
// "Description", "y" inside "ty."). Requiring that leaves a word that merely
// happens to sit inside another's box alone.
//
// 0.6, not 0.8: a ghost's box is drawn round the glyphs it re-read and can sit
// a few pixels proud of its parent. The "y" scored 0.74, survived an 0.8 test,
// and turned the heading "Qty." into "Q ty. y" — matching no heading pattern,
// which cost the entire column model and sent the PO to the guessing reader.
const isRedundant = (small, big) => {
  const a = small.text.toLowerCase(), b = big.text.toLowerCase();
  if (a.length >= b.length || !b.includes(a)) return false;
  return overlapArea(small, big) >= area(small) * 0.6;
};

function dropGhosts(tokens) {
  const kept = [];
  const sorted = [...tokens].sort((a, z) => area(z) - area(a));
  for (const t of sorted) {
    if (!kept.some(k => isRedundant(t, k))) kept.push(t);
  }
  return kept;
}

export function cleanOcrWords(words) {
  const usable = (words || []).filter(w => textOf(w) && !isVerticalRule(w));
  const split = usable.flatMap(splitOnRules).filter(t => t.text && !isPunctOnly(t.text));
  return dropGhosts(split).sort((a, z) => a.y0 - z.y0 || a.x0 - z.x0);
}

export function cleanOcrPages(pages) {
  return (pages || []).map(p => ({ ...p, words: cleanOcrWords(p.words) }));
}
