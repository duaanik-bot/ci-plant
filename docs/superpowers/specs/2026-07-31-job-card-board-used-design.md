# Job Card — the board being used, and how it differs from the master

Date: 2026-07-31
Status: approved

## Problem

The Job Card is the only document in the plant that names the **product master's**
board. Everywhere else already resolves the *effective* board — the planner's
`order_lines.spec_override->>'board_material_id'` wins over
`products.board_material_id`:

- `server/src/helpers.js` exports `EFF_BOARD_ID` for exactly this.
- `server/src/routes/orders.js` (Planning) selects the effective board plus
  `board_overridden` and `master_board_material_id`.
- `server/src/routes/floor.js` `STAGE_VIEW` selects
  `COALESCE(ebm.name, bm.name) AS board_name` — the Live Floor and every section
  workspace show the effective board.

`JC_VIEW` in `server/src/routes/production.js` hard-joins
`materials bm ON bm.id = p.board_material_id`. It feeds **both** the Job Card form
modal (`client/src/pages/Production.jsx`) and the printed traveler
(`client/src/pages/JobCardPrint.jsx`).

Consequences today:

1. When Planning moves a job onto a different board, the form and the printed
   card still name the master's board. The floor screen and the paper in the
   operator's hand disagree about which board to cut.
2. `sheet_l` / `sheet_w` (the "Parent Sheet" cell) come from the master board, so
   an override onto a different parent size prints the wrong size.
3. `JC_VIEW`'s `stk` lateral **already** measures stock against the effective
   board id, while `board_name` names the master. The "Board pending" tooltip in
   `Production.jsx` therefore reads "short N parent sheets of «master board»"
   while the number counts the override's stock.

Nothing on the Job Card compares the board being used against the master, and
nothing compares either against what the warehouse actually consumed.

## Goals

- The Job Card form and the printed traveler name **the board being used**.
- Both state plainly when that differs from the product master.
- Both state plainly when the material actually **issued** differs from either.
- On the printed card, all specification lives in one block at the top.

## Non-goals

- COA (`server/src/routes/coa.js`) and FG receipt (`server/src/routes/fg.js`)
  read `product.board_material_id` directly and carry the same class of bug.
  Out of scope; flagged separately.
- No new columns, no migration. Everything needed is already in the schema.

## Design

### 1. Server — `JC_VIEW` learns the effective board

`server/src/routes/production.js`.

Keep the existing INNER join on the master board (it can never be NULL, and
dropping it would change row counts). Add a LEFT join on the effective board —
the exact shape `floor.js` already proves:

```sql
LEFT JOIN materials ebm ON ebm.id = COALESCE(
  (COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int,
  p.board_material_id)
```

`COALESCE(ol.spec_override, gol.spec_override)` rather than the bare
`EFF_BOARD_ID` helper: a gang parent card has no order line of its own and reads
its spec off the anchor member `gol`, which is how every other effective-value
expression in `JC_VIEW` is already written.

Selected columns change to:

| Column | Expression | Meaning |
|---|---|---|
| `board_name` | `COALESCE(ebm.name, bm.name)` | the board being used (was: master) |
| `sheet_l` / `sheet_w` | `COALESCE(ebm.sheet_l, bm.sheet_l)` etc. | parent size of the board being used |
| `board_material_id` | `COALESCE(ebm.id, bm.id)` | effective id |
| `master_board_name` | `bm.name` | the product master's board |
| `master_board_material_id` | `p.board_material_id` | master id |
| `board_overridden` | `(COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id') IS NOT NULL` | is this a job board? |
| `board_grade` | `COALESCE(NULLIF(p.board_grade,''), NULLIF(split_part(p.board_name,' ',1),''), split_part(COALESCE(ebm.name, bm.name),' ',1))` | grade chip, same ladder as `floor.js` |

`p.board_material_id` is already selected by the view and must be **renamed** to
`master_board_material_id` so it cannot be mistaken for the effective id.

This alone fixes the Board-pending tooltip and the Parent Sheet cell, because
both already read `jc.board_name` / `jc.sheet_l`.

### 2. Server — issues carry material identity

`jc.issues` is built twice (the GET detail handler and the PUT response). Both
select `mt.name AS material_name` but no id, so the client cannot tell whether
the consumed material is the board the card names.

Add `sm.material_id` to both queries.

A cutting over-issue lands on a `CUT-SHORT-<id>` batch of the **same** material,
so comparing on `material_id` produces no false positives.

### 3. Client — Job Card form, board in the first panel

`client/src/pages/Production.jsx`.

A full-width board band at the top of the **Editable job fields** panel, above
the four inputs:

```
[SAFFIRE]  Saffire · 300 GSM · 31.5x41.5      31.5×41.5"     [JOB BOARD]
           Master: FBB · 300 GSM · 31.5x41.5
           ⚠ Issued: FBB · 280 GSM · 31.5x41.5 — 4,200 sheets
```

- State chip reads `MASTER` (slate) or `JOB BOARD` (violet) — the same two words
  Planning already uses, so the two screens speak one language.
- The `Master:` line renders **only** when `board_overridden` and the names
  differ.
- The amber `Issued:` line renders **only** when some `jc.issues` row has a
  `material_id` differing from the effective `board_material_id`; it names each
  distinct material and its total issued quantity.
- The **Product Master** panel's Board cell switches to `master_board_name`.
  That panel states the master by definition; the effective board now lives at
  the top.

### 4. Client — printed PDF, one spec block at the top

`client/src/pages/JobCardPrint.jsx`.

The three `Block`s (Planning Engine, Artwork Module, Product Master) collapse
into a single **Job Specification** section rendered directly under the header —
above the Gang Run table and above Material Issued.

- It opens with the same board band, boxed and at heavier weight: it is the one
  value a cutter must not get wrong. It carries the same `Master:` and `Issued:`
  lines under the same conditions.
- Below the band, one dense 4-column grid of every field the three blocks carry
  today. No field is dropped. Order: **Board & sheet → Product geometry →
  Artwork → Planning numbers**, with faint group captions so it stays scannable.
- Three block headers become one, so the page cost is slightly lower than today
  and the card still fits one A4.

## Testing

- `node --test` for the server; the existing suite must stay green.
- Add a case proving `JC_VIEW` returns the override's board name and parent size
  for a line carrying `spec_override.board_material_id`, and the master's for one
  that does not.
- Verify in the running app at a desktop breakpoint: a plain card with no
  override (chip reads `MASTER`, no second line), a card with a Planning
  override (chip reads `JOB BOARD`, `Master:` line present), and the printed
  view for both.
- `npm run build` for the client.

## Risks

- `JC_VIEW` is shared by the job-card list, the detail endpoint and the
  finished-goods endpoint. A malformed join would break all three; the LEFT join
  cannot drop rows, which is why the master INNER join stays.
- The tree is shared with concurrent sessions. Exact-string edits only; never
  `git checkout --` a file.
