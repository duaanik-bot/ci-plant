// CI Messenger — DMs, group rooms, and a thread on any record in the ERP, so
// plant talk about a job, an order or a board lives next to it instead of on
// WhatsApp. Attachments are BYTEA in Postgres (photos compressed client-side);
// transport is polling, so every read endpoint is built to be cheap and every
// write is one tx.
// Access rule on EVERY endpoint that takes a conversation or attachment id:
// record threads (and their legacy synonym, job threads) are open to any
// signed-in user and auto-join on first touch; dm/group require a membership
// row. See ensureAccess for where that rule currently lives.
import { Router } from 'express';
import multer from 'multer';
import { q, one, tx } from '../db.js';
import { audit, notify } from '../helpers.js';
import {
  dmKey, canSee, removalError, attachmentError, msgKind, notifyTargets, previewText,
} from '../chat-rules.js';
import { entityOr400, resolveLabel } from '../record-entities.js';

const r = Router();

// Multer caps the wire size; attachmentError() re-checks bytes + mime + voice
// length afterwards. The wrapper turns multer's LIMIT_FILE_SIZE (a plain
// Error, no .status) into a clean 400 instead of a logged 500.
// 4 MB matches ATTACHMENT_MAX_BYTES in chat-rules.js — Vercel's serverless
// body limit (~4.5 MB) is the real ceiling, so a bigger number would only be
// honest on local dev. defParamCharset: browsers send multipart filenames as
// raw UTF-8 but busboy's default decodes latin1, which turns every Hindi or
// emoji filename from a plant phone into mojibake.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  defParamCharset: 'utf8',
});
const uploadOne = (req, res, next) => upload.single('file')(req, res, err => {
  if (err) {
    return res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Files are capped at 4 MB — compress it and try again' : err.message,
    });
  }
  next();
});

const intParam = v => { const n = +v; return Number.isInteger(n) && n > 0 ? n : null; };

const MSG_COLS = 'id, conversation_id, sender_id, sender_name, kind, body, created_at, removed_at';

// ── shared helpers ──────────────────────────────────────────────────────────

const membership = (convId, userId) =>
  one('SELECT * FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [convId, userId]);

// A record thread is plant-public for exactly the same reason a job thread is:
// the conversation about a record belongs to whoever is working on that record,
// and 'job' is only the legacy synonym of 'record'. chat-rules.canSee still
// knows about 'job' alone, so the rule for 'record' lives HERE — two homes for
// one rule, deliberately, because chat-rules.js is not this wave's to edit.
// Fold this back into canSee the next time that file is touched, and delete
// this helper; until then the two must be changed together.
const plantPublic = conv => conv?.kind === 'record' || conv?.kind === 'job';

// The security chokepoint. Throws 404/403; plant-public threads auto-join on
// first touch so the caller always leaves with a member row to poll/read
// against.
async function ensureAccess(convId, userId) {
  const conv = await one('SELECT * FROM conversations WHERE id=$1', [convId]);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  let member = await membership(conv.id, userId);
  if (!plantPublic(conv) && !canSee(conv, member)) {
    throw Object.assign(new Error('Not a member of this conversation'), { status: 403 });
  }
  if (!member) {
    // A plant-public thread let a non-member through, so join them. ON CONFLICT
    // because two tabs polling the same thread will race this insert.
    await q(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)
             ON CONFLICT DO NOTHING`, [conv.id, userId]);
    member = await membership(conv.id, userId);
  }
  return { conv, member };
}

// Conversation label from a viewer's seat: dm → the other person, group/job →
// the room's name. qcFn lets tx-bound callers stay on their client.
async function convLabel(conv, viewerId, qcFn = q) {
  if (conv.kind !== 'dm') return conv.name;
  const rows = await qcFn(`
    SELECT u.name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id=$1 AND cm.user_id<>$2 LIMIT 1`, [conv.id, viewerId]);
  return rows[0]?.name || 'Direct message';
}

// ConversationListItem — one batched query for the whole list (LATERALs, not a
// per-conversation loop): the dm partner's name, member count, my unread
// count, and the newest message all ride along on the membership row.
const LIST_SELECT = `
  SELECT c.id, c.kind, c.name, c.job_card_id, c.entity, c.entity_id, c.auto_add, c.created_at,
         cm.role AS my_role, cm.muted,
         CASE WHEN c.kind='dm' THEN other.name ELSE c.name END AS label,
         mc.count AS members, un.count AS unread,
         lm.id AS lm_id, lm.kind AS lm_kind, lm.body AS lm_body, lm.sender_id AS lm_sender_id,
         lm.sender_name AS lm_sender_name, lm.created_at AS lm_created_at, lm.removed_at AS lm_removed_at
  FROM conversation_members cm
  JOIN conversations c ON c.id = cm.conversation_id
  LEFT JOIN LATERAL (
    SELECT u.name FROM conversation_members om JOIN users u ON u.id = om.user_id
    WHERE c.kind='dm' AND om.conversation_id = c.id AND om.user_id <> cm.user_id
    LIMIT 1) other ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count FROM conversation_members m2
    WHERE m2.conversation_id = c.id) mc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count FROM messages m
    WHERE m.conversation_id = c.id AND m.id > COALESCE(cm.last_read_message_id, 0)
      AND m.sender_id <> cm.user_id AND m.removed_at IS NULL) un ON true
  LEFT JOIN LATERAL (
    SELECT id, kind, body, sender_id, sender_name, created_at, removed_at
    FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) lm ON true
  WHERE cm.user_id = $1`;

const rowToItem = row => ({
  id: row.id, kind: row.kind, name: row.name, label: row.label,
  job_card_id: row.job_card_id, auto_add: row.auto_add,
  // Additive: the record a thread hangs off, so the dock can render the chip
  // and the deep link without a second call. null on dm/group.
  entity: row.entity, entity_id: row.entity_id,
  my_role: row.my_role, muted: row.muted,
  members: row.members, unread: row.unread,
  last_message: row.lm_id == null ? null : {
    id: row.lm_id, kind: row.lm_kind, body: row.lm_body, sender_id: row.lm_sender_id,
    sender_name: row.lm_sender_name, created_at: row.lm_created_at, removed_at: row.lm_removed_at,
  },
});

async function listItem(convId, userId) {
  const row = await one(`${LIST_SELECT} AND c.id = $2`, [userId, convId]);
  return row ? rowToItem(row) : null;
}

// MemberState[] — read pointers + typing, recomputed on every poll because the
// thread view renders "Seen" and "is typing…" from it.
const memberStates = convId => q(`
  SELECT cm.user_id, u.name, cm.role, cm.last_read_message_id,
         (cm.typing_at IS NOT NULL AND cm.typing_at > now() - interval '6 seconds') AS typing
  FROM conversation_members cm JOIN users u ON u.id = cm.user_id
  WHERE cm.conversation_id=$1 ORDER BY u.name`, [convId]);

// Attachment meta and job tags batched onto a page of messages. data stays in
// the DB — the ONLY place it is ever selected is the byte-serving endpoint.
async function hydrateMessages(rows) {
  if (!rows.length) return [];
  const ids = rows.map(m => m.id);
  const atts = await q(`
    SELECT id, message_id, file_name, mime, size_bytes, duration_secs
    FROM message_attachments WHERE message_id = ANY($1) ORDER BY id`, [ids]);
  const tags = await q(`
    SELECT t.message_id, t.job_card_id, jc.jc_number
    FROM message_job_tags t JOIN job_cards jc ON jc.id = t.job_card_id
    WHERE t.message_id = ANY($1) ORDER BY t.job_card_id`, [ids]);
  const attsBy = {}, tagsBy = {};
  for (const a of atts) (attsBy[a.message_id] ||= []).push({
    id: a.id, file_name: a.file_name, mime: a.mime, size_bytes: a.size_bytes, duration_secs: a.duration_secs,
  });
  for (const t of tags) (tagsBy[t.message_id] ||= []).push({ job_card_id: t.job_card_id, jc_number: t.jc_number });
  return rows.map(m => ({ ...m, attachments: attsBy[m.id] || [], job_tags: tagsBy[m.id] || [] }));
}

async function fullMessage(id) {
  const m = await one(`SELECT ${MSG_COLS} FROM messages WHERE id=$1`, [id]);
  return m ? (await hydrateMessages([m]))[0] : null;
}

// Replace-then-insert: a conversation holds at most ONE unread bell row per
// user — a chatty room updates its row instead of stacking twenty. Read rows
// are left alone (they are history). Label is taken from the SENDER's seat so
// a DM bell reads "Shiv — Dharminder", not "Shiv — Shiv".
async function pushChatNotification(qc, conv, message, targets) {
  if (!targets.length) return;
  const label = await convLabel(conv, message.sender_id, qc);
  await qc(`DELETE FROM notifications
            WHERE user_id = ANY($1) AND kind='chat' AND ref_table='conversations' AND ref_id=$2
              AND read_at IS NULL`, [targets, conv.id]);
  await notify(targets, {
    kind: 'chat',
    title: `${message.sender_name} — ${label}`,
    body: previewText(message),
    link: `/chat/${conv.id}`,
    refTable: 'conversations', refId: conv.id,
  }, qc);
}

// A mention is addressed at a PERSON, so it pierces both of the silencers a
// normal chat bell obeys — the muted flag and the 120-second watching window
// (notifyTargets) — and the replace-then-insert rule above: five people asking
// you five different things must not collapse into one bell row. That is the
// whole reason this is a separate function instead of another notifyTargets
// caller. Piercing muted is the point, not an oversight.
async function pushMentionNotification(qc, conv, message, targets) {
  if (!targets.length) return;
  const label = await convLabel(conv, message.sender_id, qc);
  await notify(targets, {
    kind: 'mention',
    title: `${message.sender_name} mentioned you — ${label}`,
    body: previewText(message),
    link: `/chat/${conv.id}`,
    refTable: 'conversations', refId: conv.id,
  }, qc);
}

// Handles are written into the body as `@[handle]`. The brackets are load
// bearing: handles come from the email local part, so 'anik.dua' is legal and a
// bare @anik.dua has no unambiguous end. Anything but ] and whitespace is
// accepted inside — mention_targets is what decides whether it is real.
const MENTION_RE = /@\[([^\]\s]{1,64})\]/g;
// One message can only ring so many phones. Past this the sender wanted a team
// handle, not twenty names.
const MENTION_MAX = 20;

function parseMentionHandles(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(MENTION_RE)) {
    const handle = m[1].toLowerCase();
    if (!out.includes(handle)) out.push(handle);
    if (out.length >= MENTION_MAX) break;
  }
  return out;
}

// Handles → the people they actually reach. Teams fan out through member_ids
// (the stored truth, not a role query — Procurement and Accounts have no role
// to derive from). Only active logins survive: a team's member list outlives
// the employee, and a mention must not resurrect a closed account.
//
// `visible` is the conversation's audience gate. On a plant-public thread it
// waves everyone through; on a dm/group it is the members, because the bell
// body carries previewText — mentioning an outsider in a private group would
// otherwise post that group's words straight into their notification list.
// Rows are written for exactly who is notified, so a mention row can never
// mean "was named in a room they may not read".
async function resolveMentions(qc, body, visible) {
  const handles = parseMentionHandles(body);
  if (!handles.length) return [];
  const targets = await qc(`
    SELECT id, kind, lower(handle) AS handle, user_id, member_ids
    FROM mention_targets WHERE active=1 AND lower(handle) = ANY($1)`, [handles]);
  const rows = [];
  for (const t of targets) {
    const ids = t.kind === 'team'
      ? (Array.isArray(t.member_ids) ? t.member_ids : [])
      : [t.user_id];                       // null when that user was deleted
    for (const raw of ids) {
      const uid = Number(raw);
      if (Number.isInteger(uid) && uid > 0 && visible(uid)) {
        rows.push({ target_id: t.id, handle: t.handle, user_id: uid });
      }
    }
  }
  if (!rows.length) return [];
  const live = await qc('SELECT id FROM users WHERE id = ANY($1) AND active=1',
    [[...new Set(rows.map(r => r.user_id))]]);
  const ok = new Set(live.map(u => +u.id));
  return rows.filter(r => ok.has(r.user_id));
}

const systemMessage = (qc, convId, user, body) => qc(`
  INSERT INTO messages (conversation_id, sender_id, sender_name, kind, body)
  VALUES ($1,$2,$3,'system',$4)`, [convId, user.id, user.name, body]);

// One tx for text and attachment sends alike: message row, optional blob, job
// tags (unknown ids silently skipped — a stale picker must not kill the send),
// a chat_mention audit on each tagged job so the mention shows on the job's
// timeline, @mention rows, then the bell fan-out. Both send routes come through
// here, which is why a caption on a photo mentions people exactly like text
// does — there is only one place it could have been forgotten.
async function createMessage(conv, user, { kind, body, attachment = null, jobTagIds = [] }) {
  return tx(async (qc) => {
    const [msg] = await qc(`
      INSERT INTO messages (conversation_id, sender_id, sender_name, kind, body)
      VALUES ($1,$2,$3,$4,$5) RETURNING ${MSG_COLS}`, [conv.id, user.id, user.name, kind, body]);
    if (attachment) {
      await qc(`
        INSERT INTO message_attachments (message_id, file_name, mime, size_bytes, duration_secs, data)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [msg.id, attachment.file_name, attachment.mime, attachment.size_bytes, attachment.duration_secs, attachment.data]);
    }
    // previewText needs the file name for file-kind messages; it lives on the
    // attachment row, not the message.
    const preview = { ...msg, file_name: attachment?.file_name };
    const wanted = [...new Set((jobTagIds || []).map(Number))].filter(n => Number.isInteger(n) && n > 0);
    if (wanted.length) {
      const label = await convLabel(conv, user.id, qc);
      const jobs = await qc('SELECT id, jc_number FROM job_cards WHERE id = ANY($1)', [wanted]);
      for (const jc of jobs) {
        await qc(`INSERT INTO message_job_tags (message_id, job_card_id) VALUES ($1,$2)
                  ON CONFLICT DO NOTHING`, [msg.id, jc.id]);
        await audit('job_card', jc.id, 'chat_mention',
          `${user.name}: ${previewText(preview)} (${label})`, qc, user.name);
      }
    }
    const members = await qc(
      'SELECT user_id, muted, last_seen_at FROM conversation_members WHERE conversation_id=$1', [conv.id]);

    // Who may be named here: anyone on a plant-public thread (they can open it
    // and will be auto-joined), members only on a dm/group.
    const memberIds = new Set(members.map(m => +m.user_id));
    const mentions = await resolveMentions(qc, body,
      uid => plantPublic(conv) || memberIds.has(uid));
    for (const m of mentions) {
      await qc(`INSERT INTO message_mentions (message_id, target_id, handle, user_id)
                VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [msg.id, m.target_id, m.handle, m.user_id]);
    }
    // Naming yourself is not a notification. Everyone else who was mentioned
    // gets the mention bell INSTEAD of the chat bell, never both — one message
    // writes at most one row per person.
    const mentioned = [...new Set(mentions.map(m => m.user_id))].filter(id => id !== +user.id);
    const mentionedSet = new Set(mentioned);
    await pushChatNotification(qc, conv, preview,
      notifyTargets(members, user.id).filter(id => !mentionedSet.has(id)));
    await pushMentionNotification(qc, conv, preview, mentioned);
    return msg.id;
  });
}

// ── pickers ─────────────────────────────────────────────────────────────────

// The admin-only /users route can't serve the DM picker — every login needs it.
r.get('/chat/users', async (req, res, next) => {
  try {
    res.json(await q('SELECT id, name, role FROM users WHERE active=1 AND id<>$1 ORDER BY name', [req.user.id]));
  } catch (e) { next(e); }
});

// The @ picker: people and teams in one namespace, which is why the composer
// needs one list and the fan-out one code path.
//
// user_id and member_ids both ship so the composer can answer "does this chip
// mean ME?" exactly — by id for a person, by membership for a team. The
// alternative the client would be left with is string-matching the label
// against the signed-in name, which two Rahuls or one label edit would break,
// and "someone needs me" is the whole point of the highlight. The roster is no
// wider a disclosure than /chat/users, which already hands every login every
// active user's name and role; these are the same people as bare ids.
// member_count is the same fact pre-counted, so the picker can warn before
// somebody rings a whole department.
r.get('/chat/mention-targets', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT id, kind, handle, label, user_id, member_ids,
             CASE WHEN kind='team' AND jsonb_typeof(member_ids)='array'
                  THEN jsonb_array_length(member_ids) ELSE NULL END AS member_count
      FROM mention_targets WHERE active=1 ORDER BY kind, label`));
  } catch (e) { next(e); }
});

// Open work for the # tag picker.
r.get('/chat/jobs', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT jc.id, jc.jc_number, p.name AS product_name, jc.status
      FROM job_cards jc JOIN products p ON p.id = jc.product_id
      WHERE jc.status IN ('open','in_progress')
      ORDER BY jc.id DESC LIMIT 300`));
  } catch (e) { next(e); }
});

// ── conversations ───────────────────────────────────────────────────────────

r.get('/chat/conversations', async (req, res, next) => {
  try {
    const rows = await q(`${LIST_SELECT} ORDER BY lm_id DESC NULLS LAST, c.created_at DESC`, [req.user.id]);
    res.json(rows.map(rowToItem));
  } catch (e) { next(e); }
});

r.post('/chat/conversations', async (req, res, next) => {
  try {
    const { kind } = req.body || {};

    if (kind === 'dm') {
      const target = await one('SELECT id, name FROM users WHERE id=$1 AND active=1', [intParam(req.body.user_id) || 0]);
      if (!target) return res.status(400).json({ error: 'Pick an active user to message' });
      const key = dmKey(req.user.id, target.id);
      if (!key) return res.status(400).json({ error: "You can't message yourself" });
      let conv = await one('SELECT id FROM conversations WHERE dm_key=$1', [key]);
      if (!conv) {
        conv = await tx(async (qc, oc) => {
          // Double-submit races are real on serverless: the loser's insert
          // hits the dm_key unique, returns nothing, and re-selects the
          // winner's row. Member inserts are idempotent either way.
          const [ins] = await qc(`
            INSERT INTO conversations (kind, dm_key, created_by) VALUES ('dm',$1,$2)
            ON CONFLICT (dm_key) DO NOTHING RETURNING id`, [key, req.user.id]);
          const row = ins || await oc('SELECT id FROM conversations WHERE dm_key=$1', [key]);
          await qc(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)
                    ON CONFLICT DO NOTHING`, [row.id, req.user.id, target.id]);
          return row;
        });
      }
      return res.json(await listItem(conv.id, req.user.id));
    }

    if (kind === 'group') {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'A group needs a name' });
      if (name.length > 60) return res.status(400).json({ error: 'Group names are capped at 60 characters' });
      const memberIds = [...new Set((req.body.member_ids || []).map(Number))]
        .filter(n => Number.isInteger(n) && n > 0 && n !== req.user.id);
      const convId = await tx(async (qc, oc) => {
        const row = await oc(`
          INSERT INTO conversations (kind, name, created_by) VALUES ('group',$1,$2) RETURNING id`,
        [name, req.user.id]);
        await qc(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')`,
          [row.id, req.user.id]);
        if (memberIds.length) {
          // Only real, active users get rows — a stale picker id must not
          // blow the whole create on a FK.
          const users = await qc('SELECT id FROM users WHERE id = ANY($1) AND active=1', [memberIds]);
          for (const u of users) {
            await qc(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)
                      ON CONFLICT DO NOTHING`, [row.id, u.id]);
          }
        }
        await systemMessage(qc, row.id, req.user, `${req.user.name} created the group`);
        return row.id;
      });
      return res.json(await listItem(convId, req.user.id));
    }

    return res.status(400).json({ error: 'kind must be dm or group' });
  } catch (e) { next(e); }
});

r.get('/chat/conversations/:id', async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv } = await ensureAccess(convId, req.user.id);
    res.json({ conversation: await listItem(conv.id, req.user.id), members: await memberStates(conv.id) });
  } catch (e) { next(e); }
});

// The thread poll. No `after` → latest page; with `after` → what's new, PLUS
// two healing overlaps the client's id-merge absorbs: (1) a 30-id overlap
// window, because ids are assigned at INSERT but commit order can invert
// across serverless instances — a strict id>after cursor would skip the slower
// tx forever; (2) recently-removed rows regardless of id, because a removal
// mutates an already-delivered message and the viewers most likely to be
// staring at the wrong photo are exactly the ones an unsend must reach.
// Members ride along on every poll (they carry seen/typing). Side effect: the
// fetch stamps my last_seen_at, which is what keeps a watcher's bell quiet.
r.get('/chat/conversations/:id/messages', async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv } = await ensureAccess(convId, req.user.id);
    const after = intParam(req.query.after);
    const rows = after
      ? await q(`
          SELECT ${MSG_COLS} FROM messages
          WHERE conversation_id=$1
            AND (id > GREATEST($2 - 30, 0)
                 OR (removed_at IS NOT NULL AND removed_at > now() - interval '15 minutes'))
          ORDER BY id`, [conv.id, after])
      : (await q(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 100`, [conv.id])).reverse();
    await q('UPDATE conversation_members SET last_seen_at=now() WHERE conversation_id=$1 AND user_id=$2',
      [conv.id, req.user.id]);
    res.json({ messages: await hydrateMessages(rows), members: await memberStates(conv.id) });
  } catch (e) { next(e); }
});

// ── sending ─────────────────────────────────────────────────────────────────

r.post('/chat/conversations/:id/messages', async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv } = await ensureAccess(convId, req.user.id);
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message text is required' });
    if (body.length > 4000) return res.status(400).json({ error: 'Messages are capped at 4000 characters' });
    const id = await createMessage(conv, req.user, { kind: 'text', body, jobTagIds: req.body.job_tags });
    res.json(await fullMessage(id));
  } catch (e) { next(e); }
});

// Multipart: file + optional caption/duration/tags (multipart fields arrive as
// strings, so job_tags is a JSON array string).
r.post('/chat/conversations/:id/attachments', uploadOne, async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv } = await ensureAccess(convId, req.user.id);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const duration = req.body.duration_secs != null && req.body.duration_secs !== ''
      ? +req.body.duration_secs : null;
    const meta = { mime: req.file.mimetype, size_bytes: req.file.buffer.length, duration_secs: duration };
    const bad = attachmentError(meta);
    if (bad) return res.status(400).json({ error: bad });
    let jobTagIds = [];
    if (req.body.job_tags) {
      try { jobTagIds = JSON.parse(req.body.job_tags); } catch { /* junk tags never block a send */ }
      if (!Array.isArray(jobTagIds)) jobTagIds = [];
    }
    // The caption obeys the same cap as a plain message — the multipart path
    // must not be a side door around it.
    const caption = (req.body.body || '').trim();
    if (caption.length > 4000) return res.status(400).json({ error: 'Messages are capped at 4000 characters' });
    const id = await createMessage(conv, req.user, {
      kind: msgKind(meta.mime, duration),
      body: caption || null,
      jobTagIds,
      attachment: {
        file_name: req.file.originalname || 'file', mime: meta.mime,
        size_bytes: meta.size_bytes, duration_secs: duration, data: req.file.buffer,
      },
    });
    res.json(await fullMessage(id));
  } catch (e) { next(e); }
});

// The one place message_attachments.data is ever selected. Access is checked
// FIRST — this endpoint would otherwise be an open door to every factory photo
// by id-guessing.
r.get('/chat/attachments/:id', async (req, res, next) => {
  try {
    const attId = intParam(req.params.id);
    const meta = attId && await one(`
      SELECT ma.id, ma.file_name, ma.mime, m.conversation_id
      FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
      WHERE ma.id=$1`, [attId]);
    if (!meta) return res.status(404).json({ error: 'Attachment not found' });
    await ensureAccess(meta.conversation_id, req.user.id);
    const blob = await one('SELECT data FROM message_attachments WHERE id=$1', [attId]);
    if (!blob) return res.status(404).json({ error: 'Attachment not found' });
    // nosniff: the mime came from the uploader — the browser must never
    // second-guess it into something executable. (SVG is already refused at
    // upload; this is the belt to that suspender.)
    res.set('Content-Type', meta.mime)
      .set('X-Content-Type-Options', 'nosniff')
      .set('Content-Disposition', `inline; filename="${(meta.file_name || 'file').replace(/["\r\n]/g, '')}"`)
      .send(blob.data);
  } catch (e) { next(e); }
});

// ── read / typing / remove ──────────────────────────────────────────────────

// Advance-only read pointer — a poll of an older page must never pull the
// pointer (and the unread count) backwards. Also quiets this conversation's
// bell row, since reading the thread IS reading the notification.
r.post('/chat/conversations/:id/read', async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv } = await ensureAccess(convId, req.user.id);
    const messageId = intParam(req.body.message_id);
    if (!messageId) return res.status(400).json({ error: 'message_id is required' });
    await q(`UPDATE conversation_members
             SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $1)
             WHERE conversation_id=$2 AND user_id=$3`, [messageId, conv.id, req.user.id]);
    // 'mention' rides along with 'chat': reading the thread IS reading the
    // notification, and a mention inbox that still shows a ping you have
    // already answered is the same lie for both kinds.
    await q(`UPDATE notifications SET read_at=now()
             WHERE user_id=$1 AND kind IN ('chat','mention')
               AND ref_table='conversations' AND ref_id=$2 AND read_at IS NULL`,
    [req.user.id, conv.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/chat/conversations/:id/typing', async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv } = await ensureAccess(convId, req.user.id);
    await q('UPDATE conversation_members SET typing_at=now() WHERE conversation_id=$1 AND user_id=$2',
      [conv.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Tombstone, not delete: the row stays (thread order and "Message removed"
// render from it) but the body is nulled and the blob rows are deleted for
// good — a removed factory photo must actually leave the database.
r.post('/chat/messages/:id/remove', async (req, res, next) => {
  try {
    const msgId = intParam(req.params.id);
    const msg = msgId && await one(`SELECT ${MSG_COLS} FROM messages WHERE id=$1`, [msgId]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    await ensureAccess(msg.conversation_id, req.user.id);
    const refusal = removalError(msg, req.user.id);
    if (refusal) return res.status(400).json({ error: refusal });
    await tx(async (qc) => {
      await qc('UPDATE messages SET removed_at=now(), body=NULL WHERE id=$1', [msg.id]);
      await qc('DELETE FROM message_attachments WHERE message_id=$1', [msg.id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── group membership ────────────────────────────────────────────────────────

r.post('/chat/conversations/:id/members', async (req, res, next) => {
  try {
    const convId = intParam(req.params.id);
    if (!convId) return res.status(404).json({ error: 'Conversation not found' });
    const { conv, member } = await ensureAccess(convId, req.user.id);
    if (conv.kind !== 'group') {
      return res.status(400).json({ error: 'Only group conversations have managed members' });
    }
    if (member?.role !== 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only a group admin can change members' });
    }
    const clean = ids => [...new Set((ids || []).map(Number))].filter(n => Number.isInteger(n) && n > 0);
    const add = clean(req.body.add);
    const remove = clean(req.body.remove);
    await tx(async (qc, oc) => {
      // Serialise on the conversation row — two admins editing members at once
      // must not race the last-admin check past each other.
      await oc('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conv.id]);
      if (remove.length) {
        const admins = await qc(
          `SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND role='admin'`, [conv.id]);
        if (admins.length && !admins.some(a => !remove.includes(+a.user_id))) {
          throw Object.assign(new Error('A group must keep at least one admin'), { status: 409 });
        }
        const gone = await qc(`
          DELETE FROM conversation_members cm USING users u
          WHERE cm.conversation_id=$1 AND cm.user_id = ANY($2) AND u.id = cm.user_id
          RETURNING u.name`, [conv.id, remove]);
        for (const g of gone) await systemMessage(qc, conv.id, req.user, `${req.user.name} removed ${g.name}`);
      }
      if (add.length) {
        const users = await qc('SELECT id, name FROM users WHERE id = ANY($1) AND active=1', [add]);
        for (const u of users) {
          // RETURNING is empty when the row already existed — no "added"
          // system message for someone who was already in the room.
          const ins = await qc(`
            INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)
            ON CONFLICT DO NOTHING RETURNING user_id`, [conv.id, u.id]);
          if (ins.length) await systemMessage(qc, conv.id, req.user, `${req.user.name} added ${u.name}`);
        }
      }
    });
    res.json({ conversation: await listItem(conv.id, req.user.id), members: await memberStates(conv.id) });
  } catch (e) { next(e); }
});

// ── record threads ──────────────────────────────────────────────────────────

// One thread lookup for every record in the ERP. Two ways in, because a job
// card can be addressed both ways: by (entity, entity_id) like everything else,
// and by job_card_id, which is the legacy address AND the FK that deletes a
// job's thread with the job. Matching on either is what makes the two
// physically incapable of drifting into two threads for one job — including on
// a database where the entity backfill has not run yet, where the entity lookup
// alone would miss the existing row and then collide with its UNIQUE.
const THREAD_LOOKUP = `
  SELECT id, entity, entity_id, job_card_id FROM conversations
  WHERE (entity = $1 AND entity_id = $2) OR ($3::int IS NOT NULL AND job_card_id = $3)
  ORDER BY id LIMIT 1`;

// Find-or-create the conversation for a record, then join the caller to it.
// The table name is taken from the registry and never from the request, so
// `entity` cannot become a SQL injection point; an unknown key is a 400 before
// any query runs, and a record that does not exist is a 404 rather than an
// orphan thread pointing at nothing.
async function resolveThread(entity, entityId, userId) {
  const spec = entityOr400(entity);
  const id = intParam(entityId);
  if (!id) throw Object.assign(new Error(`${spec.label} not found`), { status: 404 });
  const cols = ['id', spec.number].filter(Boolean).join(', ');
  const row = await one(`SELECT ${cols} FROM ${spec.table} WHERE id=$1`, [id]);
  if (!row) throw Object.assign(new Error(`${spec.label} not found`), { status: 404 });

  const jobCardId = entity === 'job_card' ? id : null;
  let conv = await one(THREAD_LOOKUP, [entity, id, jobCardId]);
  if (!conv) {
    // ON CONFLICT DO NOTHING with no target: BOTH uniques are in play here
    // (entity+entity_id, and job_card_id), and a double-submit race must lose
    // quietly and re-select the winner's row rather than 500. Same pattern the
    // dm_key create uses, same reason — serverless makes the race routine.
    // kind stays 'job' for job cards: it is the legacy synonym of 'record',
    // carries the identical access rule, and keeping it means the live Discuss
    // button and every existing job thread render exactly as they do today.
    await q(`INSERT INTO conversations (kind, name, entity, entity_id, job_card_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [jobCardId ? 'job' : 'record', resolveLabel(entity, row), entity, id, jobCardId, userId]);
    conv = await one(THREAD_LOOKUP, [entity, id, jobCardId]);
    // Unreachable unless a unique we do not know about rejected the insert.
    // A named 409 beats dereferencing null and logging a 500 as a mystery.
    if (!conv) throw Object.assign(new Error('Could not open this thread — try again'), { status: 409 });
  }
  // A job thread created before the backfill has job_card_id but no entity.
  // Heal it in place rather than leaving a second address for the same row.
  if (conv.entity == null) {
    await q('UPDATE conversations SET entity=$2, entity_id=$3 WHERE id=$1 AND entity IS NULL',
      [conv.id, entity, id]);
  }
  await ensureAccess(conv.id, userId); // plant-public — auto-joins the caller
  return conv;
}

// The unread indicator feed: ONE query for a whole page of rows, never one per
// row. A page renders 60 rows and asks for those 60 ids; records with no thread
// simply do not come back, and the client reads a missing key as zero.
//
// `unread` mirrors the conversation list's rule exactly — above MY watermark,
// not mine, not removed — so the number on the row and the number in the dock
// can never disagree. No membership row (the common case: a record thread you
// have never opened) means a watermark of 0, i.e. every comment is unread,
// which is the honest answer.
const SUMMARY_SELECT = `
  SELECT c.entity_id,
         COALESCE(mc.count, 0) AS comments, mc.last_at,
         COALESCE(un.count, 0) AS unread,
         COALESCE(mn.hit, false) AS mentioned
  FROM conversations c
  LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count, MAX(m.created_at) AS last_at
    FROM messages m WHERE m.conversation_id = c.id AND m.removed_at IS NULL) mc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count FROM messages m
    WHERE m.conversation_id = c.id AND m.id > COALESCE(cm.last_read_message_id, 0)
      AND m.sender_id <> $3 AND m.removed_at IS NULL) un ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
      WHERE mm.user_id = $3 AND m.conversation_id = c.id
        AND m.id > COALESCE(cm.last_read_message_id, 0) AND m.removed_at IS NULL) AS hit) mn ON true
  WHERE c.entity = $1 AND c.entity_id = ANY($2::int[])`;

const SUMMARY_MAX_IDS = 200;

r.get('/threads/summary', async (req, res, next) => {
  try {
    entityOr400(req.query.entity);       // 400 before the query, like everywhere else
    const ids = [...new Set(String(req.query.ids || '').split(',').map(s => intParam(s.trim())))]
      .filter(Boolean);
    // Refused, not silently truncated: a short answer is indistinguishable from
    // "no comments here" and would hide an unread mention on the rows it drops.
    if (ids.length > SUMMARY_MAX_IDS) {
      return res.status(400).json({ error: `Ask for at most ${SUMMARY_MAX_IDS} records at a time` });
    }
    if (!ids.length) return res.json({});
    const rows = await q(SUMMARY_SELECT, [req.query.entity, ids, req.user.id]);
    const out = {};
    for (const row of rows) {
      out[row.entity_id] = {
        comments: row.comments, unread: row.unread,
        mentioned: !!row.mentioned, last_at: row.last_at,
      };
    }
    res.json(out);
  } catch (e) { next(e); }
});

// Registered AFTER /threads/summary on purpose: 'summary' is one segment and
// this pattern needs two, so they cannot collide today — but the day someone
// makes :id optional, registration order is the only thing standing between
// the summary feed and being swallowed as entity='summary'.
//
// The generic address. Response is the same ConversationListItem every other
// conversation endpoint returns, so the dock needs no second shape.
r.get('/threads/:entity/:id', async (req, res, next) => {
  try {
    const conv = await resolveThread(req.params.entity, req.params.id, req.user.id);
    res.json(await listItem(conv.id, req.user.id));
  } catch (e) { next(e); }
});

// The legacy address, now a thin alias — one resolver, so the two can never
// create two threads for one job.
r.get('/job-cards/:id/chat', async (req, res, next) => {
  try {
    const conv = await resolveThread('job_card', req.params.id, req.user.id);
    res.json(await listItem(conv.id, req.user.id));
  } catch (e) { next(e); }
});

// Where has this job been talked about? Counts per conversation, the job's own
// thread included when messages there tag it. Labels resolve only for rooms
// the caller belongs to — a mention count is fine to show, but naming who is
// privately messaging whom (or what a members-only group is called) is not.
r.get('/job-cards/:id/chat-mentions', async (req, res, next) => {
  try {
    const jcId = intParam(req.params.id);
    if (!jcId) return res.status(404).json({ error: 'Job card not found' });
    const rows = await q(`
      SELECT c.id AS conversation_id, c.kind, c.name, COUNT(*)::int AS count,
             EXISTS (SELECT 1 FROM conversation_members me
                     WHERE me.conversation_id = c.id AND me.user_id = $2) AS mine
      FROM message_job_tags t
      JOIN messages m ON m.id = t.message_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE t.job_card_id=$1 AND m.removed_at IS NULL
      GROUP BY c.id, c.kind, c.name
      ORDER BY count DESC, c.id DESC`, [jcId, req.user.id]);
    const dmIds = rows.filter(x => x.kind === 'dm' && x.mine).map(x => x.conversation_id);
    let dmNames = {};
    if (dmIds.length) {
      const names = await q(`
        SELECT cm.conversation_id, u.name
        FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ANY($1) AND cm.user_id <> $2`,
      [dmIds, req.user.id]);
      dmNames = Object.fromEntries(names.map(n => [n.conversation_id, n.name]));
    }
    const threads = rows.map(x => ({
      conversation_id: x.conversation_id,
      label: x.kind === 'dm' ? (dmNames[x.conversation_id] || 'Direct message')
        : x.kind === 'group' && !x.mine ? 'A private group'
        : x.name,
      count: x.count,
    }));
    res.json({ total: threads.reduce((s, t) => s + t.count, 0), threads });
  } catch (e) { next(e); }
});

export default r;
