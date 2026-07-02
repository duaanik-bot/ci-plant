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
    const { email, password } = req.body;
    const user = await one('SELECT * FROM users WHERE lower(email)=lower($1) AND active=1', [email || '']);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    await audit('user', user.id, 'login', null, q, user.name);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { next(e); }
});

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

usersRouter.get('/users', requireRole(), async (_req, res, next) => {
  try {
    res.json(await q('SELECT id, name, email, role, active, created_at FROM users ORDER BY name'));
  } catch (e) { next(e); }
});

usersRouter.post('/users', requireRole(), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = bcrypt.hashSync(password, 10);
    const [u] = await q(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)
       RETURNING id, name, email, role, active`,
      [name, email, hash, role || 'viewer']);
    await audit('user', u.id, 'create', email, q, req.user.name);
    res.json(u);
  } catch (e) {
    if (String(e.message).includes('users_email_key')) { e.status = 409; e.message = 'A user with this email already exists'; }
    next(e);
  }
});

usersRouter.put('/users/:id', requireRole(), async (req, res, next) => {
  try {
    const { name, role, active, password } = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    if (name != null) { sets.push(`name=$${i++}`); vals.push(name); }
    if (role != null) { sets.push(`role=$${i++}`); vals.push(role); }
    if (active != null) { sets.push(`active=$${i++}`); vals.push(active ? 1 : 0); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      sets.push(`password_hash=$${i++}`); vals.push(bcrypt.hashSync(password, 10));
    }
    if (!sets.length) return res.json({});
    vals.push(req.params.id);
    const [u] = await q(
      `UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING id, name, email, role, active`, vals);
    await audit('user', +req.params.id, 'update', null, q, req.user.name);
    res.json(u);
  } catch (e) { next(e); }
});

// First-boot admin account
export async function seedAdminIfMissing() {
  const n = await one('SELECT COUNT(*)::int AS n FROM users');
  if (n.n === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await q(`INSERT INTO users (name, email, password_hash, role) VALUES ('Anik Dua','admin@ci.local',$1,'admin')`, [hash]);
    console.log('Created default admin → admin@ci.local / admin123 (change it in Masters → Users)');
  }
}
