// One printable job-card traveler — the page around a single sheet.
//
// The traveler itself lives in components/JobCardSheet.jsx, because the SAME
// sheet is also printed in bulk from /production/jobcards/print. This page owns
// only the toolbar and the fetch; everything the floor reads is the shared
// component, so a card printed on its own and the same card printed inside a
// batch are the same piece of paper.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { Button } from '../components/ui.jsx';
import JobCardSheet from '../components/JobCardSheet.jsx';
import { Printer, ArrowLeft } from 'lucide-react';

export default function JobCardPrint() {
  const { id } = useParams();
  const [jc, setJc] = useState(null);
  useEffect(() => { api.get(`/job-cards/${id}`).then(setJc); }, [id]);
  if (!jc) return null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/production"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print Job Card</Button>
      </div>

      <JobCardSheet jc={jc} />
    </div>
  );
}
