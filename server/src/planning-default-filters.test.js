import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const planning = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');

test('Planning opens on To Plan with the All set-type chip selected', () => {
  assert.match(planning, /const \[tab, setTab\] = useState\('pending'\);/);
  assert.match(planning, /const \[subTab, setSubTab\] = useState\('all'\);/);
});
