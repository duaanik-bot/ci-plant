// Set-type classification — the pure rules, written once.
//
// Two screens read them and neither may hand-roll a copy (the gang-anchor
// rule: a rule with one spelling can be fixed once; a rule with two gets fixed
// once and stays broken in the other). Planning triages ORDER LINES, where the
// stored tag is intent and facts outrank it. Print Planning triages JOB CARDS,
// which carry no tag at all and are classified purely by fact.
//
// This lives in lib/ rather than components/SetType.jsx because that file
// holds JSX and cannot be imported by a node test — so the rule that decides
// what the plant sees had never been executed by a test at all, only grepped.
// SetType.jsx re-exports everything here, so every import site is unchanged.

// The ONE fact that forces a zone: a gang shares its sheet with other products
// and splits after die cutting, so it can never print on its own terms.
export const isGangRun = r => r?.run_kind === 'gang';

// A COMBINED RUN (kind 'merge') deliberately forces nothing. One product, one
// plate, several sales orders — physically a Single, which is why it falls
// through to the line's own tag rather than being pinned to 'single': a
// combined run needing a fresh plate set is New Output, exactly as an
// uncombined one would be.
export const isMergeRun = r => r?.run_kind === 'merge';

// A Planning row — the collapsed run (members on `_gang`) or a lone line.
//   hold      any member on hold parks the whole row; a run moves as one
//   gang      the sheet is shared, so no tag may say otherwise
//   otherwise the planner's stored intent, defaulting to single
export const rowSetType = r => ((r._gang || [r]).some(m => m.set_type === 'hold') ? 'hold'
  : isGangRun(r) ? 'gang' : (r.set_type || 'single'));

export const holdReasonOf = r => (r._gang || [r]).map(m => m.hold_reason).find(Boolean) || '';

// A Print Planning card. No stored tag exists here, so the fall-through lands
// on 'single' directly. The press hold IS the hold — never a second flag.
export const cardSetType = c => (c.printing_status === 'hold' ? 'hold'
  : isGangRun(c) ? 'gang' : 'single');
