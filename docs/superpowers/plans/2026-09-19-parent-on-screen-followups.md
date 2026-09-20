# Parent-on-screen — follow-ups found during the build (NOT in this branch)

## Worth a decision from Anik
- **Masters that store parent = their board's own sheet** (dozens on the mirror: SW-251, FP-201, SW-781, …).
  They are fossils-in-waiting: the next board change through a path that doesn't carry the parent (the Product
  Master editor) turns them into CI-MRG-0028. Two options:
  - a one-time data normalisation (parent → NULL where it equals the board's sheet, orientation-free), a prod
    write needing Anik's OK;
  - and/or a rule that a parent equal to the board's sheet is stored as NULL.
- **The Run Sheet one-click on a merge** writes the board's dims into an order whose product has NO parent on
  file. That's the same fossil shape; it needs "clear" plumbing in /shared.
- **The 14-Sep oversize refusal** (a parent larger than its board) is kept as is. Offer to soften it into a
  warning.
- **GAL-001 / GAL-072 / SW-586 masters carry lossy parents.** CHECK 3 lists them, and the screens warn when
  they're next planned. They need a human judgement: a trim or a fossil?

## Code follow-ups (pre-existing unless noted)
- FG consume/release re-derive on the bare board and drop wastage (fg.js ~319, helpers.js ~2208), the same class
  of screen-vs-lock mismatch. A fix needs the co-printed exception.
- The board freeze (plan_lock hold) is not re-held after a re-derive.
- The issue override is dropped from re-derived figures (merge/separate runs read Board Position from the stored
  sum).
- A shared layout loses its explicit child under "Update Product Master" (the primary button), so the layout
  goes pending. This branch now heals it at the next Lock sheet.
- `unbankPlanningLeftover` still audits over dead batches (the run twin is fixed in this branch).
- PATCH gang line accepts `ups: 'abc'` (NaN passes `v < 1`). Use `!(v >= 1)`.
- Missing carries:
  - `confirmMixMakeMaster`: a full-replacement mix made the product's board;
  - `applyGangBoard`: the gang's other members;
  - the merge carry reads the lead only.
- The single-engine board handlers aren't sequenced: a Reset/Undo race (M2 of the Task 7 review).
- The mix block's planned board measures a half parent on a mixed sheet.
- Smart Match quotes full sheets.
- The wastage gap (Task 3 review), already in the spec's Known gap section.
- Stored figures go stale after a Product Master edit until the next Save or Lock (general, pre-existing).
- Small items:
  - master_update audit detail;
  - an `isCoPrinted` helper;
  - `calc.engineParent` naming beside the new `engineParent()`;
  - the Parent L/W placeholder shows the board even when blank means the saved parent.

- Single-engine board handlers: when `boardSeq` sequencing lands, it must also bail when `planLine` changed.
  Closing the engine and opening another job during a Reset's reload writes the old line's board and parent
  fill into the new job.
- The context route's mix block measures its "planned" board on the per-side folded `line.sheet_l`. For a half
  parent that's a mixed sheet: 1 up where plan-save counts 3. The reviewer says `board_sheet_l/_w` there matches
  plan-save for full, half and no parents. Verify before changing.
- A Reset over a job-only parent when the master has none fills the master board's dims as a job override (a
  board-sheet copy). Needs the same clear plumbing as the Run Sheet merge one-click.

- Single engine, degenerate parents on file:
  - a zero-sided parent (e.g. 22×0) shows the generic "No sheet sizes … in Masters" band. It needs a specific row
    with the one-click; `boardSheetFill` already yields a valid fill.
  - with only half a parent on file, a blank L field's placeholder shows the ignored half.


## Tell Anik (from the final review)
- **SW-818 (prod data, pre-existing):** the master parent 26×30 is larger than its own 20×36 board, so its next
  order will be refused by the 14-Sep rule until the master is corrected. The new `check:parent` list names it.
- **New input checks, not planning blockers:** the planning screens now refuse to SAVE a half-typed or
  zero-sided parent, with a message. Previously a half parent saved and was silently ignored, and a zero side
  locked at 1:1.
- **Behaviour change:** a coating-only Lock sheet no longer re-derives, which is what keeps saved mixes safe. So
  it no longer incidentally refreshes stale figures after a Product Master edit; the next Save or Lock does.
- **Toast emphasis option:** the "saved mix cleared" note is appended to the success toast (3.8 s). It could be
  its own toast.
- **Rare, deferred:** a scoped one-click with Update Master can reach same-product orders on a different board
  size in a separate gang.

- The Lock-sheet prompt could warn BEFORE a master-parent clear. Today only the toast says it, afterwards.
- One product can be reported both "kept" and "cleared" in one request (two orders, a typed parent the new board
  can't yield). The end state is correct; only the wording doubles up.
- When a master changes in general (board, child), other open lines of the product aren't re-derived or flagged.
  This is pre-existing. The parent clear is now guarded by pinning.

- Pin lock (final review): narrow `pinParentOnMasterClear`'s WHERE so only lines that will actually be pinned
  get locked. Add a same-product race case to the `gang-lock-order-pg` harness. Watch
  `pg_stat_database.deadlocks` (baseline 0), and add a per-product advisory lock only if it ever fires.
- Other planned orders pinned by a master-parent clear are audited per line but not shown in the toast; they
  surface later as red rows.

## Data
- CI-PR-0123 still mirrors the old-board 22×28 to line 684 (seen during the 19 Sep investigation).
