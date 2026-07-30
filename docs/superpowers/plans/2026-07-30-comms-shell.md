# Comms Shell — Implementation Plan (wave 1)

> **For agentic workers:** you are in an ISOLATED WORKTREE on branch `comms-shell`, cut from
> `main@aa26e5e`. The repo root here is the worktree, NOT `~/Documents/CI ERP FInal/ci-erp`. Own only
> the files under your task. Spec: `docs/superpowers/specs/2026-07-30-comms-shell-design.md`.

**Goal:** Both communication centres become always-visible, labelled, counted controls in a real top
bar; the messenger becomes a filterable inbox that survives hundreds of conversations; notifications
gain categories. All of it reversible without a deploy.

**Rollback is a feature, not a postscript.** `company_profile.ui_shell` (`'topbar'` | `'docks'`)
selects the shell at runtime. The existing floating docks are **kept, not deleted** — they are the
`'docks'` shell. Every schema change is additive and inert when unused, so reverting code never
leaves the app talking to a schema it does not understand.

**Tech stack:** Express + pg (`q/one/tx` from `../db.js`), node:test, React 18 + Tailwind +
lucide-react + `client/src/components/ui.jsx` primitives.

**House rules:** comments explain WHY in the codebase's voice, never changelog. `tx` errors
`throw Object.assign(new Error(m), { status })`. Route errors `res.status(400).json({ error })`.

---

### Task 1: Schema + the rollback switch (ORCHESTRATOR)

`server/src/db.js` and `supabase/migrations/0014_comms_shell.sql`:

```sql
-- Personal filing, not a plant-wide hide: one person tidying their inbox must
-- never remove a live discussion from everyone else's.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
-- Which shell the app renders. 'docks' is exactly today's floating bell/chat/
-- history; 'topbar' is the new header. A shell is a matter of taste and taste is
-- judged after a day of using it, so switching back must not need a deploy.
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS ui_shell TEXT NOT NULL DEFAULT 'topbar';
```

`server/src/auth.js`: `/auth/me` returns `ui_shell` (read from `company_profile` LIMIT 1, fall back
to `'topbar'` when the row is missing). One extra column on a query that already runs.

### Task 2: Server — inbox tabs, filters, pagination, notification categories (server agent)

**Files:** `server/src/routes/chat.js`, `server/src/routes/notifications.js`, CREATE
`server/src/notify-categories.js` + `notify-categories.test.js`.

1. **`GET /chat/conversations`** gains query params, all applied in SQL (never client-side):
   - `tab` = `all|unread|dm|group|mention|record|system|archived`
   - `q` — free text over conversation label + message bodies + sender names. **Use `squashSql` from
     `../search-key.js`, NOT `to_tsvector`** — every other search box in this ERP is
     space-insensitive by a tested twin contract, and this must not be the one that differs.
   - `from` / `to` (ISO dates), `sender` (user id), `entity` (module filter), `unread=1`,
     `attachments=1`, `mentions=1`
   - `before` (keyset pagination on conversation id) + `limit` (default 40, max 100)
   - Response becomes `{ rows, counts, next }` where `counts` is `{all, unread, dm, group, mention,
     record, system, archived}` from ONE grouped query — never by loading each tab.
   - `archived` semantics: `archived_at IS NOT NULL` for MY membership row. Every other tab excludes
     archived. A new message clears `archived_at` unless the member is muted.
   - **The existing unfiltered call must keep working** — with no params the response's `rows` is the
     same list in the same order as today, so the current dock does not break mid-deploy.
2. **`POST /chat/conversations/:id/archive`** `{ on }` — sets/clears my `archived_at`. Audited.
3. **`notify-categories.js`** — pure: `categoryOf(kind)` → `approvals | mentions | messages |
   decisions | quality | alerts | other`, plus `CATEGORIES` (ordered, with labels).
   **A `kind` the map does not know MUST fall into `other`, never vanish.** The test asserts every
   `kind:` string the server actually emits maps to a named category — grep
   `server/src/routes/*.js server/src/helpers.js` for `kind: '...'` and assert each one. There are
   already six kinds from a parallel shade-card wave (`expiring`, `expired`, `revised`,
   `pending_internal`, `artwork_changed`, `master_changed`) — they belong to `quality`.
4. **`GET /notifications`** gains `category`, `unread=1`, `from`/`to`, `action=1` (has a live pending
   approval behind it), `before`/`limit`; returns `{ rows, counts, next }` in the same shape as the
   conversation list so one client filter component serves both.

VERIFY: `cd server && node --test src/notify-categories.test.js` green; `node --test src/*.test.js`
all green; `node --check` each edited file. Then re-read: confirm a no-param
`GET /chat/conversations` still returns today's shape.

### Task 3: Client — TopBar (client agent A)

**Files:** CREATE `client/src/components/TopBar.jsx` ONLY.

Per spec Part 1. `~52px`, `glass`, `sticky top-0 z-30`, `no-print`. Layout:
`[toggle] [wordmark] | [search] | [Messages n] [Notifications n] [History] [avatar]`.

- Props: `{ onToggleSidebar, collapsed, unread, approvals, mentioned, onOpenMessages, onOpenNotifications, onOpenHistory, user, onSignOut, q, onSearch }`. It renders and reports; it owns no data fetching — AppLayout already polls those counts for the bell.
- Counts are **labelled** buttons: `Messages 12`, not a bare dot. Below `lg` the labels drop, the
  numbers stay. Count colour: systemBlue unread → amber when approvals waiting → red when mentioned
  (the same ladder the row tints use).
- `Messages` fires `onOpenMessages('unread')` when `unread > 0`, else `onOpenMessages('all')`.
- Keyboard: `/` focuses search, `g m` opens messages, `g n` notifications (§15 keyboard-friendly).
- Avatar menu holds the user + sign-out (moving out of the sidebar footer).

VERIFY: `npx esbuild client/src/components/TopBar.jsx --loader:.jsx=jsx --jsx=automatic --outfile=/dev/null`.

### Task 4: Client — messenger inbox (client agent B)

**Files:** `client/src/components/Chat.jsx` ONLY.

- Tabs row (`SubTabs`) driven by `counts` from the server; default tab `unread` when opened with
  `'unread'`, else `all`.
- Collapsible filter bar: date presets + range, sender, module, unread-only, attachments-only,
  mentions-me. Filters go to the server; the client never filters a truncated page.
- Infinite scroll using `next` (keyset), replacing today's fetch-everything list.
- Archive/unarchive on a conversation row (swipe-free: a row action), copy says **"Archive for me"**
  because it is per-member.
- Accept an imperative open: the existing `ci-chat-open` gains an optional `tab` in its detail.
- **Do not change the thread view.** This task is the list only.

VERIFY: esbuild the file. Re-read and confirm the three existing `ci-chat-open` paths
(`conversationId`, `jobCardId`, `entity`) still work and the `#`/`@` pickers are untouched.

### Task 5: Mount + shell switch + Masters setting (ORCHESTRATOR)

- `client/src/components/AppLayout.jsx`: read `ui_shell` from `auth.user`; render `<TopBar/>` when
  `'topbar'`, the existing floating docks when `'docks'`. **Both paths keep working.** The mobile
  `lg:hidden` bar is replaced by TopBar in `'topbar'` mode only.
- `client/src/pages/Masters.jsx`: the Company tab gains a shell picker (Top bar / Floating docks)
  with copy naming it a display preference that takes effect on next load.
- Fix the stale `// Pureflix Notification Center` comment — that product is unrelated to this ERP.

### Task 6: Verify + ship gate (ORCHESTRATOR)

`npm run verify`; adversarial review; browser check of **both** shells and of the flip between them;
UAT-scoped data only. **Do not merge to main until the `shade-card-simplification` branch lands** —
`AppLayout.jsx` is dirty there and the merge is deliberate, not accidental.
