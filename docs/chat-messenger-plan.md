# CI Messenger — In-App Chat Design Plan

*Drafted 2026-07-28. Status: design approved-pending-Anik, not yet built.*

## What this is

An internal messenger inside the ERP, so plant communication about jobs stays
**next to the jobs**. The driving example: printing hits a problem at 11pm →
the operator opens chat, messages the floor manager or plant head, **tags the
job card**, attaches a photo of the sheet, or just holds the mic button and
says it. No WhatsApp screenshots, no lost context — the conversation carries a
live link to CI-JC-0123 and becomes part of the plant's record.

Three capabilities, in his words: **chat**, **voice messages**, **file
sending** — plus **job tagging** so a message can point at the work it is
about.

## What we already have to build on

- **Notification system (shipped 2026-07-28):** the bell polls
  `/notifications` every 30s; `notify()` fans out rows per user. Chat rides
  the same rails — an offline recipient's bell rings with a deep link into the
  conversation.
- **Users with roles + per-user flags:** recipient picker comes free
  (`/users` list). "Message the floor manager / plant head" = DM to those
  logins (Plant, Planning, MD…).
- **Supabase (prod DB) + Vercel:** Supabase **Storage** handles voice + file
  blobs (nothing binary in Postgres); the existing Express API handles the
  rest. No new infrastructure, no new vendor.
- **Timeline/audit discipline:** a job-tagged message writes an `audit` row on
  the job card, so the Universal Timeline shows "chat: issue raised at
  printing" alongside everything else.

## Design decisions (made, with reasons)

1. **Transport = polling first, realtime later.** Phase 1 polls the
   conversation list every 10s and the open thread every 4s — identical to how
   the rest of the app refreshes, zero new moving parts, works on the plant's
   spotty Wi-Fi. Phase 3 upgrades to Supabase Realtime (the DB already lives
   there) so messages arrive instantly; the polling code stays as fallback.
2. **Storage = Supabase Storage, private bucket `chat-media`.** Uploads go
   through our API (multer is already a dependency) → API pushes to the bucket
   with the service key → messages store only the object path. Downloads are
   served through an authenticated API redirect to a short-lived signed URL,
   so files are exactly as private as the ERP login. Caps: 4 MB per file
   (Vercel's serverless body limit is ~4.5 MB — anything bigger would only
   ever work on local dev),
   images/PDF/audio/video/xlsx/docx allowlist.
3. **Voice = the browser's MediaRecorder.** Hold-to-record mic button;
   Chrome/Android produce webm/opus, iPhone Safari produces mp4/aac — we store
   whatever the device gives (audio element plays both). 3-minute cap per
   note. No transcoding service needed.
4. **Threads = DMs + named groups, one optional thread per job.**
   - DM: any user ↔ any user (operator → floor manager / plant head).
   - Group: named rooms ("Printing Floor", "Management"), members managed by
     admins.
   - Job thread: opened from a Job Card ("Discuss this job") — a group thread
     hard-linked to the job card, so the whole story of a problem job lives in
     one place.
5. **Job tagging inside any message.** Typing `#` opens a job picker (same
   deep search as everywhere); the tag renders as a chip → clicking it opens
   the job card. One message can tag several jobs. Tags are stored
   relationally (`message_job_tags`) so a job card can also show "3 chat
   threads mention this job".
6. **Unread + notifications.** Per-member `last_read_message_id` drives
   unread badges. A new message notifies members via the existing `notify()`
   ONLY if they haven't read the thread within ~2 minutes (no bell spam while
   both people are chatting). The chat dock itself shows a live unread count.
7. **Retention & audit.** Messages are never hard-deleted by users (sender can
   "remove" within 10 min → tombstone "message removed"). This is a plant
   record, same philosophy as the audit log. Storage cost at plant scale is
   negligible.
8. **Access.** Every active login can chat. No customer/vendor access, ever.

## Data model (5 tables)

```sql
conversations      id, kind ('dm'|'group'|'job'), name, job_card_id, created_by, created_at
conversation_members conversation_id, user_id, role ('member'|'admin'),
                     last_read_message_id, joined_at, muted INT
messages           id, conversation_id, sender_id, body TEXT,
                   kind ('text'|'voice'|'file'), created_at, removed_at
message_attachments id, message_id, object_path, file_name, mime, size_bytes,
                    duration_secs (voice), width/height (images)
message_job_tags   message_id, job_card_id
```

DM uniqueness: one `dm` conversation per user pair (enforced with a canonical
`least(id),greatest(id)` unique index). Job threads: one per job card.

## API surface (one new route file, ~10 endpoints)

```
GET  /chat/conversations              my list + unread counts (poll 10s)
POST /chat/conversations              start DM {user_id} / group {name, member_ids}
GET  /chat/conversations/:id/messages ?after=<id> incremental fetch (poll 4s while open)
POST /chat/conversations/:id/messages {body, job_tags:[jc ids]}
POST /chat/conversations/:id/attachments  multipart (file or voice blob) → message
GET  /chat/attachments/:id            auth-checked redirect → signed URL
POST /chat/conversations/:id/read     {message_id} advance read pointer
POST /chat/messages/:id/remove        sender, ≤10 min → tombstone
POST /chat/conversations/:id/members  group admins add/remove
GET  /job-cards/:id/chat              find-or-create the job thread
```

## UI

- **Chat dock:** a floating chat bubble next to the existing bell
  (bottom-right), with unread badge. Click → a slide-up panel (like the bell's
  glass panel, but taller): conversation list → thread view.
- **Thread view:** message bubbles, day separators, sender name + time; job
  chips inline; image thumbnails; voice notes as play bar with duration; file
  rows with icon + size.
- **Composer:** text box, 📎 attach, hold-🎤 record (release = send, slide
  away = cancel), `#` job tagging.
- **Entry points:** "Message" button on Job Card view (opens the job thread);
  "Message user" from Masters → Users; the dock itself.
- **Mobile:** the dock goes full-screen under the plant PWA breakpoints —
  operators use phones; the composer must be thumb-first.

## Build phases

| Phase | Scope | Effort |
|---|---|---|
| **1 — Text MVP** | Tables, endpoints, dock UI, DMs + groups, job tagging, unread + bell integration, polling | 1 session |
| **2 — Voice + files** | `chat-media` bucket, upload/signed-URL endpoints, mic recorder UI, attachment rendering, caps/allowlist | 1 session |
| **3 — Live + polish** | Supabase Realtime subscription (instant delivery), job-thread entry on Job Card page, "N threads mention this job", typing indicator if wanted | 1 session |

Prod rollout per phase = one migration (000N) + `git push` (Vercel
auto-deploy) + create the Storage bucket once in Supabase (Phase 2).

## Open items for Anik (defaults chosen, change if you disagree)

- Seed groups: **"Plant Floor"** (everyone) and **"Management"** (MD +
  Plant + Planning)? Default: yes.
- Voice-note cap 3 min, file cap 4 MB (Vercel serverless body limit). Default: yes.
- Should a job-tagged message ALSO ping the plant head automatically when the
  tagging user is an operator? Default: no — the sender chooses the audience;
  escalation is picking the right thread.
