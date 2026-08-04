// Express app builder — routers + middleware only. No DB init, no seed, no
// listen. Local dev (index.js) and the Vercel serverless function (api/index.js)
// both import this and wire up their own lifecycle around it.
import express from 'express';
import cors from 'cors';
import { authRouter, requireAuth, usersRouter } from './auth.js';
import masters from './routes/masters.js';
import boardRates from './routes/board-rates.js';
import board from './routes/board.js';
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
import shadecards from './routes/shadecards.js';
import timeline from './routes/timeline.js';
import logbook from './routes/logbook.js';
import coa from './routes/coa.js';
import masterHistory from './routes/master-history.js';
import notifications from './routes/notifications.js';
import chat from './routes/chat.js';
import writeons from './routes/writeons.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', authRouter);          // login is public
app.use('/api', requireAuth);         // everything below needs a token
app.use('/api', usersRouter);
app.use('/api', masters);
app.use('/api', boardRates);
app.use('/api', board);
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
app.use('/api', shadecards);
app.use('/api', timeline);
app.use('/api', logbook);
app.use('/api', coa);
app.use('/api', masterHistory);
app.use('/api', notifications);
app.use('/api', chat);
app.use('/api', writeons);

// Central error handler — business errors carry .status; structured errors
// (e.g. tolerance decisions) carry .body so the UI can offer choices.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error', ...(err.body || {}) });
});

export default app;
