// The printing station's AVS pop-ups, for a job whose AVS Planning made mandatory.
//
//   start   — right after printing starts: send photos of the first good
//             sheets for the AVS check; printing can be completed only after
//             QA releases the job.
//   locked  — Complete was refused (AVS_NOT_RELEASED): why, report by report,
//             and what to do. Day counts can still be recorded meanwhile.
//
// Both offer the photo upload straight away, with the job card filled in.
// AvsGateBanner is the same answer shown inside the Complete dialog before the
// operator presses anything.
import { useEffect, useState } from 'react';
import { Lock, ScanSearch, Unlock } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Modal } from '../ui.jsx';
import AvsUploadDialog from './AvsUpload.jsx';

const STATE_TONE = {
  released: 'text-emerald-700', waiting: 'text-sky-700', open: 'text-amber-800', rejected: 'text-red-700', closed: 'text-slate-600',
};

export function GateReports({ gate }) {
  if (!gate) return null;
  if (!gate.reports?.length) return <p className="text-sm text-slate-700">{gate.reason}</p>;
  return (
    <ul className="space-y-1">
      {gate.reports.map(r => (
        <li key={r.report_no} className={`text-sm ${STATE_TONE[r.state] || 'text-slate-700'}`}>{r.text}</li>
      ))}
    </ul>
  );
}

// prompt: { kind: 'start' | 'locked', row: { job_card_id, jc_number, product_name }, gate? }
export default function AvsPrompt({ prompt, onClose }) {
  const [upload, setUpload] = useState(null);
  const row = prompt?.row;
  const jobCard = row ? { id: row.job_card_id, jc_number: row.jc_number, product_name: row.product_name } : null;
  const openUpload = () => { setUpload(jobCard); onClose?.(); };

  return (
    <>
      <Modal open={prompt?.kind === 'start'} onClose={onClose}
        title={<span className="inline-flex items-center gap-2"><ScanSearch size={18} className="text-violet-600" /> AVS check is mandatory</span>}
        footer={<>
          <Button variant="secondary" repeatable onClick={onClose}>Later</Button>
          <Button repeatable onClick={openUpload}>Upload photos now</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-700">
          <p><b className="font-mono">{row?.jc_number}</b>{row?.product_name ? ` · ${row.product_name}` : ''} needs an AVS check before printing can be completed.</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>When the first good sheets are off the press, photograph one sheet flat: every panel and flap with text, the artwork code, and the small print.</li>
            <li>Upload the photos and press <b>Verify</b>. Claude checks them against the approved artwork, the PO and the job card.</li>
            <li>Keep printing. You can complete printing once QA has released the job in Artwork Verification.</li>
          </ol>
        </div>
      </Modal>

      <Modal open={prompt?.kind === 'locked'} onClose={onClose}
        title={<span className="inline-flex items-center gap-2"><Lock size={18} className="text-amber-600" /> AVS is mandatory — printing can't be completed yet</span>}
        footer={<>
          <Button variant="secondary" repeatable onClick={onClose}>OK</Button>
          <Button repeatable onClick={openUpload}>Upload photos</Button>
        </>}>
        <div className="space-y-3 text-sm text-slate-700">
          <p><b className="font-mono">{row?.jc_number}</b> can be completed once QA releases it in Artwork Verification.</p>
          <GateReports gate={prompt?.gate} />
          <p className="text-xs text-slate-500">
            You can still record today's count (Partial). If the check cannot be done in time, Planning can switch AVS off for this job, with a reason.
          </p>
        </div>
      </Modal>

      <AvsUploadDialog open={!!upload} jobCard={upload} onClose={() => setUpload(null)} />
    </>
  );
}

// Inside the Complete dialog of a printing job whose AVS is mandatory.
export function AvsGateBanner({ jobCardId }) {
  const [gate, setGate] = useState(null);
  useEffect(() => {
    let live = true;
    setGate(null);
    api.get(`/avs/gate/${jobCardId}`).then(g => { if (live) setGate(g); }).catch(() => {});
    return () => { live = false; };
  }, [jobCardId]);
  if (!gate?.mandatory) return null;
  if (gate.released) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <Unlock size={15} /> AVS released by QA — printing can be completed.
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <div className="flex items-center gap-2 font-semibold"><Lock size={15} /> AVS is mandatory: Final completion waits for QA's release.</div>
      <div className="mt-1"><GateReports gate={gate} /></div>
      <div className="mt-1 text-xs text-amber-800/80">Partial (today's count) can still be recorded.</div>
    </div>
  );
}
