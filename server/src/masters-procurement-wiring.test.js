import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('Masters exposes the procured item chips and their real data sources', () => {
  const source = read('client/src/pages/Masters.jsx');

  assert.match(source, /label: 'Products \/ Items We Supply'/);
  assert.match(source, /items: \['vendors', 'boards', 'plates', 'chemicals', 'blocks'\]/);
  assert.match(source, /label: 'Organisation & System'/);
  assert.match(source, /plates:\s*\{[\s\S]*endpoint: '\/plate-masters'/);
  assert.match(source, /chemicals:\s*\{[\s\S]*endpoint: '\/materials'/);
  assert.match(source, /blocks:\s*\{[\s\S]*endpoint: '\/tooling\/procurement\/block\/inventory'/);
});

test('Plate Masters use controlled size records while Blocks retain generic tooling masters', () => {
  const client = read('client/src/pages/Masters.jsx');
  const route = read('server/src/routes/tooling-procurement.js');

  assert.match(client, /allowed_components: \['cyan', 'magenta', 'yellow', 'black', 'pantone'\]/);
  assert.match(client, /endpoint: '\/plate-masters'/);
  assert.match(client, /block\/inventory\?all=1/);
  assert.match(route, /req\.query\.all === '1'/);
  assert.match(route, /AND ti\.active=1/);
});

test('chemical masters can persist their warehouse stock controls', () => {
  const route = read('server/src/routes/masters.js');

  assert.match(route, /materials: \[[^\]]*'min_stock'[^\]]*'max_stock'/);
});
