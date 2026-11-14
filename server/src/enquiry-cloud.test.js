import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsFire, fireText, passHash, mintPass, tokenHint, cloudView, cloudKeys, REFIRE_AFTER_MIN } from './enquiry-cloud.js';

// Claude in the cloud for the Enquiry desk (enquiry-cloud.js): the start note, the pass, and when a waiting fetch is
// started again. The routes are tested against a real Postgres in enquiry-pg.test.js.

test('the start note carries the job and a one-time pass, and nothing the routine should act on beyond them', () => {
  const pass = mintPass();
  assert.ok(pass.length >= 30 && /^[A-Za-z0-9_-]+$/.test(pass));
  assert.notEqual(mintPass(), pass);
  const note = fireText({ id: 42, mailbox_email: 'trial@example.test' }, pass);
  assert.match(note, /^JOB=42$/m);
  assert.match(note, new RegExp(`^CI_JOB_TOKEN=${pass}$`, 'm'));
  // Kept as a hash only.
  assert.equal(passHash(pass).length, 64);
  assert.notEqual(passHash(pass), passHash(`${pass}x`));
});

test('a waiting fetch is started again only when it never started, its start failed, or it has waited too long', () => {
  const now = Date.parse('2026-11-12T06:00:00Z');
  const ago = min => new Date(now - min * 60e3).toISOString();
  assert.equal(needsFire(null), false);
  assert.equal(needsFire({ status: 'working', fire_status: 'cloud_failed' }, now), false);
  assert.equal(needsFire({ status: 'queued', fire_status: 'waiting', brief: {} }, now), true);
  assert.equal(needsFire({ status: 'queued', fire_status: 'cloud_failed', brief: {} }, now), true);
  assert.equal(needsFire({ status: 'queued', fire_status: 'cloud', brief: { fired_at: ago(2) } }, now), false);
  assert.equal(needsFire({ status: 'queued', fire_status: 'cloud', brief: { fired_at: ago(REFIRE_AFTER_MIN + 1) } }, now), true);
});

test('the desk sees whether the cloud is linked; only an admin sees the URL, and the token only as its last four characters', () => {
  const cfg = { routine_fire_url: 'https://api.anthropic.com/v1/claude_code/routines/trig_abc123/fire', routine_token: 'sk-ant-oat01-secretvalue9z' };
  assert.deepEqual(cloudView(cfg, false), { linked: true });
  assert.deepEqual(cloudView(cfg, true), { linked: true, fire_url: cfg.routine_fire_url, token_hint: '…ue9z' });
  assert.ok(!JSON.stringify(cloudView(cfg, true)).includes('secretvalue'));
  assert.deepEqual(cloudView({ routine_fire_url: '', routine_token: '' }, false), { linked: false });
  assert.equal(tokenHint(''), '');
});

// Each mailbox has its own routine (14 Nov 2026: the company mailbox's lives on the company Claude account, beside the
// AVS check routine, because that account's Gmail is the company mailbox): its own keys, never the AVS routine's.
test('each mailbox keeps its own routine link, under its own keys — never the AVS check routine\'s', () => {
  assert.deepEqual({ ...cloudKeys('trial') }, { url: 'enquiry_routine_fire_url', token: 'enquiry_routine_token' });
  assert.deepEqual({ ...cloudKeys('business') }, { url: 'enquiry_business_routine_fire_url', token: 'enquiry_business_routine_token' });
  assert.throws(() => cloudKeys('nonsense'), /mailbox/);
  const all = ['trial', 'business'].flatMap(k => Object.values(cloudKeys(k)));
  assert.equal(new Set(all).size, 4);
  assert.ok(!all.some(k => ['routine_fire_url', 'routine_token'].includes(k)));
});

test('the company routine\'s prompt: the company mailbox only, two values from the start note, read-only Gmail, CI Plant only through desk.py', () => {
  const p = readFileSync(new URL('../../client/src/lib/enquiry-robot/company-routine-prompt.md', import.meta.url), 'utf8');
  assert.match(p, /mppchd@gmail\.com/);
  assert.doesNotMatch(p, /dua\.anik/);
  assert.match(p, /JOB=<number> and\s+CI_JOB_TOKEN=<pass>/);
  for (const route of ['/api/avs/robot/enquiry-desk/desk.py', '/api/avs/robot/enquiry-desk/procedure']) assert.ok(p.includes(route), route);
  assert.match(p, /x-enquiry-job-token/);
  assert.match(p, /Never send, reply, forward or draft/);
  assert.doesNotMatch(p, /x-avs-robot-key|robot_key|execute_sql|supabase/i);
});
