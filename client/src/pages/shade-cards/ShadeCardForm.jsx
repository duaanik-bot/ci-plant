// Creating a shade card is picking a sales order line. Everything the ERP
// already knows arrives read-only from /prefill; the operator types only the
// five things that exist nowhere else.
import { useEffect, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, Field, Input, Modal, Select, Textarea, searchText } from '../../components/ui.jsx';
import { Plus, AlertTriangle } from 'lucide-react';
import { today } from './lifecycle.js';

const EMPTY = {
  title: '', colour_system: '', num_colours: '', print_process: '', artwork_rev: '',
  print_reference: '', colour_details: '', expected_approval_date: '',
  creation_date: today(), location: '', remarks: '',
};

export default function ShadeCardForm({ meta, onClose, onCreated, toast }) {
  const [lines, setLines] = useState([]);
  const [lineId, setLineId] = useState('');
  const [pre, setPre] = useState(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState(false);

  // Every order line still owed to a customer, flattened, so one Select covers
  // "which job is this card for". GET /orders returns order headers only (no
  // embedded line detail), so the cross-order flat line list comes from
  // /sales/pendency instead — the same source Orders.jsx's Pendency tab reads.
  // Its demand filter already excludes cancelled, dispatched and fully-shipped
  // lines server-side: a shade card for work that has shipped is not a thing
  // anyone needs.
  useEffect(() => {
    api.get('/sales/pendency').then(({ lines: ls }) => {
      setLines((ls || []).map(l => ({ id: l.line_id, po_number: l.po_number, customer_name: l.customer_name,
                 product_name: l.product_name, product_code: l.product_code, qty: l.qty })));
    }).catch(() => toast.error('Could not load sales orders'));
  }, []);

  useEffect(() => {
    if (!lineId) { setPre(null); return; }
    api.get(`/shade-cards/prefill/${lineId}`).then(p => {
      setPre(p);
      setForm(f => ({ ...f,
        title: f.title || p.suggested_title,
        colour_system: f.colour_system || p.colour_system || '',
        num_colours: f.num_colours || (p.num_colours ?? ''),
      }));
    }).catch(() => toast.error('Could not read that sales order line'));
  }, [lineId]);

  const create = async () => {
    setBusy(true);
    try {
      const card = await api.post('/shade-cards', {
        order_line_id: +lineId, ...form,
        num_colours: form.num_colours ? +form.num_colours : null,
      });
      toast.success(`${card.sc_number} created`);
      await onCreated(card.id);
    } catch (e) {
      toast.error(e.message || 'Could not create the shade card');
    } finally { setBusy(false); }
  };

  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-3 py-1">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="text-right font-semibold text-slate-800">{value || '—'}</dd>
    </div>
  );

  return (
    <Modal open onClose={onClose} title="New Shade Card" wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!lineId || !form.title.trim() || busy} onClick={create}>
          <Plus size={14} /> Create
        </Button>
      </>}>
      <div className="space-y-3">
        <section className="ci-form-panel">
          <div className="ci-form-panel-title">Which order is this card for?</div>
          <Field label="Sales order line" required>
            <Select value={lineId} onChange={e => setLineId(e.target.value)}>
              <option value="">Select a sales order…</option>
              {lines.map(l => (
                <option key={l.id} value={l.id} data-search={searchText(l)}>
                  {l.po_number} — {l.customer_name} · {l.product_name} ({fmt.num(l.qty)})
                </option>))}
            </Select>
          </Field>
        </section>

        {pre && (
          <section className="ci-summary-panel p-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              From the sales order — nothing to type
            </div>
            <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
              <Row label="Sales order" value={pre.po_number} />
              <Row label="Customer" value={pre.customer_name} />
              <Row label="Product" value={pre.product_name && `${pre.product_name} · ${pre.product_code}`} />
              <Row label="Order quantity" value={pre.order_qty != null && fmt.num(pre.order_qty)} />
              <Row label="Artwork code (AW)" value={pre.artwork_no} />
              <Row label="Output code" value={pre.output_no} />
              <Row label="Board" value={pre.board} />
              <Row label="Printing specs" value={pre.print_specs} />
            </dl>
            {!pre.output_no && (
              <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-amber-700">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                This product has no Output Code in the master, so the card cannot be
                checked against one. Add it on the Product Master when you know it.
              </p>)}
          </section>
        )}

        <section className="ci-form-panel">
          <div className="ci-form-panel-title">What only you know</div>
          <div className="ci-form-grid">
            <Field label="Shade card name" required className="sm:col-span-2">
              <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Colour system">
              <Select value={form.colour_system} onChange={e => setForm({ ...form, colour_system: e.target.value })}>
                <option value="">Select…</option>
                <option value="CMYK">CMYK</option>
                <option value="Pantone">Pantone</option>
                <option value="CMYK + Pantone">Hybrid (CMYK + Pantone)</option>
              </Select>
            </Field>
            <Field label="Number of colours">
              <Input type="number" min="1" value={form.num_colours}
                onChange={e => setForm({ ...form, num_colours: e.target.value })} />
            </Field>
            <Field label="Print process">
              <Select value={form.print_process} onChange={e => setForm({ ...form, print_process: e.target.value })}>
                <option value="">Select…</option>
                {['Offset', 'UV Offset', 'Digital', 'Flexo', 'Gravure', 'Screen'].map(x =>
                  <option key={x} value={x}>{x}</option>)}
              </Select>
            </Field>
            {/* Typed, not inherited: the ERP has no artwork revision column
                anywhere, so there is nothing to auto-populate this from. */}
            <Field label="Artwork revision" hint="No source in the ERP yet — type it if the customer quoted one">
              <Input value={form.artwork_rev} onChange={e => setForm({ ...form, artwork_rev: e.target.value })} />
            </Field>
            <Field label="Expected approval by" hint="Drives the Overdue tile">
              <Input type="date" value={form.expected_approval_date}
                onChange={e => setForm({ ...form, expected_approval_date: e.target.value })} />
            </Field>
            <Field label="Card made on" hint="Starts the 365-day age clock">
              <Input type="date" value={form.creation_date}
                onChange={e => setForm({ ...form, creation_date: e.target.value })} />
            </Field>
            <Field label="Print reference" hint="Pantone refs / press notes carried onto the Job Card">
              <Input value={form.print_reference}
                onChange={e => setForm({ ...form, print_reference: e.target.value })} />
            </Field>
            <Field label="Physical location">
              <Input value={form.location} placeholder="QC Cabinet…"
                onChange={e => setForm({ ...form, location: e.target.value })} />
            </Field>
            <Field label="Colour details" className="sm:col-span-2">
              <Textarea value={form.colour_details}
                onChange={e => setForm({ ...form, colour_details: e.target.value })} />
            </Field>
            <Field label="Remarks" className="sm:col-span-2">
              <Textarea value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  );
}
