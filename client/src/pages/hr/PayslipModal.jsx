// HR · one person's payslip on screen, from the register card (owner's request 2026-11-03: "the payslip at screen
// level itself, even before payment, and download it as a beautiful PDF").
//
// Reads GET /hr/runs/:month/payslips?person_ids=<id> and draws the same Slip the print page draws (HRPayslips.jsx),
// so the screen, the print and the PDF never disagree. Download PDF renders that slip to an A4 page (html2canvas at
// 2× for crisp text, JPEG, then jsPDF; a slip taller than A4 runs onto a second page). Before the month is finalised the
// slip carries a "Provisional" band, on screen and in the PDF, because its figures can still change. Print opens the
// print page for this one person. The file name carries the month and the person's code, never an amount.
import { useEffect, useRef, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button, Modal } from '../../components/ui.jsx';
import { hrApi, monthLabel } from '../../lib/hr.js';
import { Slip } from '../HRPayslips.jsx';
import { list } from './RunLineDrawer.jsx';

export default function PayslipModal({ month, personId, name, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const paper = useRef(null);

  useEffect(() => {
    let live = true;
    hrApi.payslips(month, { person_ids: [personId] }).then(
      d => { if (live) setData(d); },
      e => { if (live) setError(e?.data?.error || e?.message || 'The payslip could not be loaded.'); },
    );
    return () => { live = false; };
  }, [month, personId]);

  const slip = list(data?.slips)[0] || null;
  const finalised = data?.run?.status === 'finalised';
  const code = slip?.person?.code || String(personId);

  const download = async () => {
    if (!paper.current) return;
    setSaving(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
      const canvas = await html2canvas(paper.current, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = 210; const pageH = 297; const margin = 10;
      const w = pageW - margin * 2;
      const h = (canvas.height * w) / canvas.width;
      const img = canvas.toDataURL('image/jpeg', 0.92); // a PNG of a 2× slip is ~8 MB; JPEG keeps it light and sharp
      let left = h; let y = margin;
      doc.addImage(img, 'JPEG', margin, y, w, h);
      left -= pageH - margin * 2;
      while (left > 0) {
        y -= pageH - margin * 2;
        doc.addPage();
        doc.addImage(img, 'JPEG', margin, y, w, h);
        left -= pageH - margin * 2;
      }
      doc.save(`Payslip ${monthLabel(month)} ${code}.pdf`);
    } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} wide title={`Payslip — ${name || code} · ${monthLabel(month)}`}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="secondary" disabled={!slip}
            onClick={() => window.open(`/hr/payslips/${encodeURIComponent(month)}?person_ids=${encodeURIComponent(personId)}`, '_blank', 'noopener')}>
            <Printer size={14} /> Print
          </Button>
          <Button onClick={download} disabled={!slip || saving}><Download size={14} /> {saving ? 'Making PDF…' : 'Download PDF'}</Button>
        </div>
      )}>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>}
      {!data && !error && <p className="p-6 text-sm text-slate-400">Loading the payslip…</p>}
      {data && !slip && !error && <p className="p-6 text-sm text-[#515154]">There is no payslip for this person in {monthLabel(month)}.</p>}
      {slip && (
        <div ref={paper} className="bg-white">
          {!finalised && (
            <p className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-center text-[11px] font-bold uppercase tracking-[0.08em] text-amber-800">
              Provisional — {monthLabel(month)} is not finalised yet, so these figures can still change
            </p>
          )}
          <Slip slip={slip} company={data.company} monthName={monthLabel(month)} />
        </div>
      )}
    </Modal>
  );
}
