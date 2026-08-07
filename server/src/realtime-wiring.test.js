import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('operational screens subscribe to the shared realtime invalidation feed', () => {
  const files = [
    'client/src/components/AppLayout.jsx',
    'client/src/components/FgStockPanel.jsx',
    'client/src/pages/Dashboard.jsx',
    'client/src/pages/Dispatch.jsx',
    'client/src/pages/ExtraSheets.jsx',
    'client/src/pages/Floor.jsx',
    'client/src/pages/Inventory.jsx',
    'client/src/pages/Invoices.jsx',
    'client/src/pages/Orders.jsx',
    'client/src/pages/Planning.jsx',
    'client/src/pages/PrintPlanning.jsx',
    'client/src/pages/Procurement.jsx',
    'client/src/pages/Production.jsx',
    'client/src/pages/Reports.jsx',
    'client/src/pages/Section.jsx',
    'client/src/pages/ShadeCards.jsx',
    'client/src/pages/SortPaste.jsx',
    'client/src/pages/StatusSheet.jsx',
    'client/src/pages/Tooling.jsx',
  ];

  for (const file of files) {
    const source = read(file);
    assert.match(source, /useRealtimeRefresh\(/, `${file} should subscribe to database changes`);
    assert.match(source, /OPERATIONS_REALTIME_TABLES/, `${file} should use the shared table list`);
  }
});

test('realtime migration sends metadata only and keeps the trigger function private', () => {
  const migration = read('supabase/migrations/20260807100428_realtime_broadcast.sql');
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /revoke all on function public\.ci_erp_realtime_ping\(\) from public/);
  assert.match(migration, /'table', TG_TABLE_NAME/);
  assert.doesNotMatch(migration, /row_to_json|NEW,\s*OLD/i);
});
