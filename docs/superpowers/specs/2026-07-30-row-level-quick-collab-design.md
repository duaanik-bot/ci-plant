# Row-level quick collaboration — Design

One button on every row. Hold it and talk. Tap it and get the four sentences the plant actually
says, plus the people who need to hear them.

## The objective, restated

An operator standing at a die-cutting machine has found a problem with one specific job. Today he
can say so — the comment cell shipped in `aa26e5e` opens a full messenger on that record — but the
path is *press cell → dock opens → find the mic → hold*. Four movements, on a phone, in a plant.
He types nothing and tells nobody, and the job sits.

This design closes the distance between noticing and saying, without building a second messenger.

## Decisions taken (Anik, 2026-07-30)

1. **Device is mixed** — office on desktop, floor on phone and tablet. One control that adapts:
   hold-to-record on touch, click-and-hold or click-toggle on desktop.
2. **Quick phrases carry a reason code, and nothing more.** They post text plus a machine-readable
   reason so "what is blocking the plant" becomes answerable. They do **not** open approvals, flag
   tooling, or move readiness. That collision is deliberately avoided.
3. **Behaviour is option C** — hold to talk, tap for the sheet, and the sheet's mic records too. The
   gesture serves the operator who learns it; the sheet serves the one who never does.
4. **Station teams get seeded**, so `@printing` and `@die-cutting` are mentionable.

## What already exists and is inherited, not rebuilt

Nothing in this list is being written again. This design is a shortcut onto machinery that works.

- `conversations (entity, entity_id)` with a unique partial index — any of twenty record types
  carries a thread. `job_card_id` is legacy and is **not** a second address.
- `ThreadCell` on thirteen surfaces: grey bubble / blue count / red `@` badge, in that priority.
- The dock's recorder: `getUserMedia`, a mimetype fallback chain, a guard against a recording whose
  press was already released, Escape-to-cancel, discard-on-unmount.
- `mention_targets` (users and teams in one namespace) and `message_mentions` fan-out.
- Unread summaries batched once per page via `GET /threads/summary`; `ci-thread-read` broadcast.
- Bell notifications, tombstones, the 120-second watching window, the one-bell-per-conversation rule.

## A. The control

### A1. Two gestures on one target

`ThreadCell` gains behaviour; it does not gain size, and no table gains a column. Idle appearance is
unchanged, because this cell repeats on thousands of rows and an empty state that shouts is noise.

- **Hold** — `touchstart` on touch, `mousedown` on desktop, both qualified by a **350 ms** timer.
  Recording begins when the timer fires, not on press, so a slow tap never records by accident. The
  cell is replaced in place by a red pill: `● 0:04 — release to send`.
- **Tap** — press and release inside 350 ms opens the sheet.
- **Cancel** — Escape, or dragging the pointer more than 40 px off the button. Both discard the blob
  and free the microphone.

On desktop the same hold works with the mouse held down; a click that starts a recording and a
second click that ends it is also accepted, because holding a mouse button for a 30-second note is
unpleasant. Touch does not get the toggle — a stray tap leaving a hot mic in a plant is worse than
the inconsistency.

### A2. The sheet

Anchored under the cell, dismissed on outside click or Escape. Four regions, top to bottom:

1. **Mic** — full-width, hold or click-toggle, identical behaviour to A1.
2. **Quick message** — the phrase chips for this record (§B2). One tap sends.
3. **Tell someone** — up to four suggested handles (§B3). Tapping one arms it; the next phrase or
   voice note carries the mention. Tapping a second adds it.
4. **Open full thread →** with the message count, which does exactly what the cell does today.

A chip alone sends immediately. A handle alone sends nothing — a mention with no message is not a
message.

## B. What is new

### B1. One column

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reason TEXT;
```

A quick phrase is an ordinary `kind='text'` message whose `body` is the sentence a human reads and
whose `reason` is the code a query reads. Voice notes and typed messages are untouched and leave
`reason` NULL. Nothing else in the chat schema changes.

The sentence is stored, not derived from the code at render time. If the wording of a phrase is
edited next year, history must keep saying what the operator actually said.

### B2. The phrase registry — twinned, with a parity test

There is no `shared/` directory in this repo, and the registry this would have mirrored,
`server/src/record-entities.js`, is **server-only** — the client never imports it. What actually
holds its two sides together is `record-entities.test.js`, which re-reads `db.js` and `modules.js`
and re-asserts every row. Copying that is truer to the codebase than inventing a shared module.

So: `server/src/quick-replies.js` is the validator's truth, `client/src/quick-replies.js` renders the
chips, and a parity test asserts the two are identical (§E). Keyed by entity, with a floor section as
an override. The universal set is appended to every context.

| Context | Phrases (code → sentence) |
|---|---|
| Universal | `approval_required` → Approval required · `machine_down` → Machine down · `awaiting_material` → Waiting for material |
| `printing` | `plate_not_received` → Plate not received · `plate_cancelled` → Plate cancelled · `shade_issue` → Shade/ink issue |
| `cutting` | `board_issue` → Board issue · `board_short` → Board short |
| `die_cutting` | `die_not_received` → Die not received · `die_broken` → Die broken |
| `coating`, `lamination`, `foiling`, `embossing` | `material_issue` → Material issue · `job_on_hold` → Job on hold |
| `purchase_order` | `vendor_delay` → Vendor delay · `rate_mismatch` → Rate mismatch |

Sections not listed get the universal set alone. Codes are stable identifiers and are never reused
for different meanings.

The section comes from the page, passed as an optional `section` prop; the cell does not infer it
from the URL, because Live Floor rows and Section station tables render the same cell from different
routes. Where no section is passed, the entity's set applies.

### B3. Suggestion, not automation

At most four handles, in this priority, first four win:

1. **Already in this thread** — distinct senders of the last twenty messages, most recent first. The
   person you are answering is the person you most likely want.
2. **The station's team** — `@printing`, `@die-cutting`, … (§B4).
3. **The record's owner** — the job card's planner, the PO's raiser, the requisition's requester.
4. **`@management`** — offered only when the armed phrase is `approval_required`, because that is the
   only one of these sentences addressed at a decision rather than at a shift.

Nothing is pre-armed. A suggestion the operator did not tap does not become a mention; a button that
silently pages the MD would be untapped within a week.

### B4. Station teams, seeded once

There are no per-station teams today — the seeded handles are `@planning`, `@production`,
`@quality`, `@dispatch` and `@management`, each backed by a role or the `is_management` flag.
`@printing` cannot be suggested if it does not exist.

Seed one team per `SECTION_META` key from the `users.sections` JSONB grant that already governs
station-scoped logins. This obeys the rule the collaboration design set: teams are seeded from grants
that **actually exist**, never invented, and membership is then **explicit and editable** rather than
re-derived — so moving someone between stations stays a decision, not a side effect.

A section with no granted users seeds an empty team. It is still created, so an admin can populate
it, but an empty team is not offered as a suggestion — suggesting a handle that mentions nobody is
the exact failure the collaboration design refused for `@procurement`.

### B5. One server call

```
POST /threads/:entity/:id/quick
body: { kind: 'text'|'voice', body?, reason?, mentions?: string[] }
```

Upserts the conversation, inserts the message, expands and fans out mentions, returns the updated
summary for the cell to repaint. Voice posts the blob on the same call.

It is one call because the row control must work on records nobody has ever discussed. Create-then-post
from the client is two round-trips that race: two operators tapping the same untouched row at the same
moment would both attempt an insert, and the unique partial index on `(entity, entity_id)` means one
gets a constraint violation instead of a message. The upsert resolves that server-side with
`ON CONFLICT DO NOTHING` followed by a read.

`reason` is validated against the registry. An unknown code is a 400, not a stored value — a typo'd
code silently persisted would corrupt the blocker query this feature exists to enable.

`entity` is validated against the existing entity registry, exactly as `GET /threads/:entity/:id`
already does. This endpoint sits behind the same `requireAuth` as every other `/api` route.

## C. Code health

The recorder lives inside `Chat.jsx`, which is about 1,100 lines. Two callers cannot share it where
it is.

Extract `useVoiceRecorder()` — permission, mimetype fallback, the released-before-resolve guard,
timer, cancel, discard-on-unmount — into `client/src/hooks/useVoiceRecorder.js`. `Chat.jsx` and the
row control both consume it. Duplicating that guard is how one of the two paths ends up leaving an
unattended hot microphone.

This is the only refactor. Nothing else in `Chat.jsx` moves.

## D. Failure behaviour

- **A chip that fails to post** reverts and toasts. Cheap to retry; the operator taps again.
- **A voice note that fails to upload is kept, not discarded.** The pill becomes
  `Tap to retry — 0:18` and holds the blob in memory until sent or explicitly dismissed. An operator
  who spoke for twenty seconds over machine noise and lost it will not use this button again.
- **Microphone denied** — one toast naming the fix, and the sheet still opens with chips usable. Voice
  being unavailable must not take the phrases down with it.
- **Offline** — the existing dock behaviour applies; no new offline queue is introduced.

## E. Testing

Server:
- Quick endpoint upserts idempotently — two concurrent posts to an untouched record yield one
  conversation and two messages.
- Unknown `reason` → 400; unknown `entity` → 400.
- Mention fan-out expands a team handle to its members and writes one `message_mentions` row each.
- A mentioned user gets the mention notification instead of, not in addition to, the chat one — the
  existing rule must survive this new sender.

Shared:
- **Registry parity twin test** — every code in the client's phrase list exists in the server's
  validator and vice versa, so the two cannot drift. Same idiom as the `searchKey` and `board-math`
  twins.

Client:
- 350 ms threshold: a 200 ms press opens the sheet and records nothing; a 500 ms press records.

## Explicitly deferred, with reasons

- **Reason codes driving workflow** — Anik's call. `approval_required` does not open an approval,
  `plate_not_received` does not flag tooling. The approvals, readiness and tooling systems all shipped
  within the last week; wiring a new sender into them in the same fortnight risks double-firing
  notifications on a live plant. The codes are chosen to line up with those states so the wiring is a
  follow-up, not a redesign.
- **Voice transcription** — not asked for, and Hindi/Punjabi plant-floor audio is not a solved problem
  worth betting this feature on.
- **Realtime** — unchanged from the collaboration design: serverless functions cannot hold a
  websocket. The 3-second poll repaints the cell.
- **Editing the phrase list from the UI** — a registry file edit is a deploy, which is the right
  friction for vocabulary that queries depend on.

## Risks I am watching

- **Accidental recordings while scrolling a table on a phone — and this one is not hypothetical.**
  The concurrent mobile/tablet design (`2026-07-30-mobile-tablet-ui-design.md`) makes every table a
  **horizontal scroller below `lg`** with the first column pinned. The `ThreadCell` sits inside that
  scroller, so a finger that lands on the cell and swipes sideways to read the rest of the row is
  indistinguishable, for 350 ms, from a press-and-hold.

  Mitigation is therefore stricter than a generic drag-cancel: the timer is armed on `touchstart` but
  **disarmed by the first `touchmove` that exceeds 10 px on the X axis**, before the 350 ms elapses,
  and never fires while the ancestor scroller reports a non-zero `scrollLeft` delta. Vertical
  movement keeps the 40 px threshold. If the floor still reports stray notes, the touch path falls
  back to tap-sheet-only and the hold gesture survives on desktop alone.

  **This design and that one must land in a known order.** If the mobile pass ships first, this must
  be built against the scroller. If this ships first, the mobile pass must not wrap tables in a
  scroller without re-testing the hold.
- **Chip fatigue.** Six phrases at a station is a menu; twelve is a wall. The per-section sets are
  capped at three plus the three universal, deliberately.
- **A quick phrase becoming the whole message.** "Board issue" with no detail is barely better than
  silence. Mitigation is that the chip sends immediately but the thread stays open underneath, and
  the voice button sits directly above the chips — the faster path is the richer one, by design.
- **Empty station teams** suggesting handles that reach nobody. Guarded in §B4, but it depends on
  `users.sections` being populated, which is true for station logins and not for admins.

## Shipping

One deploy. The migration is one nullable column; the rest is additive. Gate is the established one:
`npm run verify`, adversarial review, browser verification against the real app at a desktop
breakpoint **and** a phone viewport (this is the first control designed for touch first), prod backup,
migration applied to Supabase before the code, clean-worktree verify of the exact commit, then push.
