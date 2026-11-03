// Costing → Enquiry desk: customer enquiries from the mailbox, through costing and a person's final price,
// to a quotation answered in the customer's own thread (docs/superpowers/specs/2026-11-03-enquiry-desk-design.md).
//
//   Inbox · Costing · Final price · Quotations · Sent · Dropped · Settings (admin)
//
// "Fetch enquiries from mail" asks the AVS robot (Claude, with the mailbox's own Gmail) to read new mail and
// file the enquiries here. A reply is only ever saved as a Gmail draft — CI Plant never sends; the person sends it
// from Gmail. Finalise and Mark as sent need the Management right.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, Mail, Plus, RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Checkbox, DataTable, Field, Input, Select, SelectionDock, SubTabs, Textarea, useToast } from '../../components/ui.jsx';
import {
  DESK_TABS, QUOTE_LABEL, QUOTE_TONE, STAGE_TONE, adjustPrice, dateText, quantitiesText, qtyText, rupees,
} from '../../lib/enquiryUi.js';
import EnquiryDetail from './EnquiryDetail.jsx';
import QuotationPanel from './QuotationPanel.jsx';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function MailboxBadge({ box }) {
  if (!box) return <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-800">No mailbox in use</span>;
  const trial = box.send_to !== 'customers';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${box.key === 'trial' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}
      title={trial ? 'Replies from this mailbox go only to its own address' : 'Replies go to the customer'}>
      <Mail size={13} />{box.label.toUpperCase()} · {box.email}{trial ? ' · replies go only to itself' : ''}
    </span>
  );
}

function JobLine({ job }) {
  if (!job) return <span className="text-xs text-slate-500">No fetch yet.</span>;
  const r = job.result || {};
  const text = {
    queued: job.fire_status === 'fired' ? 'Claude has been started — it picks the job up in a minute or two.'
      : 'Waiting for Claude. It runs the job when the enquiry desk skill or the AVS robot next runs.',
    working: `${job.claimed_by || 'Claude'} is reading the mailbox…`,
    done: `Done ${dateText(job.finished_at)}${r.filed != null ? ` — ${plural(r.filed, 'mail')} filed${r.skipped ? `, ${r.skipped} filed before` : ''}` : ''}.`,
    failed: `Failed: ${job.error}`,
    cancelled: 'Cancelled.',
  }[job.status];
  return <span className={`text-xs ${job.status === 'failed' ? 'text-red-700' : 'text-slate-600'}`}>Last fetch (job {job.id}, {job.mailbox_email}): {text}</span>;
}

export default function EnquiryDesk({ onPushSingle, onPushBulk, onOpenCosting }) {
  const toast = useToast();
  const [desk, setDesk] = useState(null);
  const [tab, setTab] = useState('inbox');
  const [rows, setRows] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState([]);
  const [open, setOpen] = useState(null);         // enquiry id or 'new'
  const [openQuote, setOpenQuote] = useState(null);
  const [prices, setPrices] = useState({});       // `${id}|${qty}` → the box's text
  const [adjust, setAdjust] = useState({ mode: 'add', amount: '' });
  const poll = useRef(null);

  const loadDesk = useCallback(() => api.get('/costing/enquiry-desk').then(setDesk), []);
  const stages = DESK_TABS.find(t => t.key === tab)?.stages;
  const loadRows = useCallback(() => {
    if (!stages) return Promise.resolve();
    return api.get(`/costing/enquiries?stage=${stages.join(',')}`).then(rs => {
      setRows(rs);
      setPrices(cur => {
        const next = { ...cur };
        for (const e of rs) for (const p of e.prices || []) {
          const k = `${e.id}|${p.qty}`;
          if (next[k] == null) next[k] = p.final != null ? String(p.final) : p.suggested != null ? String(p.suggested) : '';
        }
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const loadQuotes = useCallback(() => {
    if (tab === 'quote') return api.get('/costing/quotations?status=ready,queued,drafted').then(setQuotes);
    if (tab === 'sent') return api.get('/costing/quotations?status=sent').then(setQuotes);
    return Promise.resolve();
  }, [tab]);
  const reload = useCallback(() => Promise.all([loadDesk(), loadRows(), loadQuotes()]).catch(() => {}), [loadDesk, loadRows, loadQuotes]);

  useEffect(() => { loadDesk().catch(() => {}); }, [loadDesk]);
  useEffect(() => { setRows(null); setPicked([]); loadRows().catch(() => setRows([])); loadQuotes().catch(() => {}); }, [loadRows, loadQuotes]);

  // While a fetch is with Claude, look again every few seconds.
  const lastFetch = desk?.jobs?.find(j => j.kind === 'fetch');
  useEffect(() => {
    clearInterval(poll.current);
    if (!lastFetch || !['queued', 'working'].includes(lastFetch.status)) return undefined;
    poll.current = setInterval(() => { reload(); }, 6000);
    return () => clearInterval(poll.current);
  }, [lastFetch?.id, lastFetch?.status, reload]);

  const fetchMail = async () => {
    const r = await api.post('/costing/enquiry-desk/fetch', {});
    toast.success(r.already ? `Job ${r.job.id} is already with Claude` : r.fired?.ok ? 'Claude is reading the mailbox' : `Fetch queued (job ${r.job.id}) — waiting for Claude`);
    await loadDesk();
  };

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s || !rows) return rows || [];
    return rows.filter(e => [e.enquiry_no, e.customer_name, e.product_name, e.size_text, e.contact_email, e.mail_subject, e.quotation_no]
      .some(x => String(x || '').toLowerCase().includes(s)));
  }, [rows, search]);
  const pickedRows = shown.filter(e => picked.includes(e.id));
  const toggle = (r, on) => setPicked(p => (on ? [...new Set([...p, r.id])] : p.filter(x => x !== r.id)));
  const toggleAll = (rs, on) => setPicked(on ? rs.map(r => r.id) : []);
  const after = async (promise, done) => {
    const r = await promise;
    if (r?.skipped?.length) toast.info(`${plural(r.skipped.length, 'row')} could not move: ${r.skipped.map(s => s.enquiry_no).join(', ')}`);
    if (done) toast.success(done);
    setPicked([]);
    await reload();
    return r;
  };

  const counts = desk?.counts || {};
  const qc = desk?.quotation_counts || {};
  const views = [
    ...DESK_TABS.map(t => ({ key: t.key, label: t.label, count: t.stages.reduce((s, k) => s + (counts[k] || 0), 0) || null })),
    ...(desk?.can_admin ? [{ key: 'settings', label: 'Settings' }] : []),
  ];
  const quoteCount = (qc.ready || 0) + (qc.queued || 0) + (qc.drafted || 0);
  if (quoteCount) views[3] = { ...views[3], count: (views[3].count || 0) + quoteCount };

  const stageChip = e => <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${STAGE_TONE[e.stage]}`}>{desk?.statuses?.[e.stage] || e.stage}</span>;
  const baseCols = [
    { key: 'enquiry_no', label: 'No.', render: e => <span className="font-bold text-brand-600">{e.enquiry_no}</span> },
    { key: 'received', label: 'Received', sortValue: e => e.mail_received_at || e.created_at, render: e => dateText(e.mail_received_at || e.created_at) },
    { key: 'customer_name', label: 'Customer', render: e => <div><div className="font-semibold">{e.customer_name || '—'}</div><div className="text-[11px] text-slate-500">{e.contact_email || ''}</div></div> },
    { key: 'product_name', label: 'Product', render: e => <div><div className="font-semibold">{e.product_name || '—'}</div><div className="text-[11px] text-slate-500">{[e.size_text && `${e.size_text} mm`, e.mail_subject && `“${e.mail_subject}”`].filter(Boolean).join(' · ')}</div></div> },
    { key: 'quantities', label: 'Quantities', render: e => quantitiesText(e.quantities) },
    { key: 'stage', label: 'Status', render: stageChip },
  ];

  const priceCols = [
    ...baseCols.slice(0, 1), baseCols[2], baseCols[3],
    { key: 'costing_no', label: 'Costing', render: e => e.costing_no
      ? <button type="button" className="font-semibold text-brand-600 hover:underline" onClick={ev => { ev.stopPropagation(); onOpenCosting(e); }}>{e.costing_no}</button> : '—' },
    { key: 'prices', label: 'Quantity · costing proposes · your final price a carton', render: e => (
      <div className="space-y-1" onClick={ev => ev.stopPropagation()}>
        {(e.prices || []).map(p => {
          const k = `${e.id}|${p.qty}`;
          return (
            <div key={p.qty} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-right font-semibold">{qtyText(p.qty)}</span>
              <span className="w-20 text-right text-slate-500" title="The costing's quote price a carton at this quantity">{rupees(p.proposed, 3)}</span>
              <Input className="!h-8 w-24 text-right" inputMode="decimal" value={prices[k] ?? ''} onChange={ev => setPrices(x => ({ ...x, [k]: ev.target.value }))} />
              {p.changed && <span className="font-semibold text-amber-700" title={`Set against ${rupees(p.set_against, 3)}`}>costing changed</span>}
              {p.final != null && String(p.final) === String(prices[k]) && <span className="text-emerald-700">saved</span>}
            </div>
          );
        })}
      </div>
    ) },
    baseCols[5],
  ];

  const savePrices = async list => {
    const items = list.map(e => ({ id: e.id, prices: (e.prices || []).map(p => ({ qty: p.qty, final: Number(prices[`${e.id}|${p.qty}`]) })) }));
    const bad = items.find(it => it.prices.some(p => !(p.final > 0)));
    if (bad) { toast.error('Every quantity needs a final price above zero.'); return; }
    await after(api.put('/costing/enquiries/prices', { items }), `${plural(items.length, 'price')} saved`);
  };
  const applyAdjust = () => {
    setPrices(cur => {
      const next = { ...cur };
      for (const e of pickedRows) for (const p of e.prices || []) {
        const k = `${e.id}|${p.qty}`;
        const v = adjustPrice(next[k] || p.suggested, adjust);
        if (v != null) next[k] = String(v);
      }
      return next;
    });
  };

  const quoteCols = [
    { key: 'quotation_no', label: 'No.', render: x => <span className="font-bold text-brand-600">{x.quotation_no}</span> },
    { key: 'customer_name', label: 'Customer', render: x => <div><div className="font-semibold">{x.customer_name || '—'}</div><div className="text-[11px] text-slate-500">{x.contact_email || ''}</div></div> },
    { key: 'items', label: 'Items', render: x => `${new Set(x.lines.map(l => l.enquiry_no)).size}` },
    { key: 'total', label: 'Total', align: 'right', render: x => rupees(x.total) },
    { key: 'status', label: 'Status', render: x => <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${QUOTE_TONE[x.status]}`}>{QUOTE_LABEL[x.status]}</span> },
    { key: 'when', label: tab === 'sent' ? 'Sent' : 'Made', sortValue: x => x.sent_at || x.created_at, render: x => `${dateText(x.sent_at || x.created_at)} · ${x.sent_by_name || x.created_by_name || ''}` },
  ];

  if (!desk) return <div className="p-8 text-sm text-slate-400">Loading the enquiry desk…</div>;
  const mgmt = desk.can_finalise;
  const one = pickedRows.length === 1 ? pickedRows[0] : null;

  return (
    <div>
      <div className="glass mb-4 flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <MailboxBadge box={desk.in_use} />
        <div className="min-w-0 flex-1"><JobLine job={lastFetch} /></div>
        <Button variant="secondary" size="sm" onClick={() => setOpen('new')}><Plus size={14} className="mr-1 inline" />Add an enquiry</Button>
        <Button onClick={fetchMail} disabled={!desk.in_use}><Inbox size={15} className="mr-1.5 inline" />Fetch enquiries from mail</Button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SubTabs views={views} active={tab} onChange={k => { setTab(k); setSearch(''); }} />
        {stages && <Input className="!h-9 w-64" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, product, size, number…" />}
        {stages && <Button size="sm" variant="secondary" onClick={reload}><RefreshCw size={13} className="mr-1 inline" />Refresh</Button>}
      </div>

      {tab === 'settings' && <DeskSettings desk={desk} onSaved={loadDesk} />}

      {stages && tab === 'inbox' && (
        <p className="mb-2 text-xs text-slate-500">New mail lands here. Open a row to check what Claude read against the customer's mail, then push it to costing — one at a time, or several together.</p>
      )}
      {stages && tab === 'price' && (
        <p className="mb-2 text-xs text-slate-500">The costing proposes a price a carton for each quantity; the box starts at it, rounded up to the paisa. Type the price you want to quote, tick the rows and save. A Management login then finalises them.</p>
      )}
      {stages && (
        <DataTable rows={shown} columns={tab === 'price' ? priceCols : baseCols} onRowClick={e => setOpen(e.id)}
          selectable selectedIds={picked} onToggleRow={toggle} onToggleAll={toggleAll}
          defaultSort={{ key: 'received', dir: 'desc' }} serialNumber={false}
          empty={rows ? (tab === 'inbox' ? 'No new enquiries. Press "Fetch enquiries from mail".' : 'Nothing here.') : 'Loading…'} />
      )}

      {(tab === 'quote' || tab === 'sent') && (
        <div className="mt-6">
          <div className="mb-2 text-sm font-bold text-[#1D1D1F]">{tab === 'quote' ? 'Quotations' : 'Sent quotations'}</div>
          <DataTable rows={quotes} columns={quoteCols} onRowClick={x => setOpenQuote(x.id)} defaultSort={{ key: 'when', dir: 'desc' }} serialNumber={false}
            empty={tab === 'quote' ? 'No quotation yet — tick finalised enquiries above and press Generate quotation.' : 'Nothing sent yet.'} />
        </div>
      )}

      <SelectionDock open={pickedRows.length > 0} count={pickedRows.length} onClear={() => setPicked([])}
        summary={[...new Set(pickedRows.map(e => e.customer_name || e.contact_email).filter(Boolean))].join(' · ')}>
        {tab === 'inbox' && <>
          <Button size="sm" variant="secondary" onClick={() => after(api.post('/costing/enquiries/ready', { ids: picked }), 'Marked ready for costing')}>Ready for costing</Button>
          <Button size="sm" disabled={!one} title={one ? '' : 'Tick one enquiry'} onClick={async () => { await after(api.post('/costing/enquiries/push', { ids: [one.id] })); onPushSingle(one); }}>Push to single costing</Button>
          <Button size="sm" onClick={async () => { const ids = picked; await after(api.post('/costing/enquiries/push', { ids })); onPushBulk(ids); }}>Push to bulk costing</Button>
          <Button size="sm" variant="secondary" onClick={() => after(api.post('/costing/enquiries/drop', { ids: picked, reason: 'Not to be quoted' }), 'Dropped')}>Drop</Button>
        </>}
        {tab === 'costing' && <>
          <Button size="sm" disabled={!one} onClick={() => (one.costing_id ? onOpenCosting(one) : onPushSingle(one))}>{one?.costing_id ? 'Open its costing' : 'Cost it'}</Button>
          <Button size="sm" variant="secondary" onClick={() => onPushBulk(picked)}>Cost together (bulk)</Button>
          <Button size="sm" variant="secondary" onClick={() => after(api.post('/costing/enquiries/drop', { ids: picked, reason: 'Not to be quoted' }), 'Dropped')}>Drop</Button>
        </>}
        {tab === 'price' && <>
          <Select value={adjust.mode} onChange={e => setAdjust(a => ({ ...a, mode: e.target.value }))} className="!h-8 w-44">
            <option value="add">+ ₹ a carton</option><option value="pct">+ %</option><option value="round">Round up to ₹0.05</option>
          </Select>
          {adjust.mode !== 'round' && <Input className="!h-8 w-20" inputMode="decimal" value={adjust.amount} onChange={e => setAdjust(a => ({ ...a, amount: e.target.value }))} placeholder={adjust.mode === 'pct' ? '5' : '0.10'} />}
          <Button size="sm" variant="secondary" onClick={applyAdjust}>Apply to ticked</Button>
          <Button size="sm" onClick={() => savePrices(pickedRows)}>Save prices</Button>
          {mgmt && <Button size="sm" variant="success" onClick={async () => {
            const r = await api.post('/costing/enquiries/finalise', { ids: picked });
            if (r.refused?.length) toast.info(r.refused.map(x => `${x.enquiry_no} ${x.why}`).join('; '));
            if (r.done?.length) toast.success(`${r.done.length} ${r.done.length === 1 ? 'enquiry' : 'enquiries'} finalised — ready to quote`);
            setPicked([]); await reload();
          }}>Finalise prices</Button>}
        </>}
        {tab === 'quote' && <>
          <Button size="sm" onClick={async () => {
            const r = await api.post('/costing/quotations', { ids: picked });
            toast.success(r.quotations.length === 1 ? `${r.quotations[0].quotation_no} made` : `${r.quotations.length} quotations made — one per customer`);
            setPicked([]); await reload();
            if (r.quotations.length === 1) setOpenQuote(r.quotations[0].id);
          }}>Generate quotation</Button>
          <Button size="sm" variant="secondary" onClick={() => after(api.post('/costing/enquiries/reopen', { ids: picked }), 'Prices reopened')}>Reopen prices</Button>
        </>}
        {tab === 'dropped' && <Button size="sm" onClick={() => after(api.post('/costing/enquiries/restore', { ids: picked }), 'Brought back')}>Bring back</Button>}
      </SelectionDock>

      <EnquiryDetail id={open} statuses={desk.statuses} onClose={() => setOpen(null)} onChanged={reload}
        onOpenCosting={e => { setOpen(null); onOpenCosting(e); }} />
      <QuotationPanel id={openQuote} canMarkSent={mgmt} onClose={() => setOpenQuote(null)} onChanged={reload} />
    </div>
  );
}

// Admin: which mailbox is in use, who each replies to, and the quotation's standard words.
function DeskSettings({ desk, onSaved }) {
  const toast = useToast();
  const [boxes, setBoxes] = useState(desk.mailboxes);
  const [inUse, setInUse] = useState(desk.in_use?.key || 'trial');
  const [s, setS] = useState(desk.settings);
  const setBox = (key, patch) => setBoxes(bs => bs.map(b => (b.key === key ? { ...b, ...patch } : b)));
  const save = async () => {
    await api.put('/costing/enquiry-desk/settings', { mailboxes: boxes, in_use: inUse, settings: s });
    toast.success('Enquiry desk settings saved');
    onSaved();
  };
  return (
    <div className="glass max-w-4xl space-y-5 rounded-2xl p-4">
      <div>
        <div className="mb-1 text-sm font-bold">Mailboxes</div>
        <p className="mb-3 text-xs text-slate-500">Claude reads and answers the mailbox in use through its own Gmail connection (the AVS robot). The trial mailbox replies only to itself unless you allow customers here.</p>
        {boxes.map(b => (
          <div key={b.key} className="mb-2 grid items-end gap-3 sm:grid-cols-[120px_1fr_220px_110px]">
            <div className="text-sm font-bold">{b.label}</div>
            <Field label="Gmail address"><Input value={b.email} onChange={e => setBox(b.key, { email: e.target.value })} /></Field>
            <Field label="Replies go to">
              <Select value={b.send_to} onChange={e => setBox(b.key, { send_to: e.target.value })}>
                <option value="own">Its own address only</option><option value="customers">The customer</option>
              </Select>
            </Field>
            <Checkbox label="In use" checked={inUse === b.key} onChange={() => setInUse(b.key)} />
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Opening words of a reply"><Textarea value={s.opening} onChange={e => setS({ ...s, opening: e.target.value })} /></Field>
        <Field label="Closing words of a reply"><Textarea value={s.closing} onChange={e => setS({ ...s, closing: e.target.value })} /></Field>
        <Field label="Terms on every quotation"><Textarea rows={4} value={s.terms} onChange={e => setS({ ...s, terms: e.target.value })} /></Field>
        <Field label="First fetch looks back (days)"><Input inputMode="numeric" value={s.fetch_days} onChange={e => setS({ ...s, fetch_days: e.target.value })} /></Field>
      </div>
      <div className="text-xs text-slate-500">Claude link: {desk.claude_linked ? 'set (AVS → Setup) — Fetch and Send start Claude at once.' : 'not set on this database — jobs wait until the enquiry desk skill runs.'}</div>
      <Button onClick={save}>Save settings</Button>
    </div>
  );
}
