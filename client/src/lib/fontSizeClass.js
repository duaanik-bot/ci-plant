// Does a Tailwind class list set a font size at the BASE breakpoint?
//
// The problem this exists for: a component that supplies a default size and
// also accepts a caller's class string puts both in the same class attribute —
// and a class attribute has no say in which rule wins. Precedence is decided by
// the order the rules were EMITTED into the stylesheet, and Tailwind v3 emits
// `text-xs` *after* arbitrary sizes. Same specificity, later rule wins, so a
// caller asking for 13px silently renders at 12px. Verified by building this
// repo's `client/src/index.css`: the 13px rule lands at byte 101699, the
// `text-xs` rule at 102501.
//
// The fix is for the default to stand aside when the caller has already named a
// size, which is what this predicate answers. The alternative — marking the
// size important at every call site — leaves the trap armed for the next screen.
//
// Two things it deliberately does NOT count:
//
//   * colours, alignment, and the wrapping/truncation utilities. They all share
//     the `text-` prefix and set entirely different properties, so they never
//     collide with a font size. Treating one as a size would strip the default
//     and leave the element with no size at all.
//   * a variant-prefixed size, such as one that only applies from `lg` up. It
//     applies inside its own media/state rule and already outranks the base
//     default there — the base breakpoint still needs the default underneath it.
//
// NOTE for anyone extending the comments above: Tailwind's scanner harvests
// candidate class names from every byte of these files, comments included. A
// class name written here that no screen actually uses becomes a real (dead)
// rule in the production stylesheet.

const NAMED_SIZES = new Set([
  'xs', 'sm', 'base', 'lg', 'xl',
  '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
]);

// An arbitrary value Tailwind reads as a colour, not a length.
const COLOUR_VALUE = /^(?:#|(?:rgba?|hsla?|okla[bch]|la[bch]|lch|color-mix|var)\()/i;
// A number followed by a CSS length (or percentage) unit, anywhere in the value —
// so a calc() of a rem and a px counts as readily as a bare pixel figure.
const LENGTH_VALUE = /\d\s*(?:px|r?em|pt|pc|ch|ex|cap|ic|lh|rlh|vw|vh|vi|vb|vmin|vmax|cm|mm|in|%)/i;

function isFontSize(cls) {
  // Anchored at the start, so a variant prefix never matches, and neither does
  // a class that merely ends in something prefix-shaped.
  const m = /^!?text-(.+)$/.exec(cls);
  if (!m) return false;

  // Tailwind's size-over-line-height shorthand puts the line height after a
  // slash; the size is everything before it.
  const value = m[1].replace(/\/[^/]*$/, '');
  if (NAMED_SIZES.has(value)) return true;

  const arbitrary = /^\[(.+)\]$/.exec(value);
  if (!arbitrary) return false;

  const inner = arbitrary[1];
  // An explicit type hint settles it either way, whatever the value looks like.
  if (/^(?:length|size):/i.test(inner)) return true;
  if (/^color:/i.test(inner)) return false;
  if (COLOUR_VALUE.test(inner)) return false;
  return LENGTH_VALUE.test(inner);
}

export function declaresFontSize(classes) {
  if (typeof classes !== 'string') return false;
  return classes.split(/\s+/).some(cls => cls && isFontSize(cls));
}
