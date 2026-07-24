// Vercel serverless entry for the ci-erp API.
// The schema is pre-migrated into Supabase and the DB is reached via DATABASE_URL
// (set as a Vercel env var — use the Supabase connection pooler). We connect the
// pg pool once per warm instance; we do NOT run migrations or the demo seed here.
// Express 4's url.parse usage trips DEP0169 on Node 24, flooding runtime logs
// with warnings that drown real errors. Silence deprecations in prod only.
process.noDeprecation = true;

import app from '../server/src/app.js';
import { connect } from '../server/src/db.js';

let ready;
export default async function handler(req, res) {
  try {
    await (ready ||= connect());
  } catch (e) {
    ready = undefined; // let the next request retry a fresh connection
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Database connection failed' }));
  }
  return app(req, res);
}
