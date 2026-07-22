# Role-Scoped Users & Granular Access Control — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending spec review
**Scope:** ci-erp (local only, no git commits per project rule)

## Goal

Turn the flat, page-level `users.modules` toggle into a three-dimension access
system, seed the plant's real user roster, and expose every dimension as
checkboxes in the Create/Edit User form so future users can be built without
touching code.

## Decisions (locked with Anik)

1. **Enforcement = view filter, not a hard boundary.** Scoped users only *see*
   their queue; the server does not reject a crafted write outside their scope.
   Writes stay guarded by the existing coarse roles, unchanged. Filtering is
   applied **server-side on the floor read routes** (cleaner than sprinkling
   filter logic through components).
2. **Printing operators run their own press.** Shiv/Dileep/Modi keep the normal
   `production` operator workflow (start / hold / complete) — just scoped in the
   UI to their machine's queue.
3. **Planning / Plant / Accounts = true admins** (full control, incl. user
   management). They differ from the MD login only by name and landing page.
   The checkbox system lets any of them be dialed back to scoped-non-admin later
   without a rebuild.
4. **Dies** = die_cutting + foiling + embossing floor sections **plus** the
   Tooling Hub module. One shared login for all die operators.

## Data model

Three new **nullable** columns on `users`. NULL = unrestricted, identical in
spirit to how `modules` already works (NULL = every module the role allows).

| Column        | Type  | Meaning                                                        |
|---------------|-------|----------------------------------------------------------------|
| `sections`    | JSONB | Array of Live Floor section keys the user may see. NULL = all. |
| `machine_ids` | JSONB | Array of machine ids the printing queue is limited to. NULL = all. |
| `landing_path`| TEXT  | Path the user is redirected to after login. NULL = role default. |

Floor section keys are the existing `SECTIONS` in `server/src/routes/floor.js`:
`cutting, printing, coating, lamination, foiling, embossing, die_cutting,
sorting, pasting, qc`.

Machine ids reference `machines.id`. **Live-confirmed 2026-07-10** from
`machine_operators` (this supersedes an earlier stale "CI-1/2/3 = 8/9/13 with
Shiv/Dileep/Modi" note, which had the operators mapped to the wrong presses):

| Operator   | emp id | Machine id | Machine                                   |
|------------|--------|------------|-------------------------------------------|
| Modi       | 13     | **8**      | Offset Printing Press No. 1 (5C + Coater) |
| Dileep     | 12     | **9**      | Offset Printing Press No. 2               |
| Shiv Kumar | 14     | **13**     | Offset Printing Press No. 3               |

Each operator login is scoped to the machine they are actually assigned in
`machine_operators` — do not rely on press display names / the CI-1/2/3 labels.

## Enforcement (view filter, server-side reads)

The authenticated user is already on `req.user`. The floor **GET** routes filter
their output by that user's scope:

- `/floor` — return only the sections in `req.user.sections` (NULL = all).
- `/floor/:section` and `/sections/:section` — if the requested section is not in
  the user's `sections`, return empty / 403-style empty payload rather than data.
- Printing queues (`/floor/printing`, machine cards, `/sections/printing`) —
  when `req.user.machine_ids` is set, include only jobs whose effective machine
  is in that list.

Admins (`role='admin'`) bypass all scoping — `sections`/`machine_ids` are ignored
for them. This is the same short-circuit `canAccess` already uses for `modules`.

**Writes are unchanged.** `requireRole(...)` guards stay exactly as they are.
This is the explicit "view filter only" decision — we are not adding
per-machine/per-section write rejection.

## Roster to seed

Password `ci1234` for all new logins (MD stays `admin123`); all changeable in
Masters → Users. Emails follow the existing `*@ci.local` convention.

| Name     | Email               | Role       | modules                     | sections                          | machine_ids | landing_path       |
|----------|---------------------|------------|-----------------------------|-----------------------------------|-------------|--------------------|
| Anik Dua | admin@ci.local      | admin      | NULL (exists)               | NULL                              | NULL        | /                  |
| Planning | planning@ci.local   | admin      | NULL                        | NULL                              | NULL        | /planning          |
| Plant    | plant@ci.local      | admin      | NULL                        | NULL                              | NULL        | /floor             |
| Accounts | accounts@ci.local   | admin      | NULL                        | NULL                              | NULL        | /invoices          |
| Shiv     | shiv@ci.local       | production | [floor]                     | [printing]                        | [13]        | /floor/printing    |
| Dileep   | dileep@ci.local     | production | [floor]                     | [printing]                        | [9]         | /floor/printing    |
| Modi     | modi@ci.local       | production | [floor]                     | [printing]                        | [8]         | /floor/printing    |
| Dies     | dies@ci.local       | production | [floor, tooling]            | [die_cutting, foiling, embossing] | NULL        | /floor/die_cutting |
| Cutting  | cutting@ci.local    | production | [floor]                     | [cutting]                         | NULL        | /floor/cutting     |
| Pasting  | pasting@ci.local    | production | [floor, finished_goods, inventory] | [sorting, pasting, qc]     | NULL        | /floor/pasting     |

Note: a `planning@ci.local` / `die@ci.local` / `printing@ci.local` set was seeded
in an earlier session. These will be **reconciled** — the earlier `planning`/`die`/
`printing` placeholder logins are removed or repurposed so the roster above is the
single source of truth. (Reconciliation list confirmed at implementation time.)

### Pasting role caveat (accepted)

`production` lets the Pasting user run sorting/pasting/QC floor stages and *store*
finished goods. *Verifying* FG (qc/planner) and *adjusting* warehouse stock
(planner) are visible but not performable by them — consistent with view-filter
scoping. If Pasting must adjust stock later, that's a role bump, out of scope here.

## UI — Create/Edit User form

Extends the existing module-checkbox grid in `client/src/pages/Masters.jsx`
(the `moduleAccess` block). No admin restriction change — still `adminOnly`.

1. **Role-template dropdown** at the top of the user form: MD, Planning, Plant,
   Accounts, Press Operator, Section Operator. Selecting one pre-fills role +
   modules + sections + machine_ids + landing_path. Everything stays editable
   afterward — the template is a starting point, not a lock.
2. **Live Floor sub-stations (nested)** — checking "Live Floor" reveals an
   indented sub-list *inside the same grid*, one checkbox per `SECTIONS` station
   (Cutting, Printing, Coating, Lamination, Foiling, Embossing, Die Cutting,
   Sorting, Pasting, QC). This is how a user is dedicated to a particular
   station. Semantics:
   - Live Floor checked, **no** sub-stations ticked = all stations (`sections`
     NULL) — the current behaviour, unchanged.
   - Live Floor checked, **some** sub-stations ticked = `sections` = that subset;
     the user's floor shows only those stations.
   - Live Floor unchecked = no floor access at all; sub-list hidden and
     `sections` cleared.
   - A "Grant all stations" link clears the subset back to NULL (all).
3. **Machines (nested under Printing)** — when the **Printing** sub-station is
   ticked, an indented press list appears (CI presses from `/machines`). Ticking
   specific presses sets `machine_ids` (e.g. Shiv → Press No. 3); none ticked =
   all presses. This is how Shiv/Dileep/Modi get pinned to one press.
4. **Landing page** — a select of the user's granted module paths (+ floor
   sections), defaulting to role default.

`sections`, `machine_ids`, `landing_path` travel with the user save body the same
way `modules` already does (`cfg.moduleAccess` block extended).

## User management — add / edit / delete / control (MD)

The MD (any `admin`) gets full lifecycle control over users. Add and edit already
exist; this spec adds **delete** and confirms **access-control editing** covers
all three new dimensions.

- **Add** — existing `POST /users`, now also persists `sections`,`machine_ids`,`landing_path`.
- **Edit** — existing `PUT /users/:id`, same three new fields; change role,
  modules, sections, machines, landing, active, password at will.
- **Delete** — NEW `DELETE /users/:id`, `requireRole()` (admin-only). Guards:
  - cannot delete yourself (`req.user.id`);
  - cannot delete the **last active admin** (prevents lockout);
  - hard delete (row removed). If FK references block it (audit/timeline rows),
    fall back to soft-delete `active=0` and report which is used.
- **UI** — remove `noDelete: true` from the `users` Masters config so the delete
  action shows on each row (admin tab only). A confirm dialog names the user.

Net: from Masters → Users, the MD can create any login, change anyone's role and
full access scope (modules + sections + machines + landing), deactivate, reset
passwords, and delete.

## Registry / helper changes

`client/src/modules.js`:
- Export `SECTIONS` (mirror of server list) and a `canAccessSection(user, key)`
  helper (admin → true; NULL → true; else membership).
- `firstAllowedPath(user)` respects `landing_path` when present.

`server/src/auth.js`:
- `/auth/login` and `/auth/me` responses include `sections`, `machine_ids`,
  `landing_path` so the client knows scope and where to land.
- User create/update (`POST/PUT /users`) accept and persist the three new fields.

`client/src/App.jsx`:
- `RequireAuth` redirect uses `landing_path` when present.
- Section route guard: a scoped user hitting a section outside their set is
  bounced to their landing page.

## Enhancements included

- **Role templates** (above) — one-click standard users.
- **Per-user landing page** — each login opens on its own board.
- **Shared-login friendliness** — Dies/Cutting/Pasting are one credential each;
  no per-person tracking there (the machine logbook already records who ran what).

## Out of scope (YAGNI)

- Hard server-side write enforcement per machine/section.
- Multi-role / capability-from-modules (Pasting caveat above).
- PIN quick-switch kiosk mode (can revisit if the floor wants it).

## Testing

- Migration adds columns idempotently; existing users unaffected (all NULL).
- Seed script is idempotent (skip-if-exists by email), reuses live embedded PG.
- Verify on a temp server + port pair (per project convention) against live PG:
  - Admin sees all sections; Shiv sees only printing/CI-1; Cutting sees only
    cutting; Pasting sees sorting/pasting/qc + FG + Warehouse nav.
  - Login redirects land each user on their `landing_path`.
  - User form: template pre-fill, section/machine checkboxes save & reload.
  - Delete: MD deletes a test user; self-delete blocked; last-active-admin
    delete blocked; delete of a scoped operator succeeds.
- No git commit (project rule).
