// ─── Wide tables become cards on card-tier touch screens ─────────────────────
// DataTable already renders cards on phones and upright tablets. But ~80
// screens draw their OWN <table> (Procurement's lines, Payroll, costing,
// ledgers, drawers …), and on the iPhone Duo those panned sideways inside
// their scroller: an operator dragged a 14-column sheet left and right to read
// one row. On the Duo this turns any such table into one card per row — every cell on
// its own line, labelled with its column header — the way the app's own
// DataTable cards read.
//
// Rules of engagement:
//   • The iPhone Duo only (DUO_Q below). Regular iPhones, iPads and desktops
//     never run it, and the CSS that draws the cards is fenced to the same
//     media query, so a converted table is inert anywhere else.
//   • Only tables that DON'T FIT — wider than the box that holds them. A
//     three-column table that already reads fine stays a table.
//   • Never paper. Print documents (invoice, challan, PO, COA, payslip, job
//     card, voucher, press lineup) keep their printed layout; anything inside
//     .print-fit / .jc-sheet / [data-no-autocard] is skipped too, and a page
//     can opt a table out with data-no-autocard.
//   • DOM-only: it stamps a class and data-label attributes. React owns
//     neither, so re-renders keep them; new rows are stamped as they mount.
// The iPhone Duo in every posture, and nothing else: touch, 450–743 wide (folded
// or unfolded upright, folded on its side), or unfolded on its side (744–1023
// wide, landscape). Apple's iOS 27 kit: outer 466 x 678, inner 669 x 951.
// Folded on its side the outer screen is 678 x 466, but Safari's bars take
// ~50 of that height, so the floor is 380 tall plus "no wider than 7:4" —
// the Duo's 678 x ~416 is ~1.6. Regular phones on their side stay out: SE
// 667 x 375 is under 380, 8 Plus 736 x 414 and old Androids 732 x 412 are
// ~1.78; every other phone on its side is 744+ wide and under 450 tall. An
// iPad is 744+ upright and 1024+ on its side. Mirrored in index.css and the
// Tailwind `sm` screen.
export const DUO_Q = '(pointer: coarse) and (min-width: 450px) and (max-width: 743.98px) and (min-height: 380px) and (max-aspect-ratio: 7/4), '
  + '(pointer: coarse) and (orientation: landscape) and (min-width: 744px) and (max-width: 1023.98px) and (min-height: 450px)';
const duoQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DUO_Q) : null;

const PAPER_ROUTE = /\/(invoices\/[^/]+|dispatch\/challan\/[^/]+|po\/[^/]+|coas\/[^/]+|hr\/payslips\/[^/]+|production\/jobcard\/[^/]+|production\/jobcards\/print|print-planning\/lineup|vouchers\/[^/]+\/print)\/?$/;
const SKIP = '.print-fit, .jc-sheet, .lineup-sheet, [data-no-autocard]';
const CLS = 'ci-autocards';

function headerLabels(table) {
  const head = table.tHead;
  if (!head || head.rows.length === 0) return null;
  // The LAST header row names the columns (a first row may be a group band).
  const row = head.rows[head.rows.length - 1];
  const labels = [];
  for (const th of row.cells) {
    const text = (th.innerText || th.textContent || '').replace(/\s+/g, ' ').trim();
    const span = Math.max(1, th.colSpan || 1);
    for (let i = 0; i < span; i++) labels.push(text);
  }
  return labels;
}

// Columns the page itself hides at this size (`hidden`, `ph:hidden`, the
// tablet-only `ci-p3` fold) must stay hidden inside the cards — the card's
// cell rule would otherwise outrank those utilities and bring them back.
// Read from the HEADER before conversion, once, so later rows inherit it.
function hiddenColumns(table) {
  const head = table.tHead;
  if (!head || !head.rows.length) return new Set();
  const out = new Set();
  let col = 0;
  for (const th of head.rows[head.rows.length - 1].cells) {
    const span = Math.max(1, th.colSpan || 1);
    if (getComputedStyle(th).display === 'none') for (let i = 0; i < span; i++) out.add(col + i);
    col += span;
  }
  return out;
}

function stamp(table, labels) {
  const hidden = new Set((table.dataset.ciHidden || '').split(',').filter(Boolean).map(Number));
  const bodies = [...table.tBodies, ...(table.tFoot ? [table.tFoot] : [])];
  for (const body of bodies) {
    for (const tr of body.rows) {
      let col = 0;
      let title = null;
      for (const td of tr.cells) {
        const label = labels[col] || '';
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
        if (hidden.has(col)) td.setAttribute('data-ci-hidden', '');
        // The card's title is the first LABELLED cell with something in it —
        // not a leading tick box or row number.
        if (!title && label && !hidden.has(col) && (td.textContent || '').trim()) title = td;
        col += Math.max(1, td.colSpan || 1);
      }
      for (const td of tr.cells) {
        if (td === title) { if (!td.hasAttribute('data-ci-title')) td.setAttribute('data-ci-title', ''); }
        else if (td.hasAttribute('data-ci-title')) td.removeAttribute('data-ci-title');
      }
    }
  }
}

function overflows(table) {
  const box = table.parentElement;
  if (!box) return false;
  return table.scrollWidth > box.clientWidth + 1;
}

function scan(root = document) {
  if (!duoQuery || !duoQuery.matches) return;
  if (PAPER_ROUTE.test(location.pathname)) return;
  for (const table of root.querySelectorAll('table')) {
    if (table.closest(SKIP)) continue;
    const converted = table.classList.contains(CLS);
    if (!converted) {
      const labels = headerLabels(table);
      if (!labels || labels.filter(Boolean).length < 2) continue;
      if (!table.tBodies.length || !table.tBodies[0].rows.length) continue;
      if (!overflows(table)) continue;
      table.dataset.ciHidden = [...hiddenColumns(table)].join(',');
      table.classList.add(CLS);
      stamp(table, labels);
    } else {
      // Rows arrive and change after the first pass — keep their labels in step.
      const labels = headerLabels(table);
      if (labels) stamp(table, labels);
    }
  }
}

let installed = false;
export function installAutoCards() {
  if (installed || typeof window === 'undefined' || !window.MutationObserver) return;
  installed = true;
  let queued = false;
  const run = () => { queued = false; try { scan(); } catch { /* never break the page */ } };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
  // Folding/unfolding and rotating change what fits — in BOTH directions. A
  // table carded on the folded screen may fit as a table once unfolded, so on
  // a width change every carded table is put back, measured, and carded again
  // only if it still runs past its box. Height-only resizes (Safari's bars
  // sliding, the keyboard) are ignored: they never change what fits across.
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth !== lastW) { lastW = window.innerWidth; try { recheck(); } catch { /* never break the page */ } }
    queue();
  });
  queue();
}

function recheck() {
  for (const table of document.querySelectorAll('table.' + CLS)) {
    table.classList.remove(CLS);
    if (duoQuery && duoQuery.matches && !PAPER_ROUTE.test(location.pathname) && overflows(table)) table.classList.add(CLS);
    else delete table.dataset.ciHidden;
  }
}
