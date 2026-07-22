// ─── Authentication & authorisation ──────────────────────────────────────────
// JWT bearer tokens, bcrypt passwords, coarse role guards.
// Roles: admin | planner | production | qc | dispatch | viewer
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q, one } from './db.js';
import { audit } from './helpers.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'ci-erp-local-dev-secret-change-in-production';
const TOKEN_TTL = '12h';

export const authRouter = Router();

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password, remember } = req.body;
    const user = await one('SELECT * FROM users WHERE lower(email)=lower($1) AND active=1', [email || '']);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // "Keep me signed in" → token that never expires (no expiresIn). Otherwise
    // the 12h working-shift token that dies overnight.
    const token = remember
      ? jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET)
      : jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    await audit('user', user.id, 'login', null, q, user.name);
    res.json({ token, user: userView(user) });
  } catch (e) { next(e); }
});

// Fresh copy of the signed-in user — the app shell calls this on load so
// module-access changes apply without waiting for the next login.
authRouter.get('/auth/me', (req, res, next) => {
  requireAuth(req, res, async () => {
    try {
      const user = await one(
        'SELECT id, name, email, role, active, modules, sections, machine_ids, landing_path FROM users WHERE id=$1',
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

// Attach req.user from Bearer token. Everything except /auth/login requires it.
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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

usersRouter.get('/users', requireRole(), async (_req, res, next) => {
  try {
    res.json(await q('SELECT id, name, email, role, active, modules, sections, machine_ids, landing_path, created_at FROM users ORDER BY name'));
  } catch (e) { next(e); }
});

usersRouter.post('/users', requireRole(), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = bcrypt.hashSync(password, 10);
    const [u] = await q(
      `INSERT INTO users (name, email, password_hash, role, modules, sections, machine_ids, landing_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, email, role, active, modules, sections, machine_ids, landing_path`,
      [name, email, hash, role || 'viewer',
       cleanModules(req.body.modules), cleanSections(req.body.sections),
       cleanMachineIds(req.body.machine_ids), cleanPath(req.body.landing_path)]);
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
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      sets.push(`password_hash=$${i++}`); vals.push(bcrypt.hashSync(password, 10));
    }
    if (!sets.length) return res.json({});
    vals.push(req.params.id);
    const [u] = await q(
      `UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING id, name, email, role, active, modules, sections, machine_ids, landing_path`, vals);
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

// First-boot admin account
export async function seedAdminIfMissing() {
  const n = await one('SELECT COUNT(*)::int AS n FROM users');
  if (n.n === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await q(`INSERT INTO users (name, email, password_hash, role) VALUES ('Administrator','admin@motionci.com',$1,'admin')`, [hash]);
    console.log('Created default admin → admin@motionci.com / admin123 (change it in Masters → Users)');
  }
}
