// ─── Authentication & authorisation ──────────────────────────────────────────
// JWT bearer tokens, bcrypt passwords, coarse role guards.
// Roles: admin | planner | production | qc | dispatch | viewer
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { q, one } from './db.js';
import { audit } from './helpers.js';

// This module previously fell back to a hardcoded literal when JWT_SECRET was
// unset, with no environment guard — so a deployment that forgot the variable
// signed AND verified with a constant that anyone reading this file could use
// to mint an admin token. Fail closed instead: refuse to start in production.
// Outside production the secret is random per process, so no usable constant
// exists in the source at all; dev tokens simply don't survive a restart.
const IN_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
if (IN_PRODUCTION && !process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Refusing to start in production rather than sign tokens with a fallback secret.',
  );
}
export const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const TOKEN_TTL = '12h';

export const authRouter = Router();

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password, remember } = req.body;
    const user = await one('SELECT * FROM users WHERE lower(email)=lower($1) AND active=1', [email || '']);
    // Async compare — the ~10-round check takes ~200ms and must not block the
    // event loop for every other request sharing this serverless instance.
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // "Keep me signed in" → token that never expires (no expiresIn). Otherwise
    // the 12h working-shift token that dies overnight.
    const token = remember
      ? jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET)
      : jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    // The audit row is a record OF the login, not a condition of it. It used to
    // be awaited bare, so any failure to write it refused a valid credential —
    // and on a read-only connection (the live-data preview) the INSERT can never
    // succeed, which made signing in there impossible rather than merely
    // unlogged. Failures go to the server log; the user still gets their token.
    await audit('user', user.id, 'login', null, q, user.name)
      .catch(e => console.warn(`[auth] login audit failed for user ${user.id}: ${e.message}`));
    res.json({ token, user: userView(user) });
  } catch (e) { next(e); }
});

// Fresh copy of the signed-in user — the app shell calls this on load so
// module-access changes apply without waiting for the next login.
authRouter.get('/auth/me', (req, res, next) => {
  requireAuth(req, res, async () => {
    try {
      const user = await one(
        'SELECT id, name, email, role, active, modules, sections, machine_ids, landing_path, xs_approver, is_management, reverse_approver FROM users WHERE id=$1',
        [req.user.id]);
      if (!user || !user.active) return res.status(401).json({ error: 'Account disabled' });
      res.json(userView(user));
    } catch (e) { next(e); }
  });
});

// The client-facing shape of a user — everything the app shell needs to gate
// nav, stations and the landing page. Never leaks password_hash.
function userView(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    modules: u.modules ?? null,
    sections: u.sections ?? null,
    machine_ids: u.machine_ids ?? null,
    landing_path: u.landing_path ?? null,
    // Approval grants — UI gating only; every server endpoint re-reads the
    // flag from the database, so a stale client copy can never decide.
    xs_approver: +(u.xs_approver ?? 0),
    is_management: +(u.is_management ?? 0),
    reverse_approver: +(u.reverse_approver ?? 0),
  };
}

// Floor scope for the signed-in user (server-side view filtering). Admins are
// unrestricted. Looked up per request because scope can change mid-session and
// the JWT deliberately carries only id/name/role.
export async function floorScope(req) {
  if (req.user?.role === 'admin') return { sections: null, machineIds: null };
  const u = await one('SELECT sections, machine_ids FROM users WHERE id=$1', [req.user?.id]);
  return { sections: u?.sections ?? null, machineIds: u?.machine_ids ?? null };
}

// "Delivered" on a message means the recipient's app has been active since it
// was posted — NOT that they opened that thread, which is the same act as
// reading and would collapse the two ticks into one.
//
// Throttled hard, and in memory rather than by asking the database first: every
// client polls several endpoints continuously, so a write per request would be
// a permanent UPDATE stream on the one table every request already reads. One
// write per user per two minutes is far finer than a delivered tick needs.
const ACTIVE_STAMP_MS = 2 * 60 * 1000;
const lastStamped = new Map();
function stampActive(userId) {
  if (!userId) return;
  const now = Date.now();
  if (now - (lastStamped.get(userId) || 0) < ACTIVE_STAMP_MS) return;
  lastStamped.set(userId, now);
  // Fire and forget: a failed heartbeat must never fail the request it rode in
  // on. The serverless case is safe too — a cold instance has an empty Map, so
  // it writes once and then throttles like any other.
  q('UPDATE users SET last_active_at=now() WHERE id=$1', [userId]).catch(() => {});
}

// Attach req.user from Bearer token. Everything except /auth/login requires it.
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    stampActive(req.user.id);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — sign in again' });
  }
}

// Role guard for write endpoints. Admin always passes.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || roles.includes(req.user?.role)) return next();
    return res.status(403).json({ error: `Your role (${req.user?.role}) cannot perform this action` });
  };
}

// ── User management (admin only) ────────────────────────────────────────────
export const usersRouter = Router();

// users.modules — NULL means "all modules" (role-gated as before); an array
// restricts the account to exactly those module keys. Sanitised here so the
// column only ever holds a JSON array of strings or NULL.
const cleanModules = m => {
  if (m == null || m === '') return null;
  if (!Array.isArray(m)) return null;
  const keys = [...new Set(m.map(String).filter(Boolean))];
  return JSON.stringify(keys);
};
// sections: same shape as modules (array of string keys, NULL = all).
const cleanSections = cleanModules;
// machine_ids: array of positive integers, NULL = all presses.
const cleanMachineIds = m => {
  if (m == null || m === '') return null;
  if (!Array.isArray(m)) return null;
  const ids = [...new Set(m.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  return JSON.stringify(ids);
};
const cleanPath = p => (p == null || String(p).trim() === '') ? null : String(p).trim();
// Approval grants — stored 0/1 like users.active.
const cleanFlag = v => (+v ? 1 : 0);

usersRouter.get('/users', requireRole(), async (_req, res, next) => {
  try {
    res.json(await q('SELECT id, name, email, role, active, modules, sections, machine_ids, landing_path, xs_approver, is_management, reverse_approver, created_at FROM users ORDER BY name'));
  } catch (e) { next(e); }
});

usersRouter.post('/users', requireRole(), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = bcrypt.hashSync(password, 10);
    const [u] = await q(
      `INSERT INTO users (name, email, password_hash, role, modules, sections, machine_ids, landing_path, xs_approver, is_management, reverse_approver)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, name, email, role, active, modules, sections, machine_ids, landing_path, xs_approver, is_management, reverse_approver`,
      [name, email, hash, role || 'viewer',
       cleanModules(req.body.modules), cleanSections(req.body.sections),
       cleanMachineIds(req.body.machine_ids), cleanPath(req.body.landing_path),
       cleanFlag(req.body.xs_approver), cleanFlag(req.body.is_management),
       cleanFlag(req.body.reverse_approver)]);
    // Standing chat rooms flagged auto_add (Plant Floor) take every new login
    // the moment it exists — nobody joins the plant and misses the plant.
    await q(`
      INSERT INTO conversation_members (conversation_id, user_id, role)
      SELECT c.id, $1, $2 FROM conversations c WHERE c.auto_add = 1
      ON CONFLICT DO NOTHING`, [u.id, (role || 'viewer') === 'admin' ? 'admin' : 'member']);
    await audit('user', u.id, 'create', email, q, req.user.name);
    res.json(u);
  } catch (e) {
    if (String(e.message).includes('users_email_key')) { e.status = 409; e.message = 'A user with this email already exists'; }
    next(e);
  }
});

usersRouter.put('/users/:id', requireRole(), async (req, res, next) => {
  try {
    const { name, email, role, active, password } = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    if (name != null) { sets.push(`name=$${i++}`); vals.push(name); }
    if (email != null) {
      if (!String(email).trim()) return res.status(400).json({ error: 'Email cannot be blank' });
      sets.push(`email=$${i++}`); vals.push(String(email).trim());
    }
    if (role != null) { sets.push(`role=$${i++}`); vals.push(role); }
    if (active != null) { sets.push(`active=$${i++}`); vals.push(active ? 1 : 0); }
    if ('modules' in req.body) { sets.push(`modules=$${i++}`); vals.push(cleanModules(req.body.modules)); }
    if ('sections' in req.body) { sets.push(`sections=$${i++}`); vals.push(cleanSections(req.body.sections)); }
    if ('machine_ids' in req.body) { sets.push(`machine_ids=$${i++}`); vals.push(cleanMachineIds(req.body.machine_ids)); }
    if ('landing_path' in req.body) { sets.push(`landing_path=$${i++}`); vals.push(cleanPath(req.body.landing_path)); }
    if ('xs_approver' in req.body) { sets.push(`xs_approver=$${i++}`); vals.push(cleanFlag(req.body.xs_approver)); }
    if ('is_management' in req.body) { sets.push(`is_management=$${i++}`); vals.push(cleanFlag(req.body.is_management)); }
    if ('reverse_approver' in req.body) { sets.push(`reverse_approver=$${i++}`); vals.push(cleanFlag(req.body.reverse_approver)); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      sets.push(`password_hash=$${i++}`); vals.push(bcrypt.hashSync(password, 10));
    }
    if (!sets.length) return res.json({});
    vals.push(req.params.id);
    const [u] = await q(
      `UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING id, name, email, role, active, modules, sections, machine_ids, landing_path, xs_approver, is_management, reverse_approver`, vals);
    await audit('user', +req.params.id, 'update', null, q, req.user.name);
    res.json(u);
  } catch (e) {
    if (String(e.message).includes('users_email_key')) { e.status = 409; e.message = 'A user with this email already exists'; }
    next(e);
  }
});

usersRouter.delete('/users/:id', requireRole(), async (req, res, next) => {
  try {
    const id = +req.params.id;
    // You can't delete the account you're signed in as — sign in as another
    // admin to remove it.
    if (id === req.user.id) return res.status(409).json({ error: "You can't delete the account you're signed in with" });
    const target = await one('SELECT id, name, email, role FROM users WHERE id=$1', [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Never orphan the plant — keep at least one active admin.
    if (target.role === 'admin') {
      const { n } = await one("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active=1 AND id<>$1", [id]);
      if (n === 0) return res.status(409).json({ error: 'Cannot delete the last admin account' });
    }
    await q('DELETE FROM users WHERE id=$1', [id]);
    await audit('user', id, 'delete', target.email, q, req.user.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// First-boot admin account.
// This used to hardcode one well-known password. Every deployment seeded from it
// shared one publicly-known admin password — which is exactly how five live
// admin accounts ended up on it. Generate a random password instead and print
// it once; set ADMIN_PASSWORD to choose your own (handy for local dev).
export async function seedAdminIfMissing() {
  const n = await one('SELECT COUNT(*)::int AS n FROM users');
  if (n.n === 0) {
    const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');
    const hash = bcrypt.hashSync(password, 10);
    await q(`INSERT INTO users (name, email, password_hash, role) VALUES ('Administrator','admin@motionci.com',$1,'admin')`, [hash]);
    console.log(`Created default admin → admin@motionci.com / ${password}`);
    console.log('This password is shown once. Change it in Masters → Users.');
  }
}
