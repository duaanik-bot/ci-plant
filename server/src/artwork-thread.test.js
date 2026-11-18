import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadMessages } from './artwork-thread.js';

// Gmail's thread (format=full) → messages a person can read. Invented people and text.
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
const hdr = (from, to, extra = []) => [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: 'RE: ALPHA KIT SIZE' }, ...extra];
const thread = {
  id: 't-1',
  messages: [
    { id: 'm2', internalDate: String(Date.parse('2026-11-17T09:40:00Z')), labelIds: ['SENT'],
      payload: { mimeType: 'multipart/mixed', headers: hdr('Office <office@plant.test>', 'Asha Rao <asha@client.test>', [{ name: 'Cc', value: 'qa@client.test' }]), parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64('Please Provide Approval,\r\n\r\nRegards') } },
          { mimeType: 'text/html', body: { data: b64('<p>Please Provide Approval,</p>') } }] },
        { mimeType: 'application/pdf', filename: 'PRF-CI-AW-0001-v2-1.pdf', body: { attachmentId: 'att-9', size: 81234 } }] } },
    { id: 'm1', internalDate: String(Date.parse('2026-11-17T09:26:45Z')), labelIds: ['INBOX'],
      payload: { mimeType: 'text/html', headers: hdr('Asha Rao <asha@client.test>', 'office@plant.test'),
        body: { data: b64('<div>Hello Sir,<br>Please find the <b>revised</b> artwork &amp; check the size.</div><style>.x{}</style>') } } },
    { id: 'm3', internalDate: String(Date.parse('2026-11-17T09:42:00Z')), labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: hdr('Care <care@client.test>', 'office@plant.test'),
        body: { data: b64('Approved, please go ahead.\n\nOn Mon, 17 Nov 2026 at 15:10, Office <office@plant.test> wrote:\n> Please Provide Approval,') } } },
    { id: 'm4', internalDate: String(Date.parse('2026-11-17T10:00:00Z')), labelIds: ['DRAFT'],
      payload: { mimeType: 'text/plain', headers: hdr('Office <office@plant.test>', 'care@client.test'), body: { data: b64('draft text') } } },
  ],
};

test('messages oldest first, with who, when, to/cc, and which are ours', () => {
  const m = threadMessages(thread, { own: 'office@plant.test' });
  assert.deepEqual(m.map(x => x.id), ['m1', 'm2', 'm3'], 'oldest first; drafts are not part of the trail');
  assert.equal(m[0].from, 'Asha Rao <asha@client.test>');
  assert.equal(m[0].at, '2026-11-17T09:26:45.000Z');
  assert.equal(m[1].ours, true);
  assert.equal(m[0].ours, false);
  assert.equal(m[1].cc, 'qa@client.test');
  assert.equal(m[1].subject, 'RE: ALPHA KIT SIZE');
});

test('the text: plain text preferred; HTML made readable; the quoted earlier mail kept apart', () => {
  const m = threadMessages(thread, { own: 'office@plant.test' });
  assert.equal(m[1].text, 'Please Provide Approval,\n\nRegards');
  assert.equal(m[0].text, 'Hello Sir,\nPlease find the revised artwork & check the size.');
  assert.equal(m[2].text, 'Approved, please go ahead.');
  assert.match(m[2].quoted, /^On Mon, 17 Nov 2026 at 15:10, Office <office@plant\.test> wrote:\n> Please Provide Approval,/);
});

test('attachments are listed with their name, kind, size and the id to fetch them', () => {
  const m = threadMessages(thread, { own: 'office@plant.test' });
  assert.deepEqual(m[1].attachments, [{ name: 'PRF-CI-AW-0001-v2-1.pdf', mime: 'application/pdf', size: 81234, attachment_id: 'att-9', message_id: 'm2' }]);
  assert.deepEqual(m[0].attachments, []);
});

test('a very long mail is cut, and says so; an empty thread is an empty list', () => {
  const long = { messages: [{ id: 'x', internalDate: '1', labelIds: [], payload: { mimeType: 'text/plain', headers: [], body: { data: b64('a'.repeat(40000)) } } }] };
  const [x] = threadMessages(long, { own: 'office@plant.test' });
  assert.ok(x.text.length <= 20100);
  assert.equal(x.cut, true);
  assert.deepEqual(threadMessages({}, { own: 'x' }), []);
});
