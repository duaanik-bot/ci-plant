# Size proposals and KLDs — design (12 Nov 2026)

Owner, 12 Nov 2026: "Whenever there is a new size, I put the dimensions. You will propose the size to me, not only from
the sizer, but also by analysing it yourself … you will give me the proposals, out of which I will select one. Once we
select all of this, you will create the KLD for the product and save it … in the cost sheet itself … save those KLDs in
the drive dua.anik@gmail.com and share it with mppchd@gmail.com." He approved building it ("Yes, build it") after the
Carton Sizing Rulebook page (house rules measured from the plant's own dies and outputs) and before answering its
eight open questions — so every rule below is a default an admin can see, and the open questions stay open.

## House rules (measured from the plant's dies, outputs and Size Library; not yet confirmed by the owner)

- SIDE (reverse tuck) is read two ways and both are tried: **side-open** (written L×W×H, the tube runs along L, faces H
  and W) and **top-open** (the tube runs along H, faces L and W). LOCK (crash-lock bottom + tuck top): tube along H.
- Glue flap 8 mm when W ≤ 20, 10 when W ≤ 50, 15 above. Tuck 10 (W ≤ 20), 12 (≤ 50), 14 (≤ 80), 15 above.
  Closure panel = W. Dust flaps min(12, (W + tuck)/2 − 1). Lock flaps W/2 + 5. Panels at the nominal (inner) size.
- Across: rows butt with no gap (pitch = blank width). Along the tube: side-open/top-open tucks interleave every
  tube + W + tuck, plus one W + tuck at the end; LOCK pairs go head to head (2·lock + 2·tube + W + tuck), a lone one
  lock + tube + W + tuck. No sheet margin by default (the plant's outputs run 0–10 mm).
- Print sheets proposed: whole pieces (1–4 × 1–3 cuts) of mill sheets in the board master that use ≥ 97% of the mill
  sheet, inside the press window (long ≤ 28 in, short ≤ 20 in, long ≥ 12, short ≥ 10).
- Grain: the blank's across direction must run with the sheet grain (industry rule for tube cartons). Board master
  gets `grain` ('long' | 'short' | null); a proposal says which sheet side needs the grain and, where the mill sheet's
  grain is known, whether the child sheet has it.
- Ranking: board area a carton (print-sheet sq in ÷ ups), then more ups (fewer impressions); the smaller die stays listed. Near misses are reported ("needs 1.2 mm").

## What it does

1. Die check first: exact and near (±3 mm a side) dies in the Die Master (tools) AND the 2024 die register
   (new table `die_register`, loaded by script from the owner's Drive sheet; the two lists number dies differently).
2. Proposals: up to four distinct-ups options per reading, each with sheet, mill sheet and pieces, ups (m × n), board a
   carton (sq in and g at the costing's GSM), spare mm, grain side, and a block picture.
3. Picking one fills the costing's sheet, ups and pasting and ticks New die.
4. KLD: drawn by CI Plant from the size, construction and rules (cut solid, crease dashed, glue area, dimensions,
   grain arrow, title block); saved on the Size Library entry (`costing_sizes.kld` jsonb, with a revision number) so
   every costing of that size shows it; served as a 1:1 PDF (pdf-lib).
5. Drive: "Save to Drive" uploads the PDF into a "CI Plant KLDs" folder of the Google account linked for the trial
   mailbox (dua.anik@gmail.com) and shares it (reader) with the business mailbox's address (mppchd@gmail.com). Needs
   the Drive permission (drive.file) on that Google link: the Connect button asks for it; a link made before it is
   told to connect again. Nothing is shared with anyone else.

Not in v1: editing allowances per carton, other constructions (sleeve, seal end, 1-2-3 bottom, tray), caliper allowance,
importing the register into the Die Master (numbering not reconciled).
