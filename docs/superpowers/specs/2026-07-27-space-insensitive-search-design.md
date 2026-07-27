# Space-insensitive search, board names without spaces, spec code in Masters

Date: 2026-07-27
Status: approved

## Problem

Three related complaints, all about finding things on the plant floor.

1. **Searching a board size is fiddly.** Board names are stored as
   `Duplex GB · 296 GSM · 20 x 38`. To find that board an operator has to type
   the spaces exactly — `20 x 38`. Typing `2038`, the way the size is actually
   spoken and written on the floor, finds nothing.
2. **Board names carry cosmetic spaces.** `22 x 28` should read `22x28`.
3. **The board's short code is invisible in Masters.** A board carries a spec
   code (`2037DPGB230`) that is entered on the form but never shown in the list,
   so the code an operator is told on the floor cannot be looked up.

Plus a coverage gap: three modules in the sidebar have no search box at all.

## Design

### 1. One normalization rule, defined once

New twin pair, `client/src/lib/searchKey.js` and `server/src/search-key.js`,
following the existing `boardCode.js` / `board-code.js` twin convention (a test
asserts the two produce identical output).

```
squash(text) = lowercase
             → collapse dimension separators:  /(\d)\s*[x×*]\s*(\d)/ → "$1$2"
             → strip every non-alphanumeric character
```

`"Duplex GB · 296 GSM · 20 x 38"` → `duplexgb296gsm2038`

The dimension-separator step is what makes `2038` work: stripping punctuation
alone would leave `20x38`, and the operator does not type the `x`.

**Match rule:** a term matches if the **raw** haystack contains the raw term
**OR** the squashed haystack contains the squashed term.

The OR is the safety property. Squashing only ever *adds* matches, so every
search that works today keeps working — including searches that depend on
punctuation the squash would otherwise destroy (`31.5`, `CI-BOX`, `₹`).

| typed | matches |
| --- | --- |
| `2038` | `20 x 38`, `20×38`, `20x38` |
| `315415` | `31.5 x 41.5` |
| `2037DPGB230` | that spec code |
| `duplex 2038` | ANDs across fields, as today |

**Accepted cost:** squashing creates false positives — `2038` also matches a
rate of `20.38`. Deliberate: on a plant floor an extra row is cheaper than a
search that needs exact spacing. Raised with the user and accepted.

### 2. Client — two chokepoints cover the whole app

- **`rowMatches` (`client/src/components/ui.jsx`)** gains the squashed haystack.
  One edit upgrades `DataTable` — Masters, Planning, Warehouse, Procurement,
  Orders, Accounts, Reports, Logbook, Invoices, Dispatch, Artwork, Tooling,
  Shade Cards — *and* the eleven pages that call `rowMatches` directly: every
  station board, Sort & Paste, Print Planning, Finished Goods & QC, Extra
  Sheets, Tracking, Status Sheet, Cutting Variances, Orders, Tooling,
  Shade Cards.
- **`Combobox` (same file)** gets the same rule on `${label} ${value}`. This is
  the board picker in the Planning Engine, the Product Master and the PO
  editor, so `2038` resolves a board in every dropdown too.

No page-level changes are needed for search normalization. That is the point of
routing everything through these two functions.

### 3. Server — three live search endpoints

`squashSql(col)` returns the equivalent Postgres expression:

```sql
regexp_replace(
  regexp_replace(lower(col), '(\d)\s*[x×*]\s*(\d)', '\1\2', 'g'),
  '[^a-z0-9]+', '', 'g')
```

OR'd onto the existing `ILIKE` at three sites:

- `server/src/routes/inventory.js` — `/warehouse/paper`, the Planning Engine's
  warehouse picker (`m.name`, `m.spec`, `m.code`)
- `server/src/routes/orders.js` — Sales Orders `search_blob`
- `server/src/routes/timeline.js` — the audit-history drawer

### 4. Three new search boxes

The only sidebar modules with no search today:

- **Live Floor** (`Floor.jsx`) — filters machine cards and their job chips; a
  machine with no surviving job is hidden.
- **Job Cards** (`Production.jsx`) — filters the job list.
- **Dashboard** (`Dashboard.jsx`) — filters the Recent Jobs, machines and
  alerts panels. Aggregate KPI tiles are left alone; filtering a plant-wide
  count by a search term would misreport it.

All three use `rowMatches`, so they inherit the squash automatically.

### 5. Board names lose the spaces

`boardName()` in both twins emits `20x38` instead of `20 x 38`. The
`parseBoardName` regex already accepts `\s*[x×]\s*`, so it round-trips both the
old and new form and needs no change.

The `·` separators stay. Only the L × W pair closes up:
`Duplex GB · 296 GSM · 20x38`.

**Migration.** Two columns hold this text and must move together:

- `materials.name` (the board master)
- `products.board_name` (a denormalized copy on each product)

Both are rewritten in one transaction with the same regex. That is what keeps
them consistent: any product↔board pair that matched before still matches
after, and any pair that did not, still does not. This matters because gang
compatibility buckets jobs by board-name string (`gangs.js`, `uniq(m =>
m.board_name)`) — a half-migration would split one board into two gangs.

The statement is idempotent (re-running is a no-op), so it follows the existing
`init()` backfill precedent — e.g. the `UPDATE materials SET gst_rate=18 …`
already in `db.js`.

Procedure is DEPLOYMENT.md §3, not improvised:

1. Idempotent `UPDATE` into `init()`; restart local to apply.
2. `npm run db:baseline` then `npm run db:check -- --baseline` — must print
   `OK — schemas match`.
3. Apply the delta to production as a named Supabase migration on
   `colour-impressions-prod`, after `npm run db:backup`.
4. `npm run db:check` against production — must agree.
5. Commit `db.js` and the regenerated baseline together.

### 6. Spec code under the name in Masters

The Materials and Boards tabs render the `name` cell as a two-line stack: name
on top, `spec` beneath in 11px mono `slate-400`. This reuses the exact
`leading-tight` pattern the Products tab already uses for its Sheets and
Shade-card cells, so it is a pattern the page already contains rather than a
new one.

Column widths, the table's horizontal layout and the surrounding card are
untouched. Rows in those two tabs grow by one tight text line; a board with no
spec code renders exactly as it does today, with no reserved empty line.

## Testing

- **Unit** — `squash` against the real board-name shapes in the master
  (integer, decimal, `×` separator, spec codes), the OR match rule (a
  punctuation-dependent term still matches), and twin parity between the client
  and server copies. Extend `board-code.test.js` for the new `boardName` output.
- **Verification in the real running app** (not a mock — per the standing rule
  for this project): log in at desktop breakpoint and confirm `2038` finds the
  board in Masters, in the Planning Engine warehouse picker and in a board
  dropdown; the spec code shows under the name; the three new search boxes
  filter their boards.
- **Gate** — `npm run verify` (baseline freshness + server tests + client
  build) before commit.

## Out of scope

- Reworking the Dashboard's aggregate tiles into searchable lists.
- Fuzzy or typo-tolerant matching. Substring-after-squash only.
- Renaming anything other than the L × W pair inside board names.
