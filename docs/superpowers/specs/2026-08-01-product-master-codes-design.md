# Product master — three codes, not four

**Status:** approved 2026-08-01. Branch `product-code-fields`, cut from `origin/main@2ece413`.
**Not committed, not deployed** — the working agreement for this session is plan → code → run locally.

## The ask

The product master form carries only three codes:

| Field | Source | Behaviour |
| --- | --- | --- |
| Item Code | given by the party | typed |
| Artwork Code | given by the party | typed |
| Internal Code | the ERP | auto-issued, prefilled on every new master — from Masters **and** from a sales order |

There is no Product Code field. Wherever the codes have gone duplicate in the existing masters, fix them.

## What the data actually shows

Measured on the `:5439` mirror, 1595 products.

| Column | Filled | State |
| --- | --- | --- |
| `code` (shown as "Product Code") | 1595 | globally UNIQUE (`products_code_key`); dense per-customer series SW-001..767, FP-, SGB-, GAL-, PF-, HRB- |
| `internal_carton_code` | 1594 | **1591 byte-identical to `code`**; 3 hold `''`; 1 NULL |
| `party_item_code` | 362 | clean — no duplicates globally or within a customer |
| `party_artwork_code` | 1418 | polluted — 664 revision markers, 14 dates, 27 genuine within-customer repeats |

Two distinct problems wear the same word "duplicate":

1. **Structural.** `code` and `internal_carton_code` are one value stored twice. Collapsing them *is* the requested change.
2. **Content.** `party_artwork_code` holds things that are not artwork codes. All 664 `R0`–`R5` values also appear inside the product name (`DERMAGYL-4 CREAM 10GM CARTON(SALES)-R0` → artwork `R0`); an old import sliced the revision suffix off the name and parked it here. The 14 dates came the same way (`…SALE - 11/25` → `2026-11-25`).

**Live defect found while measuring.** `helpers.js:339` gates FG matching on `internal_carton_code IS NOT NULL`. The 3 rows holding `''` are not NULL, so they satisfy `fp.internal_carton_code = p.internal_carton_code` against each other — SGB-325, SGB-327 and SGB-328 (three different ZIKDUCE cartons) can draw each other's finished-goods stock. Backfilling those rows closes it.

## Decisions taken

- **`code` survives as the Internal Code**; `internal_carton_code` becomes a server-kept mirror. It holds the UNIQUE constraint and the series generator, 1591/1594 rows already agree, and no FG-matching SQL has to change. Dropping `internal_carton_code` outright was rejected: large blast radius, no user-visible gain.
- **Internal Code is prefilled but editable** (Anik, 2026-08-01). Clearing it hands the code back to the series.
- **Revision markers stay; only the 14 dates are cleared** (Anik, 2026-08-01). This is safe under the new design: once every product carries an Internal Code, `fgMatchPredicate`'s artwork fallback — which requires `internal_carton_code IS NULL` — can never fire, so `R0` goes inert for FG matching.
- **Cleanup runs on the local mirror only.** Production gets a dry-run report and nothing else.

## Design

### 1. The form

`Masters ▸ Products`, identity block. Four code fields become three, and Customer moves above Internal Code because the code derives from the customer.

```
BEFORE                                  AFTER
Name                 | Product Code *   Name          | Customer *
Internal Carton Code | Party Item Code  Internal Code | Item Code
Party Artwork Code   | Output Number    Artwork Code  | Output Number
Customer *
```

- **Internal Code** → `products.code`. Prefills on picking a Customer for a new master; mono; editable. Hint names the series it came from and says clearing it takes the next one.
- **Item Code** → `party_item_code`, relabelled.
- **Artwork Code** → `party_artwork_code`, relabelled.
- **Internal Carton Code** field removed. The column stays, kept equal to `code` by the server.
- The products list column header follows the field label.

### 2. One derivation, both sides

`server/src/product-code.js` → `client/src/lib/productCode.js`. It is already pure and tested. The server imports it by relative path — the same arrangement `customerCode.js` already ships in production, where `@vercel/nft` traces the static relative import correctly.

- Client prefill uses `nextCodeFrom()` over the rows Masters has already loaded. No new request.
- Server stays the authority: blank `code` on POST → assign from the series; changed `customer_id` on PUT → regenerate (existing migration behaviour, unchanged).

### 3. Prepopulated from a sales order

`routes/import.js:173` stamps `NEW-${seq}` on PO-import quick-create. It calls `nextProductCode(customer_id)` instead — the function `POST /products/:id/migrate-customer` already uses. A master born from a PO is born as `SW-768`. The Orders inline-create path gets the same treatment if it carries the placeholder.

### 4. Editable implies collision handling

- Client `validate` on the products config, in the shape the Boards master already uses: a code already on another product names the owner and offers the blank-it-out escape.
- Server maps the `products_code_key` unique violation to a 409 with a readable message rather than a 500.

### 5. Data cleanup

`scripts/fix-product-codes.mjs` — dry-run by default, `--apply` writes, one transaction, JSON backup first.

Changes:
1. `internal_carton_code := code` where NULL or `''` (4 rows) — closes the ZIKDUCE cross-match.
2. Assert afterwards: every row has `internal_carton_code = code`, none NULL, none empty.
3. Clear the 14 date values out of `party_artwork_code`.

Reported, never changed:
4. The 27 within-customer Artwork Code groups, as CSV.
5. `PCSG493` — the one code outside every series, legal now that the field is editable.
6. Revision markers.

## Testing

- `product-code.js` keeps its existing unit tests at the new path.
- New unit tests: the client prefill picks the customer's series; a cleared code round-trips to a server-assigned one.
- `app-imports.test.js` guards the moved import — the trap where a route importing a deleted export 500s every endpoint while `verify` stays green.
- Cleanup script asserts its own invariant and refuses to write if the post-state fails.
- Verified in the running app, not a mock: create a product from Masters, create one from a PO import, confirm both codes land in the customer's series.

## Out of scope

Renumbering `PCSG493`, merging the 27 artwork groups, clearing the revision markers, and any change to production data.
