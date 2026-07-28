// ─── CI Messenger rules — pure logic, no DB ─────────────────────────────────
// Everything a chat endpoint has to decide without touching Postgres lives
// here so it can be unit-tested flat: who may see a conversation, when a
// message may still be pulled back, which files are welcome, and who deserves
// a bell. The route file (routes/chat.js) supplies rows; these functions
// supply verdicts.

// One DM per user pair — the pair IS the identity, so the key sorts the ids
// and the UNIQUE constraint on conversations.dm_key does the dedupe (including
// the double-submit race). Self-DMs and junk ids get null, not a key.
export function dmKey(a, b) {
  const x = +a, y = +b;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0 || x === y) return null;
  return x < y ? `dm:${x}:${y}` : `dm:${y}:${x}`;
}

// The ONE access rule, applied on every endpoint that receives a conversation
// (or attachment) id from the client: job threads are plant-public — any
// signed-in user may read and join — while dm/group content exists only for
// people holding a membership row.
export function canSee(conv, membership) {
  if (conv?.kind === 'job') return true;
  return !!membership;
}

// Senders may pull a message back for 10 minutes — long enough to fix a wrong
// photo, short enough that a thread's history stays trustworthy.
export const REMOVAL_WINDOW_MS = 10 * 60 * 1000;

export function removalError(message, userId, now = new Date()) {
  if (+message.sender_id !== +userId) return 'Only the sender can remove a message';
  if (message.removed_at) return 'This message was already removed';
  if (now - new Date(message.created_at) > REMOVAL_WINDOW_MS)
    return 'Messages can only be removed within 10 minutes of sending';
  return null;
}

// What the plant actually shares: photos of sheets/cartons, voice notes,
// short videos, and the office document trio. Everything else (zips,
// executables, unknown blobs) is refused — attachments live as BYTEA inside
// Postgres, so the type gate is also the "don't store junk in the DB" gate.
// SVG is image/* but scriptable — a stored-XSS vector if ever served inline —
// and no plant phone produces one, so it is refused by name.
// 4 MB is the REAL ceiling: prod runs as a Vercel serverless function, which
// hard-rejects request bodies (and inflates response bodies) past ~4.5 MB —
// a bigger cap here would only ever be honest on local dev.
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const VOICE_MAX_SECS = 180;

const mimeAllowed = mime => !!mime && mime !== 'image/svg+xml' && (
  mime.startsWith('image/')
  || mime.startsWith('audio/')
  || mime === 'video/mp4'
  || mime === 'application/pdf'
  || mime.startsWith('application/vnd.openxmlformats-officedocument.') // xlsx / docx
  || mime === 'text/csv'
  || mime === 'text/plain'
);

export function attachmentError({ mime, size_bytes, duration_secs } = {}) {
  if (!mimeAllowed(mime)) return `This file type can't be shared here (${mime || 'unknown type'})`;
  if (+size_bytes > ATTACHMENT_MAX_BYTES) return 'Files are capped at 4 MB — compress it and try again';
  // The duration cap only bites voice notes (audio WITH a recorded duration);
  // an audio file forwarded without one is just a file and the byte cap rules it.
  if (mime.startsWith('audio/') && duration_secs != null && +duration_secs > VOICE_MAX_SECS)
    return 'Voice notes are capped at 3 minutes';
  return null;
}

// A voice note is audio the recorder measured; audio without a duration (a
// forwarded clip) renders as a plain file, not the voice player.
export function msgKind(mime, duration_secs) {
  return !!mime && mime.startsWith('audio/') && duration_secs != null ? 'voice' : 'file';
}

// Bell fan-out for a new message. Three silencers: the sender (own action),
// muted members (their choice), and anyone whose thread fetch is fresher than
// 120 s — they are watching the conversation and the message will appear on
// their next poll, so a bell would only double-announce it.
export const WATCHING_WINDOW_MS = 120 * 1000;

export function notifyTargets(members, senderId, now = new Date()) {
  return (members || [])
    .filter(m => +m.user_id !== +senderId
      && !+(m.muted ?? 0)
      && (m.last_seen_at == null || now - new Date(m.last_seen_at) > WATCHING_WINDOW_MS))
    .map(m => +m.user_id);
}

// One-line rendering of a message for list rows and bell bodies. Removed
// messages show their tombstone even if a body survived somewhere; voice and
// file kinds describe themselves (their body, if any, is a caption).
export function previewText({ kind, body, file_name, removed_at } = {}) {
  if (removed_at) return 'Message removed';
  if (kind === 'voice') return 'Voice note';
  if (kind === 'file') return file_name || 'File';
  const text = (body || '').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
