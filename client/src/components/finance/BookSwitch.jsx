// The Finance book switch (spec §10): a segmented control of the books this login holds, Colour Impressions | Darbi
// Print Pack, on the shared Tabs. `value` is the current book's id and onChange is handed the id of the one picked.
// The Finance shell draws it only for a login that holds more than one book.
import { Tabs } from '../ui.jsx';

export default function BookSwitch({ books, value, onChange }) {
  return <Tabs tabs={books.map(book => ({ key: book.id, label: book.name }))} active={value} onChange={onChange} />;
}
