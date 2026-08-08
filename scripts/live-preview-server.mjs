// Connect to an already-migrated remote database without running local schema or seed paths.
import app from '../server/src/app.js';
import { connect } from '../server/src/db.js';

await connect();

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`CI ERP live-data preview server -> http://localhost:${port}`);
});
