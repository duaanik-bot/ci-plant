// "Turn on phone alerts" for new purchase orders (owner's request, 6 Oct 2026).
//
// Every new draft PO the order intake keys in is pushed to every phone that has
// notifications on (server: routes/drafts.js notifyNewDraftOrders). A phone that
// never turned them on hears nothing, so Sales Orders and the Drafts list ask
// each device once, with one button — the same subscribe path as the bell's own
// toggle (lib/webPush.js), and the same honest sentence when a device cannot
// (an iPhone must add the app to its Home Screen first).
import { useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { api } from '../api.js';
import { currentSubscription, readEnvironment, registerWorker, subscribe } from '../lib/webPush.js';
import { storage } from '../lib/safeStorage.js';
import { useToast } from './ui.jsx';

const DISMISS_KEY = 'ci_po_alert_prompt_dismissed';

export default function PhoneAlertsPrompt({ compact = false }) {
  const toast = useToast();
  const [st, setSt] = useState(null); // { can, on, message, key }
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => storage.getItem(DISMISS_KEY) === '1');

  const load = () => api.get('/push/key').then(async ({ enabled, key }) => {
    const support = readEnvironment(!!enabled);
    const sub = support.can ? await currentSubscription() : null;
    setSt({ can: support.can, state: support.state, on: !!sub, message: support.message, key });
  }).catch(() => setSt(null));
  useEffect(() => { load(); }, []);

  if (!st || st.on || st.state === 'server_off' || (hidden && !compact)) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      await registerWorker();
      const sub = await subscribe(st.key);
      if (!sub) { toast.info('Notifications were not allowed on this device'); await load(); return; }
      await api.post('/push/subscribe', { subscription: sub.toJSON() });
      await api.post('/push/test').catch(() => {});
      toast.success('Phone alerts on — a test buzz is on its way');
      await load();
    } catch (e) {
      toast.error(e?.message || 'Could not turn on alerts on this device');
    } finally { setBusy(false); }
  };
  const dismiss = () => { storage.setItem(DISMISS_KEY, '1'); setHidden(true); };

  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-xl bg-orange-50 px-3 py-2 text-xs text-orange-900 ring-1 ring-inset ring-orange-200 ${compact ? 'mb-3' : 'mb-3'}`}>
      <BellRing size={15} className="shrink-0 text-orange-600" />
      <span className="min-w-0 flex-1">
        <b>Get new purchase orders on this phone.</b>{' '}
        {st.can ? 'Each new PO the system keys in pings you here, so it can be checked and confirmed quickly.' : st.message}
      </span>
      {st.can && (
        <button type="button" onClick={turnOn} disabled={busy}
          className="rounded-full bg-orange-500 px-3 py-1 font-bold text-white hover:bg-orange-600 disabled:opacity-60">
          {busy ? 'Turning on…' : 'Turn on alerts'}
        </button>
      )}
      {!compact && (
        <button type="button" onClick={dismiss} title="Hide on this device" aria-label="Hide"
          className="rounded-full p-1 text-orange-700 hover:bg-orange-100"><X size={13} /></button>
      )}
    </div>
  );
}
