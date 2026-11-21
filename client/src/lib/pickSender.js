// Which mailbox a quotation's reply goes out from (owner, 21 Nov 2026: "while sending, ask me whether I want to send it
// from dua.anik or from mppchd, and it should be the reply to the same thread"). Every Send / Draft again asks here.
// The question itself is drawn by <SenderPicker /> (mounted once in App.jsx); this module only passes it along.
//
// askSender(api, { current }) → 'business' | 'trial'  — the mailbox chosen
//                              → null                  — nothing to choose (fewer than two connected): the server's default
//                              → undefined             — the person closed the question: send nothing
let show = null; // set by <SenderPicker />
export const bindSenderPicker = fn => { show = fn; return () => { if (show === fn) show = null; }; };

export async function askSender(api, { current = null } = {}) {
  let list = [];
  try { list = (await api.get('/costing/enquiry-desk/senders'))?.senders || []; } catch { return null; }
  const ready = list.filter(s => s.connected);
  if (ready.length < 2 || !show) return null;
  return new Promise(resolve => show({ senders: ready, current, resolve }));
}
