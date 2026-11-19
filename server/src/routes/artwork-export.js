// The CorelDRAW button on a designer's PC uploads its export with that PC's key, not a login (owner, 17 Nov 2026;
// design plans/2026-11-17-artwork-workflow-design.md §5). Mounted before the login check (app.js).
//   POST /api/artwork/export/start | PUT /api/artwork/export/:up/chunk/:n | POST /api/artwork/export/:up/finish
import express, { Router } from 'express';
import { CHUNK, keyOf, startUpload, putChunk, finishUpload } from '../artwork-upload.js';

const r = Router();
const raw = express.raw({ type: () => true, limit: CHUNK + 1024 });
const fail = (status, error) => Object.assign(new Error(error), { status });
const wrap = fn => async (req, res, next) => {
  try { res.json(await fn(req, res)); } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); next(e); }
};
const keyed = async req => {
  const k = await keyOf(req.get('x-artwork-key'));
  if (!k) throw fail(401, 'This PC\'s artwork key is wrong or switched off — ask an admin for a key (Artwork › Designer PCs).');
  return { key_id: k.id, by_name: k.name };
};
r.post('/artwork/export/start', wrap(async req => startUpload(await keyed(req), req.body)));
r.put('/artwork/export/:up/chunk/:n', raw, wrap(async req => putChunk(req.params.up, req.params.n, req.body, await keyed(req))));
r.post('/artwork/export/:up/finish', wrap(async req => finishUpload(req.params.up, await keyed(req))));

export default r;
