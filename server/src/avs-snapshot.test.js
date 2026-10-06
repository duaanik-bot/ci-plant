import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobSnapshot, SNAPSHOT_LIMITS } from './avs-snapshot.js';

// The job snapshot (6 Oct 2026): one read-only answer for the check's prefetch.

const fake = (answers = {}, fail = {}) => {
  const seen = [];
  const run = async (text, params) => {
    seen.push({ text, params });
    for (const [k, code] of Object.entries(fail)) if (text.includes(k)) throw Object.assign(new Error(k), { code });
    for (const [k, rows] of Object.entries(answers)) if (text.includes(k)) return rows;
    return [];
  };
  return { run, seen };
};

test('snapshot only ever SELECTs', () => {
  const src = readFileSync(new URL('./avs-snapshot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE)\b/i);
});

test('a set with no job card asks nothing about production and still answers', async () => {
  const { run, seen } = fake();
  const s = await jobSnapshot(run, { id: 30, status: 'checking' });
  assert.equal(s.set.id, 30);
  assert.deepEqual(s.products, []);
  assert.deepEqual(s.order_lines, []);
  assert.deepEqual(s.limits, SNAPSHOT_LIMITS);
  assert.ok(seen.every(x => /^\s*SELECT/i.test(x.text)));
  assert.equal(seen.length, 1); // only the set's own documents
});

test('a set with a job card follows card -> product -> lines -> orders', async () => {
  const { run, seen } = fake({
    'WHERE jc.id = ANY': [{ id: 576, jc_number: 'CI-JC-0458', product_id: 160 }],
    'FROM products p': [{ id: 160, customer_id: 9, party_item_code: 'GLY-M1' }],
    'FROM order_lines ol JOIN orders o ON o.id = ol.order_id\n    WHERE ol.product_id': [{ id: 900, order_id: 77, product_id: 160 }],
  });
  const s = await jobSnapshot(run, { id: 30, job_card_id: 576 });
  assert.equal(s.products[0].id, 160);
  assert.equal(s.order_lines[0].order_id, 77);
  const flags = seen.find(x => x.text.includes('avs.order_flags'));
  assert.deepEqual(flags.params, [[77]]);
  const reports = seen.find(x => x.text.includes('avs.latest_reports'));
  assert.ok(reports.params[0].includes('GLY-M1'));
  assert.ok(seen.every(x => /^\s*SELECT/i.test(x.text)));
});

test('missing AVS tables answer empty lists; other errors are thrown', async () => {
  const ok = fake({ 'WHERE jc.id = ANY': [{ id: 1, product_id: 2 }], 'FROM products p': [{ id: 2 }] }, { 'avs.artwork_codes': '42P01' });
  const s = await jobSnapshot(ok.run, { id: 1, job_card_id: 1 });
  assert.deepEqual(s.avs.artwork_codes, []);
  const bad = fake({}, { 'avs.check_docs': '57014' });
  await assert.rejects(() => jobSnapshot(bad.run, { id: 1 }));
});

test('the robot route is behind the key and read only', () => {
  const src = readFileSync(new URL('./routes/avs-robot.js', import.meta.url), 'utf8');
  const i = src.indexOf("r.get('/avs/robot/job-snapshot/:setId'");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /keyOk\(req\)/);
  assert.match(body, /jobSnapshot\(/);
});
