// CI Plant's own Gmail line (server/src/gmail.js): the token sealed at rest, the e-mail built right, the consent asked
// for exactly two permissions — and Gmail's send is called from ONE place only, sendToCompany, which can address nobody
// but the company's own mailbox (the order sheet, owner 12 Nov 2026). Invented addresses and figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GMAIL_TOKEN_KEY = 'ab'.repeat(32);
const g = await import('./gmail.js');

test('the refresh token is sealed: it round-trips, is never stored in clear, and a changed byte or key is refused', () => {
  const sealed = g.sealToken('1//refresh-token-xyz');
  assert.doesNotMatch(sealed, /refresh-token-xyz/);
  assert.notEqual(sealed, g.sealToken('1//refresh-token-xyz'), 'a fresh IV each time');
  assert.equal(g.openToken(sealed), '1//refresh-token-xyz');
  const parts = sealed.split('.');
  const body = Buffer.from(parts[3], 'base64'); body[0] ^= 1;
  assert.throws(() => g.openToken([...parts.slice(0, 3), body.toString('base64')].join('.')), e => e.expired === true);
  const was = process.env.GMAIL_TOKEN_KEY;
  process.env.GMAIL_TOKEN_KEY = 'cd'.repeat(32);
  assert.throws(() => g.openToken(sealed), /key changed/);
  process.env.GMAIL_TOKEN_KEY = was;
});

test('consent: offline, the two Gmail permissions plus Drive for KLDs (files CI Plant makes) and only those, the mailbox as the hint', () => {
  const u = new URL(g.consentUrl({ redirectUri: 'https://plant.test/api/gmail/callback', state: 's1', loginHint: 'box@plant.test' }));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.deepEqual(u.searchParams.get('scope').split(' ').sort(),
    ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.metadata']);
  assert.equal(u.searchParams.get('login_hint'), 'box@plant.test');
  assert.equal(u.searchParams.get('state'), 's1');
});

test('not set up: no Google settings → clearly refused, not a crash', () => {
  const was = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(g.gmailConfigured(), false);
  assert.throws(() => g.consentUrl({ redirectUri: 'x', state: 'y' }), /not set up/);
  process.env.GOOGLE_CLIENT_SECRET = was;
  assert.equal(g.gmailConfigured(), true);
});

test('the e-mail: threaded headers, text + HTML, the PDF attached, Unicode subject encoded, no header injection', () => {
  const pdf = Buffer.from('%PDF-1.4 invented');
  const mime = g.buildMime({
    from: 'box@plant.test', to: ['buyer@customer.test'], subject: 'Re: Rates — ₹ cartons\r\nBcc: evil@x.test',
    text: 'Dear Sir,\nPlease find our quotation.', html: '<p>Dear Sir,</p>', inReplyTo: '<abc@mail.test>', references: '<root@mail.test>',
    attachment: { name: 'CI-QTN-0001.pdf', bytes: pdf }, boundary: 'B',
  });
  const head = mime.split('\r\n\r\n')[0];
  assert.match(head, /^From: box@plant\.test\r\nTo: buyer@customer\.test\r\nSubject: =\?UTF-8\?B\?/);
  assert.doesNotMatch(head, /^Bcc:/m, 'a newline in the subject cannot add a header');
  assert.match(head, /^In-Reply-To: <abc@mail\.test>$/m);
  assert.match(head, /^References: <root@mail\.test> <abc@mail\.test>$/m);
  const subj = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(head)[1];
  assert.equal(Buffer.from(subj, 'base64').toString('utf8'), 'Re: Rates — ₹ cartons Bcc: evil@x.test');
  assert.ok(mime.includes(Buffer.from('Dear Sir,\nPlease find our quotation.').toString('base64')));
  assert.match(mime, /Content-Disposition: attachment; filename="CI-QTN-0001\.pdf"/);
  assert.ok(mime.includes(pdf.toString('base64')));
  assert.ok(mime.trimEnd().endsWith('--mix_B--'));
  assert.equal(Buffer.from(g.rawOf(mime), 'base64url').toString('utf8'), mime);
});

test('CI Plant sends to nobody but the company: the only Gmail send is sendToCompany, used only by the order sheet', () => {
  const SEND = /(messages|drafts)\/send|\/send['"`]\s*,\s*\{\s*raw|users\/me\/messages\/send/g;
  const dirs = [new URL('./', import.meta.url), new URL('./routes/', import.meta.url)];
  const importers = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter(x => x.endsWith('.js') && !x.endsWith('.test.js'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      if (/\bsendToCompany\b/.test(src) && f !== 'gmail.js') importers.push(f);
      if (f === 'gmail.js') continue;
      assert.doesNotMatch(src, SEND, `${f} calls Gmail send`);
    }
  }
  assert.deepEqual(importers, ['enquiries.js'], 'only the enquiry desk (its order sheet) uses sendToCompany');
  const gm = readFileSync(new URL('./gmail.js', import.meta.url), 'utf8');
  const hits = [...gm.matchAll(SEND)];
  assert.equal(hits.length, 1, 'one send in gmail.js');
  const from = gm.indexOf('export async function sendToCompany');
  const to = gm.indexOf('\n}\n', from);
  assert.ok(from > 0 && hits[0].index > from && hits[0].index < to, 'and it is inside sendToCompany');
  const writes = [...gm.matchAll(/gmailCall\(token, '(POST|PUT|DELETE|PATCH)', `?'?([^`',]+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(writes.sort(), ['POST /drafts', 'POST /messages/send', 'PUT /drafts/${encodeURIComponent(draftId)}'].sort(),
    'the only Gmail writes are draft create / update and the company send');
});

test('sendToCompany addresses only the company mailbox: one recipient, no Cc, and refuses a bad address', async () => {
  const seen = [];
  const was = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    return { status: 200, ok: true, statusText: 'OK', json: async () => ({ id: 'm-1', threadId: 't-1' }) };
  };
  try {
    const out = await g.sendToCompany('tok', { from: 'box@plant.test', company: 'Office@Plant.test', subject: 'Order finalised — X',
      text: 'hello', html: '<p>hello</p>', attachments: [{ name: 'KLD 1.pdf', bytes: Buffer.from('%PDF-1.7 a'), mime: 'application/pdf' }] });
    assert.deepEqual(out, { message_id: 'm-1', thread_id: 't-1' });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/messages\/send$/);
    const mime = Buffer.from(seen[0].body.raw, 'base64url').toString('utf8');
    assert.match(mime, /^To: office@plant\.test$/m);
    assert.doesNotMatch(mime, /^(Cc|Bcc):/mi);
    assert.match(mime, /filename="KLD 1\.pdf"/);
    for (const bad of ['', 'not-an-address', 'a@b.test, c@d.test', 'x@y.test\r\nBcc: z@w.test', null]) {
      await assert.rejects(g.sendToCompany('tok', { from: 'box@plant.test', company: bad, subject: 's', text: 't' }), /company mailbox/);
    }
    assert.equal(seen.length, 1, 'nothing sent for a bad address');
  } finally { globalThis.fetch = was; }
});

test('reply to everyone: Reply-To (else the sender) in To, everyone else in Cc, never the mailbox itself', () => {
  const hdr = { from: 'Buyer J <buyer@customer.test>', to: 'box@plant.test', cc: 'a@customer.test, "B, Purchase" <b@customer.test>, Box <BOX@plant.test>, sales@plant.test' };
  assert.deepEqual(g.replyAll(hdr, 'box@plant.test'), { to: ['buyer@customer.test'], cc: ['a@customer.test', 'b@customer.test', 'sales@plant.test'] });
  assert.deepEqual(g.replyAll({ ...hdr, replyTo: 'orders@customer.test' }, 'box@plant.test').to, ['orders@customer.test']);
  const mime = g.buildMime({ to: ['buyer@customer.test'], cc: ['a@customer.test', 'b@customer.test'], subject: 'Re: x', text: 'hi', boundary: 'B' });
  assert.match(mime, /^Cc: a@customer\.test, b@customer\.test$/m);
  assert.doesNotMatch(mime, /Content-Disposition: attachment/, 'no attachment unless one is given');
});
