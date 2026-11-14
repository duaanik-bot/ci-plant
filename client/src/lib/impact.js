// A change that moves payroll already worked out (owner's request 2026-11-14): "whenever a previous month's loan or
// advance is changed and the payout is impacted, the next month gets the impact, with a pop-up giving remarks about
// the change and taking approval before changing."
//
// The server answers such a change 409 IMPACT_NEEDS_APPROVAL with the list of lines that would move (and changes
// nothing). withImpact() catches that answer, asks through the pop-up the HR page mounts (pages/hr/ImpactModal.jsx),
// and — given a remark — sends the same change again with it. Closed without one, nothing changes and the caller
// sees a "not changed" error in its own place.
let asker = null;
export function setImpactAsker(fn) { asker = fn; }

export async function withImpact(send) {
  try {
    return await send({});
  } catch (e) {
    if (e?.data?.code !== 'IMPACT_NEEDS_APPROVAL' || !asker) throw e;
    const remark = await asker(e.data);
    if (!remark) {
      const stop = new Error('Not changed: the change was not approved.');
      stop.data = { error: stop.message, code: 'IMPACT_NOT_APPROVED' };
      throw stop;
    }
    return send({ impact_remark: remark });
  }
}
