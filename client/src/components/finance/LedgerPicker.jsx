// LedgerPicker: a book's ledgers in the shared searchable Select (spec §10).
//
//   <LedgerPicker bookId={book.id} value={ledgerId} onChange={(id, ledger) => ...} />
//
// Types to search: the name, the code and the group all find a ledger ("rent", "RM-04", "debtors"). Each option shows its group as
// a hint, so two ledgers of one name in two groups can be told apart. `onChange` is given the ledger's id (null when it is cleared)
// and, as a second argument, the ledger itself: the entry form reads `is_party` off it to know which lines take bill details.
//
// Only active ledgers are offered. A ledger that has been switched off since a draft was saved is still SHOWN, as the picker's
// current value (marked "switched off"), so the line is not mistaken for one with no ledger; it cannot be picked again.
// `manualOnly` leaves out the ledgers kept for system entries, which a typed voucher is refused (the voucher form sets it).
//
// The ledgers come from GET /finance/books/:id/ledgers. A page that holds several pickers (the entry form has one per line) reads
// them once with useBookLedgers and hands the list to each picker through `ledgers` (null while they load: still handed, so the
// pickers wait for it and do not each go and ask), so a voucher of ten lines asks once. A picker given nothing asks for itself.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Select } from '../ui.jsx';

// The book's ledgers, switched-off ones included (the picker decides what to offer): { ledgers, failed, reload }.
// `ledgers` is null while they load. A read that fails leaves an empty list and `failed`: api.js has already said why when the
// server answered, and a dropped connection is `failed` and nothing more. `skip` is for a picker that was handed its list.
export function useBookLedgers(bookId, { skip = false } = {}) {
  const [state, setState] = useState({ ledgers: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (skip) return undefined;
    let live = true;
    setState({ ledgers: null, failed: false });
    api.get(`/finance/books/${bookId}/ledgers?include_inactive=1`)
      .then(answer => { if (live) setState({ ledgers: answer.ledgers, failed: false }); })
      .catch(() => { if (live) setState({ ledgers: [], failed: true }); });
    return () => { live = false; };
  }, [bookId, skip, attempt]);
  const reload = useCallback(() => setAttempt(n => n + 1), []);
  return { ...state, reload };
}

export default function LedgerPicker({
  bookId, value, onChange, ledgers: given, manualOnly = false, disabled = false, placeholder = 'Choose a ledger…', ...rest
}) {
  const handed = given !== undefined;
  const own = useBookLedgers(bookId, { skip: handed });
  const ledgers = handed ? given : own.ledgers;

  // `search` is what the Select matches a typed word against (the options form of <option data-search>): name, code and group.
  const options = useMemo(() => (ledgers ?? [])
    .filter(l => (l.active && (!manualOnly || l.manual_entry)) || String(l.id) === String(value))
    .map(l => ({
      value: l.id,
      label: l.active ? l.name : `${l.name} (switched off)`,
      search: [l.name, l.code, l.group_name].filter(Boolean).join(' '),
      group: l.group_name,
      disabled: !l.active || (manualOnly && !l.manual_entry),
    })), [ledgers, manualOnly, value]);

  const choose = e => {
    const raw = e.target.value;
    const id = raw === '' || raw == null ? null : Number(raw);
    onChange?.(id, id == null ? null : (ledgers ?? []).find(l => l.id === id) ?? null);
  };

  return (
    <Select
      options={options}
      value={value ?? ''}
      onChange={choose}
      disabled={disabled || ledgers == null}
      placeholder={ledgers == null ? 'Loading ledgers…' : placeholder}
      renderOption={item => (
        <span className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate font-medium">{item.label}</span>
          <span className="shrink-0 text-[11px] font-normal text-slate-400">{item.group}</span>
        </span>
      )}
      {...rest}
    />
  );
}
