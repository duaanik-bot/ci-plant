// Local dev entry — starts the embedded/live DB, builds schema, seeds, listens.
// The Vercel serverless deploy uses api/index.js instead (schema pre-migrated,
// demo seed never runs in production).
import app from './app.js';
import { init } from './db.js';
import { seedAdminIfMissing } from './auth.js';
import { seedIfEmpty } from './seed.js';

await init();
await seedAdminIfMissing();
await seedIfEmpty();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`CI ERP server → http://localhost:${PORT}`));
