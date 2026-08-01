// Printable job card traveler — modelled on CI-Production's job-card PDF.
// One A4 sheet that walks the floor with the job: spec, materials issued,
// and a stage table with sign-off columns. Browser print = PDF.
//
// Every specification lives in ONE block at the top, headed by the board the job
// is actually on. Spec used to be three separate blocks (Planning / Artwork /
// Product Master) and the board sat in the last of them — so the first thing a
// cutter read was the run list, and the board was the last. It reads spec-first
// now, headed by ONE "Board & cutting plan" block: the master spec, every board
// the job actually runs on, and the full cut plan for each — because the board a
// job is on and the way it gets cut are the same decision, and splitting them
// across the sheet made the cutter read the identity at the top and the numbers
// he executes at the bottom. Any disagreement with what the warehouse actually
// issued is called out in the same block.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, shadeAge } from '../components/ui.jsx';
import { scLabel } from './shade-cards/lifecycle.js';
import { boardUsed, pktText } from '../lib/boardUsed.js';
import { packets } from '../lib/boardMath.js';
import { Printer, ArrowLeft } from 'lucide-react';

export default function JobCardPrint() {
  const { id } = useParams();
  const [jc, setJc] = useState(null);
  useEffect(() => { api.get(`/job-cards/${id}`).then(setJc); }, [id]);
  if (!jc) return null;

  const t = (fam) => (jc.tools || []).filter(x => x.family === fam);
  const block = t('block')[0]; const plate = t('plate')[0];
  // Shade card is LIVE from the Shade Card Management module (jc.shade_card):
  // number, revision, approval status and colour details flow straight onto the
  // traveler so the floor prints against the approved card, never a stale copy.
  const shade = jc.shade_card;
  // Shade-card age on the printed traveler — plain text (the chip is UI-only).
  // The module's creation date wins; the master date is the fallback.
  const shadeAgeInfo = shadeAge(shade?.creation_date || jc.shade_card_date);
  const shadeCardAgeText = shadeAgeInfo
    ? `${shadeAgeInfo.days} days (${shadeAgeInfo.label})${shadeAgeInfo.expired ? ' — EXPIRED' : ''}`
    : '—';
  // scLabel, not fmt.title: the four statuses read as plant English ("Sent to
  // Customer"), which fmt.title would render as "Sent To Customer". The old
  // "· Rev N" suffix is gone with the shade-card revision counter — it is no
  // longer maintained, so it printed "Rev 0" on every traveler in the plant.
  const scStatusText = shade ? scLabel(shade.status) : '—';
  const colorMode = jc.colors === 4 ? 'CMYK' : jc.colors ? `${jc.colors}C` : '—';
  const yieldTxt = jc.children_per_parent > 1 ? `${jc.children_per_parent} print sheets / parent` : '1:1';

  const board = boardUsed(jc);

  // The cut plan rows behind the Board & cutting plan block — every job with a
  // cutting stage gets them, single-board included, so the operator executes
  // straight off the paper with no ambiguity. Mixed job: one row per
  // jc.board_mix row (already enriched server-side with cut geometry — see
  // production.js's attachBoardMix/helpers.js's cutLayout). Single-board job:
  // one row built from the card's own effective board/child, using
  // jc.cut_layout — the same geometry function, so a solo job's arrangement
  // can never disagree with a mixed job's.
  const mixRows = jc.board_mix || [];
  // Every row carries the three counts the floor works in — packets (how the
  // store holds it), parent sheets (what goes on the guillotine) and child
  // sheets (what comes off) — so nobody converts in their head at the machine.
  const withCounts = r => ({
    ...r,
    packets: packets({ sheets_per_packet: r.sheets_per_packet }, r.sheets),
    child: r.cut?.count > 0 ? Math.round(Number(r.sheets || 0) * r.cut.count) : null,
  });
  const cutRows = (mixRows.length
    ? mixRows.map(r => ({ board_name: r.board_name, sheet_l: r.sheet_l, sheet_w: r.sheet_w, sheets: r.sheets, cut: r.cut, reason: r.reason, sheets_per_packet: r.sheets_per_packet }))
    : [{ board_name: board?.name, sheet_l: jc.sheet_l, sheet_w: jc.sheet_w, sheets: jc.sheets_issued, cut: jc.cut_layout, reason: null, sheets_per_packet: jc.sheets_per_packet }]
  ).map(withCounts);
  // The substitution REASON is deliberately not printed here. It is a planning
  // decision the planner records and the Board Mix panel keeps; the operator at
  // the guillotine needs the sizes and counts, not the why.
  const sheetSize = (l, w) => (l ? `${l}×${w}"` : '—');
  // Every board on a job cuts to the SAME finished child sheet — that is what
  // makes them substitutes at all — so this is one value, printed per row.
  const childSize = sheetSize(jc.child_l, jc.child_w);
  // Just the count. The (across × down) arrangement and the rotated flag were
  // noise at the machine — the operator needs how many pieces come off a sheet,
  // and the two sizes either side of this column already say which way it goes.
  const cutsLabel = cut => (cut?.count == null ? '—' : fmt.num(cut.count));

  // Who is on the press. Print Planning sets the press operator on the PRINTING
  // stage when it assigns the machine, so that is the authoritative name — the
  // card's own machine_name says which press, this says who is standing at it.
  // Trimmed: operator names are free-typed and often carry a trailing space.
  const pressOperator = (jc.stages || []).find(s => s.stage === 'printing')?.operator?.trim() || null;
  const cutTotalSheets = cutRows.reduce((s, r) => s + Number(r.sheets || 0), 0);
  const cutTotalOutput = cutRows.reduce((s, r) => s + Number(r.sheets || 0) * Number(r.cut?.count || 0), 0);
  // Packets total only when every row could be converted — a board with no
  // sheets_per_packet on its master would otherwise silently under-report the
  // pile the storeman has to pull.
  const cutTotalPackets = cutRows.every(r => r.packets != null)
    ? cutRows.reduce((s, r) => s + r.packets, 0)
    : null;

  // Parent sheet lives in the board band above — it is part of the board's
  // identity, not a separate fact — so it is deliberately absent here.
  const sheet = [
    ['Coating / Lamination', jc.coating && jc.coating !== 'none' ? fmt.title(jc.coating) : 'None'],
    ['Print Sheet', jc.child_l ? `${jc.child_l}×${jc.child_w}"` : '—'],
    ['Ups / Print Sheet', jc.ups],
    ['Print Sheets / Parent', yieldTxt],
  ];
  const planning = [
    ['Ordered Qty', `${fmt.num(jc.line_qty)} cartons`],
    ['Planned Qty', fmt.num(jc.qty_planned)],
    // What the plant actually made. Zero until the last stage closes, so it
    // reads as a dash on a card that has not run rather than a misleading 0.
    ['Qty Produced', jc.qty_produced ? `${fmt.num(jc.qty_produced)} cartons` : '—'],
    ['Parent Sheets Issued', fmt.num(jc.sheets_issued)],
    ['Sheets Required', jc.sheets_required != null ? fmt.num(jc.sheets_required) : '—'],
    // The press AND who is on it. Print Planning assigns both together, so a
    // card naming the machine without the operator sends the floor asking.
    ['Press', pressOperator ? `${jc.machine_name || '—'} · ${pressOperator}` : (jc.machine_name || '—')],
    ['Planned Date', fmt.date(jc.planned_date) || '—'],
    ['Delivery', fmt.date(jc.delivery_date)],
  ];
  const artwork = [
    ['Customer Approval', jc.artwork_customer_ok ? 'Approved' : 'Pending'],
    ['QA Approval', jc.artwork_qa_ok ? 'Approved' : 'Pending'],
    ['Lock', jc.artwork_locked ? 'Locked' : 'Open'],
    ['Colours', colorMode],
    ['Shade Card No', shade?.sc_number || jc.shade_card_number || '—'],
    ['Shade Approval', scStatusText],
    ['Shade Card Age', shadeCardAgeText],
    ['Shade Ref', shade?.print_reference || shade?.colour_details || '—'],
    ['Block No', jc.block_number || block?.code || '—'],
    ['Output No', jc.output_number || '—'],
    ['Emboss', jc.emboss ? 'Yes' : 'No'],
    ['Leafing', jc.leafing ? 'Yes' : 'No'],
    ...(jc.leafing ? [['Leafing Colour', jc.leafing_colour ? fmt.title(jc.leafing_colour) : '—']] : []),
  ];
  const product = [
    ['Product Code', jc.product_code],
    ['Carton Size', jc.size || '—'],
    ['Pasting', jc.pasting_type ? fmt.title(jc.pasting_type) : '—'],
    ['Die', jc.die_number ? `#${jc.die_number}${jc.die_location ? ` · ${jc.die_location}` : ''}` : '—'],
  ];

  // One group inside the single spec block: a faint full-width caption, then its
  // fields on the shared 4-column grid. Captions keep the merged block scannable
  // without paying for three separate block headers.
  const Group = ({ title, rows }) => (
    <>
      <div className="col-span-4 mt-1 border-b border-gray-200 pb-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-gray-400">
        {title}
      </div>
      {rows.map(([k, v]) => (
        <div key={k}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{k}</div>
          <div className="font-semibold text-gray-900">{v ?? '—'}</div>
        </div>
      ))}
    </>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/production"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print Job Card</Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:border-0 print:shadow-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">
              {jc.gang_parent ? 'Gang Production Job Card' : 'Production Job Card'}
            </div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink-900">{jc.jc_number}</h1>
            <p className="mt-0.5 text-sm text-gray-600">
              {jc.gang_parent && jc.gang_members?.length
                ? `${jc.gang_number} — ${jc.gang_members.length} jobs on one run (until die cutting)`
                : jc.product_name}
            </p>
          </div>
          <div className="text-right text-xs text-gray-600">
            <div className="text-sm font-extrabold text-ink-900">COLOUR IMPRESSIONS</div>
            <div>Customer: <b>{jc.customer_name}</b></div>
            <div>PO: <b>{jc.po_number}</b> · Released {fmt.date(jc.created_at)}</div>
            <div className="mt-1 inline-flex gap-1.5">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase">{jc.status}</span>
              {jc.finalised_at && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">Finalised</span>}
            </div>
          </div>
        </div>

        {/* Job Specification — ALL of it, at the top, board first. */}
        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between border-b-2 border-gray-300 pb-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-600">Job Specification</div>
            <div className="text-[10px] text-gray-400">
              Product #{jc.product_id} · Plan {fmt.date(jc.planned_date) || '—'} · Artwork {jc.artwork_locked ? 'Locked' : 'Open'}
            </div>
          </div>

          {/* Board & Cutting Plan — ONE section, boxed, above every other field.
              The board a job runs on and the way it is cut are the same
              decision, and splitting them across the card meant the cutter read
              the identity at the top and the executable numbers at the bottom.
              Everything the guillotine needs is here: which boards, what size
              they are, what they cut to, how many cuts, and the three counts —
              packets pulled, parents on the machine, children off it. */}
          <div className="mb-3 rounded border-2 border-ink-900 px-3 py-2">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Board &amp; cutting plan</div>
              <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">
                {board?.differsFromMaster ? 'Job board — not the master' : 'Product master board'}
                {mixRows.length > 1 && ` · ${jc.board_mix_phase === 'plan' ? 'As planned' : 'As issued'} · ${mixRows.length} boards`}
              </div>
            </div>

            {/* The master spec first — what the carton is specced on — so the
                difference reads before the boards, not as a footnote after. */}
            <div className="mt-1 text-xs text-gray-600">
              Product master specs <b className="text-ink-900">{board?.masterName || board?.name || '—'}</b>
              {board?.differsFromMaster
                ? ' — this job was moved onto the board(s) below in Planning.'
                : ' — this job runs on its master board.'}
            </div>

            <table className="mt-2 w-full text-xs [&_td]:pr-3 [&_th]:pr-3 [&_td:last-child]:pr-0 [&_th:last-child]:pr-0">
              <thead><tr className="border-b border-gray-300 text-left text-[9px] font-bold uppercase tracking-wide text-gray-500">
                {/* Read left to right as the work happens: pull this board at
                    this parent size — that many packets, that many parent
                    sheets — make this many cuts, and you get this child size,
                    that many child sheets. Every size sits beside its own
                    counts instead of both sizes bunching at the front. */}
                <th className="py-1">Board</th>
                <th className="w-[13%] py-1 text-right">Parent Size</th>
                <th className="w-[10%] py-1 text-right">Packets</th>
                <th className="w-[13%] py-1 text-right">Parent Sheets</th>
                <th className="w-[11%] py-1 text-right">No. of Cuts</th>
                <th className="w-[12%] py-1 text-right">Cut To</th>
                <th className="w-[13%] py-1 text-right">Child Sheets</th>
              </tr></thead>
              <tbody>
                {cutRows.map((r, n) => (
                  <tr key={n} className="border-b border-gray-100">
                    <td className="py-1.5 font-extrabold text-ink-900">{r.board_name || '—'}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{sheetSize(r.sheet_l, r.sheet_w)}</td>
                    <td className="py-1.5 text-right font-bold tabular-nums">{pktText(r.packets) ?? '—'}</td>
                    <td className="py-1.5 text-right font-bold tabular-nums">{fmt.num(r.sheets)}</td>
                    <td className="py-1.5 text-right tabular-nums">{cutsLabel(r.cut)}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{childSize}</td>
                    <td className="py-1.5 text-right font-bold tabular-nums">{r.child != null ? fmt.num(r.child) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              {cutRows.length > 1 && (
                <tfoot>
                  <tr className="font-extrabold text-ink-900">
                    <td className="py-1.5" colSpan={2}>Total — {cutRows.length} boards</td>
                    <td className="py-1.5 text-right tabular-nums">{pktText(cutTotalPackets) ?? '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(cutTotalSheets)}</td>
                    <td className="py-1.5" colSpan={2} />
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(cutTotalOutput)}</td>
                  </tr>
                </tfoot>
              )}
            </table>

            {board?.issuedElsewhere.map(m => (
              <div key={m.material_id} className="mt-1 text-xs font-bold text-gray-900">
                ⚠ Issued from <b>{m.name}</b> — {fmt.num(m.qty)} {m.unit} actually consumed.
              </div>
            ))}
          </div>

          <div className="grid grid-cols-4 gap-x-6 gap-y-2.5 text-sm">
            <Group title="Sheet & Finish" rows={sheet} />
            <Group title="Product" rows={product} />
            <Group title="Artwork" rows={artwork} />
            <Group title="Planning" rows={planning} />
          </div>
        </div>

        {/* Gang run — every product travelling on this one physical card.
            The run stays combined through cutting → printing → die cutting,
            then splits into product-specific child job cards. */}
        {jc.gang_parent && jc.gang_members?.length > 0 && (
          <div className="mt-5">
            <div className="mb-1 flex items-baseline justify-between">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-600">Gang Run — {jc.gang_number}</div>
              <div className="text-[10px] text-gray-400">travels together · separates after die cutting</div>
            </div>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200 text-left text-[10px] font-bold uppercase text-gray-400">
                <th className="py-1">Product</th><th className="py-1">Code</th>
                <th className="py-1">Customer</th><th className="py-1">PO</th>
                <th className="py-1 text-right">Qty (pcs)</th><th className="py-1 text-right">Print Sheets</th>
              </tr></thead>
              <tbody>
                {jc.gang_members.map((m, n) => (
                  <tr key={n} className="border-b border-gray-50">
                    <td className="py-1.5 font-semibold">{m.product_name}</td>
                    <td className="py-1.5 font-mono">{m.product_code}</td>
                    <td className="py-1.5">{m.customer_name}</td>
                    <td className="py-1.5">{m.po_number}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(m.qty)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.sheets_required != null ? fmt.num(m.sheets_required) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Material Issued — compact traceability strip */}
        {jc.issues?.length > 0 && (
          <div className="mt-5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Material Issued (FIFO)</div>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200 text-left text-[10px] font-bold uppercase text-gray-400">
                <th className="py-1">Material</th><th className="py-1">Batch</th>
                <th className="py-1 text-right">Qty</th><th className="py-1 text-right">Issued On</th>
              </tr></thead>
              <tbody>
                {jc.issues.map((i, n) => (
                  <tr key={n} className="border-b border-gray-50">
                    <td className="py-1.5">{i.material_name}</td>
                    <td className="py-1.5 font-mono">{i.batch_no || '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(Math.abs(i.qty))} {i.unit}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.date(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Sign-off */}
        <div className="mt-10 grid grid-cols-3 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Planned By</div>
          <div className="border-t border-gray-300 pt-2">Finalised By</div>
          <div className="border-t border-gray-300 pt-2">QA Release</div>
        </div>
      </div>
    </div>
  );
}
