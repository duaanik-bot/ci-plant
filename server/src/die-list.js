// The die list (die_register: the 2024 register and the dies from the studio's Drive drawings) by size — shared by the
// size proposals (routes/sizing.js) and the costing editor's size check (routes/costing.js, owner 17 Nov 2026).
import { q } from './db.js';
import { registerMatchesFrom, REGISTER_MM } from './costing-match.js';

// The die list by size (owner, 15 Nov 2026): the 2024 register and the dies from the studio's Drive drawings, each side
// within REGISTER_MM as written or once both sizes are sorted, then sorted into exact / another order / close by
// registerMatchesFrom. The list's copies of Die Master dies are left out — the Die Master is checked from the Die Master
// itself (dieMasterMatches, the same rule), so they would show twice. The sizes go in as numeric: untyped, `$1 - 3` made
// $1 an integer and any size with a decimal failed the whole check. job_no is read through to_jsonb so the check keeps
// working on a database the job-number migration has not reached yet.
export async function registerMatches(size) {
  const [s1, s2, s3] = [size.l, size.w, size.h].sort((a, b) => a - b);
  const rows = await q(`
    SELECT die_no, l_mm::float8 AS l, w_mm::float8 AS w, h_mm::float8 AS h, style, ups, size_text, source, to_jsonb(d) ->> 'job_no' AS job_no
      FROM die_register d
     WHERE source IS DISTINCT FROM 'CI PLANT DIE MASTER'
       AND l_mm IS NOT NULL AND w_mm IS NOT NULL AND h_mm IS NOT NULL
       AND ((abs(l_mm - $1::numeric) <= $7::numeric AND abs(w_mm - $2::numeric) <= $7::numeric AND abs(h_mm - $3::numeric) <= $7::numeric)
         OR (abs(LEAST(l_mm, w_mm, h_mm) - $4::numeric) <= $7::numeric
             AND abs(l_mm + w_mm + h_mm - LEAST(l_mm, w_mm, h_mm) - GREATEST(l_mm, w_mm, h_mm) - $5::numeric) <= $7::numeric
             AND abs(GREATEST(l_mm, w_mm, h_mm) - $6::numeric) <= $7::numeric))
     ORDER BY abs(l_mm - $1::numeric) + abs(w_mm - $2::numeric) + abs(h_mm - $3::numeric), die_no`,
  [size.l, size.w, size.h, s1, s2, s3, REGISTER_MM]);
  return registerMatchesFrom(size, rows);
}
