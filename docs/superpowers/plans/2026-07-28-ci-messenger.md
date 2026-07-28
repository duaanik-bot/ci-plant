# CI Messenger Implementation Plan

> **For agentic workers:** Each task names its exact files. Build agents own ONLY the files listed under their task — never touch shared files (db.js, app.js, AppLayout.jsx, Production.jsx); the orchestrator wires those. Follow the JSON contracts EXACTLY — server and client are built in parallel against this document.

**Goal:** In-app messenger (CI Messenger) — DMs, group rooms, one thread per job card; text, hold-to-record voice notes, file/photo sharing, `#` job tagging; unread badges and bell integration. Spec: `docs/chat-messenger-plan.md`.

**Architecture:** 5 new tables (attachments stored as BYTEA in Postgres — zero new infrastructure, works identically on local embedded PG and Supabase prod; client compresses images before upload so blobs stay small). One new Express route file. One new client component file (floating chat dock next to the bell). Polling transport (list 15s closed / 5s open, thread 3s incremental) matching the app's refresh idiom; Supabase Realtime stays a later upgrade.

**Tech stack:** Express + pg (ESM, `q/one/tx` from `../db.js`), multer (already a dependency — copy the pattern in `server/src/routes/import.js`), React 18 + Tailwind + lucide-react + the primitives in `client/src/components/ui.jsx`, MediaRecorder API.

**House rules for both agents:**
- Comments explain *why*, matching the codebase voice. No "added by" / changelog comments.
- Errors inside `tx`: `throw Object.assign(new Error(msg), { status: 409 })`. Route-level: `res.status(400).json({ error })`. Central handler exists.
- `req.user` = `{ id, name, role }` from the JWT. Per-user grants are re-read from DB when they matter.
- Names denormalize as TEXT next to the id (`sender_name`), like `requested_by`/`requested_by_id` elsewhere.
- Audit via `audit(entity, id, action, detail, qc, req.user.name)` from `../helpers.js`; notifications via `notify(userIds, {kind,title,body,link,refTable,refId}, qc)`.

---

## Schema (Task 0 — orchestrator, already done when agents start)

Tables exist in local DB and in `supabase/migrations/0008_chat_messenger.sql`:

```sql
conversations(id, kind CHECK dm|group|job, name, dm_key UNIQUE, job_card_id UNIQUE→job_cards ON DELETE CASCADE,
              auto_add INT DEFAULT 0, created_by INT, created_at)
conversation_members(conversation_id→conversations CASCADE, user_id→users CASCADE, role CHECK member|admin,
              last_read_message_id INT, last_seen_at TIMESTAMPTZ, typing_at TIMESTAMPTZ,
              muted INT DEFAULT 0, joined_at, PK(conversation_id,user_id))
messages(id, conversation_id→conversations CASCADE, sender_id→users, sender_name TEXT,
              kind CHECK text|voice|file|system, body TEXT, created_at, removed_at TIMESTAMPTZ)
message_attachments(id, message_id→messages CASCADE, file_name, mime, size_bytes INT,
              duration_secs DOUBLE PRECISION, data BYTEA)
message_job_tags(message_id→messages CASCADE, job_card_id→job_cards CASCADE, PK(both))
```

Seeded groups: **Plant Floor** (`auto_add=1`, every active user; admins = role-admin users) and **Management** (members = `is_management=1` users). New users are added to `auto_add` groups at user-creation (orchestrator wires this into `auth.js`).

Access rule (the ONE security rule, enforced on EVERY endpoint): `kind='job'` conversations are open to every signed-in user (first touch auto-joins); `dm`/`group` require an existing membership row. **Never trust a conversation id from the client without this check — attachments included.**

---

## JSON contracts (both agents build to these, verbatim)

`ConversationListItem`:
```json
{ "id": 1, "kind": "dm|group|job", "name": null, "label": "Dharminder",
  "job_card_id": null, "auto_add": 0, "my_role": "member|admin", "muted": 0,
  "members": 5, "unread": 3,
  "last_message": { "id": 9, "kind": "text", "body": "…", "sender_id": 2, "sender_name": "Shiv",
                    "created_at": "…", "removed_at": null } }
```
`label`: dm → the OTHER user's name; group/job → `name`. `unread` = count of messages with `id > COALESCE(last_read_message_id,0)` and `sender_id <> me` and `removed_at IS NULL`.

`Message`:
```json
{ "id": 9, "conversation_id": 1, "sender_id": 2, "sender_name": "Shiv", "kind": "text|voice|file|system",
  "body": "…", "created_at": "…", "removed_at": null,
  "attachments": [{ "id": 4, "file_name": "sheet.jpg", "mime": "image/jpeg", "size_bytes": 812345, "duration_secs": null }],
  "job_tags": [{ "job_card_id": 7, "jc_number": "CI-JC-0002" }] }
```
`MemberState`: `{ "user_id": 2, "name": "Shiv", "role": "member", "last_read_message_id": 9, "typing": false }`
(`typing` = `typing_at` within the last 6 seconds, computed server-side.)

---

### Task 1: Pure rules — `server/src/chat-rules.js` + `server/src/chat-rules.test.js` (server agent)

Style-match `server/src/approvals.js` / `approvals.test.js` (node:test + assert/strict). Functions and REQUIRED behaviors (each gets tests, including the listed edge cases):

- `dmKey(a, b)` → `'dm:<lowId>:<highId>'`; `null` when ids are equal / not positive ints.
- `canSee(conv, membership)` → `true` for `kind==='job'`; otherwise `!!membership`.
- `removalError(message, userId, now = new Date())` → `null` when `userId === sender_id` AND `now - created_at <= 10min` AND not already removed; else the refusal message (distinct messages for "not yours", "older than 10 minutes", "already removed").
- `attachmentError({ mime, size_bytes, duration_secs })` → `null` or message. Allow: `image/*`, `audio/*`, `video/mp4`, `application/pdf`, xlsx/docx/csv (`application/vnd.openxmlformats-officedocument.*`, `text/csv`), `text/plain`. Caps: 4 MB (Vercel serverless body limit — revised down from 15 MB in review); voice (`audio/*` with `duration_secs`) ≤ 180 s. SVG refused (stored-XSS surface).
- `msgKind(mime, duration_secs)` → `'voice'` when `audio/*` && duration provided, else `'file'`.
- `notifyTargets(members, senderId, now = new Date())` → ids of members who are NOT the sender, NOT `muted`, and whose `last_seen_at` is null or older than 120 s (someone watching the thread doesn't need a bell).
- `previewText({ kind, body, file_name, removed_at })` → `'Message removed'` when removed; `'Voice note'` for voice; `file_name` for file; else body trimmed to 80 chars with `…`.

### Task 2: Routes — `server/src/routes/chat.js` (server agent)

Import: `Router` from express; `q, one, tx` from `../db.js`; `audit, notify` from `../helpers.js`; multer (memory storage — copy `import.js`); everything from `../chat-rules.js`. Export default router. All endpoints assume `requireAuth` ran (mounted under `/api` after it).

Shared helpers inside the file:
- `membership(convId, userId)` → member row or null.
- `ensureAccess(convId, userId)` → `{ conv, member }`; 404 unknown conv; for `job` kind with no member row, INSERT one (auto-join, `ON CONFLICT DO NOTHING`) and return it; 403 for dm/group non-members.
- `fullMessage(id)` → `Message` contract shape (attachments meta WITHOUT `data`; job tags joined to `jc_number`).
- `pushChatNotification(qc, conv, message, targets)` → for each target: DELETE that user's unread notifications where `kind='chat' AND ref_table='conversations' AND ref_id=conv.id`, then `notify([id], { kind:'chat', title, body, link:'/chat/'+conv.id, refTable:'conversations', refId:conv.id }, qc)`. Title: `` `${message.sender_name} — ${label}` `` (label per contract); body = `previewText(message)`.

Endpoints:
1. `GET /chat/users` — `SELECT id, name, role FROM users WHERE active=1 AND id<>$me ORDER BY name` (the admin-only `/users` route can't serve the picker).
2. `GET /chat/jobs` — open work for the tag picker: `SELECT jc.id, jc.jc_number, p.name AS product_name, jc.status FROM job_cards jc JOIN products p ON p.id=jc.product_id WHERE jc.status IN ('open','in_progress') ORDER BY jc.id DESC LIMIT 300`.
3. `GET /chat/conversations` — my list per contract, ordered by latest activity (last message id desc, empty conversations last by created_at desc). One or two batched queries — no per-conversation loop.
4. `POST /chat/conversations` — `{kind:'dm', user_id}`: validate target exists+active; `dmKey`; find by `dm_key` else create + both members (`ON CONFLICT (dm_key) DO NOTHING` then re-select — races are real on serverless). `{kind:'group', name, member_ids[]}`: name required non-blank ≤ 60 chars; creator becomes `admin`; de-duped member_ids get `member` rows; a `system` message "<creator> created the group". Returns `ConversationListItem`.
5. `GET /chat/conversations/:id` — detail + `MemberState[]`.
6. `GET /chat/conversations/:id/messages?after=ID` — `ensureAccess`; no `after` → latest 100 (return ascending); with `after` → everything newer. Response `{ messages, members }` (MemberState included every poll — it carries seen/typing). Side effect: set my `last_seen_at=now()`.
7. `POST /chat/conversations/:id/messages` — `{ body, job_tags:[] }`; body required non-blank ≤ 4000 chars. In `tx`: insert message (kind 'text'); insert de-duped tag rows (validate each id exists — skip unknowns); for each tagged job `audit('job_card', jcId, 'chat_mention', '<sender>: <preview> (<label>)', qc, name)`; compute `notifyTargets` from member rows; `pushChatNotification`. Returns `fullMessage`.
8. `POST /chat/conversations/:id/attachments` — multer single `file`; fields `body?`, `duration_secs?`, `job_tags?` (JSON array string). `attachmentError` → 400. Insert message (`msgKind`) + attachment (`data` = `req.file.buffer`) + tags/audit/notify identical to (7). Returns `fullMessage`.
9. `GET /chat/attachments/:id` — join to message+conversation, `ensureAccess`, then send bytes: `res.set('Content-Type', mime).set('Content-Disposition', 'inline; filename="…"').send(row.data)`. **Never** include `data` in any list query.
10. `POST /chat/conversations/:id/read` — `{ message_id }`; advance-only (`GREATEST(COALESCE(last_read_message_id,0), $id)`); also mark my unread `chat` notifications for this conversation read.
11. `POST /chat/conversations/:id/typing` — set my `typing_at=now()`; `{ ok: true }`.
12. `POST /chat/messages/:id/remove` — `removalError` gate; set `removed_at=now()`, null the body, DELETE its attachment rows (blob gone for good); `{ ok: true }`.
13. `POST /chat/conversations/:id/members` — `{ add:[], remove:[] }`; group conversations only, caller must be conversation `admin` (or role-admin user); never remove the last admin; a `system` message per change ("<actor> added <name>"). Returns updated detail.
14. `GET /job-cards/:id/chat` — find-or-create the job thread (`kind='job'`, `name=jc_number`, unique on `job_card_id` — `ON CONFLICT DO NOTHING` + re-select), auto-join caller, return `ConversationListItem`.
15. `GET /job-cards/:id/chat-mentions` — `{ total, threads:[{ conversation_id, label, count }] }` from `message_job_tags` joined through messages→conversations (job thread itself included).

### Task 3: Client — `client/src/components/Chat.jsx` (client agent)

One file, default export `ChatDock`. The orchestrator mounts `<ChatDock />` in AppLayout next to the bell. Reuse `api, auth, fmt` from `../api.js`, primitives from `./ui.jsx` (`Button, Input, Textarea, Checkbox, SearchInput, useToast, searchText`), lucide icons. Visual language: the app's Liquid-Glass (`glass` class, systemBlue `#007AFF` accents, rounded-[22px] panels, `animate-liquidPop`) — study `NotificationBell` in `AppLayout.jsx` and match it; the dock must feel like the bell's sibling.

Layout:
- Floating button `fixed bottom-[68px] right-4 z-40` (bell owns bottom-4), `MessageCircle` icon, unread-total badge (blue, `99+` cap).
- Panel `w-[420px] max-h-[78vh]` glass, three views: **list**, **thread**, **new** (DM picker + group creator). Full-width sheet under `sm:` breakpoint (operators are on phones).

Behaviors (all required):
- **Polling:** conversations every 15 s always (drives the badge), 5 s while panel open; open thread every 3 s with `?after=<lastId>`; skip all polls when `document.hidden`. Merge incrementals by id (no duplicates on race).
- **List view:** avatar initial, label, `previewText`-style last line (client renders from `last_message`), time (`fmt.dt`), unread pill; job threads get a small `Wrench`/JC affordance; "New" button.
- **New view:** search users (`searchText`) → click = open/create DM. "New group": name + member checkboxes → create.
- **Thread view:** header (back, label, member count → members panel for groups; admins add/remove members there). Messages: mine right in the blue pill gradient, others left on white/70 glass; sender name above in groups; day separators; `system` messages centered muted; tombstone for `removed_at` ("Message removed"); long-press/hover ⋯ → Remove (only own, ≤10 min — hide otherwise). Job tag chips render inline (`#CI-JC-0002`) → `navigate('/production')` … use `useNavigate`, and close the panel.
- **Seen/typing:** in DMs show "Seen" under my newest message when the other member's `last_read_message_id >= that id`; show "<name> is typing…" from `MemberState.typing`.
- **Read tracking:** when the thread is open and messages arrive/render, POST `/read` with the newest visible id (throttle: only when it advances).
- **Composer:** auto-growing Textarea (1–4 rows), Enter sends / Shift+Enter newline; POST typing throttled to once per 3 s while keys land. Paperclip → hidden file input. `#` in the text opens the job picker (fetch `/chat/jobs` once, filter with `searchText`); picking inserts `#CI-JC-XXXX` into the text AND records the id in a pending-tags set sent as `job_tags`; chips shown above the composer with ✕.
- **Attachments out:** images > 1 MB are compressed client-side (canvas, max edge 1920, JPEG q 0.82) before upload via `api.upload('/chat/conversations/'+id+'/attachments', file, { body, duration_secs, job_tags: JSON.stringify([...]) })`.
- **Attachments in:** metadata only arrives; bytes are fetched lazily with the Bearer header (plain `<img src>` CANNOT auth):
  ```js
  const blobUrl = async id => { const r = await fetch(`/api/chat/attachments/${id}`, { headers: { Authorization: `Bearer ${auth.token}` } }); return URL.createObjectURL(await r.blob()); };
  ```
  Cache object URLs in a `useRef(new Map())`; revoke on unmount. Images render as tap-to-full thumbnails (max-h-48); voice renders a custom player (play/pause button, progress bar from `timeupdate`, `m:ss` duration); other files a row (icon, name, size, download on tap via anchor+objectURL).
- **Voice recording:** mic button `onPointerDown` starts — `getUserMedia({audio:true})`, `MediaRecorder` with the first supported of `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4` (iPhone Safari). While recording: red pulsing timer replaces the composer, live `m:ss`, cap 180 s (auto-stop+send). `onPointerUp` = stop & send (`duration_secs` from the timer); slide/leave the button or Escape = cancel (discard). Mic permission denied → toast, no crash.
- **External open:** `window.addEventListener('ci-chat-open', e)` where `e.detail = { conversationId? , jobCardId? }` — open dock to that thread (jobCardId → `GET /job-cards/:id/chat` first). Cleanup on unmount.
- **Empty/error states:** empty list copy ("No conversations yet — start one"), thread fetch failures keep prior messages (silent `catch`), toasts only on user-initiated failures.

### Task 4: Wiring (orchestrator, shared files)

- `server/src/app.js`: import + mount chat router.
- `server/src/auth.js`: on user create, add membership rows for `auto_add` conversations.
- `client/src/components/AppLayout.jsx`: render `<ChatDock />`; bell special-case — `kind==='chat'` notifications dispatch `ci-chat-open` with `ref_id` instead of `nav(link)`.
- `client/src/pages/Production.jsx`: "Discuss" (MessageCircle) affordance per job card dispatching `ci-chat-open { jobCardId }`.

### Task 5: Verification (orchestrator)

`npm run verify` (baseline check + 321+ tests + client build); adversarial review workflow (security/IDOR, serverless-correctness, React quality); browser e2e on the `ci-erp-notify-verify` launch config: two logins chatting, job tag→thread, attachment upload/render, unread badge, bell handoff, UAT-scoped data cleaned after.
