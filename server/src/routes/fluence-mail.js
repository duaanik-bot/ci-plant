// Fluence › From Fluence mail (owner, 18 Nov 2026): what the office AVS read from Fluence's mails, what it saved,
// held or only compared — and a person's buttons.
//   GET  /api/fluence/mail-readings?view=open|all
//   POST /api/fluence/mail-readings/:id/apply   a held reading saved by a person (Planning roles, with a tab a kit is
//                                               edited from — it changes a kit)
//   POST /api/fluence/mail-readings/:id/undo    a saved reading put back (the same)
//   POST /api/fluence/mail-readings/:id/keep    a held or not-matched reading set aside: the master stays (Planning roles)
//   POST /api/fluence/mail-readings/:id/ack     management has read it (admin, or the Management tick) — with its MRP changes
//   POST /api/fluence/mail-readings/ack         { ids } — the same for several at once
// Never for a customer's own login.
import { Router } from 'express';
import { one } from '../db.js';
import { PLANNING_ROLES } from '../auth.js';
import { mayUseTab } from '../access.js';
import { KIT_EDIT_TABS, FLUENCE_TABS } from '../../../client/src/modules.js';
import { listReadings, applyHeld, undoReading, keepReading, ackReadings } from '../fluence-mail.js';

const r = Router();
const idOf = v => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const fail = (status, error) => Object.assign(new Error(error), { status });
const wrap = fn => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); next(e); }
};
const staff = req => { if (!req.user || req.user.outside) throw fail(403, 'Not for this login.'); };
const planner = req => req.user.role === 'admin' || PLANNING_ROLES.includes(req.user.role);
const plans = req => { staff(req); if (!planner(req)) throw fail(403, 'Applying, undoing or setting aside a Fluence reading is for Planning roles.'); };
const kitTabNames = KIT_EDIT_TABS.map(k => FLUENCE_TABS.find(t => t.key === k)?.label ?? k).join(', ');
// Apply and Undo change a kit, so they need what changing a kit needs: a tab a kit is edited from.
const editsKits = req => {
  plans(req);
  if (req.user.role !== 'admin' && !KIT_EDIT_TABS.some(t => mayUseTab(req.access, t))) {
    throw fail(403, `Applying or undoing a Fluence reading changes a kit — it needs one of the Fluence tabs ${kitTabNames} ticked for this login.`);
  }
};
const manages = async req => {
  staff(req);
  if (req.user.role === 'admin') return;
  const u = await one('SELECT is_management FROM users WHERE id = $1', [req.user.id]);
  if (Number(u?.is_management) !== 1) throw fail(403, 'Fluence readings are acknowledged by Colour Impressions management — an admin or a login with the Management tick.');
};

r.get('/fluence/mail-readings', wrap(async req => {
  staff(req);
  const can_ack = req.user.role === 'admin' || Number((await one('SELECT is_management FROM users WHERE id = $1', [req.user.id]))?.is_management) === 1;
  const can_edit = planner(req);
  const rows = await listReadings({ view: req.query.view === 'open' ? 'open' : 'all' }).catch(e => (e?.code === '42P01' ? [] : Promise.reject(e)));
  return { rows, can_ack, can_edit };
}));
r.post('/fluence/mail-readings/ack', wrap(async req => {
  await manages(req);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(idOf).filter(Boolean).slice(0, 1000);
  return ackReadings(ids, req.user);
}));
r.post('/fluence/mail-readings/:id/apply', wrap(async req => { editsKits(req); return applyHeld(idOf(req.params.id), req.user); }));
r.post('/fluence/mail-readings/:id/undo', wrap(async req => { editsKits(req); return undoReading(idOf(req.params.id), req.user); }));
r.post('/fluence/mail-readings/:id/keep', wrap(async req => { plans(req); return keepReading(idOf(req.params.id), req.user); }));
r.post('/fluence/mail-readings/:id/ack', wrap(async req => { await manages(req); return ackReadings([idOf(req.params.id)].filter(Boolean), req.user); }));

export default r;
