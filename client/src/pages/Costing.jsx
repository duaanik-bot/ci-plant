// Costing — new-product costing worked out the way the plant's cost sheet does it, simple enough for
// anyone new to take out a costing. Tabs (?tab=): Enquiry desk · New costing · Bulk costing · Saved costings ·
// Size library · Rates & method. The desk pushes an enquiry to New costing (?enquiry=) or several to
// Bulk costing (?enquiries=). Open for admins and for logins given the Costing tick (it shows
// quotation prices); the server holds the same rule.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { api } from '../api.js';
import { GroupedTabs, PageHeader } from '../components/ui.jsx';
import SingleCosting from './costing/SingleCosting.jsx';
import BulkCosting from './costing/BulkCosting.jsx';
import CostingRegister from './costing/CostingRegister.jsx';
import CostingView from './costing/CostingView.jsx';
import SizeLibrary from './costing/SizeLibrary.jsx';
import CostingRates from './costing/CostingRates.jsx';
import EnquiryDesk from './costing/EnquiryDesk.jsx';

const GROUPS = [
  { label: 'Enquiries', items: [{ key: 'enquiries', label: 'Enquiry desk' }] },
  { label: 'Cost', items: [{ key: 'new', label: 'New costing' }, { key: 'bulk', label: 'Bulk costing' }] },
  { label: 'Records', items: [{ key: 'saved', label: 'Saved costings' }, { key: 'sizes', label: 'Size library' }] },
  { label: 'Settings', items: [{ key: 'rates', label: 'Rates & method' }] },
];
const KEYS = GROUPS.flatMap(g => g.items.map(i => i.key));

export default function Costing() {
  const [params, setParams] = useSearchParams();
  const [boot, setBoot] = useState(null);
  const [refused, setRefused] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [reload, setReload] = useState(0);
  const [startSize, setStartSize] = useState(null);

  const loadBoot = () => api.get('/costing/bootstrap').then(setBoot).catch(e => { if (e?.status === 403) setRefused(true); });
  useEffect(() => {
    loadBoot();
    api.get('/customers').then(cs => setCustomers(cs.filter(c => c.active !== 0))).catch(() => {});
  }, []);

  const asked = params.get('tab');
  const tab = KEYS.includes(asked) ? asked : 'new';
  const go = useCallback((key, extra = {}) => setParams(() => new URLSearchParams({ tab: key, ...extra }), { replace: false }), [setParams]);

  if (refused) {
    return (
      <div className="glass mx-auto mt-10 max-w-lg rounded-2xl p-6 text-center">
        <Lock className="mx-auto mb-2 text-slate-400" />
        <div className="font-bold">Costing is not ticked for this login</div>
        <p className="mt-1 text-sm text-slate-500">It shows quotation prices, so it opens only for logins given the Costing tick. Ask an admin to tick it in Masters → Users.</p>
      </div>
    );
  }
  if (!boot) return <div className="p-8 text-sm text-slate-400">Loading…</div>;

  return (
    <div>
      <PageHeader title="Costing" subtitle="Cost a new product the way our cost sheet does — check it against every earlier costing of the same size and the dies we hold" />
      <GroupedTabs groups={GROUPS} active={tab} onChange={key => { setStartSize(null); go(key); }} />
      {tab === 'new' && (
        <SingleCosting boot={boot} customers={customers} openId={params.get('id')} fromId={params.get('from')} startSize={startSize}
          enquiryId={params.get('enquiry')}
          onSaved={c => { setReload(n => n + 1); if (!params.get('id') || params.get('from')) go('new', { id: String(c.id) }); }}
          onFresh={() => { setStartSize(null); go('new'); }} />
      )}
      {tab === 'bulk' && <BulkCosting key={`${params.get('enquiries') || ''}|${params.get('batch') || ''}`} boot={boot} customers={customers}
        enquiryIds={(params.get('enquiries') || '').split(',').map(Number).filter(n => n > 0)} batchId={Number(params.get('batch')) || null} />}
      {tab === 'enquiries' && (
        <EnquiryDesk
          onPushSingle={e => go('new', { enquiry: String(e.id) })}
          onPushBulk={ids => go('bulk', { enquiries: ids.join(',') })}
          onOpenCosting={e => (e.batch_id ? go('bulk', { batch: String(e.batch_id) }) : e.costing_id ? go('new', { id: String(e.costing_id) }) : go('new', { enquiry: String(e.id) }))} />
      )}
      {tab === 'saved' && <CostingRegister onOpen={setViewing} reloadSignal={reload} />}
      {tab === 'sizes' && <SizeLibrary onCostSize={entry => { setStartSize(entry); go('new'); }} />}
      {tab === 'rates' && <CostingRates boot={boot} onSaved={loadBoot} />}
      <CostingView id={viewing} boot={boot} onClose={() => setViewing(null)}
        onRevise={id => { setViewing(null); go('new', { id: String(id) }); }}
        onCostAgain={id => { setViewing(null); go('new', { from: String(id) }); }}
        onChanged={() => setReload(n => n + 1)} />
    </div>
  );
}
