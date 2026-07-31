# Messaging & Notification Centre — UI/UX Redesign

*Drafted 2026-07-30. Source: Anik's "Messaging & Notification Center" brief (15 sections).*
*Status: awaiting approval. Nothing built.*

## Decisions taken (Anik, 2026-07-30)

1. **A real top bar.** Introduce a desktop header rather than tucking the two centres into the
   sidebar or leaving them as floating docks.
2. **Wait for the parallel session.** `AppLayout.jsx`, `Chat.jsx`, `ui.jsx` and `index.css` all carry
   uncommitted work on branch `shade-card-simplification`, including a mobile/iPad pass that just
   turned the three docks into a bottom row. **No shared file is touched until that branch lands**;
   this design merges with it rather than reverting it.
3. **Wave 1 = placement, inbox, filters.** §1, §2, §5, §6, §7 and §11–12. Priority levels (§8), the
   compose-time audience prompt (§3) and the remaining message actions in §10 follow in wave 2.
4. **PureFlix IMS is not a reference.** The brief mentions it; Anik has confirmed it is unrelated to
   this product. The design language to match is this app's own — macOS Tahoe / Liquid Glass,
   systemBlue accent, `glass` panels, `animate-liquidPop`. A stale `// Pureflix Notification Center`
   comment in AppLayout.jsx is corrected as part of this work.

## What the brief asks for that is already live

| Brief | Status |
|---|---|
| §4 thread-based conversations | Live — every message belongs to a conversation; replies stay in it |
| §9 module-based conversations | Live — 20 record types, 13 mounted surfaces, one thread per record by construction |
| §10 attachments, images, PDFs, voice notes | Live |
| §3 audience: DMs, groups, teams | Live as *destinations*; the compose-time "who is this for?" prompt is not built |
| §13 actionable notifications | Partly — the approvals desk approves/rejects inline from the bell |

So wave 1 is a **navigation and presentation** problem, not a messaging-engine problem. The engine
is there; it is unreachable at volume.

---

## Part 1 — The shell (§1)

### The problem

There is no desktop header. The wordmark lives inside the floating left sidebar, and the only
`<header>` in the app is `lg:hidden` — mobile only. The three centres (notifications, messenger,
history) are 40px circles stacked at the bottom-right corner. At a glance you cannot tell whether
anything is waiting for you.

### The shape

A new `client/src/components/TopBar.jsx`, ~52px tall, spanning the content pane (the sidebar is
`position: fixed` at 264px, so the bar starts after it and shifts with the collapse):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ☰  Colour Impressions   │  ⌕ Search…            │  💬 Messages 12  🔔 5  A │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left** — sidebar toggle, then the wordmark. The wordmark MOVES here from the sidebar; today it
  doubles as the collapse control, which is a hidden affordance. One home for identity, one explicit
  control for the rail.
- **Middle** — the global search field (§6), which is where a search field belongs and is currently
  absent from the shell entirely.
- **Right** — **Messages** and **Notifications** as *labelled* buttons carrying counts, not bare
  icons. This is the whole point of §1 and §7: `Messages 12` reads at three metres; a dot does not.
  Then the history button, then the user avatar (moved out of the sidebar footer).
- **Counts** are systemBlue for unread, amber when approvals are waiting, red when you are mentioned
  — the same priority ladder the row tints already use, so one visual language covers rows and shell.

### Responsive

One component, not two. Below `lg` it collapses to: toggle · wordmark · counts (icon + number,
labels dropped). **The existing mobile top bar is replaced by it**, not duplicated.

The parallel session's bottom-row docks are the open question here, and deliberately deferred to
build time: once their branch lands I will see whether the bottom row should remain as a
thumb-reachable duplicate on phones or give way to the top bar. Duplicating the same control top and
bottom is clutter; my expectation is the top bar wins and the bottom row is retired, but that is a
call to make against their final code, not against a guess.

### What this costs

Every page gains ~52px of chrome. `AppLayout`'s `<main>` already owns the page padding, so the bar
slots above `<Outlet />` with no page-level changes. Print is unaffected (`no-print`).

---

## Part 2 — The Messaging Centre (§2, §5, §6, §7)

### From a list to an inbox

Today the dock shows one flat conversation list, newest first. That is fine at 10 conversations and
useless at 500. Wave 1 restructures it into three stacked regions inside the same glass panel:

**1. Tabs (§2)** — a compact `SubTabs` row, each with a live count:

`All · Unread · Direct · Groups · Mentions · Records · System · Archived`

Mapping to what exists, so no tab is a fiction:
- **Direct** = `kind='dm'`, **Groups** = `kind='group'`, **Records** = `kind='record'|'job'`
  (this is the brief's "Tagged Tasks" — in this ERP a tagged thing is a record).
- **Mentions** = conversations containing a message that mentions me (`message_mentions`).
- **System** = conversations whose newest message is `kind='system'` (member added, group created).
- **Archived** = the one new piece of state, below.

**2. The list (§5)** — grouped, unread first, each row showing the conversation label, the last
message preview, its time, and an unread pill. Rows are already this shape; what changes is the
ordering rule (unread block first, then recent) and that the list is now filtered by tab.

**3. Filters (§6)** — a collapsible filter bar under the tabs: date presets (Today / Yesterday /
Last 7 days / range), sender, module, unread-only, attachments-only, mentions-me. Applied
server-side; the client never filters a truncated page.

### Search (§6)

The search field in the top bar searches conversations and message bodies, plus sender names, record
numbers and customer/product names via the record each thread hangs off.

**It uses `squashSql` from `search-key.js`, not `to_tsvector`.** Every other search box in this ERP is
space-insensitive by a tested twin contract — "2038" finds "20x38". A full-text search here would be
the one search box in the app that behaves differently, which is worse than a slower query.

### The unread counter (§7)

`Messages 12` in the top bar. **Clicking it opens the Unread tab when there is unread, and All when
there is not** — the brief's exact ask, and the right default: if 12 things are waiting, showing all
500 conversations is not an answer.

### Archived (§2)

One new column: `conversation_members.archived_at TIMESTAMPTZ`. Per-member, not per-conversation —
archiving is a personal filing decision, and one person tidying their inbox must not hide a live
discussion from the rest of the plant. Archived conversations leave every tab except Archived, and
return automatically on a new message unless muted.

---

## Part 3 — The Notification Centre (§11, §12)

The bell already has three sections (approvals desk, personal inbox, plant alerts) and the approvals
desk is already actionable. Wave 1 keeps that spine and makes it navigable:

**Categories**, derived from `notifications.kind` — no migration, because the kinds already exist:

| Category | From |
|---|---|
| Approvals | `xs_request`, `mgt_request` |
| Mentions | `mention` |
| Messages | `chat` |
| Decisions | `xs_decision`, `mgt_decision`, `ready_override` |
| Quality | `expiring`, `expired`, `revised`, `pending_internal`, `artwork_changed`, `master_changed` |
| Plant alerts | the dashboard alert feed (shortages, artwork, tooling) |

**Quality is real, and that is a late finding.** The parallel shade-card session is already writing
six notification kinds — expiry, revision, internal-approval-pending, artwork and master changes —
so §11's "Quality Alerts" has data behind it rather than being an empty tab. The category map must
therefore be built from a scan of every `kind:` the server actually emits, not from the kinds this
wave happens to know about, and it needs a default bucket so a kind added by a future session shows
up somewhere instead of vanishing from every tab. That default is `Other`, and a test asserts every
emitted kind maps to a named category — otherwise the next session's new notification silently
becomes unreachable.

The brief's remaining per-domain splits (Production / Procurement / Inventory) are **not** built in
wave 1: those alerts do not carry a domain yet, and inventing empty tabs is worse than showing the
categories that are genuinely populated. When they carry one, the tabs follow.

**Filters**: read/unread, category, date range, and "action required" (anything with a live pending
approval behind it). Same filter bar component as the messenger, so the two centres feel like one
system.

**Actionable (§13)** — extends the existing pattern rather than replacing it: every notification kind
gains a primary action where one is meaningful (`chat` → open thread, already; `mention` → open at
the message; approvals → approve/reject inline, already; `ready_override` → open the press board).

---

## Part 4 — Scale (§14)

Wave 1's job is to keep the shell honest at volume; it is not a rewrite of the transport.

- **Counts are aggregates, not fetched lists.** The tab counts come from one grouped query, not from
  loading each tab. A user with 4,000 conversations loads a page of 40.
- **The list paginates.** The dock currently fetches every conversation the user is a member of.
  Wave 1 adds keyset pagination (`?before=<id>`) with infinite scroll — required before any plant
  reaches hundreds of threads, which the record-thread wave makes likely fast.
- **Filters run in SQL**, so a filtered view never depends on how much the client happened to load.
- **Polling stays.** The existing 15s/5s/3s cadence is unchanged in wave 1. Realtime remains its own
  hardened phase: the API is serverless and cannot hold a websocket, so live push means the browser
  subscribing to Supabase directly with row-level-security policies written from scratch.

## Part 5 — Rollback (Anik's requirement: "if we don't like it we should be able to roll back")

A shell change is a matter of taste, and taste is judged after living with it for a day. So this
does not ship as a one-way door. Three layers, cheapest first:

### 1. A runtime switch — no deploy, whole plant, next page load

`company_profile.ui_shell` — `'topbar'` (new, default) or `'docks'` (exactly today's behaviour).
An admin flips it in Masters → Company. It is served on `/auth/me` alongside the user's grants, so
the shell reads it on load with no extra request.

**This is why the existing docks are NOT deleted.** The floating notification bell, chat dock and
history button stay in the codebase as the `'docks'` shell; the top bar is an alternative
presentation of the same components, not a replacement of them. Deleting the old shell would make
"we don't like it" cost a deploy, which is precisely what this requirement rules out.

The messenger's inbox changes (tabs, filters, pagination) are **independent of the shell setting** —
they improve the panel wherever it is anchored, and reverting the shell does not revert them. If the
inbox itself needs reverting that is layer 2.

### 2. `git revert` — one commit

Wave 1 lands as a single coherent commit so `git revert <sha>` undoes the whole thing in one step.
No cherry-picking a change out of a mixed commit.

### 3. Vercel instant rollback — seconds, no git

Promote the previous production deployment. Fastest possible recovery if something is wrong in a way
that cannot wait for a build.

### The property that makes all three safe

**Every schema change in this wave is additive and inert when unused.** `conversation_members.
archived_at` and `company_profile.ui_shell` are nullable/defaulted columns; if the code is reverted
and the columns stay, nothing reads them and nothing breaks. **There is no DB rollback step and no
down-migration** — which is the only way a rollback is genuinely safe on a live plant database.
Reverting code while a migration stands must never leave the app talking to a schema it does not
understand, and here it cannot.

## Out of scope for wave 1, stated so it is not mistaken for an omission

§3 compose-time audience prompt · §8 priority levels · §10's reactions, forward, copy link, pin,
mark-unread, resolve, edit · the per-domain alert categories · realtime.

## Risks

- **Shared-file collision.** Four files this design touches are mid-edit by another session. Wave 1
  does not start until that branch lands; the top bar is authored as a NEW file so the merge surface
  in `AppLayout.jsx` is a handful of lines.
- **A top bar changes every page.** It is 52px of vertical budget on screens the plant already reads
  at a distance. Verified in the running app at the desktop breakpoint before it ships.
- **Tab counts can lie if computed client-side.** They are server aggregates for exactly this reason.
- **Archived is per-member.** Anyone expecting "archive hides it for everyone" will be surprised;
  the copy says "Archive for me".
