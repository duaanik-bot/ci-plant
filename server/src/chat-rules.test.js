import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dmKey, canSee, removalError, attachmentError, msgKind, notifyTargets, previewText,
} from './chat-rules.js';

// ── dmKey ─────────────────────────────────────────────────────────────
test('dmKey: the pair is the identity — order never matters', () => {
  assert.equal(dmKey(3, 7), 'dm:3:7');
  assert.equal(dmKey(7, 3), 'dm:3:7');
});
test('dmKey: ids arriving as strings from the client still key', () => {
  assert.equal(dmKey('7', '3'), 'dm:3:7');
});
test('dmKey: no DM with yourself', () => {
  assert.equal(dmKey(5, 5), null);
});
test('dmKey: junk ids never mint a key', () => {
  assert.equal(dmKey(0, 3), null);
  assert.equal(dmKey(-1, 3), null);
  assert.equal(dmKey(1.5, 3), null);
  assert.equal(dmKey(NaN, 3), null);
  assert.equal(dmKey(null, 3), null);
  assert.equal(dmKey(undefined, undefined), null);
});

// ── canSee ────────────────────────────────────────────────────────────
test('canSee: job threads are plant-public — no membership needed', () => {
  assert.equal(canSee({ kind: 'job' }, null), true);
});
test('canSee: dm/group need a membership row', () => {
  const member = { conversation_id: 1, user_id: 2 };
  assert.equal(canSee({ kind: 'dm' }, member), true);
  assert.equal(canSee({ kind: 'group' }, member), true);
  assert.equal(canSee({ kind: 'dm' }, null), false);
  assert.equal(canSee({ kind: 'group' }, undefined), false);
});
test('canSee: a missing conversation is never visible', () => {
  assert.equal(canSee(null, null), false);
});

// ── removalError ──────────────────────────────────────────────────────
const NOW = new Date('2026-07-28T12:00:00Z');
const msgAt = (iso, extra = {}) => ({ sender_id: 2, created_at: iso, removed_at: null, ...extra });

test('removal: the sender may pull a fresh message back', () => {
  assert.equal(removalError(msgAt('2026-07-28T11:59:00Z'), 2, NOW), null);
});
test('removal: exactly 10 minutes is still inside the window', () => {
  assert.equal(removalError(msgAt('2026-07-28T11:50:00Z'), 2, NOW), null);
  assert.match(removalError(msgAt('2026-07-28T11:49:59Z'), 2, NOW), /10 minutes/);
});
test('removal: only the sender — nobody else, however fresh', () => {
  assert.match(removalError(msgAt('2026-07-28T11:59:00Z'), 9, NOW), /Only the sender/);
});
test('removal: identity is checked before age — a stranger is refused as a stranger', () => {
  // The refusal must not leak whether the window was still open.
  assert.match(removalError(msgAt('2026-07-28T09:00:00Z'), 9, NOW), /Only the sender/);
});
test('removal: a tombstone cannot be removed twice', () => {
  assert.match(removalError(msgAt('2026-07-28T11:59:00Z', { removed_at: '2026-07-28T11:59:30Z' }), 2, NOW),
    /already removed/);
});
test('removal: string ids from a JWT still match numeric sender_id', () => {
  assert.equal(removalError(msgAt('2026-07-28T11:59:00Z'), '2', NOW), null);
});

// ── attachmentError ───────────────────────────────────────────────────
const MB = 1024 * 1024;
test('attachments: the plant’s file types all pass', () => {
  for (const mime of [
    'image/jpeg', 'image/png', 'audio/webm', 'audio/mp4', 'video/mp4', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',   // xlsx
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'text/csv', 'text/plain',
  ]) assert.equal(attachmentError({ mime, size_bytes: 1 * MB }), null, mime);
});
test('attachments: everything else is refused — blobs live inside Postgres', () => {
  assert.match(attachmentError({ mime: 'application/zip', size_bytes: 1 * MB }), /file type/);
  assert.match(attachmentError({ mime: 'video/webm', size_bytes: 1 * MB }), /file type/);
  assert.match(attachmentError({ mime: 'application/x-msdownload', size_bytes: 1 * MB }), /file type/);
  assert.match(attachmentError({ size_bytes: 1 * MB }), /file type/);
});
test('attachments: 4 MB is the ceiling, inclusive — Vercel rejects bodies past ~4.5 MB, so a bigger cap would lie in prod', () => {
  assert.equal(attachmentError({ mime: 'image/jpeg', size_bytes: 4 * MB }), null);
  assert.match(attachmentError({ mime: 'image/jpeg', size_bytes: 4 * MB + 1 }), /4 MB/);
});
test('attachments: SVG is image/* but scriptable — refused by name', () => {
  assert.match(attachmentError({ mime: 'image/svg+xml', size_bytes: 1 * MB }), /file type/);
});
test('attachments: voice notes stop at 3 minutes', () => {
  assert.equal(attachmentError({ mime: 'audio/webm', size_bytes: MB, duration_secs: 180 }), null);
  assert.match(attachmentError({ mime: 'audio/webm', size_bytes: MB, duration_secs: 181 }), /3 minutes/);
});
test('attachments: audio without a duration is a file, not a voice note — no time cap', () => {
  assert.equal(attachmentError({ mime: 'audio/mpeg', size_bytes: 3 * MB }), null);
});
test('attachments: the duration cap never bites non-audio', () => {
  assert.equal(attachmentError({ mime: 'video/mp4', size_bytes: MB, duration_secs: 600 }), null);
});

// ── msgKind ───────────────────────────────────────────────────────────
test('kind: audio with a measured duration is a voice note', () => {
  assert.equal(msgKind('audio/webm', 12.4), 'voice');
  assert.equal(msgKind('audio/mp4', 0), 'voice'); // 0 s is still a recording
});
test('kind: audio without a duration, or anything non-audio, is a file', () => {
  assert.equal(msgKind('audio/mpeg', null), 'file');
  assert.equal(msgKind('audio/mpeg', undefined), 'file');
  assert.equal(msgKind('image/jpeg', 5), 'file');
  assert.equal(msgKind(undefined, 5), 'file');
});

// ── notifyTargets ─────────────────────────────────────────────────────
const MEMBERS = [
  { user_id: 1, muted: 0, last_seen_at: null },                     // never opened the thread
  { user_id: 2, muted: 0, last_seen_at: '2026-07-28T11:59:30Z' },   // watching right now
  { user_id: 3, muted: 1, last_seen_at: null },                     // muted the room
  { user_id: 4, muted: 0, last_seen_at: '2026-07-28T11:55:00Z' },   // walked away 5 min ago
];
test('targets: sender, muted, and live watchers stay silent', () => {
  assert.deepEqual(notifyTargets(MEMBERS, 1, NOW), [4]);
});
test('targets: the away threshold is strict — exactly 120 s still counts as watching', () => {
  const m = [{ user_id: 5, muted: 0, last_seen_at: '2026-07-28T11:58:00Z' }];
  assert.deepEqual(notifyTargets(m, 9, NOW), []);
  const m2 = [{ user_id: 5, muted: 0, last_seen_at: '2026-07-28T11:57:59Z' }];
  assert.deepEqual(notifyTargets(m2, 9, NOW), [5]);
});
test('targets: a never-seen member always gets the bell', () => {
  assert.deepEqual(notifyTargets([{ user_id: 7, muted: 0, last_seen_at: null }], 9, NOW), [7]);
});
test('targets: empty or missing input targets nobody', () => {
  assert.deepEqual(notifyTargets([], 1, NOW), []);
  assert.deepEqual(notifyTargets(null, 1, NOW), []);
});

// ── previewText ───────────────────────────────────────────────────────
test('preview: a tombstone hides everything, whatever the kind', () => {
  assert.equal(previewText({ kind: 'text', body: 'secret', removed_at: '2026-07-28T11:00:00Z' }), 'Message removed');
  assert.equal(previewText({ kind: 'voice', removed_at: '2026-07-28T11:00:00Z' }), 'Message removed');
});
test('preview: voice and file describe themselves', () => {
  assert.equal(previewText({ kind: 'voice', body: null }), 'Voice note');
  assert.equal(previewText({ kind: 'file', file_name: 'sheet.jpg' }), 'sheet.jpg');
  assert.equal(previewText({ kind: 'file', file_name: null }), 'File');
});
test('preview: text is trimmed to 80 chars with an ellipsis', () => {
  const long = 'x'.repeat(100);
  assert.equal(previewText({ kind: 'text', body: long }), `${'x'.repeat(80)}…`);
  const exact = 'y'.repeat(80);
  assert.equal(previewText({ kind: 'text', body: exact }), exact); // no ellipsis at the boundary
  assert.equal(previewText({ kind: 'text', body: '  hello  ' }), 'hello');
});
test('preview: a bodiless text message previews empty, not "null"', () => {
  assert.equal(previewText({ kind: 'text', body: null }), '');
  assert.equal(previewText({ kind: 'system', body: 'Shiv created the group' }), 'Shiv created the group');
});
