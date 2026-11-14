// Claude in the cloud for the Enquiry desk (owner, 12 Nov 2026: "this system needs to work in back end once we click on
// fetch enquiries from mail, and auto robot, to fetch at 11 am and 3 pm all the pending enquiries — even if desktop and
// claude are off"; he chose his own Claude plan over a paid API key).
//
// The desk's cloud routine is a claude.ai scheduled task, on the owner's Claude plan, with the mailbox's Gmail connector
// limited to its read tools. CI Plant starts it through the routine's API trigger, exactly as AVS starts its own routine
// (fireRoutine): when Fetch is pressed, and at 11:00 and 15:00 India time from Vercel Cron (routes/enquiry-robot.js).
// An admin pastes the routine's API URL and token into the desk's Settings; they are kept in avs.settings beside the
// AVS link, and the token never goes back to a browser.
//
// Each start carries a one-time PASS for its one fetch job (JOB=…, CI_JOB_TOKEN=… in the fire text). The robot routes
// take the pass in place of the robot key, for that job only and for PASS_HOURS: the routine never holds the robot key,
// and a pass that leaks opens one fetch for a few hours, nothing more. The job keeps only its sha256 (brief.pass_sha256).
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { audit } from './helpers.js';
import { plantDateStr } from './plant-calendar.js';
import { fireRoutine } from './routes/avs-intake.js';
import { setupProblem } from '../../client/src/lib/avs.js';

export const PASS_HOURS = 3;
export const CLOUD_KEYS = Object.freeze({ url: 'enquiry_routine_fire_url', token: 'enquiry_routine_token' });
export const CLOUD_RUNNER = 'Claude (cloud)';
export const TIMER_NAME = 'CI Plant timer (11 am / 3 pm)';
// A fetch still waiting this long after its start is started again by the next press of Fetch.
export const REFIRE_AFTER_MIN = 10;
// The timer starts no fetch when one was queued this recently (and never twice within it).
export const TIMER_QUIET_MIN = 30;
const MISSING = new Set(['42P01', '3F000']);

export const passHash = pass => crypto.createHash('sha256').update(String(pass)).digest('hex');
export const mintPass = () => crypto.randomBytes(24).toString('base64url');
export const tokenHint = t => (t ? `…${t.slice(-4)}` : '');

// The routine's API trigger, as an admin saved it (empty when not linked, or on a database with no AVS schema).
export async function cloudLink() {
  try {
    const rows = await q('SELECT key, value FROM avs.settings WHERE key = ANY($1)', [[CLOUD_KEYS.url, CLOUD_KEYS.token]]);
    const v = Object.fromEntries(rows.map(x => [x.key, x.value || '']));
    return { routine_fire_url: v[CLOUD_KEYS.url] || '', routine_token: v[CLOUD_KEYS.token] || '' };
  } catch (e) {
    if (MISSING.has(e?.code)) return { routine_fire_url: '', routine_token: '' };
    throw e;
  }
}
export const cloudLinked = cfg => !!(cfg?.routine_fire_url && cfg?.routine_token);
// What the desk shows: whether it is linked, and to admins the URL and the token's last four characters.
export const cloudView = (cfg, admin) => ({
  linked: cloudLinked(cfg),
  ...(admin ? { fire_url: cfg.routine_fire_url || '', token_hint: tokenHint(cfg.routine_token) } : {}),
});

// Save the link (its own keys, never the AVS routine's). An empty token keeps the one saved; the URL and the token are
// checked as the AVS link's are.
export async function saveCloudLink({ fire_url, token: tokenIn }, user) {
  const url = fire_url == null ? null : String(fire_url).trim();
  const token = tokenIn == null ? null : String(tokenIn).trim();
  const problem = setupProblem({ routine_fire_url: url, routine_token: token });
  if (problem) return { problem: problem.replace(/The Claude link/g, 'The routine link').replace(/The Claude token/g, 'The routine token') };
  const note = `set by ${user?.name || 'admin'} ${new Date().toISOString()} (enquiry desk)`;
  const put = (key, value) => q(`INSERT INTO avs.settings (key, value, note) VALUES ($1, $2, $3)
                                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note`, [key, value, note]);
  if (url != null) await put(CLOUD_KEYS.url, url);
  if (token) await put(CLOUD_KEYS.token, token);
  return { cfg: await cloudLink() };
}

// What the routine is told. Its saved prompt takes only JOB= and CI_JOB_TOKEN= from this (it arrives marked as data).
export function fireText(job, pass) {
  return [
    `CI Plant enquiry desk: fetch job ${job.id} for the mailbox ${job.mailbox_email}.`,
    `JOB=${job.id}`,
    `CI_JOB_TOKEN=${pass}`,
  ].join('\n');
}

// Start the cloud routine for a fetch job. The pass is stored before the start: the routine can claim within seconds.
export async function fireCloud(job, by) {
  const cfg = await cloudLink();
  if (!cloudLinked(cfg)) return { ok: false, status: 'not_linked', error: 'Claude in the cloud is not linked to the desk yet.' };
  const pass = mintPass();
  const until = new Date(Date.now() + PASS_HOURS * 3600e3).toISOString();
  await q(`UPDATE enquiry_jobs SET brief = brief || $2::jsonb WHERE id = $1`, [job.id, { pass_sha256: passHash(pass), pass_until: until }]);
  const out = await fireRoutine(cfg, fireText(job, pass));
  const at = new Date().toISOString();
  const note = out.ok ? { fired_at: at, fired_by: by, session_url: out.session_url || null, fire_error: null }
    : { fire_failed_at: at, fired_by: by, fire_error: out.error || 'Claude did not start' };
  await q(`UPDATE enquiry_jobs SET fire_status = $2, brief = brief || $3::jsonb WHERE id = $1`, [job.id, out.ok ? 'cloud' : 'cloud_failed', note]);
  return out;
}

// The job a pass opens, or null: a fetch job whose pass matches and has not run out.
export async function jobOfPass(pass) {
  const p = String(pass || '');
  if (p.length < 20 || p.length > 200) return null;
  const row = await one(`SELECT id FROM enquiry_jobs WHERE kind = 'fetch' AND brief->>'pass_sha256' = $1
                            AND (brief->>'pass_until')::timestamptz > now()`, [passHash(p)]);
  return row?.id ?? null;
}

// Should a fetch that is still waiting be started again? Never started in the cloud, its start failed, or it has
// waited REFIRE_AFTER_MIN since.
export function needsFire(job, now = Date.now()) {
  if (!job || job.status !== 'queued') return false;
  if (job.fire_status !== 'cloud') return true;
  const at = Date.parse(job.brief?.fired_at || '');
  return !(at > 0) || now - at > REFIRE_AFTER_MIN * 60e3;
}

// Fetch: one open fetch per mailbox — the mailbox named (14 Nov 2026: "Fetch from mail" = the company mailbox, read by
// the office computer; "Fetch from dua.anik" = the trial mailbox, read by the owner's Mac), else the one in use. A new
// one is queued from the last finished fetch of that mailbox (a day's overlap: a mail filed twice is refused), else
// fetch_days back. The company mailbox's job waits for the office computer (fire_status 'office'): its watcher asks
// GET /api/enquiry-desk/waiting and the office AVS takes the job (avs.take_enquiry_fetch). Only the trial mailbox's job
// starts the desk's cloud routine, whose Gmail is that mailbox. The timer (auto) fetches nothing while the company
// mailbox is in use — the office AVS reads it at its own hours — and nothing within TIMER_QUIET_MIN of the last fetch.
export const OFFICE_HOURS = 'The office AVS reads the company mailbox itself at 7:30 am, 1 pm, 3:30 pm and 5:30 pm.';
export async function startFetch({ user = null, by, auto = false, mailbox = null }) {
  const box = mailbox
    ? await one(`SELECT key, email FROM enquiry_mailboxes WHERE key = $1`, [mailbox])
    : await one(`SELECT key, email FROM enquiry_mailboxes WHERE in_use`);
  if (!box) return mailbox ? { error: 'No such mailbox.', status: 400 } : { error: 'No mailbox is in use — an admin chooses one in the desk settings.', status: 409 };
  const office = box.key === 'business';
  if (auto && office) return { skipped: OFFICE_HOURS };
  const open = await one(`SELECT id, status, fire_status, brief FROM enquiry_jobs
                           WHERE kind = 'fetch' AND mailbox_email = $1 AND status IN ('queued', 'working') ORDER BY id LIMIT 1`, [box.email]);
  if (auto) {
    const recent = await one(`SELECT id FROM enquiry_jobs WHERE kind = 'fetch' AND mailbox_email = $1
                                AND queued_at > now() - make_interval(mins => $2) ORDER BY id DESC LIMIT 1`, [box.email, TIMER_QUIET_MIN]);
    if (recent && !needsFire(open)) return { skipped: `A fetch was started in the last ${TIMER_QUIET_MIN} minutes.`, job: { id: recent.id } };
  }
  if (open) {
    const cloud = !office && needsFire(open) ? await fireCloud({ id: open.id, mailbox_email: box.email }, by) : null;
    return { job: { id: open.id }, already: true, cloud };
  }
  const s = await one('SELECT fetch_days FROM enquiry_settings WHERE id = 1');
  const last = await one(`SELECT finished_at FROM enquiry_jobs WHERE kind = 'fetch' AND mailbox_email = $1 AND status = 'done' ORDER BY id DESC LIMIT 1`, [box.email]);
  const since = new Date((last?.finished_at ? new Date(last.finished_at).getTime() : Date.now() - (s?.fetch_days || 7) * 864e5) - 864e5);
  const job = await one(`INSERT INTO enquiry_jobs (kind, mailbox, mailbox_email, brief, queued_by, queued_by_name, fire_status)
                         VALUES ('fetch', $1, $2, $3, $4, $5, $6) RETURNING id`,
  [box.key, box.email, { since: plantDateStr(since) }, user?.id ?? null, by, office ? 'office' : 'waiting']);
  await audit('enquiry_job', job.id, 'fetch', `Fetch enquiries — job ${job.id}${auto ? ' (timer)' : ''}${office ? ' (office computer)' : ''}`, q, by);
  const cloud = office ? null : await fireCloud({ id: job.id, mailbox_email: box.email }, by);
  return { job: { id: job.id }, already: false, cloud };
}
