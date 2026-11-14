// New enquiries stand out the way new POs do (owner, 14 Nov 2026: "like in the sales order, how things are getting
// highlighted when there are new sales orders. Like that, for the new costings"). The count is the Enquiry desk's
// Inbox — enquiries no one has started — for the logins that can open Costing (server: GET
// /costing/enquiry-desk/summary). Refreshed when enquiries change, and every two minutes as a backstop.
//
//   useEnquirySummary  { new, asked_again }
//   EnquiryBadge       the orange "N new" beside Costing in the side menu (corner = on an icon)
//   NEW_ENQUIRY_ROW    the orange row highlight for an Inbox row, as DRAFT_ROW is for a new PO
import { useState } from 'react';
import { api } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';

export const NEW_ENQUIRY_ROW = '!bg-orange-50 hover:!bg-orange-100/70 shadow-[inset_4px_0_0_#F97316]';
const EMPTY = { new: 0, asked_again: 0 };

export function useEnquirySummary(enabled = true) {
  const [s, setS] = useState(EMPTY);
  const load = () => api.get('/costing/enquiry-desk/summary').then(x => setS(x || EMPTY)).catch(() => {});
  useRealtimeRefresh(load, ['enquiries'], { debounceMs: 1500, enabled });
  useFallbackRefresh(load, { enabled, intervalMs: 120000 });
  return [s, load];
}

export const enquiryBadgeTip = s => `${s.new} new enquir${s.new === 1 ? 'y' : 'ies'} on the Enquiry desk, not started yet`
  + `${s.asked_again ? ` · ${s.asked_again} asked again this week` : ''}`;

export function EnquiryBadge({ isActive, corner = false }) {
  const [s] = useEnquirySummary(true);
  if (!s.new) return null;
  const n = s.new > 99 ? '99+' : s.new;
  const tip = enquiryBadgeTip(s);
  return (
    <span title={tip} aria-label={tip}
      className={`${corner ? 'absolute right-0.5 top-0.5 h-4 min-w-[16px] justify-center px-1 text-[9px]' : 'ml-auto gap-1 whitespace-nowrap px-1.5 text-[10px]'} flex items-center rounded-full font-bold tabular-nums ${isActive ? 'bg-white/25 text-white' : 'bg-orange-500 text-white'}`}>
      {corner ? n : `${n} new`}
    </span>
  );
}
