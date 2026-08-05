// Where an edited master-driven field is filed when the plan saves.
//
// The planning engine has always asked one question — "job only, or update the
// Product Master?" — and applied the answer to every field edited in that save.
// A planner who retunes ups for good and trims the parent for this run only had
// to answer for both at once, and either answer filed one of the two changes in
// the wrong place: the master learning a one-off trim, or a permanent ups
// correction living on as a job override nobody else inherits.
//
// The answer is now per FIELD. `masterFields` is the subset the planner ticked;
// everything else in the same save falls through to the job override. Passing
// null (or omitting it) keeps the old all-or-nothing behaviour exactly, which
// is what the mix confirm and "Save for this Job Only" still send.
//
// Pure and separate from the route so the rule can be pinned without standing a
// database up — same reason board-mix.js and board-allocation.js live apart
// from the handlers that call them.
export function splitMasterFields({ changed = {}, updateMaster = false, masterFields = null } = {}) {
  const toMaster = {};
  const toJob = {};
  for (const [field, value] of Object.entries(changed)) {
    // A field is promoted only when the planner said yes AND (they said yes to
    // everything, or named this one). Anything else stays on the job — the
    // safe direction: a job override affects one job, a master write affects
    // every job this product ever runs again.
    if (updateMaster && (!Array.isArray(masterFields) || masterFields.includes(field))) toMaster[field] = value;
    else toJob[field] = value;
  }
  return { toMaster, toJob };
}
