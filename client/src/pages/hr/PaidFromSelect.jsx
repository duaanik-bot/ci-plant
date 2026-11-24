// HR · where staff money was paid from, or received into (Cash & Bank spec §7.3, §11 item 2). One list for every HR door that
// moves money (Pay staff, Give advance, New loan, a loan prepayment, an advance sheet, Mark paid for the cash channel and for one
// line): office cash, each holder, and the banks HR's pay channels pay from, read from Finance (GET /hr/paid-from-options) once
// per mount. The labels are Finance's account names, never a balance; the value is the code HR stores, `fin:<ledger id>`.
//
//   value, onChange(code)  the chosen code; '' while nothing is chosen
//   channelCode            a pay channel's code, or `cash` (what HR has always stored for cash): when nothing is chosen yet and the
//                          list names the account that channel pays from, that account is chosen. Otherwise the choice is left
//                          empty: it is never guessed.
//   required               the form blocks its save without a choice, in the server's own words: paidFromProblem(value) is
//                          PAID_FROM_REQUIRED while the choice is empty.
//   whenNone               what the door records when no account is named, as the note says it ("it is recorded as cash").
//
// While Finance offers no account at all (its books are not set up yet), or its list cannot be read, there is nothing to choose
// (ruling R47): the select says so in a short note and hands the form null, so no form is held up, the form sends nothing, and the
// door takes cash (or, for a line paid again out of its batch, stays with the batch's account). HR is never held up by Finance's
// setup (§7.7).
import { useEffect, useRef, useState } from 'react';
import { Select } from '../../components/ui.jsx';
import { hrApi } from '../../lib/hr.js';

export const PAID_FROM_REQUIRED = 'Choose where it was paid from';

// A form's check before it saves: the server's sentence while a required choice is still empty, else null.
export const paidFromProblem = (value, required = true) => (required && value === '' ? PAID_FROM_REQUIRED : null);

// What a form sends: the code when one is chosen; nothing when Finance had none to offer.
export const paidFromBody = (key, value) => (value ? { [key]: value } : {});

export default function PaidFromSelect({ value, onChange, channelCode = null, required = false, whenNone = 'it is recorded as cash' }) {
  const [state, setState] = useState({ status: 'loading', options: [] });
  useEffect(() => {
    let live = true;
    hrApi.paidFromOptions().then(
      d => { if (live) setState({ status: 'ready', options: Array.isArray(d?.options) ? d.options : [] }); },
      () => { if (live) setState({ status: 'failed', options: [] }); }); // the central toast says why
    return () => { live = false; };
  }, []);

  // Once the list is in, or could not be read: the channel's own account when nothing is chosen yet (and the list names one), or
  // null when there is nothing to choose (ruling R47). Only once, so a choice the person clears stays cleared.
  const settled = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (settled.current || state.status === 'loading') return;
    settled.current = true;
    if (!state.options.length) { change.current(null); return; }
    if (value || !channelCode) return;
    const own = state.options.find(o => Array.isArray(o.channels) && o.channels.includes(channelCode));
    if (own) change.current(own.code);
  }, [state, value, channelCode]);

  const failed = state.status === 'failed';
  const none = failed || (state.status === 'ready' && !state.options.length);
  const placeholder = state.status === 'loading' ? 'Reading the accounts…'
    : failed ? 'The accounts could not be read'
      : none ? 'No account to choose yet' : 'Choose the account…';
  return (
    <div>
      <Select value={value || ''} placeholder={placeholder} disabled={state.status !== 'ready' || none} required={required && !none}
        options={state.options.map(o => ({ value: o.code, label: o.label }))}
        onChange={e => onChange(e.target.value || '')} />
      {none && (
        <span className={`mt-1 block text-xs ${failed ? 'font-medium text-red-600' : 'text-[#86868B]'}`}>
          {failed ? 'Finance’s accounts could not be read' : 'Finance has no account to offer yet'}, so {whenNone}.
          {failed ? ' Close this and open it again to choose one.' : ''}
        </span>
      )}
    </div>
  );
}
