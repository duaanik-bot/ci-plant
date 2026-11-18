# New die tick and "Die in the factory" follow the die check — design

Status: owner's choice 17 Nov 2026, "Die Master only" (relayed request: "Yes, pass it on"). Small change.

## Why

Seen on the live screen (17 Nov): a new costing for a size whose die the size check finds — "Job N's die is this
size … Check it is still in the rack." — still says "No die of this size in the Die Master — a new die would be
needed." in the right-hand card, and charges process ₹3,000 with New die ticked. Today nothing turns New die off by
itself, not even a Die Master die of exactly this size; only "Use this die's layout" does. The tick also decides
"New die" / "Existing" on the order sheet.

## The owner's rule

- A **Die Master** die of exactly this size turns New die off by itself (process ₹2,000, order sheet "Existing").
- A die only on the **die list** (2024 list or a Drive drawing) leaves New die on (₹3,000) — nobody has confirmed it is
  still in the rack — and the card offers one click: "No new die — use Job N's die".
- Same numbers in another order, and close dies, never change the tick.
- A tick set by hand always wins (`new_die` set explicitly); a product still means an existing die, as today.

## Non-goals

Bulk costing (its process is set when rows are added, before their size checks arrive) — unchanged, reported.
The size proposals box — unchanged. `matchDies` — unchanged (bulk uses it).

## Approaches

- **Chosen:** the editor's own size check (`GET /costing/size-check`) also returns the die list (`register`, the same
  `registerMatches` the size proposals use, moved to `server/src/die-list.js`) and the Die Master by the same rule
  (`dieMasterMatches`); `newDieDefault` and the house rules take the Die Master die into account; the card reuses
  `lib/die-check.js` wording.
- Rejected: the card fetching the size-proposals endpoint (a second request, and it computes layouts it does not need).

## Design

- `newDieDefault(v, { masterDie })`: explicit `new_die` → it; else product or a Die Master die → off; else on.
- `houseRuleValues(v, { …, masterDie })` (`masterDie` = the exact Die Master die's code or null): process ₹2,000 with
  the note "existing die (Die Master N) — ₹2,000" when that die is why. `recommend()` passes
  `check.dies.exact[0].code`.
- `GET /costing/size-check` → `dies: dieMasterMatches(size, tools)` (`{ exact, reordered, near }`) and
  `register: registerMatches(size)`.
- Card "Die in the factory": Die Master exact dies as today; die-list exact dies in the size check's words with the
  button (only while New die is on, never read-only); one "Same numbers, written another way" line; one "Close" line;
  nothing found → "No die of this size in the Die Master or the die list — a new die would be needed."
