// The two small pieces every Finance report shares: the period boxes and the line that says a report did not come.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Field, Input } from '../ui.jsx';
import { finIsValidDate } from '../../lib/finance/fy.js';
import { finRangeProblem } from '../../lib/finance/reports.js';

// One date box. It keeps what is being typed, because a date box passes through blank and half-typed states on its way to a day,
// and a page that took the value back at every keystroke would fight the typing. The page hears only a real day; leaving the box
// blank or half typed puts the page's own day back.
function DayField({ label, value, onCommit, min, max }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return (
    <Field label={label} className="w-40">
      <Input type="date" value={text} min={min} max={max}
        onChange={e => {
          setText(e.target.value);
          if (finIsValidDate(e.target.value)) onCommit(e.target.value);
        }}
        onBlur={() => setText(value)} />
    </Field>
  );
}

// From and To, side by side, with the sentence for a period that ends before it starts (the report is not asked for such a period).
// `onChange({ from, to })` is given the whole period each time.
export function PeriodFields({ from, to, onChange }) {
  const problem = finRangeProblem(from, to);
  return (
    <>
      <DayField label="From" value={from} max={to} onCommit={day => onChange({ from: day, to })} />
      <DayField label="To" value={to} min={from} onCommit={day => onChange({ from, to: day })} />
      {problem && <p className="basis-full text-sm font-medium text-red-600">{problem}</p>}
    </>
  );
}

// The line above a table when its figures did not come. `shown` says whether older figures are still on the table below: they
// are, and they are old, and the line says so; otherwise there is nothing below it to trust. A report that failed is never drawn
// as an empty one. `onRetry` returns the promise of the new request, so the button stays busy until it settles.
export function LoadNotice({ failed, shown, what, onRetry }) {
  if (!failed) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
      <AlertTriangle size={16} className="shrink-0" />
      <span>Couldn't load {what}{shown ? ' just now — showing the last figures loaded' : ''}.</span>
      <Button size="sm" variant="secondary" className="ml-auto" onClick={onRetry}>Retry</Button>
    </div>
  );
}
