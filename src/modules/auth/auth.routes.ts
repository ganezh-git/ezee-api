import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../../config/database';
import { environment } from '../../config/environment';
import { AuthPayload, authenticate } from '../../middleware/authenticate';
import { RowDataPacket } from 'mysql2';

const router = Router();

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password: string;
  full_name: string;
  email: string;
  department: string | null;
  designation: string | null;
  role: string;
  user_type: string;
  is_active: number;
  access_expires_at: string | null;
  company_id: number | null;
  location_id: number | null;
}

interface SystemRow extends RowDataPacket {
  slug: string;
}

interface SystemAdminRow extends RowDataPacket {
  system_slug: string;
}

interface LegacyUserRow extends RowDataPacket {
  user_id: number;
  username: string;
  password: string;
  empname: string;
  designation: string;
  department: string;
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password, module } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    // Strategy 1: Try modern portal authentication
    const [users] = await db.portal().query<UserRow[]>(
      'SELECT * FROM users WHERE username = ? AND is_active = 1',
      [username]
    );

    if (users.length > 0) {
      const user = users[0];

      // Check temporary user expiry
      if (user.user_type === 'temporary' && user.access_expires_at) {
        if (new Date(user.access_expires_at) < new Date()) {
          res.status(401).json({ error: 'Account has expired' });
          return;
        }
      }

      const passwordMatch = await bcrypt.compare(password, user.password);
      if (passwordMatch) {
        // Generate token and update last login in parallel
        const [token] = await Promise.all([
          generateToken(user),
          updateLastLogin(user.id),
        ]);
        res.json({ token, user: sanitizeUser(user) });
        return;
      }
    }

    // Strategy 2: For permit module, try legacy login database
    if (module === 'permit') {
      const [legacyUsers] = await db.login().query<LegacyUserRow[]>(
        'SELECT * FROM cmp_user WHERE username = ?',
        [username]
      );

      if (legacyUsers.length > 0) {
        const legacyUser = legacyUsers[0];
        const md5Hash = crypto.createHash('md5').update(password).digest('hex');

        if (legacyUser.password === md5Hash) {
          // Auto-migrate: create modern user with bcrypt password
          const migratedUser = await migrateLegacyUser(legacyUser, password);
          const token = await generateToken(migratedUser);
          res.json({
            token,
            user: sanitizeUser(migratedUser),
            migrated: true,
          });
          return;
        }
      }
    }

    res.status(401).json({ error: 'Invalid username or password' });
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: 'Token required' });
      return;
    }

    const payload = jwt.verify(token, environment.jwt.secret) as unknown as AuthPayload;
    const [users] = await db.portal().query<UserRow[]>(
      'SELECT * FROM users WHERE id = ? AND is_active = 1',
      [payload.sub]
    );

    if (users.length === 0) {
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    const newToken = await generateToken(users[0]);
    res.json({ token: newToken });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  // JWT is stateless — client discards the token
  // Future: add token to blacklist if needed
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me
router.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, environment.jwt.secret) as unknown as AuthPayload;

    const [users] = await db.portal().query<UserRow[]>(
      'SELECT id, username, full_name, email, role, user_type, company_id, location_id FROM users WHERE id = ?',
      [payload.sub]
    );

    if (users.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: users[0], systems: payload.systems });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, password, empname, email, department, designation, module } = req.body;

    if (!username || !password || !empname || !department || !designation) {
      res.status(400).json({ error: 'All fields are required: username, password, empname, department, designation' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    // Check if username already exists in portal
    const [existing] = await db.portal().query<UserRow[]>(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      res.status(409).json({ error: 'This Employee ID is already registered' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.portal().query(
      `INSERT INTO users (username, password, full_name, email, department, designation, role, user_type, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 'user', 'permanent', 1)`,
      [username, hashedPassword, empname, email || null, department, designation]
    );

    const insertId = (result as any).insertId;

    // If registering from permit module, also create legacy login entry and assign permit access
    if (module === 'permit') {
      const md5Password = crypto.createHash('md5').update(password).digest('hex');
      await db.login().query(
        `INSERT INTO cmp_user (username, email, password, empname, department, designation)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [username, email || '', md5Password, empname, department, designation]
      );

      await db.portal().query(
        `INSERT INTO user_systems (user_id, system_id, is_active)
         SELECT ?, id, 1 FROM systems WHERE slug = 'permit'`,
        [insertId]
      );
    }

    res.status(201).json({ message: 'Registration successful' });
  } catch (err: any) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Helper functions
async function generateToken(user: UserRow): Promise<string> {
  // Run both queries in parallel instead of sequentially
  const [[systems], [adminSystems]] = await Promise.all([
    db.portal().query<SystemRow[]>(
      `SELECT s.slug FROM systems s
       JOIN user_systems us ON s.id = us.system_id
       WHERE us.user_id = ? AND us.is_active = 1`,
      [user.id]
    ),
    db.portal().query<SystemAdminRow[]>(
      `SELECT s.slug as system_slug FROM system_admins sa
       JOIN systems s ON s.id = sa.system_id
       WHERE sa.user_id = ? AND sa.is_active = 1
       AND (sa.access_end IS NULL OR sa.access_end >= NOW())`,
      [user.id]
    ),
  ]);

  const userSystems = user.role === 'super_admin'
    ? ['permit', 'permit-birla', 'inventory', 'vehicle', 'safety', 'visitor', 'reception', 'stationery', 'library']
    : systems.map(s => s.slug);

  const payload: AuthPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    userType: user.user_type,
    systems: userSystems,
    systemAdmin: adminSystems.map(s => s.system_slug),
    companyId: user.company_id,
    locationId: user.location_id,
  };

  const signOptions = { expiresIn: environment.jwt.expiresIn } as SignOptions;
  return jwt.sign(payload as object, environment.jwt.secret as jwt.Secret, signOptions);
}

async function updateLastLogin(userId: number): Promise<void> {
  await db.portal().query('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
}

function sanitizeUser(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    department: user.department,
    designation: user.designation,
    role: user.role,
    userType: user.user_type,
    companyId: user.company_id,
    locationId: user.location_id,
  };
}

async function migrateLegacyUser(legacyUser: LegacyUserRow, plainPassword: string): Promise<UserRow> {
  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  // Check if user already exists in portal
  const [existing] = await db.portal().query<UserRow[]>(
    'SELECT * FROM users WHERE username = ?',
    [legacyUser.username]
  );

  if (existing.length > 0) {
    // Update password to bcrypt
    await db.portal().query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, existing[0].id]
    );
    return { ...existing[0], password: hashedPassword };
  }

  // Create new portal user from legacy data
  const [result] = await db.portal().query(
    `INSERT INTO users (username, password, full_name, role, user_type, is_active, department)
     VALUES (?, ?, ?, 'user', 'permanent', 1, ?)`,
    [legacyUser.username, hashedPassword, legacyUser.empname, legacyUser.department]
  );

  const insertId = (result as any).insertId;

  // Assign permit system access
  await db.portal().query(
    `INSERT INTO user_systems (user_id, system_id, is_active)
     SELECT ?, id, 1 FROM systems WHERE slug = 'permit'`,
    [insertId]
  );

  const [newUser] = await db.portal().query<UserRow[]>(
    'SELECT * FROM users WHERE id = ?',
    [insertId]
  );

  return newUser[0];
}

// POST /api/auth/change-password (self — any logged-in user)
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current password and new password are required' }); return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters' }); return;
    }

    const [users] = await db.portal().query<UserRow[]>('SELECT * FROM users WHERE id = ?', [userId]);
    if (!users.length) { res.status(404).json({ error: 'User not found' }); return; }

    const match = await bcrypt.compare(currentPassword, users[0].password);
    if (!match) { res.status(401).json({ error: 'Current password is incorrect' }); return; }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.portal().query('UPDATE users SET password = ? WHERE id = ?', [hashed, userId]);
    res.json({ message: 'Password changed successfully' });
  } catch (err: any) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/auth/profile (self)
router.get('/profile', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const [users] = await db.portal().query<UserRow[]>(
      'SELECT id, username, full_name, email, department, designation, role, user_type, company_id, location_id, last_login, created_at FROM users WHERE id = ?',
      [userId]
    );
    if (!users.length) { res.status(404).json({ error: 'User not found' }); return; }

    const user = users[0];
    res.json({
      id: user.id, username: user.username, fullName: user.full_name,
      email: user.email, department: user.department, designation: user.designation,
      role: user.role, userType: user.user_type, companyId: user.company_id,
      locationId: user.location_id, lastLogin: user.last_login, createdAt: user.created_at,
    });
  } catch (err: any) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// PUT /api/auth/profile (update own profile)
router.put('/profile', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const { fullName, email, department, designation } = req.body;
    await db.portal().query(
      'UPDATE users SET full_name = ?, email = ?, department = ?, designation = ? WHERE id = ?',
      [fullName, email, department, designation, userId]
    );
    res.json({ message: 'Profile updated successfully' });
  } catch (err: any) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
