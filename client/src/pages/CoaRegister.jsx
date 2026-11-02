// COA Register — every Certificate of Analysis the plant has issued, as filed in
// the mppchd Google Drive (COLOUR IMPRESSION › COA). A register, not a plant
// document: it is mirrored in by `npm run coa:sync` and reads none of the ERP's
// own data. Clicking a COA No. or product opens that COA right here, on screen.
// Viewing is the module tick; downloading the PDF is its own right
// (Masters → Users → "Download COA"), held on the server as well.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import { Button, DataTable, KpiCard, Modal, PageHeader, ResetFilters, rowMatches, useFilterReset, useToast } from '../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../components/FilterChip.jsx';
import { AlertTriangle, Building2, Download, FileCheck2, FileWarning, Lock, ReceiptText } from 'lucide-react';

const pdfUrl = (no, download) => `/api/coa-register/${encodeURIComponent(no)}/pdf${download ? '?download=1' : ''}`;
async function fetchPdf(no, download = false) {
  const res = await fetch(pdfUrl(no, download), { headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `The COA could not be fetched (${res.status}).`);
  }
  return res.blob();
}

// pdf.js, loaded only when a COA is first opened — it is a large chunk.
let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ||= (async () => {
    const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

// The COA drawn page by page onto canvases — on screen, in the module, with no
// browser PDF toolbar (whose own save button would step round the download right).
function CoaPdfView({ coaNo }) {
  const box = useRef(null);
  const [state, setState] = useState({ busy: true, error: null, pages: 0 });
  useEffect(() => {
    let dead = false;
    let doc = null;
    setState({ busy: true, error: null, pages: 0 });
    (async () => {
      try {
        const [pdfjs, blob] = await Promise.all([loadPdfjs(), fetchPdf(coaNo)]);
        doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (dead) return;
        const host = box.current;
        host.replaceChildren();
        const width = Math.max(320, host.clientWidth - 2);
        const ratio = window.devicePixelRatio || 1;
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (dead) return;
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = `${vp.width / ratio}px`;
          canvas.style.height = `${vp.height / ratio}px`;
          canvas.className = 'mx-auto mb-3 block rounded-lg bg-white shadow-card ring-1 ring-slate-200';
          canvas.oncontextmenu = e => e.preventDefault();
          host.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
        }
        if (!dead) setState({ busy: false, error: null, pages: doc.numPages });
      } catch (e) {
        if (!dead) setState({ busy: false, error: e.message || 'The COA could not be shown.', pages: 0 });
      }
    })();
    return () => { dead = true; doc?.destroy?.(); };
  }, [coaNo]);
  return (
    <div className="min-h-[320px] select-none rounded-2xl bg-slate-100/80 p-3">
      {state.busy && <div className="py-24 text-center text-sm text-slate-400">Opening the COA…</div>}
      {state.error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-700">
          <FileWarning size={14} className="mt-0.5 shrink-0" />{state.error}
        </div>
      )}
      <div ref={box} />
    </div>
  );
}

function Detail({ label, children, wide = false }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className="text-[10px] font-bold uppercase tracking-[0.07em] text-[#86868B]">{label}</div>
      <div className="mt-0.5 break-words text-[13px] font-semibold text-[#1D1D1F]">{children ?? '—'}</div>
    </div>
  );
}
const dash = v => (v == null || v === '' || v === '-' ? '—' : v);

export default function CoaRegister() {
  const toast = useToast();
  const [data, setData] = useState({ rows: [], can_download: false });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');
  const [customer, setCustomer] = useState('all');
  const [open, setOpen] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = () => api.get('/coa-register')
    .then(d => { setData(d); setLoadError(false); setLoaded(true); })
    .catch(() => { setLoadError(true); setLoaded(true); });
  useFallbackRefresh(load, { intervalMs: 120000 });

  const rows = data.rows;
  const canDownload = !!data.can_download;
  const filters = useFilterReset([[q, setQ, '', 'search'], [customer, setCustomer, 'all', 'customer']]);

  const customers = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.customer) m.set(r.customer, (m.get(r.customer) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  const shown = rows.filter(r =>
    (customer === 'all' || r.customer === customer)
    && (!q || rowMatches(r, q)));
  const lastSync = rows.reduce((m, r) => (r.synced_at && (!m || r.synced_at > m) ? r.synced_at : m), null);

  const download = async r => {
    setSaving(r.coa_no);
    try {
      const blob = await fetchPdf(r.coa_no, true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.file_name || `${r.coa_no}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      toast.error(e.message);
    } finally { setSaving(null); }
  };

  const openBtn = (r, children) => (
    <button type="button" onClick={e => { e.stopPropagation(); setOpen(r); }}
      className="text-left font-bold text-brand-600 underline-offset-2 hover:underline">
      {children}
    </button>
  );

  // Every column must fit the screen, so the second line of a cell carries what
  // would otherwise be a column of its own (generated date, job card). The whole
  // row opens the COA, so only Download needs a button.
  const sub = 'text-[11px] font-normal leading-4 text-slate-400';
  const columns = [
    { key: 'coa_no', label: 'COA No.', width: 'w-[104px]',
      render: r => <div>{openBtn(r, <span className="whitespace-nowrap">{r.coa_no}</span>)}<div className={`${sub} whitespace-nowrap`}>{r.date_generated ? fmt.date(r.date_generated) : ''}</div></div> },
    { key: 'invoice_no', label: 'Invoice', width: 'w-[104px]',
      render: r => <div className="whitespace-nowrap">{dash(r.invoice_no)}<div className={sub}>{r.invoice_date ? fmt.date(r.invoice_date) : ''}</div></div> },
    { key: 'customer', label: 'Customer', width: 'w-[124px]', render: r => <div className="leading-snug">{dash(r.customer)}</div> },
    { key: 'product', label: 'Product',
      render: r => <div className="leading-snug">{openBtn(r, r.product || r.coa_no)}<div className={sub}>{r.party_item_code || ''}</div></div> },
    { key: 'po_no', label: 'PO No. / Job card', width: 'w-[176px]',
      render: r => <div className="whitespace-nowrap">{dash(r.po_no)}<div className={sub}>{[r.po_date ? fmt.date(r.po_date) : '', r.job_card].filter(Boolean).join(' · ')}</div></div> },
    { key: 'qty', label: 'Qty', align: 'right', width: 'w-[64px]', render: r => (r.qty == null ? '—' : fmt.num(r.qty)) },
    { key: 'std_gsm', label: 'GSM', align: 'right', width: 'w-[52px]', render: r => (r.std_gsm == null ? '—' : fmt.num(r.std_gsm)) },
    ...(canDownload ? [{ key: '_pdf', label: '', align: 'right', sortable: false, width: 'w-[40px]', render: r => (
      <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); download(r); }} disabled={!r.pdf_size || saving === r.coa_no}
        title={r.pdf_size ? 'Download the PDF' : 'No PDF is filed for this COA in Drive'}>
        <Download size={13} />
      </Button>
    ) }] : []),
  ];
  // The export keeps every field as its own column, whatever the screen merges.
  const dateOf = key => r => (r[key] ? fmt.date(r[key]) : '');
  const exportColumns = [
    { key: 'coa_no', label: 'COA No.' },
    { key: 'invoice_no', label: 'Invoice' },
    { key: 'invoice_date', label: 'Invoice date', export: dateOf('invoice_date') },
    { key: 'company', label: 'Company' },
    { key: 'customer', label: 'Customer' },
    { key: 'product', label: 'Product' },
    { key: 'party_item_code', label: 'Party item code' },
    { key: 'po_no', label: 'PO No.' },
    { key: 'po_date', label: 'PO date', export: dateOf('po_date') },
    { key: 'job_card', label: 'Job card' },
    { key: 'qty', label: 'Qty', align: 'right', export: r => r.qty ?? '' },
    { key: 'std_gsm', label: 'GSM', align: 'right', export: r => r.std_gsm ?? '' },
    { key: 'date_generated', label: 'Generated', export: dateOf('date_generated') },
  ];

  return (
    <div>
      <PageHeader title="COA Register"
        subtitle={<>Every Certificate of Analysis issued, as filed in Drive (mppchd › COLOUR IMPRESSION › COA). Click a COA No. or product to open it.
          {lastSync && <> Last synced {fmt.dt(lastSync)}.</>}</>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard icon={FileCheck2} label="COAs" value={fmt.num(rows.length)} />
        <KpiCard icon={ReceiptText} label="Invoices" value={fmt.num(new Set(rows.map(r => r.invoice_no)).size)} />
        <KpiCard icon={Building2} label="Customers" value={fmt.num(customers.length)} />
      </div>

      <FilterRail className="mb-3 mt-4">
        {customers.length > 1 && (
          <FilterGroup label="Customer" divider={false}>
            <FilterChip label="All" on={customer === 'all'} onClick={() => setCustomer('all')} />
            {customers.map(([name, n]) => (
              <FilterChip key={name} label={name} count={n} on={customer === name} onClick={() => setCustomer(name)} />
            ))}
          </FilterGroup>
        )}
        {!canDownload && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400"
            title="Ask an admin to tick “Download COA” for your login in Masters → Users">
            <Lock size={11} /> View only — downloading needs the Download COA right
          </span>
        )}
      </FilterRail>

      {loadError && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last register loaded' : 'the COA register can’t load'}. Retrying…
        </div>
      )}
      {filters.dirty && (
        <div className="mb-2 flex justify-end">
          <ResetFilters filters={filters} shown={shown.length} total={rows.length} />
        </div>
      )}
      <DataTable
        exportName="coa-register"
        exportSubtitle="COA Register · as filed in Drive"
        searchValue={q} onSearchChange={setQ}
        searchPlaceholder="Search COA, invoice, product, PO, job card…"
        getRowId={r => r.coa_no}
        defaultSort={{ key: 'invoice_no', dir: 'desc' }}
        rows={shown}
        onRowClick={r => setOpen(r)}
        empty={!loaded ? 'Loading the register…' : loadError
          ? 'Server unreachable — nothing to show until it reconnects.'
          : rows.length ? 'No COA matches these filters.' : 'The register is empty — run the COA sync to bring it in from Drive.'}
        columns={columns}
        exportColumns={exportColumns}
        dense
      />

      <Modal open={!!open} onClose={() => setOpen(null)} size="xl"
        title={open ? <span className="inline-flex items-center gap-2"><ReceiptText size={16} className="text-brand-600" />COA {open.coa_no}</span> : ''}
        footer={open && <>
          {!canDownload && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400">
              <Lock size={12} /> Viewing only. Downloading needs the Download COA right.
            </span>
          )}
          <Button variant="secondary" onClick={() => setOpen(null)}>Close</Button>
          {canDownload && (
            <Button onClick={() => download(open)} disabled={!open.pdf_size || saving === open.coa_no}>
              <Download size={14} /> {saving === open.coa_no ? 'Downloading…' : 'Download COA'}
            </Button>
          )}
        </>}>
        {open && (
          <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
            <section className="ci-summary-panel h-fit">
              <div className="mb-3 text-right text-[11px] font-semibold text-slate-400">Line {dash(open.line_no)}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Detail label="Product" wide>{dash(open.product)}</Detail>
                <Detail label="Party item code">{dash(open.party_item_code)}</Detail>
                <Detail label="Job card">{dash(open.job_card)}</Detail>
                <Detail label="Customer" wide>{dash(open.customer)}</Detail>
                <Detail label="Company" wide>{dash(open.company)}</Detail>
                <Detail label="Invoice">{dash(open.invoice_no)}</Detail>
                <Detail label="Invoice date">{open.invoice_date ? fmt.date(open.invoice_date) : '—'}</Detail>
                <Detail label="PO No." wide>{dash(open.po_no)}</Detail>
                <Detail label="PO date">{open.po_date ? fmt.date(open.po_date) : '—'}</Detail>
                <Detail label="Qty">{open.qty == null ? '—' : fmt.num(open.qty)}</Detail>
                <Detail label="Std GSM">{open.std_gsm == null ? '—' : fmt.num(open.std_gsm)}</Detail>
                <Detail label="Date generated">{open.date_generated ? fmt.date(open.date_generated) : '—'}</Detail>
                <Detail label="Remarks">{dash(open.remarks)}</Detail>
                <Detail label="COA file" wide><span className="font-mono text-[11px]">{dash(open.file_name)}</span></Detail>
                <Detail label="Filed in Drive" wide><span className="font-mono text-[11px] text-slate-500">{dash(open.pdf_path || open.folder)}</span></Detail>
              </div>
            </section>
            {open.pdf_size
              ? <CoaPdfView coaNo={open.coa_no} />
              : (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-2xl bg-slate-100/80 p-6 text-center">
                  <FileWarning size={22} className="text-amber-500" />
                  <div className="text-sm font-semibold text-slate-600">No PDF is filed for this COA in Drive.</div>
                  <div className="max-w-sm text-xs text-slate-400">The register names <span className="font-mono">{dash(open.file_name)}</span>, but the last sync did not find it in the COA folder.</div>
                </div>
              )}
          </div>
        )}
      </Modal>
    </div>
  );
}
