// Press Line-up — the ONE-PAGE report the plant shares on WhatsApp so every
// operator knows their press's running order for the shift. Machine lanes only
// — triage is a planner's worry, not the floor's. A4 LANDSCAPE, three
// colour-coded columns headed by the operator who follows each one; rows are
// two dense lines each so a hard-launch queue of 14-16 jobs per press still
// fits on the single page (beyond that a column says "+N more" rather than
// spill onto page two). Browser print = PDF.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { useToast } from '../components/ui.jsx';
import { ArrowLeft, User, FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { colourTypeOf, processOf, totalColoursOf, metallicNameOf } from '../lib/printColour.js';

// Same hue order as the board's lanes, print-strength tints.
const HUES = [
  { bar: 'bg-blue-600', tint: 'bg-blue-50', edge: 'border-blue-600', chip: 'bg-blue-100 text-blue-800' },
  { bar: 'bg-emerald-600', tint: 'bg-emerald-50', edge: 'border-emerald-600', chip: 'bg-emerald-100 text-emerald-800' },
  { bar: 'bg-violet-600', tint: 'bg-violet-50', edge: 'border-violet-600', chip: 'bg-violet-100 text-violet-800' },
  { bar: 'bg-teal-600', tint: 'bg-teal-50', edge: 'border-teal-600', chip: 'bg-teal-100 text-teal-800' },
];
// MEASURED with offsetHeight — getBoundingClientRect would report the preview's
// SCALED size, not layout pixels. Against a 601px landscape column body a row is
// 46px with a wrapped item name and 60px at its worst (long name plus a second
// line of flags), so 10 fits every realistic mix with room to spare. Beyond that
// a column shows "+N more" rather than spill onto page two. Type is px-sized and
// the sheet is pinned to printed dimensions, so this holds for the preview AND
// the exported PDF/JPG alike.
const MAX_ROWS = 10;
// A4 landscape inside 10mm margins, at 96dpi. The sheet is pinned to exactly
// this so the preview, the JPG, the PDF and a browser print all agree.
const SHEET_W = 1047;
const SHEET_H = 714;

const shortPress = name => {
  const m = /(\d+)\s*(?:\(|$)/.exec(name || '');
  return m ? `Press ${m[1]}` : (name || 'Press');
};
const isOverdue = d => {
  if (!d) return false;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return new Date(d) < t;
};

export default function PressLineup() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);   // 'pdf' | 'jpg' | null
  const [bigPrint, setBigPrint] = useState(false); // false = phone/A4, true = A3 noticeboard
  const [zoom, setZoom] = useState(1);      // preview scale — export always captures 1:1
  const sheetRef = useRef(null);
  const toast = useToast();

  useEffect(() => { api.get('/print-planning').then(setData); }, []);
  useEffect(() => {
    const old = document.title;
    document.title = `Press Line-up — ${fmt.date(new Date())}`;
    return () => { document.title = old; };
  }, []);
  // Fill the screen: scale the sheet to the largest size that still shows the
  // whole page. The DOM stays 1047×714 so exports and print stay pixel-exact —
  // only the on-screen presentation is scaled.
  useEffect(() => {
    const fit = () => setZoom(Math.max(0.4, Math.min(
      (window.innerWidth - 48) / SHEET_W,
      (window.innerHeight - 108) / SHEET_H,
    )));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Both exports share one capture of the sheet at 1:1 with the preview scale
  // lifted — html2canvas mis-positions inside a transformed ancestor.
  const capture = async (scale) => {
    const [{ default: html2canvas }] = await Promise.all([import('html2canvas')]);
    const el = sheetRef.current;
    const holder = el.parentElement;
    const prev = holder.style.transform;
    holder.style.transform = 'none';
    // A timer, NOT requestAnimationFrame: rAF is throttled to a standstill in a
    // background tab, so an export started from an unfocused window would hang
    // here forever with no error and the button stuck on "Preparing…".
    await new Promise(r => setTimeout(r, 60));
    try {
      // scale 2 → 2094×1428, ≈190 DPI across the A4 sheet: crisp on a phone and
      // in normal print. scale 4 → 4188×2856, ≈266 DPI once blown up to A3 for
      // the press noticeboard.
      return await html2canvas(el, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false });
    } finally { holder.style.transform = prev; }
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  // One download path for both formats. jsPDF's own doc.save() picks its
  // mechanism at runtime and silently does nothing in some embedded browsers,
  // so the PDF is emitted as a blob and saved through this same anchor.
  const download = (href, name, revoke) => {
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };
  // Two sizes, one layout. "Share" is the phone/WhatsApp file; "A3" is the same
  // sheet captured at twice the resolution and laid onto an A3 page for the
  // noticeboard by the press.
  const suffix = () => (bigPrint ? `-A3-${stamp()}` : `-${stamp()}`);
  const exportJpg = async () => {
    setBusy('jpg');
    try {
      const canvas = await capture(bigPrint ? 4 : 2);
      download(canvas.toDataURL('image/jpeg', 0.95), `Press-Lineup${suffix()}.jpg`);
      toast.success(bigPrint ? 'A3-resolution JPG saved' : 'JPG saved — ready to share');
    } catch (e) { toast.error(e?.message || 'Could not create the JPG'); }
    finally { setBusy(null); }
  };
  const exportPdf = async () => {
    setBusy('pdf');
    try {
      const canvas = await capture(bigPrint ? 4 : 2);
      const { jsPDF } = await import('jspdf');
      const img = canvas.toDataURL('image/jpeg', 0.95);
      let doc;
      if (bigPrint) {
        // A3 landscape (420×297). The sheet keeps its A4 proportions rather than
        // being stretched: fit it to the 400mm printable width and centre the
        // resulting 400×268.6 block vertically.
        doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
        const w = 400, h = w * (186 / 277);
        doc.addImage(img, 'JPEG', 10, (297 - h) / 2, w, h);
      } else {
        // The sheet IS 277×186mm inside 10mm margins — place it exactly there.
        doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        doc.addImage(img, 'JPEG', 10, 10, 277, 186);
      }
      download(URL.createObjectURL(doc.output('blob')), `Press-Lineup${suffix()}.pdf`, true);
      toast.success(bigPrint ? 'A3 PDF saved — for the noticeboard' : 'PDF saved — ready to share');
    } catch (e) { toast.error(e?.message || 'Could not create the PDF'); }
    finally { setBusy(null); }
  };

  if (!data) return null;

  const { cards, presses } = data;
  const lanes = presses.map(p => ({ press: p, jobs: cards.filter(c => c.machine_id === p.id) }));
  const totalJobs = lanes.reduce((s, l) => s + l.jobs.length, 0);
  const totalSheets = lanes.reduce((s, l) => s + l.jobs.reduce((x, c) => x + (c.sheets_issued || 0), 0), 0);
  const now = new Date();

  return (
    <div className="px-4 py-4 print:p-0">
      {/* This report prints LANDSCAPE — overrides the app-wide portrait rule
          while this page is mounted (it lives in its own tab). */}
      {/* The on-screen sheet is the PRINTED sheet, pixel for pixel: A4 landscape
          minus 10mm margins = 277×190mm ≈ 1047×718px at 96dpi. Type is sized in
          px and does NOT scale with the paper, so a preview at any other size
          would fit a different number of rows than the PDF — what you see here
          is exactly what the press group receives. */}
      <style>{`
        .lineup-sheet { width: 1047px; height: 714px; }
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          /* Printing takes the sheet at true paper size — the preview's
             fit-to-screen scaling is a screen concern only. */
          .lineup-shell { height: auto !important; display: block !important; }
          .lineup-zoom { transform: none !important; width: auto !important; }
          .lineup-sheet { width: 277mm !important; height: 186mm !important; }
        }
      `}</style>

      {/* Screen-only toolbar — pick a format, then share the file. */}
      <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-3">
        <Link to="/print-planning" className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800">
          <ArrowLeft size={14} /> Back to board
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {/* Same sheet, two sizes — the choice applies to both formats. */}
          <span className="inline-flex rounded-full border border-slate-200 bg-white p-0.5 text-[11px] font-bold">
            {[
              [false, 'Share', 'A4 · phone & WhatsApp'],
              [true, 'A3 wall print', 'Double resolution, A3 page'],
            ].map(([v, label, tip]) => (
              <button key={String(v)} title={tip} onClick={() => setBigPrint(v)} disabled={!!busy}
                className={`rounded-full px-3 py-1 transition-colors disabled:opacity-50 ${
                  bigPrint === v ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'}`}>
                {label}
              </button>
            ))}
          </span>
          <span className="hidden text-[11px] font-semibold text-slate-400 lg:inline">
            {bigPrint ? 'For the noticeboard by the press' : 'Save it, then share on the press WhatsApp group'}
          </span>
          <button onClick={exportPdf} disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:text-slate-900 disabled:opacity-50">
            {busy === 'pdf' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} className="text-red-500" />}
            {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
          </button>
          <button onClick={exportJpg} disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#007AFF] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#0069d9] disabled:opacity-50">
            {busy === 'jpg' ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
            {busy === 'jpg' ? 'Preparing…' : 'Download JPG'}
          </button>
        </div>
      </div>

      {/* Scaled preview shell — reserves the scaled height so the page never
          scrolls past the sheet, while the sheet itself stays 1:1 underneath. */}
      <div className="lineup-shell flex justify-center" style={{ height: SHEET_H * zoom }}>
        <div className="lineup-zoom" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', width: SHEET_W }}>

      {/* ============ THE SHEET (A4 landscape) ============ */}
      <div ref={sheetRef} className="lineup-sheet print-fit flex flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-lg print:rounded-none print:border-0 print:p-0 print:shadow-none">

        {/* Compact brand line — one row, everything in it */}
        <div className="flex items-center gap-3 pb-2">
          <span className="text-[14px] font-extrabold leading-[18px] tracking-tight">
            <span className="text-slate-900">Colour</span> <span className="text-blue-600">Impressions</span>
          </span>
          <span className="text-[8px] font-bold uppercase leading-[18px] tracking-[0.15em] text-slate-400">motionci.in</span>
          <span className="ml-auto text-[12px] font-extrabold uppercase leading-[18px] tracking-wide text-slate-900">Press Line-up</span>
          <span className="text-[9.5px] font-bold leading-[18px] tabular-nums text-slate-500">
            {now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
            <span className="mx-1 text-slate-300">·</span>
            {now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            <span className="mx-1 text-slate-300">·</span>
            {totalJobs} jobs · {fmt.num(totalSheets)} sh
          </span>
        </div>
        {/* Tri-colour brand rule mirroring the presses */}
        <div className="mb-2 flex h-[2px] overflow-hidden rounded-full">
          {lanes.map((_, i) => <span key={i} className={`flex-1 ${HUES[i % HUES.length].bar}`} />)}
        </div>

        {/* ============ PRESS COLUMNS ============ */}
        <div className="grid min-h-0 flex-1 gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(0, 1fr))` }}>
          {lanes.map(({ press, jobs }, i) => {
            const hue = HUES[i % HUES.length];
            const sheets = jobs.reduce((s, c) => s + (c.sheets_issued || 0), 0);
            const shown = jobs.slice(0, MAX_ROWS);
            const operator = press.operators?.[0]?.name || '—';
            return (
              <div key={press.id} className="flex flex-col overflow-hidden rounded-md border border-slate-200">
                {/* Compact press header — operator IS the addressee */}
                {/* html2canvas draws text near the TOP of its line box instead
                    of centring it, so the wider the gap between font-size and
                    line-height the further the glyphs drift and clip. Leading
                    stays ~1.2× here; breathing room comes from PADDING, which
                    the renderer honours exactly. */}
                <div className={`${hue.bar} px-2.5 pb-[7px] pt-[5px] text-white`}>
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-extrabold leading-[12px]">{shortPress(press.name)}</span>
                    {/* NO `truncate` here: overflow:hidden makes html2canvas
                        clip these glyphs along the bottom in the exported
                        JPG/PDF. Operator names are short — let them run. */}
                    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[9px] font-extrabold leading-[12px]">
                      <User size={9} className="shrink-0 opacity-80" /> {operator}
                    </span>
                    <span className="ml-auto shrink-0 text-[8px] font-bold leading-[12px] tabular-nums opacity-90">
                      {jobs.length} job{jobs.length === 1 ? '' : 's'} · {fmt.num(sheets)} sh
                    </span>
                  </div>
                </div>

                {/* Ordered queue — two dense lines per job */}
                <div className={`${hue.tint} flex-1 p-1.5`}>
                  {shown.map((c, j) => {
                    const running = c.printing_status === 'in_progress' || c.printing_status === 'partially_completed';
                    const held = c.printing_status === 'hold';
                    const late = isOverdue(c.delivery_date);
                    const expected = (c.sheets_issued || 0) * Math.max(1, c.children_per_parent || 1);
                    const pct = running && c.printed_so_far > 0 && expected > 0
                      ? Math.min(100, Math.round((100 * c.printed_so_far) / expected)) : null;
                    return (
                      <div key={c.id}
                        className={`mb-1 rounded border-l-[3px] bg-white px-2 py-[3px] shadow-sm last:mb-0 ${
                          held ? 'border-red-500' : running ? 'border-amber-500' : hue.edge}`}>
                        {/* The ITEM leads — it gets the full column width and
                            wraps rather than truncating — then the output no.
                            The JC and the quantities sit on the line below. */}
                        {/* No -webkit-line-clamp and no sub-font line-heights:
                            html2canvas (which renders the JPG and the PDF) does
                            not implement the webkit box model and clips tight
                            leading, so the export lost the second line of every
                            wrapped name. Plain wrapping with roomy leading
                            renders identically on screen and in the export. */}
                        <div className="flex items-start gap-1.5">
                          <span className={`mt-[1px] flex h-[13px] w-[15px] shrink-0 items-center justify-center rounded-sm ${hue.chip} text-[8.5px] font-extrabold leading-[11px] tabular-nums`}>{j + 1}</span>
                          {/* pb gives the descenders of a wrapped last line
                              clearance — html2canvas draws text slightly low,
                              so the meta line below would otherwise cover it. */}
                          <span className="min-w-0 flex-1 pb-[3px] text-[9px] font-extrabold leading-[12px] text-slate-900">
                            {c.product_name}
                          </span>
                          {c.output_no && <span className="shrink-0 text-[9px] font-extrabold leading-[11px] tabular-nums text-blue-600">{c.output_no}</span>}
                        </div>
                        {/* Wraps rather than clips: a job carrying several
                            flags must never push its status off the paper. */}
                        <div className="mt-[3px] flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-[21px] text-[8px] font-semibold leading-[10px] tabular-nums text-slate-500">
                          <span className="shrink-0 font-extrabold tracking-tight text-slate-700">{c.jc_number}</span>
                          {c.gang_number && <span className="shrink-0 rounded bg-violet-100 px-0.5 text-[7px] font-bold leading-[10px] text-violet-700">{c.gang_number}</span>}
                          <span className="shrink-0">{fmt.num(c.sheets_issued)} sh · {totalColoursOf(c) ?? '—'}c{c.qty_planned ? ` · ${fmt.num(c.qty_planned)} pcs` : ''}</span>
                          {/* This sheet is one A4 page at 7-8px, so ink earns a
                              chip only when it changes the set-up: spot colours
                              to match, or a metallic unit to hang. Plain CMYK
                              offset — the common case — stays silent. */}
                          {colourTypeOf(c) === 'CMYK + Pantone' && (
                            <span className="shrink-0 rounded bg-indigo-100 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-indigo-700"
                              title={c.pantone_codes || ''}>+PANT</span>
                          )}
                          {colourTypeOf(c) === 'Pantone' && (
                            <span className="shrink-0 rounded bg-violet-100 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-violet-700"
                              title={c.pantone_codes || ''}>PANT</span>
                          )}
                          {processOf(c) !== 'Offset' && (
                            <span className="min-w-0 truncate rounded bg-amber-100 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-amber-800"
                              title={c.metallic_details || ''}>
                              {metallicNameOf(c) ? `MET ${metallicNameOf(c)}` : 'METALLIC'}
                            </span>
                          )}
                          {running && (
                            <span className="shrink-0 rounded bg-amber-100 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-amber-800">
                              ▶ Printing{pct != null ? ` ${pct}%` : ''}
                            </span>
                          )}
                          {held && (
                            <span className="min-w-0 truncate rounded bg-red-100 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-red-700"
                              title={c.hold_reason || ''}>
                              ⏸ Hold{c.hold_reason ? ` — ${c.hold_reason}` : ''}
                            </span>
                          )}
                          {c.board_pending && <span className="shrink-0 rounded bg-red-50 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-red-600">Board</span>}
                          {c.tooling_ready === false && <span className="shrink-0 rounded bg-red-50 px-1 text-[7px] font-extrabold uppercase leading-[10px] text-red-600">Tooling</span>}
                          {c.delivery_date && (
                            <span className={`ml-auto shrink-0 ${late ? 'font-extrabold text-red-600' : ''}`}>
                              {late ? '⚠ ' : 'by '}{fmt.date(c.delivery_date)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {jobs.length > MAX_ROWS && (
                    <div className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-center text-[8px] font-bold text-slate-500">
                      +{jobs.length - MAX_ROWS} more — see the board
                    </div>
                  )}
                  {jobs.length === 0 && (
                    <div className="px-1.5 py-3 text-center text-[8.5px] font-bold text-slate-400">No jobs lined up</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-1.5 flex items-center justify-between border-t border-slate-100 pt-1 text-[8px] font-semibold leading-[12px] text-slate-400">
          <span>Follow your column top-to-bottom — the top job runs first · line-up as at {now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}, changes land on the board live</span>
          <span className="font-extrabold tracking-wide"><span className="text-slate-500">Colour</span> <span className="text-blue-600">Impressions</span> · Print Planning</span>
        </div>
        </div>{/* /lineup-sheet */}
        </div>{/* /lineup-zoom */}
      </div>{/* /lineup-shell */}
    </div>
  );
}
