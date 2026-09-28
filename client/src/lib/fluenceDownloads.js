// Every file the Fluence module hands out goes on record first.
//
// The file is made here in the browser — a list as PDF or Excel, a kit's
// customer report, a printed page — so before it is made the module asks the
// server (routes/fluence.js POST /fluence/downloads). For a customer's own login
// the server records the download and tells CI management, then answers with the
// watermark the file must wear: Colour Impressions across every page, and who
// took it, when, and the reference that finds the record again. No answer, no
// file. A Colour Impressions login is answered with no watermark and its file is
// made exactly as before.
import { api } from '../api.js';

export async function recordDownload({ what, format, rows = null, filter = '' }) {
  const out = await api.post('/fluence/downloads', { what, format, rows, filter });
  return out?.watermark ?? null;
}

const rowsOf = spec => (spec?.sections?.length
  ? spec.sections.reduce((n, s) => n + (s.rows || []).length, 0)
  : (spec?.rows || []).length);

// For an ExportMenu (DataTable `exportGate`): the list's name for the record,
// and the spec comes back wearing the watermark when the server gives one.
export const fluenceExportGate = what => async (kind, spec) => {
  const search = (spec?.meta || []).find(m => /^Search:/.test(String(m))) || '';
  const watermark = await recordDownload({ what, format: kind, rows: rowsOf(spec), filter: search });
  return watermark ? { ...spec, watermark } : spec;
};
