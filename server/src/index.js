import express from 'express';
import cors from 'cors';
import { init } from './db.js';
import { authRouter, requireAuth, usersRouter, seedAdminIfMissing } from './auth.js';
import masters from './routes/masters.js';
import orders from './routes/orders.js';
import poimport from './routes/import.js';
import production from './routes/production.js';
import inventory from './routes/inventory.js';
import procurement from './routes/procurement.js';
import dispatch from './routes/dispatch.js';
import dashboard from './routes/dashboard.js';
import floor from './routes/floor.js';
import billing from './routes/billing.js';
import workflow from './routes/workflow.js';
import fg from './routes/fg.js';
import gangs from './routes/gangs.js';
import extrasheets from './routes/extrasheets.js';
import tooling from './routes/tooling.js';
import { seedIfEmpty } from './seed.js';

await init();
await seedAdminIfMissing();
await seedIfEmpty();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', authRouter);          // login is public
app.use('/api', requireAuth);         // everything below needs a token
app.use('/api', usersRouter);
app.use('/api', masters);
app.use('/api', orders);
app.use('/api', poimport);
app.use('/api', production);
app.use('/api', inventory);
app.use('/api', procurement);
app.use('/api', dispatch);
app.use('/api', dashboard);
app.use('/api', floor);
app.use('/api', billing);
app.use('/api', workflow);
app.use('/api', fg);
app.use('/api', gangs);
app.use('/api', extrasheets);
app.use('/api', tooling);

// Central error handler — business errors carry .status; structured errors
// (e.g. tolerance decisions) carry .body so the UI can offer choices.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error', ...(err.body || {}) });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`CI ERP server → http://localhost:${PORT}`));
