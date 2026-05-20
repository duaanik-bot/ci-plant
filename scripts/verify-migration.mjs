import pg from 'pg';
const { Client } = pg;
const NEON = process.env.SOURCE_DATABASE_URL;
const SB = process.env.TARGET_DATABASE_URL;
const n = new Client({ connectionString: NEON });
const s = new Client({ connectionString: SB });
await n.connect(); await s.connect();
const ntables = (await n.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '_prisma%' ORDER BY tablename`)).rows;
let totN=0, totS=0, mismatches=[];
for (const t of ntables) {
  const nc = parseInt((await n.query(`SELECT count(*) FROM "${t.tablename}"`)).rows[0].count);
  const sc = parseInt((await s.query(`SELECT count(*) FROM "${t.tablename}"`)).rows[0].count);
  totN += nc; totS += sc;
  if (nc !== sc) mismatches.push({ t: t.tablename, neon: nc, sb: sc });
}
console.log(`Total Neon rows: ${totN}`);
console.log(`Total Supabase rows: ${totS}`);
console.log(`Tables checked: ${ntables.length}`);
if (mismatches.length) {
  console.log('\nMISMATCHES:');
  mismatches.forEach(m => console.log(`  ${m.t}: neon=${m.neon}, sb=${m.sb}`));
} else {
  console.log('\nAll table row counts match. ✅');
}
await n.end(); await s.end();
