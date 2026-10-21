// useParties: the ERP's customers and vendors, for a Finance screen that links a ledger to one (spec §6.4, §11.2). The ONE reader of them:
// the ledger form and the Opening Match step each used to carry a copy, and two copies drift (a failed read, a kind that changes under a form).
//
//   useParties('customer')   the customers          useParties('vendor')   the vendors
//   useParties('both')       the customers and the vendors, for a screen that offers either
//   useParties('')           nothing: no kind is chosen yet, and nothing is read
//
// Returns { customers, vendors, list, failed, retry }. A list that is not asked for, or is still loading, is null; `list` is the one list a
// single kind asked for. A read that fails is `failed`, with the lists that were asked for empty, and the screen says so: it is never an empty
// list that looks like "there are none". `retry` reads them again. Another kind is another read, and the lists of the kind before are not
// shown under it; an answer that comes back for a kind no longer asked for is dropped.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

const PATH = { customer: '/customers', vendor: '/vendors' };
const asked = kind => (kind === 'both' ? ['customer', 'vendor'] : kind === 'customer' || kind === 'vendor' ? [kind] : []);

export default function useParties(kind) {
  const [state, setState] = useState({ kind: '', customers: null, vendors: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const asks = asked(kind);
    if (asks.length === 0) return undefined;
    let live = true;
    const none = { customers: asks.includes('customer') ? [] : null, vendors: asks.includes('vendor') ? [] : null };
    setState({ kind, customers: null, vendors: null, failed: false });
    Promise.all(asks.map(k => api.get(PATH[k])))
      .then(lists => {
        if (!live) return;
        const got = Object.fromEntries(asks.map((k, i) => [k, lists[i]]));
        setState({ kind, customers: got.customer ?? null, vendors: got.vendor ?? null, failed: false });
      })
      .catch(() => { if (live) setState({ kind, ...none, failed: true }); });
    return () => { live = false; };
  }, [kind, attempt]);
  const mine = state.kind === kind;
  const customers = mine ? state.customers : null;
  const vendors = mine ? state.vendors : null;
  return {
    customers,
    vendors,
    list: kind === 'customer' ? customers : kind === 'vendor' ? vendors : null,
    failed: mine && state.failed,
    retry: () => setAttempt(n => n + 1),
  };
}
