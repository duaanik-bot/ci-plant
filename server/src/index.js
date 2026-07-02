import express from 'express';
import cors from 'cors';
import db from './db.js';
import masters from './routes/masters.js';
import orders from './routes/orders.js';
import production from './routes/production.js';
import inventory from './routes/inventory.js';
import procurement from './routes/procurement.js';
import dispatch from './routes/dispatch.js';
import dashboard from './routes/dashboard.js';
import { seedIfEmpty } from './seed.js';

seedIfEmpty();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', masters);
app.use('/api', orders);
app.use('/api', production);
app.use('/api', inventory);
app.use('/api', procurement);
app.use('/api', dispatch);
app.use('/api', dashboard);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Central error handler — business errors carry .status
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`CI ERP server → http://localhost:${PORT}`));
