# Size check: dies by job number, any size order, one line per die — design

Status: approved by the owner 15 Nov 2026 ("Yes" to the design in the die-list session). Small change.

## Why

The costing size check (Costing › new size › Size proposals) tells the costing user whether a die already
exists before a new one is proposed. On 15 Nov 2026 the die register (`die_register`) grew from 2,120 rows (the
2024 register) to 2,430: 129 copies of Die Master dies (`DM-<code>`) and 181 dies from the studio's Drive drawings
(`J<job>`, `J<job>/<n>`). Three things in the check are now wrong or unhelpful:

1. Every register match says "Die *n* in the 2024 die register", including the Drive and Die Master rows.
2. The owner confirmed the register's numbers (1–2122) are **not written on the dies**, so "Die 693" helps nobody
   find a die. The studio knows a die by the job it was made for ("OLD DIE NO. *job*").
3. The register is matched only in the written order (L × W × H within 3 mm). The same carton is often written in
   another order (side-open: first number = tube; top-open: last = tube), so a die that exists is missed.

And one bug from the import: each `DM-` row is a copy of a Die Master die that the check already reads from the Die
Master itself, so every one of those 129 dies shows twice.

## Goals

- `die_register.job_no` — the job a die was made for, where known.
- Each register line names the die by its job ("Job 12345's die"), says where the die is known from (the 2024 die
  list with its list number, a new-die drawing in Drive, a die line in Drive, an old-die job file in Drive), and leaves out
  facts that are not recorded instead of printing "Not recorded · ? up".
- Dies whose three numbers are the same but written in another order are found, in both lists, and shown on their
  own line with "check it opens the same way" — never as an exact match.
- A close die (within 3 mm) matched only in another order is marked "(another order)".
- A `CI PLANT DIE MASTER` copy is never shown; the Die Master is shown from the Die Master.

## Non-goals

- Mix dies (two cartons on one die) — not loaded, not shown.
- Retiring the Die Master check or its codes.
- `matchDies` / `sizeRelation` in `costing-match.js` (used by other costing checks) keep their behaviour. On this screen
  the Die Master follows the die list's rule (`dieMasterMatches`): hiding the `DM-` copies would otherwise lose the 3 mm,
  any-order net they gave (matchDies stops at 2 mm as written) — decided after the final review.
- The register loader (`scripts/load-die-register.mjs`): the DIE DATA sheet has no job column.

## Anti-goals

- An other-order die presented as "this size" — the opening (tube) may differ, so it is a check, not a match.
- Real plant data (job numbers, die sizes) in the repo: the job numbers are filled on production by a one-off SQL
  kept outside the repo, like the 15 Nov import. Tests and this doc use invented values.

## Approaches

- **A. SQL prefilter + pure classifier (chosen).** The route asks Postgres for dies within 3 mm in the written order
  *or* after sorting both sizes; a pure function in `costing-match.js` sorts them into exact / another order /
  close. Testable without a database (like `matchDies`), the SQL stays a cheap scan of ~2.4k rows.
- B. Everything in SQL (classes and wording computed in the query). Harder to test, wording in SQL — rejected.
- C. Ship the whole list to the browser and match there. 2,430 rows on every size check, against the payload
  rules — rejected.

## Design

**Schema.** Migration `supabase/migrations/20261115120000_die_register_job_no.sql`:
`ALTER TABLE die_register ADD COLUMN IF NOT EXISTS job_no text;` — wired into `db.js` `init()` after `size_kld`.
No data in the migration.

**Data (production, on the owner's word only).** A one-off script outside the repo writes `dryrun.sql`,
`apply.sql`, `undo.sql`: register rows get the job from the studio's 2021 die sheet (1,021 of 2,120, aligned row by
row as in the 15 Nov analysis); `J` rows get their own number. Undo sets those `job_no` back to NULL. Backup first.

**Route** (`server/src/routes/sizing.js` `registerMatches`): selects `source` and `job_no` too; prefilter
`(each side within 3 mm, written order) OR (each side within 3 mm, both sorted)`; leaves out
`source = 'CI PLANT DIE MASTER'`. Returns `register: { exact, reordered, near }` (near capped at 8, each near die
carrying `other_order: true|false`) and `master: { exact, reordered, near }` (`dieMasterMatches`, the same
rule). `job_no` is read as `to_jsonb(d) ->> 'job_no'`, so the code also runs before the migration reaches a database.

**Wording** (`client/src/lib/die-check.js`, pure): `dieName(d)` → "Job 12345's die" (a `J…/2` row → "Job 12345's
die no. 2"), or "2024 die list no. 7" when no job is recorded; `dieFrom(d)` → "2024 die list no. 7" (with a job) /
"no job no. recorded" / "new-die drawing in Drive" / "die line in Drive" / "old-die job file in Drive"; style and ups
only when recorded.

**Screen** (`SizeProposals.jsx` `DieCheck`): green lines for exact dies (Die Master as today; register with the
new wording, "Check it is still in the rack."); an amber "Same numbers, written another way" line listing
reordered dies from both lists with their own written size and "check it opens the same way"; the Close dies line
with "(another order)" marks; the no-die sentence names the die list and says sizes were checked in any order.

## Left to the builder

Colours and ordering within a line; exact sentence punctuation; how many reordered dies to list before "…".
