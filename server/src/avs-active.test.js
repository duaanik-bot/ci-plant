import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The side pane shows how many AVS checks are in progress (owner's request, 6 Oct 2026).

test('GET /avs/active only counts, never writes, and is off quietly without the avs schema', () => {
  const src = readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8');
  const i = src.indexOf("r.get('/avs/active'");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /count\(\*\) FILTER \(WHERE status = 'queued'\)/);
  assert.match(body, /count\(\*\) FILTER \(WHERE status = 'checking'\)/);
  assert.match(body, /deleted_at IS NULL/);
  assert.match(body, /active: row\.queued \+ row\.checking/);
  assert.match(body, /offWhenMissing/);
  assert.doesNotMatch(body, /\b(INSERT|UPDATE|DELETE)\b/);
});

test('Artwork Verification carries the live badge on desktop, phone and tablet', () => {
  const src = readFileSync(new URL('../../client/src/components/AppLayout.jsx', import.meta.url), 'utf8');
  assert.match(src, /api\.get\('\/avs\/active'\)/);
  assert.equal((src.match(/i(?:tem)?\.module === 'avs' && <AvsBadge/g) || []).length, 3);
});
