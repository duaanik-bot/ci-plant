// CashTiles: the accounts row of the Cash & Bank page (spec §5, §5.3, §5.4, §5.5). Props:
//   { accounts, selectedId, onSelect(ledgerId), mayEnter, onShortcut(kind, account), onCount(account) }
//
// One tile per active bank or cash account of the book, in the order GET /finance/cash/accounts sends them (office cash, then the
// holders, then the banks), each with its balance as at today from posted lines. Clicking a tile shows that account's book below it.
//   • A holder's tile says what the holder holds and the set float, if there is one, and carries the three shortcuts of §5.3, each a
//     plain Transfer opened ready to save: Give cash (from office cash), Top up (only when the holder holds less than the float: the
//     amount that brings it back) and Return (back to office cash). They are entries, so a login that cannot enter one does not see
//     them (`mayEnter`); the server refuses regardless.
//   • A cash account's last count is said under its balance. Its difference shows amber until a later count matches or the difference
//     is cleared, and says so while its clearing waits for the MD. The count line opens the account's counts (onCount), where Clear is.
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { Button } from '../ui.jsx';

const KIND_LABEL = { cash: 'Cash', holder: 'Holder', bank: 'Bank' };

// What a tile says of its last count: { text, amber }, or null for an account never counted (or a bank, which is never counted).
function countLine(count) {
  if (!count) return null;
  const day = `Counted ${finDateText(count.count_date)}`;
  const gap = count.difference_paise;
  if (gap === 0) return { text: `${day} · matched`, amber: false };
  if (count.cleared_voucher_id != null) return { text: `${day} · difference cleared`, amber: false };
  const what = `${gap < 0 ? 'short' : 'excess'} ${finFormatINR(Math.abs(gap))}`;
  return { text: `${day} · ${what}${count.clearing_waiting ? ' · clearing waits for approval' : ''}`, amber: true };
}

export default function CashTiles({ accounts, selectedId, onSelect, mayEnter, onShortcut, onCount }) {
  if (!accounts.length) return null;
  return (
    <div className="mb-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {accounts.map(account => {
        const holder = account.account_kind === 'holder';
        const selected = account.ledger_id === selectedId;
        const count = countLine(account.last_count);
        const below = account.balance_paise < 0 && account.account_kind !== 'bank';
        return (
          <div key={account.ledger_id}
            className={`glass flex flex-col rounded-2xl px-3 py-2.5 transition-[box-shadow,transform] duration-300 ease-apple hover:-translate-y-0.5 hover:shadow-lift
              ${selected ? 'ring-2 ring-[#0A84FF]/45' : count?.amber ? 'ring-1 ring-amber-300' : ''}`}>
            <button type="button" onClick={() => onSelect(account.ledger_id)} aria-pressed={selected}
              title={`Show the book of ${account.name}`} className="w-full min-w-0 text-left">
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">
                  {holder ? account.holder_name : account.name}
                </span>
                <span className="shrink-0 rounded-full bg-[#1D1D1F]/[0.05] px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-[#6E6E73]">
                  {KIND_LABEL[account.account_kind] ?? 'Account'}
                </span>
              </span>
              <span className={`mt-0.5 flex items-baseline gap-1.5 text-xl font-extrabold leading-tight tracking-[-0.03em] tabular-nums ${below ? 'text-amber-600' : 'text-slate-900'}`}>
                {holder && <span className="text-[11px] font-semibold tracking-normal text-[#6E6E73]">holds</span>}
                {finFormatINR(account.balance_paise)}
              </span>
              {holder && (
                <span className="mt-0.5 block truncate text-[11px] text-[#6E6E73]">
                  {account.float_paise != null ? `float ${finFormatINR(account.float_paise)}` : 'no float set'} · {account.name}
                </span>
              )}
            </button>
            {count && (
              <button type="button" onClick={() => onCount(account)} title="See this account's counts"
                className={`mt-1 w-full truncate rounded-md text-left text-[11px] font-medium hover:underline ${count.amber ? 'bg-amber-50 px-1.5 py-0.5 text-amber-700' : 'text-[#6E6E73]'}`}>
                {count.text}
              </button>
            )}
            {holder && mayEnter && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => onShortcut('give', account)}>Give cash</Button>
                {account.top_up_paise > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => onShortcut('top_up', account)}>Top up {finFormatINR(account.top_up_paise)}</Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => onShortcut('return', account)}>Return</Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
