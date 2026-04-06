import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

// ─── Row types ───────────────────────────────────────────────
interface UserRow extends RowDataPacket {
  id: number; username: string; full_name: string; email: string;
  phone: string; department: string; designation: string;
  company_id: number | null; location_id: number | null;
  role: string; user_type: string; is_active: number;
  access_expires_at: string | null; last_login: string | null;
  created_at: string; managed_by: number | null;
}
interface SystemRow extends RowDataPacket { id: number; slug: string; name: string; description: string; icon: string; color: string; is_active: number; sort_order: number; }
interface UserSystemRow extends RowDataPacket { id: number; user_id: number; system_id: number; system_slug: string; system_name: string; is_active: number; access_start: string | null; access_end: string | null; }
interface CompanyRow extends RowDataPacket { id: number; name: string; short_name: string; city: string; state: string; is_active: number; }
interface LocationRow extends RowDataPacket { id: number; company_id: number; name: string; code: string; city: string; is_active: number; }
interface AuditRow extends RowDataPacket { id: number; user_id: number; username: string; action: string; entity_type: string; entity_id: number; details: string; ip_address: string; created_at: string; }
interface CountRow extends RowDataPacket { cnt: number; }

// ═══════════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const pool = db.portal();

    // Run all independent count queries in parallel instead of sequentially
    const [
      [[totalUsers]], [[activeUsers]], [[tempUsers]], [[totalSystems]],
      [[totalCompanies]], [[recentLogins]], [[auditCount]],
      [systemCounts], [recentLoginList],
    ] = await Promise.all([
      pool.query<CountRow[]>('SELECT COUNT(*) as cnt FROM users'),
      pool.query<CountRow[]>('SELECT COUNT(*) as cnt FROM users WHERE is_active = 1'),
      pool.query<CountRow[]>("SELECT COUNT(*) as cnt FROM users WHERE user_type = 'temporary' AND is_active = 1"),
      pool.query<CountRow[]>('SELECT COUNT(*) as cnt FROM systems WHERE is_active = 1'),
      pool.query<CountRow[]>('SELECT COUNT(*) as cnt FROM companies WHERE is_active = 1'),
      pool.query<CountRow[]>('SELECT COUNT(*) as cnt FROM users WHERE last_login >= DATE_SUB(NOW(), INTERVAL 24 HOUR)'),
      pool.query<CountRow[]>('SELECT COUNT(*) as cnt FROM audit_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'),
      pool.query<(RowDataPacket & { slug: string; name: string; user_count: number })[]>(
        `SELECT s.slug, s.name, COUNT(us.id) as user_count
         FROM systems s LEFT JOIN user_systems us ON s.id = us.system_id AND us.is_active = 1
         WHERE s.is_active = 1 GROUP BY s.id ORDER BY s.sort_order`
      ),
      pool.query<(RowDataPacket & { username: string; full_name: string; last_login: string })[]>(
        'SELECT username, full_name, last_login FROM users WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT 10'
      ),
    ]);

    res.json({
      totalUsers: totalUsers.cnt,
      activeUsers: activeUsers.cnt,
      tempUsers: tempUsers.cnt,
      totalSystems: totalSystems.cnt,
      totalCompanies: totalCompanies.cnt,
      recentLogins24h: recentLogins.cnt,
      auditEvents7d: auditCount.cnt,
      systemCounts,
      recentLoginList,
    });
  } catch (err: any) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// List users (with search, pagination)
router.get('/users', async (req: Request, res: Response) => {
  try {
    const { search, role, status, page = '1', limit = '20' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR u.department LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (role) { where += ' AND u.role = ?'; params.push(role); }
    if (status === 'active') { where += ' AND u.is_active = 1'; }
    else if (status === 'inactive') { where += ' AND u.is_active = 0'; }

    const [[{ cnt: total }]] = await db.portal().query<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM users u ${where}`, params
    );

    const [users] = await db.portal().query<UserRow[]>(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.department, u.designation,
              u.company_id, u.location_id, u.role, u.user_type, u.is_active,
              u.access_expires_at, u.last_login, u.created_at, u.managed_by
       FROM users u ${where}
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({ users, total, page: Number(page), limit: Number(limit) });
  } catch (err: any) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Get single user with their systems
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const [users] = await db.portal().query<UserRow[]>(
      `SELECT id, username, full_name, email, phone, department, designation,
              company_id, location_id, role, user_type, is_active,
              access_expires_at, last_login, created_at, managed_by
       FROM users WHERE id = ?`, [req.params.id]
    );
    if (users.length === 0) { res.status(404).json({ error: 'User not found' }); return; }

    const [systems] = await db.portal().query<UserSystemRow[]>(
      `SELECT us.id, us.user_id, us.system_id, s.slug as system_slug, s.name as system_name,
              us.is_active, us.access_start, us.access_end
       FROM user_systems us JOIN systems s ON s.id = us.system_id
       WHERE us.user_id = ?`, [req.params.id]
    );

    res.json({ user: users[0], systems });
  } catch (err: any) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Create user
router.post('/users', async (req: Request, res: Response) => {
  try {
    const { username, password, full_name, email, phone, department, designation,
            company_id, location_id, role, user_type, access_expires_at, systems } = req.body;

    if (!username || !password || !full_name) {
      res.status(400).json({ error: 'Username, password, and full name are required' });
      return;
    }

    // Check duplicate username
    const [existing] = await db.portal().query<CountRow[]>(
      'SELECT COUNT(*) as cnt FROM users WHERE username = ?', [username]
    );
    if (existing[0].cnt > 0) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.portal().query<ResultSetHeader>(
      `INSERT INTO users (username, password, full_name, email, phone, department, designation,
        company_id, location_id, role, user_type, access_expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [username, hashedPassword, full_name, email || null, phone || null,
       department || null, designation || null, company_id || null, location_id || null,
       role || 'user', user_type || 'permanent', access_expires_at || null]
    );

    const userId = result.insertId;

    // Assign systems
    if (systems && Array.isArray(systems) && systems.length > 0) {
      const values = systems.map((sysId: number) => [userId, sysId, 1, req.user!.sub]);
      await db.portal().query(
        'INSERT INTO user_systems (user_id, system_id, is_active, granted_by) VALUES ?',
        [values]
      );
    }

    // Audit log
    await logAudit(req.user!.sub, 'user_create', 'user', userId, `Created user: ${username}`, req.ip);

    res.status(201).json({ id: userId, message: 'User created successfully' });
  } catch (err: any) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user
router.put('/users/:id', async (req: Request, res: Response) => {
  try {
    const { full_name, email, phone, department, designation,
            company_id, location_id, role, user_type, access_expires_at, is_active } = req.body;

    // Don't allow editing super_admin unless you're super_admin
    const [target] = await db.portal().query<UserRow[]>('SELECT role FROM users WHERE id = ?', [req.params.id]);
    if (target.length === 0) { res.status(404).json({ error: 'User not found' }); return; }
    if (target[0].role === 'super_admin' && req.user!.role !== 'super_admin') {
      res.status(403).json({ error: 'Cannot modify super admin' }); return;
    }

    await db.portal().query(
      `UPDATE users SET full_name=?, email=?, phone=?, department=?, designation=?,
        company_id=?, location_id=?, role=?, user_type=?, access_expires_at=?, is_active=?
       WHERE id=?`,
      [full_name, email || null, phone || null, department || null, designation || null,
       company_id || null, location_id || null, role, user_type, access_expires_at || null,
       is_active ?? 1, req.params.id]
    );

    await logAudit(req.user!.sub, 'user_update', 'user', Number(req.params.id), `Updated user #${req.params.id}`, req.ip);
    res.json({ message: 'User updated successfully' });
  } catch (err: any) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Reset user password
router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' }); return;
    }
    const hashed = await bcrypt.hash(password, 10);
    await db.portal().query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.params.id]);
    await logAudit(req.user!.sub, 'password_reset', 'user', Number(req.params.id), `Password reset for user #${req.params.id}`, req.ip);
    res.json({ message: 'Password reset successfully' });
  } catch (err: any) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SYSTEM ACCESS MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// List all systems
router.get('/systems', async (_req: Request, res: Response) => {
  try {
    const [systems] = await db.portal().query<SystemRow[]>(
      'SELECT id, slug, name, description, icon, color, is_active, sort_order FROM systems ORDER BY sort_order'
    );
    res.json(systems);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list systems' });
  }
});

// Update user systems (bulk assign/revoke)
router.put('/users/:id/systems', async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.id);
    const { systems } = req.body; // array of system_id numbers to grant

    if (!Array.isArray(systems)) {
      res.status(400).json({ error: 'systems must be an array of system IDs' }); return;
    }

    // Deactivate all current assignments
    await db.portal().query('UPDATE user_systems SET is_active = 0 WHERE user_id = ?', [userId]);

    // Activate/create selected ones
    for (const sysId of systems) {
      await db.portal().query(
        `INSERT INTO user_systems (user_id, system_id, is_active, granted_by)
         VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE is_active = 1, granted_by = ?`,
        [userId, sysId, req.user!.sub, req.user!.sub]
      );
    }

    await logAudit(req.user!.sub, 'systems_update', 'user', userId,
      `Updated systems for user #${userId}: [${systems.join(',')}]`, req.ip);
    res.json({ message: 'System access updated' });
  } catch (err: any) {
    console.error('Update systems error:', err);
    res.status(500).json({ error: 'Failed to update system access' });
  }
});

// ═══════════════════════════════════════════════════════════════
// COMPANIES & LOCATIONS
// ═══════════════════════════════════════════════════════════════
router.get('/companies', async (_req: Request, res: Response) => {
  try {
    const [companies] = await db.portal().query<CompanyRow[]>(
      'SELECT id, name, short_name, city, state, is_active FROM companies ORDER BY name'
    );
    res.json(companies);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list companies' });
  }
});

router.get('/locations', async (_req: Request, res: Response) => {
  try {
    const [locations] = await db.portal().query<LocationRow[]>(
      'SELECT id, company_id, name, code, city, is_active FROM locations ORDER BY name'
    );
    res.json(locations);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list locations' });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════
router.get('/audit-log', async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '30', action, user_id } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (action) { where += ' AND a.action = ?'; params.push(action); }
    if (user_id) { where += ' AND a.user_id = ?'; params.push(user_id); }

    const [[{ cnt: total }]] = await db.portal().query<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM audit_log a ${where}`, params
    );

    const [logs] = await db.portal().query<AuditRow[]>(
      `SELECT a.id, a.user_id, u.username, a.action, a.entity_type, a.entity_id,
              a.details, a.ip_address, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({ logs, total, page: Number(page), limit: Number(limit) });
  } catch (err: any) {
    console.error('Audit log error:', err);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ═══════════════════════════════════════════════════════════════
// LOGIN LOG (User login history with IP location)
// ═══════════════════════════════════════════════════════════════
router.get('/login-log', async (req: Request, res: Response) => {
  try {
    const { search, user_id, action, success, page = '1', limit = '50', from, to } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (search) {
      where += ' AND (l.username LIKE ? OR l.full_name LIKE ? OR l.ip_address LIKE ? OR l.city LIKE ? OR l.country LIKE ?)';
      const pat = `%${search}%`;
      params.push(pat, pat, pat, pat, pat);
    }
    if (user_id) { where += ' AND l.user_id = ?'; params.push(user_id); }
    if (action) { where += ' AND l.action = ?'; params.push(action); }
    if (success !== undefined && success !== '') { where += ' AND l.success = ?'; params.push(success); }
    if (from) { where += ' AND l.created_at >= ?'; params.push(from); }
    if (to) { where += ' AND l.created_at <= ? '; params.push(to + ' 23:59:59'); }

    const [[{ cnt: total }]] = await db.portal().query<CountRow[]>(
      `SELECT COUNT(*) as cnt FROM login_log l ${where}`, params
    );

    const [logs] = await db.portal().query<RowDataPacket[]>(
      `SELECT l.* FROM login_log l ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    // Stats summary
    const [[stats]] = await db.portal().query<RowDataPacket[]>(
      `SELECT
         COUNT(*) as total_logins,
         SUM(success = 1 AND action = 'login') as successful,
         SUM(success = 0) as failed,
         COUNT(DISTINCT ip_address) as unique_ips,
         COUNT(DISTINCT user_id) as unique_users
       FROM login_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );

    res.json({ logs, total, page: Number(page), limit: Number(limit), stats });
  } catch (err: any) {
    console.error('Login log error:', err);
    res.status(500).json({ error: 'Failed to load login log' });
  }
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
async function logAudit(userId: number, action: string, entityType: string | null, entityId: number | null, details: string, ip?: string) {
  await db.portal().query(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, action, entityType, entityId, details, ip || null]
  );
}

export default router;
