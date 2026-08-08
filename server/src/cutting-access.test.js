import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canAccess, canAccessSection } from '../../client/src/modules.js';

const authSource = readFileSync(new URL('./auth.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../../client/src/components/Chat.jsx', import.meta.url), 'utf8');

test('Cutting is visible to Production, Planning and MD while other stations stay scoped', () => {
  for (const role of ['production', 'planner', 'admin']) {
    const user = { role, modules: role === 'admin' ? null : ['production'], sections: ['printing'] };
    assert.equal(canAccess(user, 'floor'), true, `${role} should open Live Floor for Cutting`);
    assert.equal(canAccessSection(user, 'cutting'), true, `${role} should open Cutting`);
  }
  assert.equal(canAccessSection({ role: 'production', modules: ['floor'], sections: ['printing'] }, 'printing'), true);
  assert.equal(canAccessSection({ role: 'production', modules: ['floor'], sections: ['printing'] }, 'coating'), false);
});

test('server floor scope adds Cutting without widening a station-scoped account everywhere', () => {
  assert.match(authSource, /SELECT role, sections, machine_ids FROM users/);
  assert.match(authSource, /const sharedCutting = \['planner', 'production'\]\.includes\(u\?\.role\)/);
  assert.match(authSource, /!sections\.includes\('cutting'\)/);
});

test('chat people picker tolerates array and wrapped response shapes', () => {
  assert.match(chatSource, /const peopleList = data => Array\.isArray\(data\) \? data : Array\.isArray\(data\?\.users\)/);
  assert.match(chatSource, /const visibleUsers = peopleList\(users\)/);
});
