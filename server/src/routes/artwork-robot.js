// The artwork register's robot side (Artwork Manager P1), for the same AVS robot with the same key:
//
//   POST /api/avs/robot/artwork-notify   the database, when the office AVS has filed mails into avs.artwork_intake:
//                                        copy them into the register and tell the people with Artwork ticked
//                                        (artwork-intake.js)
//
// Mounted before requireAuth (app.js). The robot key is the only way in.
import { Router } from 'express';
import { markUncacheable } from '../data-tables.js';
import { keyOk } from './avs-robot.js';
import { syncIntakeArtwork, notifyNewArtworkSoft } from '../artwork-intake.js';

const r = Router();
const MISSING = new Set(['42P01', '3F000']);

r.post('/avs/robot/artwork-notify', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    const out = await syncIntakeArtwork();
    res.json({ ...out, alert: await notifyNewArtworkSoft() });
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'The artwork intake is not set up on this database.' });
    next(e);
  }
});

export default r;
