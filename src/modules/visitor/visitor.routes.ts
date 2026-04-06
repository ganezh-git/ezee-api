import { Router, Request, Response } from 'express';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
const pool = () => db.visitor();
const portalPool = () => db.portal();

// ─── Helpers ───────────────────────────────────────────────────
async function generateVisitNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT MAX(CAST(SUBSTRING(visit_no, LENGTH('VIS-${year}-') + 1) AS UNSIGNED)) as mx FROM visits WHERE visit_no LIKE ?`,
    [`VIS-${year}-%`]
  );
  const next = ((rows[0]?.mx as number) || 0) + 1;
  return `VIS-${year}-${String(next).padStart(4, '0')}`;
}

async function generatePassNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT MAX(CAST(SUBSTRING(pass_no, LENGTH('VP-${year}-') + 1) AS UNSIGNED)) as mx FROM visits WHERE pass_no LIKE ? AND pass_no IS NOT NULL`,
    [`VP-${year}-%`]
  );
  const next = ((rows[0]?.mx as number) || 0) + 1;
  return `VP-${year}-${String(next).padStart(4, '0')}`;
}

async function generateBadgeNo(): Promise<string> {
  const [settings] = await pool().execute<RowDataPacket[]>(
    `SELECT setting_value FROM visitor_settings WHERE setting_key = 'badge_prefix'`
  );
  const prefix = settings[0]?.setting_value || 'V';
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT MAX(CAST(SUBSTRING(badge_no, LENGTH(?) + 2) AS UNSIGNED)) as mx FROM visits WHERE badge_no LIKE ? AND badge_no IS NOT NULL`,
    [prefix, `${prefix}-%`]
  );
  const next = ((rows[0]?.mx as number) || 0) + 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

async function logAction(visitId: number | null, visitorName: string, action: string, details: string, performedBy: string) {
  await pool().execute(
    `INSERT INTO visitor_log (visit_id, visitor_name, action, details, performed_by) VALUES (?, ?, ?, ?, ?)`,
    [visitId, visitorName, action, details, performedBy]
  );
}

// Lookup user profile from portal.users (fullName, department)
async function getUserProfile(userId: number): Promise<{ fullName: string; department: string } | null> {
  try {
    const [rows] = await portalPool().execute<RowDataPacket[]>(
      `SELECT full_name, department FROM users WHERE id = ?`, [userId]
    );
    if (rows.length) return { fullName: rows[0].full_name, department: rows[0].department || '' };
  } catch (_) { /* ignore */ }
  return null;
}

// Lookup visitor by phone (for reception quick-fill)
router.get('/lookup', async (req: Request, res: Response) => {
  try {
    const phone = req.query.phone as string;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    // Find most recent visit with this phone
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT visitor_name, visitor_company, visitor_phone, visitor_email, visitor_type,
              id_type, id_number, vehicle_no, emergency_contact
       FROM visits WHERE visitor_phone = ? ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );

    if (!rows.length) return res.json({ found: false });
    res.json({ found: true, visitor: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Get user profile for auto-filling host info
router.get('/my-profile', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.sub) return res.json({ fullName: user?.username || '', department: '' });
    const profile = await getUserProfile(user.sub);
    res.json(profile || { fullName: user.username, department: '' });
  } catch (err: any) {
    res.json({ fullName: '', department: '' });
  }
});

// ═══════════════════════════════════════════════════════════════
// LIVE DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [todayExpected] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM visits WHERE visit_date <= CURDATE() AND (visit_date_to >= CURDATE() OR visit_date = CURDATE())`
    );
    const [currentlyInside] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM visits WHERE status = 'checked_in'`
    );
    const [pendingApprovals] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM visits WHERE status = 'pending_approval'`
    );
    const [checkedInToday] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM visits WHERE DATE(entry_time) = CURDATE()`
    );
    const [checkedOutToday] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM visits WHERE DATE(exit_time) = CURDATE()`
    );
    const [noShowToday] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM visits WHERE visit_date = CURDATE() AND status = 'no_show'`
    );

    // Overdue visitors (inside past expected departure)
    const [overdue] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, host_name, host_department,
              expected_departure, entry_time, badge_no
       FROM visits
       WHERE status = 'checked_in'
         AND CONCAT(visit_date, ' ', COALESCE(expected_departure, '18:00:00')) < NOW()
       ORDER BY entry_time`
    );

    // Pending approvals list
    const [pendingList] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, purpose,
              visit_date, visit_date_to, expected_arrival, host_name, host_department,
              booked_by, booked_by_role, created_at
       FROM visits WHERE status = 'pending_approval' ORDER BY visit_date, expected_arrival`
    );

    // Check-in queue: approved visits for today not yet checked in
    const [checkInQueue] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, visitor_count,
              purpose, visit_date, visit_date_to, expected_arrival, expected_departure,
              host_name, host_department, requires_approval, approval_status, bypass_approval
       FROM visits
       WHERE ((visit_date <= CURDATE() AND (visit_date_to >= CURDATE() OR visit_date = CURDATE()))
              OR visit_date = CURDATE())
         AND status IN ('approved','scheduled')
         AND entry_time IS NULL
       ORDER BY expected_arrival`
    );

    // Currently inside
    const [insideList] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, purpose,
              host_name, host_department, entry_time, badge_no, expected_departure,
              exit_acknowledged_by, tentative_exit_time, entry_by
       FROM visits WHERE status = 'checked_in' ORDER BY entry_time`
    );

    res.json({
      todayExpected: todayExpected[0].count,
      currentlyInside: currentlyInside[0].count,
      pendingApprovals: pendingApprovals[0].count,
      checkedInToday: checkedInToday[0].count,
      checkedOutToday: checkedOutToday[0].count,
      noShowToday: noShowToday[0].count,
      overdue,
      pendingList,
      checkInQueue,
      insideList,
    });
  } catch (err: any) {
    console.error('Visitor stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════

router.get('/analytics', async (req: Request, res: Response) => {
  try {
    const from = (req.query.from as string) || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);

    const [dailyCounts] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(visit_date, '%Y-%m-%d') as date, COUNT(*) as count,
              COALESCE(SUM(visitor_count), 0) as headcount
       FROM visits WHERE visit_date BETWEEN ? AND ?
       GROUP BY DATE_FORMAT(visit_date, '%Y-%m-%d') ORDER BY date`, [from, to]
    );
    const [typeBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT visitor_type, COUNT(*) as count FROM visits WHERE visit_date BETWEEN ? AND ? GROUP BY visitor_type ORDER BY count DESC`, [from, to]
    );
    const [deptBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT host_department, COUNT(*) as count FROM visits WHERE visit_date BETWEEN ? AND ? GROUP BY host_department ORDER BY count DESC`, [from, to]
    );
    const [statusBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT status, COUNT(*) as count FROM visits WHERE visit_date BETWEEN ? AND ? GROUP BY status ORDER BY count DESC`, [from, to]
    );
    const [approvalStats] = await pool().execute<RowDataPacket[]>(
      `SELECT
        SUM(CASE WHEN approval_status = 'approved' AND bypass_approval = 0 THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN bypass_approval = 1 THEN 1 ELSE 0 END) as bypassed,
        SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) as pending
       FROM visits WHERE visit_date BETWEEN ? AND ?`, [from, to]
    );
    const [peakHours] = await pool().execute<RowDataPacket[]>(
      `SELECT HOUR(entry_time) as hour, COUNT(*) as count
       FROM visits WHERE entry_time IS NOT NULL AND visit_date BETWEEN ? AND ?
       GROUP BY HOUR(entry_time) ORDER BY hour`, [from, to]
    );
    const [topHosts] = await pool().execute<RowDataPacket[]>(
      `SELECT host_name, host_department, COUNT(*) as count FROM visits WHERE visit_date BETWEEN ? AND ? GROUP BY host_name, host_department ORDER BY count DESC LIMIT 10`, [from, to]
    );
    const [avgDuration] = await pool().execute<RowDataPacket[]>(
      `SELECT AVG(TIMESTAMPDIFF(MINUTE, entry_time, exit_time)) as avg_minutes FROM visits WHERE entry_time IS NOT NULL AND exit_time IS NOT NULL AND visit_date BETWEEN ? AND ?`, [from, to]
    );
    const [totals] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as visits, COALESCE(SUM(visitor_count), 0) as headcount FROM visits WHERE visit_date BETWEEN ? AND ?`, [from, to]
    );

    // Security activity log (who did check-in/check-out)
    const [securityActivity] = await pool().execute<RowDataPacket[]>(
      `SELECT performed_by, action, COUNT(*) as count
       FROM visitor_log
       WHERE action IN ('CHECKED_IN','CHECKED_OUT') AND DATE(performed_at) BETWEEN ? AND ?
       GROUP BY performed_by, action ORDER BY performed_by`, [from, to]
    );

    res.json({
      from, to, dailyCounts, typeBreakdown, deptBreakdown, statusBreakdown,
      approvalStats: approvalStats[0],
      peakHours, topHosts, securityActivity,
      avgDurationMinutes: Math.round(avgDuration[0]?.avg_minutes || 0),
      totalVisits: totals[0]?.visits || 0,
      totalHeadcount: totals[0]?.headcount || 0,
    });
  } catch (err: any) {
    console.error('Visitor analytics error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ═══════════════════════════════════════════════════════════════
// VISITS CRUD
// ═══════════════════════════════════════════════════════════════

router.get('/visits', async (req: Request, res: Response) => {
  try {
    const { status, date, from, to, department, type, search, limit: lim } = req.query;
    let sql = `SELECT id, visit_no, visitor_name, visitor_company, visitor_phone, visitor_email,
                      visitor_type, visitor_count, purpose, visit_date, visit_date_to,
                      expected_arrival, expected_departure,
                      host_name, host_department, booked_by, booked_by_role,
                      requires_approval, approval_status, bypass_approval,
                      entry_time, entry_by, exit_time, exit_by, badge_no, pass_no,
                      status, created_at
               FROM visits WHERE 1=1`;
    const params: any[] = [];

    if (status) { sql += ` AND status = ?`; params.push(status); }
    if (date) { sql += ` AND visit_date = ?`; params.push(date); }
    if (from) { sql += ` AND visit_date >= ?`; params.push(from); }
    if (to) { sql += ` AND visit_date <= ?`; params.push(to); }
    if (department) { sql += ` AND host_department = ?`; params.push(department); }
    if (type) { sql += ` AND visitor_type = ?`; params.push(type); }
    if (search) {
      sql += ` AND (visitor_name LIKE ? OR visitor_company LIKE ? OR visit_no LIKE ? OR host_name LIKE ? OR visitor_phone LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(Number(lim) || 200);

    const [rows] = await pool().execute<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err: any) {
    console.error('List visits error:', err);
    res.status(500).json({ error: 'Failed to load visits' });
  }
});

router.get('/visits/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM visits WHERE id = ?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Visit not found' });

    const [groups] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM visit_groups WHERE visit_id = ?`, [req.params.id]
    );
    const [logs] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM visitor_log WHERE visit_id = ? ORDER BY performed_at DESC`, [req.params.id]
    );

    res.json({ ...rows[0], groups, logs });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load visit' });
  }
});

// Book a visit (staff / reception / security)
router.post('/visits', async (req: Request, res: Response) => {
  try {
    const v = req.body;
    const visitNo = await generateVisitNo();
    const user = (req as any).user;
    const bookedBy = user?.username || v.booked_by || 'system';

    // Validate date range max 5 days
    if (v.visit_date_to) {
      const d1 = new Date(v.visit_date);
      const d2 = new Date(v.visit_date_to);
      const diffDays = Math.ceil((d2.getTime() - d1.getTime()) / 86400000);
      if (diffDays > 5) return res.status(400).json({ error: 'Visit date range cannot exceed 5 days' });
      if (diffDays < 0) return res.status(400).json({ error: 'End date must be after start date' });
    }

    // Determine initial status
    let status = 'scheduled';
    if (v.requires_approval) status = 'pending_approval';
    if (v.bypass_approval) status = 'approved';

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO visits (visit_no, visitor_name, visitor_company, visitor_phone, visitor_email,
        visitor_type, visitor_count, id_type, id_number, purpose, visit_date, visit_date_to,
        expected_arrival, expected_departure, meeting_room, items_carried, vehicle_no,
        host_name, host_department, host_phone, host_email,
        booked_by, booked_by_id, booked_by_role,
        requires_approval, approval_status, bypass_approval, bypass_reason,
        special_instructions, emergency_contact, nda_signed, covid_declaration, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        visitNo, v.visitor_name, v.visitor_company || null, v.visitor_phone || null, v.visitor_email || null,
        v.visitor_type || 'Visitor', v.visitor_count || 1, v.id_type || null, v.id_number || null,
        v.purpose, v.visit_date, v.visit_date_to || null,
        v.expected_arrival || null, v.expected_departure || null,
        v.meeting_room || null, v.items_carried || null, v.vehicle_no || null,
        v.host_name, v.host_department, v.host_phone || null, v.host_email || null,
        bookedBy, user?.sub || v.booked_by_id || null, v.booked_by_role || 'staff',
        v.requires_approval ? 1 : 0,
        v.bypass_approval ? 'approved' : (v.requires_approval ? 'pending' : 'approved'),
        v.bypass_approval ? 1 : 0, v.bypass_reason || null,
        v.special_instructions || null, v.emergency_contact || null,
        v.nda_signed ? 1 : 0, v.covid_declaration ? 1 : 0,
        status,
      ]
    );

    if (v.group_members?.length) {
      for (const m of v.group_members) {
        await pool().execute(
          `INSERT INTO visit_groups (visit_id, name, company, phone, id_type, id_number) VALUES (?, ?, ?, ?, ?, ?)`,
          [result.insertId, m.name, m.company || null, m.phone || null, m.id_type || null, m.id_number || null]
        );
      }
    }

    await logAction(result.insertId, v.visitor_name, 'BOOKED', `Visit ${visitNo} booked by ${bookedBy} (${v.booked_by_role || 'staff'})`, bookedBy);
    if (v.bypass_approval) {
      await logAction(result.insertId, v.visitor_name, 'BYPASS_APPROVED', v.bypass_reason || 'Approved without workflow', bookedBy);
    }

    res.status(201).json({ id: result.insertId, visit_no: visitNo, status });
  } catch (err: any) {
    console.error('Book visit error:', err);
    res.status(500).json({ error: 'Failed to book visit' });
  }
});

router.put('/visits/:id', async (req: Request, res: Response) => {
  try {
    const v = req.body;
    const [existing] = await pool().execute<RowDataPacket[]>(`SELECT status FROM visits WHERE id = ?`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Visit not found' });
    if (['checked_in', 'checked_out'].includes(existing[0].status)) {
      return res.status(400).json({ error: 'Cannot edit a visit that is checked in or completed' });
    }

    await pool().execute(
      `UPDATE visits SET visitor_name=?, visitor_company=?, visitor_phone=?, visitor_email=?,
        visitor_type=?, visitor_count=?, purpose=?, visit_date=?, visit_date_to=?,
        expected_arrival=?, expected_departure=?,
        meeting_room=?, items_carried=?, vehicle_no=?, host_name=?, host_department=?,
        host_phone=?, host_email=?, special_instructions=?, emergency_contact=?
       WHERE id = ?`,
      [
        v.visitor_name, v.visitor_company || null, v.visitor_phone || null, v.visitor_email || null,
        v.visitor_type || 'Visitor', v.visitor_count || 1, v.purpose, v.visit_date,
        v.visit_date_to || null, v.expected_arrival || null, v.expected_departure || null,
        v.meeting_room || null, v.items_carried || null, v.vehicle_no || null,
        v.host_name, v.host_department, v.host_phone || null, v.host_email || null,
        v.special_instructions || null, v.emergency_contact || null, req.params.id,
      ]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update visit' });
  }
});

// ═══════════════════════════════════════════════════════════════
// LIFECYCLE ACTIONS
// ═══════════════════════════════════════════════════════════════

router.post('/visits/:id/approve', async (req: Request, res: Response) => {
  try {
    const { action, remarks } = req.body;
    const user = (req as any).user;
    const by = user?.username || 'admin';
    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });

    if (action === 'approve') {
      await pool().execute(
        `UPDATE visits SET approval_status='approved', approved_by=?, approved_by_id=?,
         approved_at=NOW(), approval_remarks=?, status='approved' WHERE id=?`,
        [by, user?.sub || null, remarks || null, req.params.id]
      );
      await logAction(Number(req.params.id), visit[0].visitor_name, 'APPROVED', `Approved by ${by}. ${remarks || ''}`, by);
    } else {
      await pool().execute(
        `UPDATE visits SET approval_status='rejected', approved_by=?, approved_by_id=?,
         approved_at=NOW(), approval_remarks=?, status='rejected' WHERE id=?`,
        [by, user?.sub || null, remarks || null, req.params.id]
      );
      await logAction(Number(req.params.id), visit[0].visitor_name, 'REJECTED', `Rejected by ${by}. ${remarks || ''}`, by);
    }

    res.json({ success: true, status: action === 'approve' ? 'approved' : 'rejected' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to process approval' });
  }
});

router.post('/visits/:id/checkin', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    const user = (req as any).user;
    const by = user?.username || 'security';
    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });

    const v = visit[0];
    if (v.status === 'checked_in') return res.status(400).json({ error: 'Already checked in' });
    if (v.status === 'rejected') return res.status(400).json({ error: 'Visit was rejected' });
    if (v.status === 'cancelled') return res.status(400).json({ error: 'Visit was cancelled' });

    const badgeNo = b.badge_no || await generateBadgeNo();
    const passNo = await generatePassNo();

    await pool().execute(
      `UPDATE visits SET
        entry_time=NOW(), entry_by=?, entry_gate=?, badge_no=?, pass_no=?,
        photo_data=?, id_type=COALESCE(?, id_type), id_number=COALESCE(?, id_number),
        id_proof_data=?, address_proof_data=?,
        nda_signed=?, covid_declaration=?, vehicle_no=COALESCE(?, vehicle_no),
        wifi_code=?, remarks=?,
        status='checked_in',
        approval_status=CASE WHEN approval_status='pending' THEN 'approved' ELSE approval_status END,
        bypass_approval=CASE WHEN approval_status='pending' THEN 1 ELSE bypass_approval END,
        bypass_reason=CASE WHEN approval_status='pending' THEN COALESCE(?, bypass_reason) ELSE bypass_reason END
       WHERE id=?`,
      [
        by, b.entry_gate || null, badgeNo, passNo,
        b.photo_data || null, b.id_type || null, b.id_number || null,
        b.id_proof_data || null, b.address_proof_data || null,
        b.nda_signed ? 1 : 0, b.covid_declaration ? 1 : 0, b.vehicle_no || null,
        b.wifi_code || null, b.remarks || null,
        b.bypass_reason || null,
        req.params.id,
      ]
    );

    await logAction(Number(req.params.id), v.visitor_name, 'CHECKED_IN',
      `Checked in at ${b.entry_gate || 'N/A'}, Badge: ${badgeNo} — by ${by}`, by);

    res.json({ success: true, badge_no: badgeNo, pass_no: passNo });
  } catch (err: any) {
    console.error('Checkin error:', err);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

router.post('/visits/:id/acknowledge-exit', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const by = user?.username || 'staff';
    const tentativeTime = req.body.tentative_exit_time || new Date().toISOString().slice(0, 19).replace('T', ' ');

    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });

    await pool().execute(
      `UPDATE visits SET exit_acknowledged_by=?, exit_acknowledged_at=NOW(), tentative_exit_time=? WHERE id=?`,
      [by, tentativeTime, req.params.id]
    );
    await logAction(Number(req.params.id), visit[0].visitor_name, 'EXIT_ACKNOWLEDGED',
      `Exit acknowledged by ${by}, tentative: ${tentativeTime}`, by);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to acknowledge exit' });
  }
});

router.post('/visits/:id/checkout', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const by = user?.username || 'security';
    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });
    if (visit[0].status !== 'checked_in') return res.status(400).json({ error: 'Visitor is not checked in' });

    await pool().execute(
      `UPDATE visits SET exit_time=NOW(), exit_by=?, exit_gate=?, remarks=COALESCE(?, remarks), status='checked_out' WHERE id=?`,
      [by, req.body.exit_gate || null, req.body.remarks || null, req.params.id]
    );
    await logAction(Number(req.params.id), visit[0].visitor_name, 'CHECKED_OUT',
      `Checked out at ${req.body.exit_gate || 'N/A'} — by ${by}. ${req.body.remarks || ''}`, by);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to check out' });
  }
});

router.post('/visits/:id/cancel', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const by = user?.username || 'system';
    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });

    await pool().execute(`UPDATE visits SET status='cancelled', cancel_reason=? WHERE id=?`,
      [req.body.reason || null, req.params.id]);
    await logAction(Number(req.params.id), visit[0].visitor_name, 'CANCELLED', req.body.reason || 'Cancelled', by);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to cancel visit' });
  }
});

router.post('/visits/:id/no-show', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const by = user?.username || 'system';
    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });

    await pool().execute(`UPDATE visits SET status='no_show' WHERE id=?`, [req.params.id]);
    await logAction(Number(req.params.id), visit[0].visitor_name, 'NO_SHOW', 'Marked as no-show', by);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to mark no-show' });
  }
});

// Block visitor: cancel visit + add to blacklist
router.post('/visits/:id/block', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const by = user?.username || 'security';
    const { reason, severity } = req.body;
    if (!reason) return res.status(400).json({ error: 'Block reason is required' });

    const [visit] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visits WHERE id = ?`, [req.params.id]);
    if (!visit.length) return res.status(404).json({ error: 'Visit not found' });

    const v = visit[0];
    // Cancel or reject the visit
    if (['scheduled','approved','pending_approval'].includes(v.status)) {
      await pool().execute(`UPDATE visits SET status='cancelled', cancel_reason=? WHERE id=?`, [reason, req.params.id]);
    } else if (v.status === 'checked_in') {
      await pool().execute(`UPDATE visits SET exit_time=NOW(), exit_by=?, status='checked_out', remarks=? WHERE id=?`, [by, 'Blocked: ' + reason, req.params.id]);
    }

    // Add to blacklist
    await pool().execute(
      `INSERT INTO blacklist (visitor_name, company, phone, id_number, reason, severity, blacklisted_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [v.visitor_name, v.visitor_company || null, v.visitor_phone || null, v.id_number || null, reason, severity || 'high', by]
    );
    await logAction(Number(req.params.id), v.visitor_name, 'BLOCKED', `Blocked by ${by}: ${reason}`, by);

    res.json({ success: true });
  } catch (err: any) {
    console.error('Block visitor error:', err);
    res.status(500).json({ error: 'Failed to block visitor' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CONVENIENCE QUERIES
// ═══════════════════════════════════════════════════════════════

router.get('/pending-approvals', async (req: Request, res: Response) => {
  try {
    const dept = req.query.department as string;
    let sql = `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, visitor_count,
                      purpose, visit_date, visit_date_to, expected_arrival, expected_departure,
                      host_name, host_department, booked_by, booked_by_role, created_at
               FROM visits WHERE status = 'pending_approval'`;
    const params: any[] = [];
    if (dept) { sql += ` AND host_department = ?`; params.push(dept); }
    sql += ` ORDER BY visit_date, expected_arrival`;
    const [rows] = await pool().execute<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load pending approvals' });
  }
});

router.get('/check-in-queue', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, visitor_count,
              visitor_phone, purpose, visit_date, visit_date_to,
              expected_arrival, expected_departure,
              host_name, host_department, requires_approval, approval_status, bypass_approval
       FROM visits
       WHERE ((visit_date <= CURDATE() AND visit_date_to >= CURDATE()) OR visit_date = CURDATE())
         AND status IN ('approved','scheduled','pending_approval')
         AND entry_time IS NULL
       ORDER BY expected_arrival`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load check-in queue' });
  }
});

router.get('/currently-inside', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, visitor_phone, purpose,
              host_name, host_department, entry_time, badge_no, pass_no,
              expected_departure, exit_acknowledged_by, tentative_exit_time, entry_gate, entry_by
       FROM visits WHERE status = 'checked_in' ORDER BY entry_time`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load current visitors' });
  }
});

// Upcoming visitors (future dates)
router.get('/upcoming-visitors', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, visitor_phone,
              purpose, visit_date, visit_date_to, expected_arrival, expected_departure,
              host_name, host_department, requires_approval, approval_status, bypass_approval, status
       FROM visits
       WHERE visit_date > CURDATE()
         AND status IN ('approved','scheduled','pending_approval')
       ORDER BY visit_date, expected_arrival
       LIMIT 100`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load upcoming visitors' });
  }
});

// Staff: my department's visitors
router.get('/my-visitors', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const profile = user?.sub ? await getUserProfile(user.sub) : null;
    const dept = (req.query.department as string) || profile?.department || '';

    if (!dept) return res.json([]);

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT id, visit_no, visitor_name, visitor_company, visitor_type, purpose,
              visit_date, expected_arrival, expected_departure,
              host_name, host_department, entry_time, exit_time, badge_no,
              status, exit_acknowledged_by, tentative_exit_time
       FROM visits
       WHERE host_department = ? AND visit_date >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)
       ORDER BY FIELD(status, 'checked_in','approved','pending_approval','scheduled','checked_out','cancelled','rejected','no_show'), visit_date DESC`,
      [dept]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load visitors' });
  }
});

// ═══════════════════════════════════════════════════════════════
// WATCHLIST & BLACKLIST
// ═══════════════════════════════════════════════════════════════

router.get('/watchlist', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM watchlist ORDER BY added_at DESC`);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load watchlist' }); }
});
router.post('/watchlist', async (req: Request, res: Response) => {
  try {
    const w = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO watchlist (visitor_name, company, phone, reason, priority, added_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [w.visitor_name, w.company || null, w.phone || null, w.reason, w.priority || 'medium', w.added_by || 'admin']
    );
    res.status(201).json({ id: result.insertId });
  } catch (err: any) { res.status(500).json({ error: 'Failed to add to watchlist' }); }
});
router.delete('/watchlist/:id', async (req: Request, res: Response) => {
  try {
    await pool().execute(`DELETE FROM watchlist WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: 'Failed to remove from watchlist' }); }
});

router.get('/blacklist', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM blacklist ORDER BY blacklisted_at DESC`);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load blacklist' }); }
});
router.post('/blacklist', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO blacklist (visitor_name, company, phone, id_number, reason, severity, blacklisted_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [b.visitor_name, b.company || null, b.phone || null, b.id_number || null, b.reason, b.severity || 'high', b.blacklisted_by || 'admin']
    );
    res.status(201).json({ id: result.insertId });
  } catch (err: any) { res.status(500).json({ error: 'Failed to add to blacklist' }); }
});
router.delete('/blacklist/:id', async (req: Request, res: Response) => {
  try {
    await pool().execute(`DELETE FROM blacklist WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: 'Failed to remove from blacklist' }); }
});

// ═══════════════════════════════════════════════════════════════
// GATES & SETTINGS & LOG
// ═══════════════════════════════════════════════════════════════

router.get('/gates', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM gates WHERE is_active = 1 ORDER BY name`);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load gates' }); }
});

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visitor_settings ORDER BY setting_key`);
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.setting_key] = r.setting_value;
    res.json(settings);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load settings' }); }
});

router.put('/settings', async (req: Request, res: Response) => {
  try {
    const settings = req.body as Record<string, string>;
    for (const [key, value] of Object.entries(settings)) {
      await pool().execute(
        `INSERT INTO visitor_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?`,
        [key, value, value]
      );
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: 'Failed to save settings' }); }
});

router.get('/log', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const from = req.query.from as string;
    const to = req.query.to as string;
    let sql = `SELECT * FROM visitor_log WHERE 1=1`;
    const params: any[] = [];
    if (from) { sql += ` AND DATE(performed_at) >= ?`; params.push(from); }
    if (to) { sql += ` AND DATE(performed_at) <= ?`; params.push(to); }
    sql += ` ORDER BY performed_at DESC LIMIT ?`;
    params.push(limit);

    const [rows] = await pool().execute<RowDataPacket[]>(sql, params);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load log' }); }
});

export default router;
