import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();

// ─── Constants ─────────────────────────────────────────────────
const PERMIT_TABLES = [
  'hot_permit', 'confined_permit', 'electrical_permit', 'excavation_permit',
  'height_permit', 'pipeline_permit', 'general_permit', 'fragile_permit',
  'unloading_permit', 'monomer_permit',
] as const;

const PERMIT_TYPE_LABELS: Record<string, string> = {
  hot_permit: 'Hot Work', confined_permit: 'Confined Space',
  electrical_permit: 'Electrical', excavation_permit: 'Excavation',
  height_permit: 'Height', pipeline_permit: 'Pipeline',
  general_permit: 'General', fragile_permit: 'Fragile Roof',
  unloading_permit: 'Unloading', monomer_permit: 'Monomer Unloading',
};

const PERMIT_TYPE_ICONS: Record<string, string> = {
  hot_permit: 'local_fire_department', confined_permit: 'reduce_capacity',
  electrical_permit: 'bolt', excavation_permit: 'construction',
  height_permit: 'height', pipeline_permit: 'plumbing',
  general_permit: 'assignment', fragile_permit: 'roofing',
  unloading_permit: 'local_shipping', monomer_permit: 'science',
};

const PERMIT_TYPE_COLORS: Record<string, string> = {
  hot_permit: '#ef4444', confined_permit: '#f97316',
  electrical_permit: '#eab308', excavation_permit: '#84cc16',
  height_permit: '#22c55e', pipeline_permit: '#06b6d4',
  general_permit: '#3b82f6', fragile_permit: '#8b5cf6',
  unloading_permit: '#ec4899', monomer_permit: '#f43f5e',
};

// High-risk types that need GWM approval on holidays
const GWM_REQUIRED_TYPES = ['hot_permit', 'confined_permit', 'monomer_permit'];

interface PermitRow extends RowDataPacket {
  id: number; rdate: string; rtime: string; type: string; location: string;
  disc: string; estime: string; eetime: string; remark: string; issued: string;
  returned: string; loto: string; ladder: string; perowner: string;
  permitno: string; secname: string; perremark: string; idate: string;
  itime: string; secname1: string; loto1: string; ladder1: string;
  cdate: string; ctime: string; cloname: string; csdate: string;
  cstime: string; perremark1: string; emer: string; gwmapp: string;
  st: string; st2: string; clocomment: string; s1: string;
  c1: string; c2: string; c3: string; c4: string; c5: string; c6: string; c7: string;
  perowner1: string; perowner2: string; peruser: string;
  peruser1: string; peruser2: string; matime: string; holidayapproval: number;
}

interface LocationRow extends RowDataPacket {
  id: number; loc: string; locks: string; dept: string;
}

interface HolidayRow extends RowDataPacket {
  id: number; holiday_date: string; description: string;
}

interface CountRow extends RowDataPacket { cnt: number; }

// Columns used by formatPermit — safe across all tables (some tables lack certain columns)
const PERMIT_SELECT_COLS = `id, rdate, rtime, type, location, disc, estime, eetime, remark,
  issued, returned, loto, ladder, perowner, permitno, secname, perremark, idate, itime,
  secname1, loto1, ladder1, cdate, ctime, cloname, csdate, cstime, perremark1, emer,
  gwmapp, st, st2, clocomment, s1, c1, c2, c3, c4, c5, c6, c7`;

// Tables missing optional columns
const TABLES_MISSING_ALL_OPTIONAL = ['unloading_permit'];  // missing all 7
const TABLES_MISSING_HOLIDAY = ['height_permit'];           // missing holidayapproval only

// Build safe SELECT for a table: always returns same column set
function permitSelectFrom(table: string, whereClause: string): string {
  if (TABLES_MISSING_ALL_OPTIONAL.includes(table)) {
    return `SELECT ${PERMIT_SELECT_COLS}, '' as perowner1, '' as perowner2,
      '' as peruser, '' as peruser1, '' as peruser2, '' as matime, 0 as holidayapproval,
      '${table}' as _table FROM \`${table}\` WHERE ${whereClause}`;
  }
  if (TABLES_MISSING_HOLIDAY.includes(table)) {
    return `SELECT ${PERMIT_SELECT_COLS},
      perowner1, perowner2, peruser, peruser1, peruser2, matime, 0 as holidayapproval,
      '${table}' as _table FROM \`${table}\` WHERE ${whereClause}`;
  }
  return `SELECT ${PERMIT_SELECT_COLS},
    perowner1, perowner2, peruser, peruser1, peruser2, matime, holidayapproval,
    '${table}' as _table FROM \`${table}\` WHERE ${whereClause}`;
}

// Helper: query all permit tables and combine results
async function queryAllTables(whereClause: string, params: any[] = []): Promise<(PermitRow & { _table: string })[]> {
  const results: (PermitRow & { _table: string })[] = [];
  const queries = PERMIT_TABLES.map(async (table) => {
    try {
      const [rows] = await db.permit().query<PermitRow[]>(
        permitSelectFrom(table, whereClause),
        params
      );
      return rows.map(r => ({ ...r, _table: table }));
    } catch { return []; }
  });
  const allResults = await Promise.all(queries);
  for (const rows of allResults) results.push(...rows);
  return results;
}

// Helper: format permit for API response
function formatPermit(row: PermitRow & { _table: string }) {
  return {
    id: row.id,
    type: row._table,
    typeLabel: PERMIT_TYPE_LABELS[row._table] || row._table,
    typeIcon: PERMIT_TYPE_ICONS[row._table] || 'assignment',
    typeColor: PERMIT_TYPE_COLORS[row._table] || '#64748b',
    requestDate: row.rdate,
    requestTime: row.rtime,
    location: row.location,
    description: row.disc,
    expectedStart: row.estime,
    expectedEnd: row.eetime,
    mode: row.emer === 'N' ? 'Normal' : row.emer === 'B' ? 'Breakdown' : row.emer === 'U' ? 'Unplanned' : row.emer,
    modeCode: row.emer,
    status: row.st2,
    issueStatus: row.st,
    permitNumber: row.permitno,
    department: row.secname,
    permitOwner: row.perowner,
    permitOwner2: row.perowner1,
    permitOwner3: row.perowner2,
    permitUser1: row.peruser,
    permitUser2: row.peruser1,
    permitUser3: row.peruser2,
    lotoRequired: row.loto,
    lotoReturned: row.loto1,
    ladderRequired: row.ladder,
    ladderReturned: row.ladder1,
    fireGuard: row.s1,
    checklist: { c1: row.c1, c2: row.c2, c3: row.c3, c4: row.c4, c5: row.c5, c6: row.c6, c7: row.c7 },
    issueDate: row.idate,
    issueTime: row.itime,
    closedBy: row.cloname,
    closeDate: row.cdate,
    closeTime: row.ctime,
    securityName: row.secname1,
    securityCloseDate: row.csdate,
    securityCloseTime: row.cstime,
    securityReturn: row.returned,
    remarks: row.perremark,
    securityRemarks: row.perremark1,
    closureComment: row.clocomment,
    managerApprovalTime: row.matime,
    gwmApproval: row.gwmapp,
    holidayApproval: row.holidayapproval,
  };
}

// ─── GET /dashboard ────────────────────────────────────────────
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const today = new Date().toISOString().slice(0, 10);
    const todayFormatted = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });

    // Build UNION ALL queries to fetch all stats in a single round-trip per metric
    const unionAllFrom = PERMIT_TABLES.map(t => `SELECT '${t}' as _table, id, rdate, estime, st2, emer FROM \`${t}\``).join(' UNION ALL ');
    const allPermitsQuery = `SELECT * FROM (${unionAllFrom}) AS combined`;

    // Run all stats queries in parallel
    const [
      [statsRows],
      recentResults,
    ] = await Promise.all([
      // Single query for all counts using conditional aggregation
      db.permit().query<RowDataPacket[]>(`
        SELECT
          _table,
          COUNT(*) as total,
          SUM(CASE WHEN estime >= ? AND st2 IN ('Printable and permit to be surrender','Permit Returned') THEN 1 ELSE 0 END) as approved,
          SUM(CASE WHEN estime >= ? AND st2 LIKE 'Waiting%' THEN 1 ELSE 0 END) as waiting,
          SUM(CASE WHEN rdate = ? THEN 1 ELSE 0 END) as raised,
          SUM(CASE WHEN st2 = 'Locked' THEN 1 ELSE 0 END) as locked,
          SUM(CASE WHEN st2 = 'Printable and permit to be surrender' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN emer = 'N' THEN 1 ELSE 0 END) as normal_mode,
          SUM(CASE WHEN emer = 'B' THEN 1 ELSE 0 END) as breakdown_mode,
          SUM(CASE WHEN emer = 'U' THEN 1 ELSE 0 END) as unplanned_mode
        FROM (${unionAllFrom}) AS combined
        GROUP BY _table
      `, [today, today, todayFormatted]),

      // Recent permits - parallel per table, only 3 each
      Promise.all(PERMIT_TABLES.map(async (table) => {
        try {
          const [rows] = await db.permit().query<PermitRow[]>(
            permitSelectFrom(table, '1=1') + ' ORDER BY id DESC LIMIT 3'
          );
          return rows.map(r => formatPermit({ ...r, _table: table }));
        } catch { return []; }
      })),
    ]);

    // Process stats from single query result
    let approved = 0, waiting = 0, raised = 0, locked = 0, active = 0;
    const typeCounts: Record<string, number> = {};
    const modeCounts: Record<string, number> = { Normal: 0, Breakdown: 0, Unplanned: 0 };

    for (const row of statsRows as any[]) {
      approved += Number(row.approved);
      waiting += Number(row.waiting);
      raised += Number(row.raised);
      locked += Number(row.locked);
      active += Number(row.active);
      typeCounts[PERMIT_TYPE_LABELS[row._table] || row._table] = Number(row.total);
      modeCounts.Normal += Number(row.normal_mode);
      modeCounts.Breakdown += Number(row.breakdown_mode);
      modeCounts.Unplanned += Number(row.unplanned_mode);
    }

    // Status distribution - single query with UNION ALL
    const statusUnion = PERMIT_TABLES.map(t => `SELECT st2 FROM \`${t}\``).join(' UNION ALL ');
    const [statusRows] = await db.permit().query<(RowDataPacket & { st2: string; cnt: number })[]>(
      `SELECT st2, COUNT(*) as cnt FROM (${statusUnion}) AS combined GROUP BY st2`
    );
    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) {
      statusCounts[row.st2] = row.cnt;
    }

    // Flatten recent permits
    const recentPermits = recentResults.flat().sort((a: any, b: any) => b.id - a.id).slice(0, 10);

    res.json({
      stats: { approved, waiting, raised, locked, active },
      typeCounts,
      modeCounts,
      statusCounts,
      recentPermits,
    });
  } catch (err: any) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ─── GET /permits ──────────────────────────────────────────────
router.get('/permits', async (req: Request, res: Response) => {
  try {
    const { type, status, mode, department, search, page = '1', limit = '20' } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = Math.min(100, parseInt(limit as string));

    // If a specific type is requested, only query that table
    const tables = (type && type !== 'all' && PERMIT_TABLES.includes(type as any))
      ? [type as string]
      : [...PERMIT_TABLES];

    // Build WHERE clause for database-level filtering
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (status && status !== 'all') {
      conditions.push('st2 = ?');
      params.push(status);
    }
    if (mode && mode !== 'all') {
      conditions.push('emer = ?');
      params.push(mode);
    }
    if (department && department !== 'all') {
      conditions.push('secname = ?');
      params.push(department);
    }
    if (search) {
      conditions.push('(disc LIKE ? OR location LIKE ? OR perowner LIKE ? OR permitno LIKE ? OR CAST(id AS CHAR) LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const whereClause = conditions.join(' AND ');

    // Get counts and data in parallel across all relevant tables
    const countQueries = tables.map(async (table) => {
      try {
        const [rows] = await db.permit().query<CountRow[]>(
          `SELECT COUNT(*) as cnt FROM \`${table}\` WHERE ${whereClause}`, params
        );
        return rows[0].cnt;
      } catch { return 0; }
    });

    const counts = await Promise.all(countQueries);
    const total = counts.reduce((sum, c) => sum + c, 0);

    // Now fetch only the page we need using UNION ALL with LIMIT/OFFSET
    const unionParts = tables.map(t => permitSelectFrom(t, whereClause));
    const unionQuery = unionParts.join(' UNION ALL ');
    const offset = (pageNum - 1) * limitNum;

    // Replicate params for each UNION part
    const allParams = tables.flatMap(() => params);

    const [rows] = await db.permit().query<PermitRow[]>(
      `SELECT * FROM (${unionQuery}) AS combined ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...allParams, limitNum, offset]
    );

    const permits = rows.map(r => formatPermit({ ...r, _table: (r as any)._table }));

    res.json({ permits, total, page: pageNum, limit: limitNum });
  } catch (err: any) {
    console.error('List permits error:', err);
    res.status(500).json({ error: 'Failed to load permits' });
  }
});

// ─── GET /permits/:type/:id ────────────────────────────────────
router.get('/permits/:type/:id', async (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    const id = req.params.id;
    if (!PERMIT_TABLES.includes(type as any)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    const [rows] = await db.permit().query<PermitRow[]>(
      permitSelectFrom(type, 'id = ?'), [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Permit not found' });
      return;
    }

    res.json(formatPermit({ ...rows[0], _table: type }));
  } catch (err: any) {
    console.error('Get permit error:', err);
    res.status(500).json({ error: 'Failed to get permit' });
  }
});

// ─── POST /permits ─────────────────────────────────────────────
router.post('/permits', async (req: Request, res: Response) => {
  try {
    const { type, location, description, expectedStart, expectedEnd, mode, fireGuard } = req.body;
    const user = req.user!;

    if (!type || !location || !description || !expectedStart) {
      res.status(400).json({ error: 'Type, location, description, and expected start date are required' });
      return;
    }

    if (!PERMIT_TABLES.includes(type)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    // Get user details and check holiday in parallel
    const [usersResult, holidaysResult] = await Promise.all([
      db.portal().query<RowDataPacket[]>(
        'SELECT full_name, department FROM users WHERE id = ?', [user.sub]
      ),
      db.permit().query<HolidayRow[]>(
        'SELECT * FROM holidays WHERE holiday_date = ?', [expectedStart]
      ),
    ]);

    const [users] = usersResult;
    if (users.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const { full_name: ownerName, department } = users[0];

    const now = new Date();
    const rdate = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const rtime = now.toTimeString().slice(0, 8);
    const modeCode = mode === 'Breakdown' ? 'B' : mode === 'Unplanned' ? 'U' : 'N';

    // Determine initial status
    let st2 = 'Waiting for Dept. Mgr Approval';
    if (modeCode === 'U') {
      st2 = 'Waiting for Sr. Mgr Approval';
    }

    // Check if holiday and high-risk type
    const [holidays] = holidaysResult;
    const isHoliday = holidays.length > 0;
    const isSunday = new Date(expectedStart).getDay() === 0;

    if ((isHoliday || isSunday) && GWM_REQUIRED_TYPES.includes(type)) {
      st2 = 'Waiting for GWM Approval';
    }

    const [result] = await db.permit().query<ResultSetHeader>(
      `INSERT INTO \`${type}\` (rdate, rtime, type, location, disc, estime, eetime, perowner, emer, st, st2, secname, s1, gwmapp, remark, holidayapproval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Not Issued', ?, ?, ?, ?, '', ?)`,
      [rdate, rtime, type, location, description, expectedStart, expectedEnd || '5:00pm',
       ownerName, modeCode, st2, department || '', fireGuard || 'Fire Guard Not Required',
       modeCode, isHoliday || isSunday ? 1 : 0]
    );

    res.status(201).json({
      id: result.insertId,
      type,
      status: st2,
      message: 'Permit created successfully',
    });
  } catch (err: any) {
    console.error('Create permit error:', err);
    res.status(500).json({ error: 'Failed to create permit' });
  }
});

// ─── GET /approvals ────────────────────────────────────────────
router.get('/approvals', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { scope = 'department' } = req.query;

    // Get user's department
    const [users] = await db.portal().query<RowDataPacket[]>(
      'SELECT department, designation FROM users WHERE id = ?', [user.sub]
    );
    const userDept = users[0]?.department;
    const today = new Date().toISOString().slice(0, 10);

    let permits: any[];

    if (scope === 'gwm') {
      // GWM approvals - only holiday permits
      permits = await queryAllTables(`st2 = 'Waiting for GWM Approval' AND estime >= ?`, [today]);
    } else if (scope === 'all') {
      // Cross-department approvals
      permits = await queryAllTables(`st2 LIKE 'Waiting%' AND estime >= ?`, [today]);
    } else if (scope === 'unplanned') {
      // Unplanned approvals
      permits = await queryAllTables(`st2 = 'Waiting for Sr. Mgr Approval' AND estime >= ?`, [today]);
    } else {
      // Department-specific
      permits = await queryAllTables(`st2 = 'Waiting for Dept. Mgr Approval' AND secname = ? AND estime >= ?`, [userDept, today]);
    }

    res.json(permits.map(formatPermit));
  } catch (err: any) {
    console.error('Approvals error:', err);
    res.status(500).json({ error: 'Failed to load approvals' });
  }
});

// ─── POST /approvals/:type/:id/approve ─────────────────────────
router.post('/approvals/:type/:id/approve', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    if (!PERMIT_TABLES.includes(type as any)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    const now = new Date();
    const matime = now.toTimeString().slice(0, 8);

    await db.permit().query(
      `UPDATE \`${type}\` SET st2 = 'Permit Pending for Confirm', matime = ? WHERE id = ?`,
      [matime, id]
    );

    res.json({ message: 'Permit approved' });
  } catch (err: any) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'Failed to approve permit' });
  }
});

// ─── POST /approvals/:type/:id/reject ──────────────────────────
router.post('/approvals/:type/:id/reject', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const { remark } = req.body;
    if (!PERMIT_TABLES.includes(type as any)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    await db.permit().query(
      `UPDATE \`${type}\` SET st2 = 'Cancelled', perremark = ? WHERE id = ?`,
      [remark || 'Rejected by manager', id]
    );

    res.json({ message: 'Permit rejected' });
  } catch (err: any) {
    console.error('Reject error:', err);
    res.status(500).json({ error: 'Failed to reject permit' });
  }
});

// ─── POST /permits/:type/:id/confirm ───────────────────────────
router.post('/permits/:type/:id/confirm', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const { permitNumber, permitOwner2, permitOwner3, permitUser1, permitUser2, permitUser3,
            loto, ladder, c1, c2, c3, c4, c5, c6, c7, remarks } = req.body;

    if (!PERMIT_TABLES.includes(type as any)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    const now = new Date();
    const idate = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const itime = now.toTimeString().slice(0, 8);

    await db.permit().query(
      `UPDATE \`${type}\` SET
        st = 'Permit Issued', st2 = 'Printable and permit to be surrender',
        permitno = ?, perowner1 = ?, perowner2 = ?,
        peruser = ?, peruser1 = ?, peruser2 = ?,
        loto = ?, ladder = ?,
        c1 = ?, c2 = ?, c3 = ?, c4 = ?, c5 = ?, c6 = ?, c7 = ?,
        perremark = ?, idate = ?, itime = ?, returned = 'Not Returned'
       WHERE id = ?`,
      [permitNumber || '', permitOwner2 || '', permitOwner3 || '',
       permitUser1 || '', permitUser2 || '', permitUser3 || '',
       loto || '', ladder || '', c1 || '', c2 || '', c3 || '', c4 || '', c5 || '', c6 || '', c7 || '',
       remarks || '', idate, itime, id]
    );

    res.json({ message: 'Permit confirmed and issued' });
  } catch (err: any) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm permit' });
  }
});

// ─── GET /security ─────────────────────────────────────────────
router.get('/security', async (_req: Request, res: Response) => {
  try {
    const permits = await queryAllTables(
      `st2 IN ('Printable and permit to be surrender', 'Permit not surrendered')`
    );
    res.json(permits.map(formatPermit));
  } catch (err: any) {
    console.error('Security list error:', err);
    res.status(500).json({ error: 'Failed to load security permits' });
  }
});

// ─── POST /security/:type/:id/close ────────────────────────────
router.post('/security/:type/:id/close', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const { returnStatus, securityName, remarks } = req.body;

    if (!PERMIT_TABLES.includes(type as any)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    const validStatuses = ['Permit Returned', 'Locked', 'Permit Returned with NC', 'Cancelled'];
    if (!validStatuses.includes(returnStatus)) {
      res.status(400).json({ error: 'Invalid return status' });
      return;
    }

    const now = new Date();
    const csdate = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const cstime = now.toTimeString().slice(0, 8);

    await db.permit().query(
      `UPDATE \`${type}\` SET
        returned = ?, secname1 = ?, csdate = ?, cstime = ?,
        perremark1 = ?, st2 = ?
       WHERE id = ?`,
      [returnStatus, securityName || '', csdate, cstime,
       remarks ? `${remarks}-${csdate}` : '',
       returnStatus === 'Permit Returned' ? 'Permit Returned' : returnStatus,
       id]
    );

    res.json({ message: `Permit ${returnStatus.toLowerCase()}` });
  } catch (err: any) {
    console.error('Security close error:', err);
    res.status(500).json({ error: 'Failed to close permit' });
  }
});

// ─── Safety Admin Routes ───────────────────────────────────────

// GET /safety/locked - Locked & NC permits
router.get('/safety/locked', async (_req: Request, res: Response) => {
  try {
    const permits = await queryAllTables(
      `st2 IN ('Locked', 'Permit Returned with NC')`
    );
    res.json(permits.map(formatPermit));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load locked permits' });
  }
});

// POST /safety/:type/:id/unlock - Unlock a permit
router.post('/safety/:type/:id/unlock', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    if (!PERMIT_TABLES.includes(type as any)) {
      res.status(400).json({ error: 'Invalid permit type' });
      return;
    }

    await db.permit().query(
      `UPDATE \`${type}\` SET st2 = 'Lock Released' WHERE id = ?`, [id]
    );

    res.json({ message: 'Permit unlocked' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to unlock permit' });
  }
});

// ─── Locations ─────────────────────────────────────────────────
router.get('/locations', async (_req: Request, res: Response) => {
  try {
    const [rows] = await db.permit().query<LocationRow[]>(
      'SELECT * FROM permit_location ORDER BY loc'
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load locations' });
  }
});

router.post('/locations', async (req: Request, res: Response) => {
  try {
    const { name, department } = req.body;
    if (!name) { res.status(400).json({ error: 'Location name is required' }); return; }

    await db.permit().query<ResultSetHeader>(
      'INSERT INTO permit_location (loc, locks, dept) VALUES (?, ?, ?)',
      [name.replace(/ /g, '_'), 'Open', department || '']
    );

    res.status(201).json({ message: 'Location added' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add location' });
  }
});

router.put('/locations/:id/lock', async (req: Request, res: Response) => {
  try {
    await db.permit().query('UPDATE permit_location SET locks = ? WHERE id = ?', ['Locked', req.params.id]);
    res.json({ message: 'Location locked' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to lock location' });
  }
});

router.put('/locations/:id/unlock', async (req: Request, res: Response) => {
  try {
    await db.permit().query('UPDATE permit_location SET locks = ? WHERE id = ?', ['Open', req.params.id]);
    res.json({ message: 'Location unlocked' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to unlock location' });
  }
});

// ─── Holidays ──────────────────────────────────────────────────
router.get('/holidays', async (_req: Request, res: Response) => {
  try {
    const [rows] = await db.permit().query<HolidayRow[]>(
      'SELECT * FROM holidays ORDER BY holiday_date'
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load holidays' });
  }
});

router.post('/holidays', async (req: Request, res: Response) => {
  try {
    const { date, description } = req.body;
    if (!date) { res.status(400).json({ error: 'Holiday date is required' }); return; }

    await db.permit().query<ResultSetHeader>(
      'INSERT INTO holidays (holiday_date, description, created_by) VALUES (?, ?, ?)',
      [date, description || '', req.user!.sub]
    );

    res.status(201).json({ message: 'Holiday added' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add holiday' });
  }
});

router.delete('/holidays/:id', async (req: Request, res: Response) => {
  try {
    await db.permit().query('DELETE FROM holidays WHERE id = ?', [req.params.id]);
    res.json({ message: 'Holiday removed' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to remove holiday' });
  }
});

// ─── Reports ───────────────────────────────────────────────────
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const { permitType, status, mode, department, startDate, endDate } = req.query;

    // Build WHERE clause for database-level filtering
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (status && status !== 'all') {
      conditions.push('st2 = ?');
      params.push(status);
    }
    if (mode && mode !== 'all') {
      conditions.push('emer = ?');
      params.push(mode);
    }
    if (department && department !== 'all') {
      conditions.push('secname = ?');
      params.push(department);
    }
    if (startDate) {
      conditions.push('estime >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('estime <= ?');
      params.push(endDate);
    }

    const whereClause = conditions.join(' AND ');

    // If specific type, only query that table
    const tables = (permitType && permitType !== 'all' && PERMIT_TABLES.includes(permitType as any))
      ? [permitType as string]
      : [...PERMIT_TABLES];

    const results = await Promise.all(tables.map(async (table) => {
      try {
        const [rows] = await db.permit().query<PermitRow[]>(
          permitSelectFrom(table, whereClause),
          params
        );
        return rows.map(r => ({ ...r, _table: table }));
      } catch { return []; }
    }));

    const allResults = results.flat();
    allResults.sort((a, b) => b.id - a.id);

    res.json({
      permits: allResults.map(r => formatPermit({ ...r, _table: r._table })),
      total: allResults.length,
      summary: {
        byType: Object.fromEntries(PERMIT_TABLES.map(t => [PERMIT_TYPE_LABELS[t], allResults.filter(r => r._table === t).length])),
        byStatus: allResults.reduce((acc, r) => { acc[r.st2] = (acc[r.st2] || 0) + 1; return acc; }, {} as Record<string, number>),
        byMode: allResults.reduce((acc, r) => { const m = r.emer === 'N' ? 'Normal' : r.emer === 'B' ? 'Breakdown' : 'Unplanned'; acc[m] = (acc[m] || 0) + 1; return acc; }, {} as Record<string, number>),
      },
    });
  } catch (err: any) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ─── Permit Types Reference ────────────────────────────────────
router.get('/types', (_req: Request, res: Response) => {
  res.json(PERMIT_TABLES.map(t => ({
    value: t,
    label: PERMIT_TYPE_LABELS[t],
    icon: PERMIT_TYPE_ICONS[t],
    color: PERMIT_TYPE_COLORS[t],
    gwmRequired: GWM_REQUIRED_TYPES.includes(t),
  })));
});

// ─── My Permits ────────────────────────────────────────────────
router.get('/my-permits', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const [users] = await db.portal().query<RowDataPacket[]>(
      'SELECT full_name FROM users WHERE id = ?', [user.sub]
    );
    const ownerName = users[0]?.full_name;

    if (!ownerName) {
      res.json([]);
      return;
    }

    const permits = await queryAllTables('perowner = ?', [ownerName]);
    permits.sort((a, b) => b.id - a.id);

    res.json(permits.map(formatPermit));
  } catch (err: any) {
    console.error('My permits error:', err);
    res.status(500).json({ error: 'Failed to load permits' });
  }
});

export default router;
