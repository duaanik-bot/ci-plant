import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button, Modal } from './ui.jsx';
import { bindSenderPicker } from '../lib/pickSender.js';

// "Send from which mailbox?" — asked on every quotation Send / Draft again (lib/pickSender.js). Each choice is a
// connected Gmail; the reply is saved there as a draft in the customer's own conversation. Closing sends nothing.
export default function SenderPicker() {
  const [ask, setAsk] = useState(null);
  useEffect(() => bindSenderPicker(q => setAsk(q)), []);
  if (!ask) return null;
  const done = v => { ask.resolve(v); setAsk(null); };
  // The company mailbox first: it is where customers write.
  const order = s => (s.key === 'business' ? 0 : 1);
  return (
    <Modal open title="Send from which mailbox?" onClose={() => done(undefined)}
      footer={<Button variant="secondary" onClick={() => done(undefined)}>Cancel</Button>}>
      <p className="mb-3 text-sm text-[#515154]">
        The reply is saved as a Gmail draft in that mailbox, in the customer's own conversation. Check it there and press Send.
      </p>
      <div className="flex flex-col gap-2">
        {[...ask.senders].sort((a, b) => order(a) - order(b)).map(s => (
          <button key={s.key} type="button" onClick={() => done(s.key)} autoFocus={s.key === (ask.current || 'business')}
            className="flex items-center gap-3 rounded-2xl border border-[#1D1D1F]/[0.08] bg-white/70 px-4 py-3 text-left hover:border-[#007AFF]/40 hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40">
            <Mail size={16} className="shrink-0 text-[#007AFF]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[#1D1D1F]">{s.email}</span>
              <span className="block text-xs text-[#86868B]">{s.key === 'business' ? 'Company mailbox' : 'Your own mailbox'}{s.key === ask.current ? ' · the enquiry came here' : ''}</span>
              {s.can_read === false && (
                <span className="block text-xs text-[#B25000]">Limited Gmail access — press Connect Gmail for it again in Settings to reply in the customer's thread</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
