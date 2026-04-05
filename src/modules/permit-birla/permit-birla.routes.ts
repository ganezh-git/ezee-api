import { Router, Request, Response } from 'express';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
const pool = () => db.permitBirla();

// ─── Helper: Generate Permit Number ────────────────────────────
async function generatePermitNo(typeCode: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix: Record<string, string> = {
    HEIGHT: 'HWP', CONFINED: 'CSP', ELECTRICAL: 'EWP', EXCAVATION: 'EXP',
    GENERAL: 'GWP', LOTOTO: 'LTP', LIFTING: 'MLP',
    MONOMER_BARREL: 'MBP', MONOMER_TANKER: 'MTP', HOT_WORK: 'HTP',
  };
  const pfx = prefix[typeCode] || 'PTW';

  // Upsert then read in two separate queries
  await pool().execute(
    `INSERT INTO permit_sequence (permit_type_code, year, last_number) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
    [typeCode, year]
  );
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT last_number FROM permit_sequence WHERE permit_type_code = ? AND year = ?`,
    [typeCode, year]
  );
  const num = rows.length > 0 ? rows[0].last_number : 1;
  return `${pfx}-${year}-${String(num).padStart(4, '0')}`;
}

// ─── GET /my-role ──────────────────────────────────────────────
router.get('/my-role', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) { res.json({ roles: [] }); return; }

    // Look up the portal user's username, then find matching personnel
    const [users] = await pool().execute<RowDataPacket[]>(
      `SELECT p.* FROM personnel p WHERE p.portal_user_id = ? AND p.active = 1`,
      [userId]
    );

    if (!users.length) {
      // Fallback: match by username via a loose mapping
      res.json({ roles: [], personnel: null });
      return;
    }

    const person = users[0];
    const roles: string[] = [];
    if (person.is_initiator) roles.push('initiator');
    if (person.is_issuer) roles.push('issuer');
    if (person.is_custodian) roles.push('custodian');
    if (person.is_isolator) roles.push('isolator');
    if (person.is_fire_watcher) roles.push('fire_watcher');
    if (person.is_co_permittee) roles.push('co_permittee');

    // Super_admin and admin get all roles
    if (req.user?.role === 'super_admin' || req.user?.role === 'admin') {
      res.json({ roles: ['initiator', 'issuer', 'custodian', 'isolator', 'fire_watcher', 'co_permittee', 'admin'], personnel: person });
      return;
    }

    res.json({ roles, personnel: person });
  } catch (err: any) {
    console.error('My role error:', err);
    res.json({ roles: [], personnel: null });
  }
});

// ─── GET /stats ────────────────────────────────────────────────
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    // Status counts
    const [statusRows] = await pool().execute<RowDataPacket[]>(
      `SELECT status, COUNT(*) as count FROM permits GROUP BY status`
    );

    // Type counts  
    const [typeRows] = await pool().execute<RowDataPacket[]>(
      `SELECT pt.code, pt.short_label, COUNT(p.id) as count 
       FROM permit_types pt LEFT JOIN permits p ON p.permit_type_id = pt.id 
       GROUP BY pt.id, pt.code, pt.short_label ORDER BY pt.id`
    );

    // Daily counts (last 15 days)
    const [dailyRows] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as date, COUNT(*) as count 
       FROM permits WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 15 DAY) 
       GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d') ORDER BY date`
    );

    // Expiring soon (within 24 hours)
    const [expiringRows] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.valid_until_date, p.valid_until_time, p.status
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status IN ('Active', 'Extended') 
       AND CONCAT(p.valid_until_date, ' ', p.valid_until_time) <= DATE_ADD(NOW(), INTERVAL 24 HOUR)
       AND CONCAT(p.valid_until_date, ' ', p.valid_until_time) >= NOW()
       ORDER BY p.valid_until_date, p.valid_until_time`
    );

    // Overdue (expired but not closed)
    const [overdueRows] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.valid_until_date, p.valid_until_time, p.status
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status IN ('Active', 'Extended')
       AND CONCAT(p.valid_until_date, ' ', p.valid_until_time) < NOW()
       ORDER BY p.valid_until_date`
    );

    // Pending actions
    const [pendingRows] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.status, p.created_at
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status IN ('Initiated', 'Issued', 'Custodian_Approved')
       ORDER BY p.created_at DESC LIMIT 20`
    );

    // Department breakdown
    const [deptRows] = await pool().execute<RowDataPacket[]>(
      `SELECT d.name, d.code, COUNT(p.id) as count 
       FROM departments d LEFT JOIN permits p ON p.department_id = d.id 
       WHERE d.active = 1 GROUP BY d.id, d.name, d.code ORDER BY count DESC`
    );

    // Monthly trend (last 6 months)
    const [monthlyRows] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, 
              DATE_FORMAT(created_at, '%b %Y') as label,
              COUNT(*) as count,
              SUM(status = 'Closed') as closed,
              SUM(status IN ('Active', 'Extended')) as active
       FROM permits WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b %Y') ORDER BY month`
    );

    res.json({
      statusCounts: statusRows,
      typeCounts: typeRows,
      dailyCounts: dailyRows,
      expiringSoon: expiringRows,
      overdue: overdueRows,
      pendingActions: pendingRows,
      departmentBreakdown: deptRows,
      monthlyTrend: monthlyRows,
    });
  } catch (err: any) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── GET /notifications ────────────────────────────────────────
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const notifications: any[] = [];

    // Overdue permits
    const [overdue] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.valid_until_date, p.status
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status IN ('Active', 'Extended')
       AND CONCAT(p.valid_until_date, ' ', COALESCE(p.valid_until_time, '23:59')) < NOW()`
    );
    for (const o of overdue) {
      notifications.push({ type: 'danger', icon: 'warning', title: 'Overdue Permit', 
        message: `${o.permit_no} (${o.short_label}) expired on ${o.valid_until_date}`, permitId: o.id });
    }

    // Expiring within 24h
    const [expiring] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.valid_until_date, p.valid_until_time
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status IN ('Active', 'Extended')
       AND CONCAT(p.valid_until_date, ' ', COALESCE(p.valid_until_time, '23:59')) BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 24 HOUR)`
    );
    for (const e of expiring) {
      notifications.push({ type: 'warning', icon: 'schedule', title: 'Expiring Soon', 
        message: `${e.permit_no} (${e.short_label}) expires ${e.valid_until_date} ${e.valid_until_time}`, permitId: e.id });
    }

    // Pending approvals
    const [pending] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.status, 
              TIMESTAMPDIFF(HOUR, p.created_at, NOW()) as hours_pending
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status IN ('Initiated', 'Issued', 'Custodian_Approved')
       AND p.created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
    );
    for (const pa of pending) {
      const action = pa.status === 'Initiated' ? 'Issuer approval' : pa.status === 'Issued' ? 'Custodian approval' : 'Co-permittee activation';
      notifications.push({ type: 'info', icon: 'pending_actions', title: 'Pending Action',
        message: `${pa.permit_no} awaiting ${action} (${pa.hours_pending}h)`, permitId: pa.id });
    }

    // Suspended permits
    const [suspended] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label, p.suspension_reason
       FROM permits p JOIN permit_types pt ON p.permit_type_id = pt.id
       WHERE p.status = 'Suspended'`
    );
    for (const s of suspended) {
      notifications.push({ type: 'danger', icon: 'pause_circle', title: 'Suspended',
        message: `${s.permit_no} (${s.short_label}) — ${s.suspension_reason || 'No reason'}`, permitId: s.id });
    }

    res.json(notifications);
  } catch (err: any) {
    console.error('Notifications error:', err);
    res.json([]);
  }
});

// ─── GET /reports/export ───────────────────────────────────────
router.get('/reports/export', async (req: Request, res: Response) => {
  try {
    const { from, to, status, type, department, format } = req.query;
    let where = '1=1';
    const params: any[] = [];

    if (from) { where += ' AND p.issued_date >= ?'; params.push(from); }
    if (to) { where += ' AND p.issued_date <= ?'; params.push(to); }
    if (status) { where += ' AND p.status = ?'; params.push(status); }
    if (type) { where += ' AND pt.code = ?'; params.push(type); }
    if (department) { where += ' AND d.code = ?'; params.push(department); }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT p.id, p.permit_no, pt.short_label as type_label, pt.code as permit_type_code, d.name as department_name,
              wl.name as location_name, p.location_text, p.work_description, p.status,
              p.issued_date, p.issued_time, p.valid_until_date, p.valid_until_time,
              ini.name as initiator, iss.name as issuer, cust.name as custodian,
              p.co_permittee_name, p.isolation_electrical, p.isolation_services, p.isolation_process,
              p.suspension_reason, p.closed_at, p.created_at
       FROM permits p
       JOIN permit_types pt ON p.permit_type_id = pt.id
       LEFT JOIN departments d ON p.department_id = d.id
       LEFT JOIN work_locations wl ON p.location_id = wl.id
       LEFT JOIN personnel ini ON p.initiator_id = ini.id
       LEFT JOIN personnel iss ON p.issuer_id = iss.id
       LEFT JOIN personnel cust ON p.custodian_id = cust.id
       WHERE ${where}
       ORDER BY p.created_at DESC`, params
    );

    if (format === 'csv') {
      const headers = ['Permit No','Type','Department','Location','Work Description','Status',
        'Issued Date','Issued Time','Valid Until','Initiator','Issuer','Custodian',
        'Co-Permittee','Elec Isolation','Svc Isolation','Process Isolation','Created'];
      const csvRows = [headers.join(',')];
      for (const r of rows) {
        csvRows.push([
          `"${r.permit_no}"`,`"${r.type}"`,`"${r.department || ''}"`,`"${r.location || ''}"`,
          `"${(r.work_description || '').replace(/"/g, '""')}"`,`"${r.status}"`,
          `"${r.issued_date}"`,`"${r.issued_time}"`,`"${r.valid_until_date} ${r.valid_until_time}"`,
          `"${r.initiator || ''}"`,`"${r.issuer || ''}"`,`"${r.custodian || ''}"`,
          `"${r.co_permittee_name || ''}"`,`"${r.isolation_electrical}"`,
          `"${r.isolation_services}"`,`"${r.isolation_process}"`,`"${r.created_at}"`
        ].join(','));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=permits_report.csv');
      res.send(csvRows.join('\n'));
    } else {
      res.json({ rows, total: rows.length });
    }
  } catch (err: any) {
    console.error('Report export error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ─── POST /permits/:id/safety-hold ────────────────────────────
router.post('/permits/:id/safety-hold', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, hold_by } = req.body;
    await pool().execute(
      `UPDATE permits SET status = 'Suspended', suspension_reason = ?, suspended_by = ?, suspended_at = NOW() WHERE id = ? AND status IN ('Active', 'Extended')`,
      [`SAFETY HOLD: ${reason}`, hold_by || 'Safety Officer', id]
    );
    await pool().execute(
      'INSERT INTO permit_audit_log (permit_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
      [id, 'SAFETY_HOLD', `Safety hold: ${reason}`, hold_by || 'Safety Officer']
    );
    res.json({ message: 'Safety hold applied' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to apply safety hold' });
  }
});

// ─── POST /permits/:id/resume ──────────────────────────────────
router.post('/permits/:id/resume', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { resumed_by } = req.body;
    await pool().execute(
      `UPDATE permits SET status = 'Active', suspension_reason = NULL, suspended_by = NULL, suspended_at = NULL WHERE id = ? AND status = 'Suspended'`,
      [id]
    );
    await pool().execute(
      'INSERT INTO permit_audit_log (permit_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
      [id, 'RESUMED', 'Permit resumed from suspension', resumed_by || 'Safety Officer']
    );
    res.json({ message: 'Permit resumed' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to resume permit' });
  }
});

// ─── GET /types ────────────────────────────────────────────────
router.get('/types', async (_req: Request, res: Response) => {
  const [rows] = await pool().execute<RowDataPacket[]>(
    'SELECT * FROM permit_types WHERE active = 1 ORDER BY id'
  );
  res.json(rows);
});

// ─── GET /departments ──────────────────────────────────────────
router.get('/departments', async (_req: Request, res: Response) => {
  const [rows] = await pool().execute<RowDataPacket[]>(
    'SELECT * FROM departments WHERE active = 1 ORDER BY name'
  );
  res.json(rows);
});

// ─── GET /locations ────────────────────────────────────────────
router.get('/locations', async (_req: Request, res: Response) => {
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT l.*, d.name as department_name FROM work_locations l
     LEFT JOIN departments d ON l.department_id = d.id WHERE l.active = 1 ORDER BY l.name`
  );
  res.json(rows);
});

// ─── GET /personnel ────────────────────────────────────────────
router.get('/personnel', async (req: Request, res: Response) => {
  const { role } = req.query;
  let where = 'WHERE p.active = 1';
  if (role === 'initiator') where += ' AND p.is_initiator = 1';
  if (role === 'issuer') where += ' AND p.is_issuer = 1';
  if (role === 'custodian') where += ' AND p.is_custodian = 1';
  if (role === 'isolator') where += ' AND p.is_isolator = 1';
  if (role === 'fire_watcher') where += ' AND p.is_fire_watcher = 1';
  if (role === 'co_permittee') where += ' AND p.is_co_permittee = 1';

  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT p.*, d.name as department_name FROM personnel p
     LEFT JOIN departments d ON p.department_id = d.id ${where} ORDER BY p.name`
  );
  res.json(rows);
});

// ─── GET /hazard-types ─────────────────────────────────────────
router.get('/hazard-types', async (_req: Request, res: Response) => {
  const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM hazard_types ORDER BY id');
  res.json(rows);
});

// ─── GET /ppe-types ────────────────────────────────────────────
router.get('/ppe-types', async (_req: Request, res: Response) => {
  const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM ppe_types ORDER BY id');
  res.json(rows);
});

// ─── GET /permits (list) ───────────────────────────────────────
router.get('/permits', async (req: Request, res: Response) => {
  try {
    const { status, type, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];

    if (status) { where += ' AND p.status = ?'; params.push(status); }
    if (type) { where += ' AND pt.code = ?'; params.push(type); }
    if (department) { where += ' AND p.department_id = ?'; params.push(department); }

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM permits p
       JOIN permit_types pt ON p.permit_type_id = pt.id WHERE ${where}`, params
    );
    const total = countRows[0].total;

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT p.*, pt.code as type_code, pt.label as type_label, pt.short_label,
              d.name as department_name, wl.name as location_name,
              ini.name as initiator_name, iss.name as issuer_name, cust.name as custodian_name
       FROM permits p
       JOIN permit_types pt ON p.permit_type_id = pt.id
       LEFT JOIN departments d ON p.department_id = d.id
       LEFT JOIN work_locations wl ON p.location_id = wl.id
       LEFT JOIN personnel ini ON p.initiator_id = ini.id
       LEFT JOIN personnel iss ON p.issuer_id = iss.id
       LEFT JOIN personnel cust ON p.custodian_id = cust.id
       WHERE ${where}
       ORDER BY p.created_at DESC LIMIT ${Number(limitNum)} OFFSET ${Number(offset)}`,
      params
    );
    res.json({ permits: rows, total, page: pageNum, limit: limitNum });
  } catch (err: any) {
    console.error('List permits error:', err);
    res.status(500).json({ error: 'Failed to load permits' });
  }
});

// ─── GET /permits/:id ──────────────────────────────────────────
router.get('/permits/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT p.*, pt.code as type_code, pt.label as type_label, pt.doc_id, pt.short_label,
              pt.requires_fire_watcher, pt.requires_gas_test,
              d.name as department_name, wl.name as location_name,
              ini.name as initiator_name, ini.designation as initiator_designation, ini.emp_code as initiator_emp,
              iss.name as issuer_name, iss.designation as issuer_designation, iss.emp_code as issuer_emp,
              cust.name as custodian_name, cust.designation as custodian_designation, cust.emp_code as custodian_emp,
              iso.name as isolator_name, iso.designation as isolator_designation
       FROM permits p
       JOIN permit_types pt ON p.permit_type_id = pt.id
       LEFT JOIN departments d ON p.department_id = d.id
       LEFT JOIN work_locations wl ON p.location_id = wl.id
       LEFT JOIN personnel ini ON p.initiator_id = ini.id
       LEFT JOIN personnel iss ON p.issuer_id = iss.id
       LEFT JOIN personnel cust ON p.custodian_id = cust.id
       LEFT JOIN personnel iso ON p.isolator_id = iso.id
       WHERE p.id = ?`, [id]
    );
    if (!rows.length) { res.status(404).json({ error: 'Permit not found' }); return; }

    const permit = rows[0];

    // Get hazards
    const [hazards] = await pool().execute<RowDataPacket[]>(
      `SELECT ph.*, ht.code, ht.label FROM permit_hazards ph
       JOIN hazard_types ht ON ph.hazard_type_id = ht.id WHERE ph.permit_id = ?`, [id]
    );

    // Get PPE
    const [ppe] = await pool().execute<RowDataPacket[]>(
      `SELECT pp.*, pt.code, pt.label FROM permit_ppe pp
       JOIN ppe_types pt ON pp.ppe_type_id = pt.id WHERE pp.permit_id = ?`, [id]
    );

    // Get checklist items
    const [checklist] = await pool().execute<RowDataPacket[]>(
      'SELECT * FROM permit_checklist_items WHERE permit_id = ? ORDER BY item_no', [id]
    );

    // Get audit log
    const [auditLog] = await pool().execute<RowDataPacket[]>(
      'SELECT * FROM permit_audit_log WHERE permit_id = ? ORDER BY performed_at DESC', [id]
    );

    res.json({ ...permit, hazards, ppe, checklist, auditLog });
  } catch (err: any) {
    console.error('Get permit error:', err);
    res.status(500).json({ error: 'Failed to load permit' });
  }
});

// ─── POST /permits (create) ────────────────────────────────────
router.post('/permits', async (req: Request, res: Response) => {
  try {
    const {
      permit_type_code, department_id, location_id, location_text,
      is_project, cross_ref, issued_date, issued_time, valid_until_date, valid_until_time,
      work_description, has_additional_permit, additional_permit_details,
      specific_hazards, hazards, ppe, initiator_id,
      isolation_electrical, isolation_electrical_drive, isolation_electrical_how,
      isolation_services, isolation_services_type, isolation_services_how,
      isolation_process, isolation_process_equip, isolation_process_how,
      isolation_requested_by, lototo_owner_name,
      precautions, additional_precautions,
      fire_watcher_name, fire_watcher_mobile,
      working_group_members, initiator_signature,
    } = req.body;

    // Resolve permit type
    const [types] = await pool().execute<RowDataPacket[]>(
      'SELECT id FROM permit_types WHERE code = ?', [permit_type_code]
    );
    if (!types.length) { res.status(400).json({ error: 'Invalid permit type' }); return; }

    const permitNo = await generatePermitNo(permit_type_code);

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO permits (
        permit_no, permit_type_id, department_id, location_id, location_text,
        is_project, cross_ref, issued_date, issued_time, valid_until_date, valid_until_time,
        work_description, has_additional_permit, additional_permit_details,
        specific_hazards,
        isolation_electrical, isolation_electrical_drive, isolation_electrical_how,
        isolation_services, isolation_services_type, isolation_services_how,
        isolation_process, isolation_process_equip, isolation_process_how,
        isolation_requested_by, lototo_owner_name,
        additional_precautions, fire_watcher_name, fire_watcher_mobile,
        working_group_members, initiator_id, initiator_signed_at, initiator_signature, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 'Initiated')`,
      [
        permitNo, types[0].id, department_id || null, location_id || null, location_text || null,
        is_project ? 1 : 0, cross_ref || null,
        issued_date, issued_time, valid_until_date, valid_until_time,
        work_description, has_additional_permit ? 1 : 0, additional_permit_details || null,
        specific_hazards || null,
        isolation_electrical || 'NA', isolation_electrical_drive || null, isolation_electrical_how || null,
        isolation_services || 'NA', isolation_services_type || null, isolation_services_how || null,
        isolation_process || 'NA', isolation_process_equip || null, isolation_process_how || null,
        isolation_requested_by || null, lototo_owner_name || null,
        additional_precautions || null, fire_watcher_name || null, fire_watcher_mobile || null,
        working_group_members ? JSON.stringify(working_group_members) : null,
        initiator_id || null,
        initiator_signature || null,
      ]
    );

    const permitId = result.insertId;

    // Insert hazards
    if (hazards?.length) {
      for (const h of hazards) {
        await pool().execute(
          'INSERT INTO permit_hazards (permit_id, hazard_type_id, other_specify) VALUES (?, ?, ?)',
          [permitId, h.id, h.other_specify || null]
        );
      }
    }

    // Insert PPE
    if (ppe?.length) {
      for (const p of ppe) {
        await pool().execute(
          'INSERT INTO permit_ppe (permit_id, ppe_type_id, harness_id_number, other_specify) VALUES (?, ?, ?, ?)',
          [permitId, p.id, p.harness_id_number || null, p.other_specify || null]
        );
      }
    }

    // Insert precaution checkboxes
    if (precautions) {
      const precFields = Object.entries(precautions);
      if (precFields.length) {
        const setClauses = precFields.map(([k]) => `${k} = ?`).join(', ');
        const vals = precFields.map(([, v]) => v ? 1 : 0);
        await pool().execute(`UPDATE permits SET ${setClauses} WHERE id = ?`, [...vals, permitId]);
      }
    }

    // Audit log
    await pool().execute(
      'INSERT INTO permit_audit_log (permit_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
      [permitId, 'CREATED', `Permit ${permitNo} created`, 'system']
    );

    res.json({ id: permitId, permit_no: permitNo, status: 'Initiated', message: 'Permit created successfully' });
  } catch (err: any) {
    console.error('Create permit error:', err);
    res.status(500).json({ error: 'Failed to create permit' });
  }
});

// ─── POST /permits/:id/approve (Issuer or Custodian) ───────────
router.post('/permits/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, person_id, signature } = req.body; // role: 'issuer' | 'custodian'

    // Validate the logged-in user has the required role
    const userId = req.user?.sub;
    if (userId && req.user?.role !== 'super_admin' && req.user?.role !== 'admin') {
      const [personnel] = await pool().execute<RowDataPacket[]>(
        'SELECT * FROM personnel WHERE portal_user_id = ? AND active = 1', [userId]
      );
      if (personnel.length) {
        const p = personnel[0];
        if (role === 'issuer' && !p.is_issuer) {
          res.status(403).json({ error: 'You do not have Issuer privileges' }); return;
        }
        if (role === 'custodian' && !p.is_custodian) {
          res.status(403).json({ error: 'You do not have Custodian privileges' }); return;
        }
      }
    }

    if (role === 'issuer') {
      await pool().execute(
        'UPDATE permits SET issuer_id = ?, issuer_signed_at = NOW(), issuer_signature = ?, status = "Issued" WHERE id = ?',
        [person_id, signature || null, id]
      );
    } else if (role === 'custodian') {
      await pool().execute(
        'UPDATE permits SET custodian_id = ?, custodian_signed_at = NOW(), custodian_signature = ?, status = "Custodian_Approved" WHERE id = ?',
        [person_id, signature || null, id]
      );
    }

    await pool().execute(
      'INSERT INTO permit_audit_log (permit_id, action, details, performed_by) VALUES (?, ?, ?, ?)',
      [id, `APPROVED_${role?.toUpperCase()}`, `Approved by ${role}`, String(person_id)]
    );

    res.json({ message: `Permit approved by ${role}` });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// ─── POST /permits/:id/activate ────────────────────────────────
router.post('/permits/:id/activate', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { co_permittee_name, signature } = req.body;
    await pool().execute(
      `UPDATE permits SET co_permittee_name = ?, co_permittee_signed_at = NOW(), co_permittee_signature = ?, status = 'Active' WHERE id = ?`,
      [co_permittee_name, signature || null, id]
    );
    res.json({ message: 'Permit is now active' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to activate' });
  }
});

// ─── POST /permits/:id/close ───────────────────────────────────
router.post('/permits/:id/close', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { closure_debris_removed, closure_tools_removed, closure_solvent_jumpers,
            closure_lototo_removed, closure_equipment_ready, closure_area_cordoned,
            closure_comments } = req.body;
    await pool().execute(
      `UPDATE permits SET
        closure_debris_removed = ?, closure_tools_removed = ?, closure_solvent_jumpers = ?,
        closure_lototo_removed = ?, closure_equipment_ready = ?, closure_area_cordoned = ?,
        closure_comments = ?, closure_initiator_signature = ?, closure_initiator_signed_at = NOW(), closed_at = NOW(), status = 'Closed'
       WHERE id = ?`,
      [closure_debris_removed ? 1 : 0, closure_tools_removed ? 1 : 0, closure_solvent_jumpers ? 1 : 0,
       closure_lototo_removed ? 1 : 0, closure_equipment_ready ? 1 : 0, closure_area_cordoned ? 1 : 0,
       closure_comments || null, req.body.signature || null, id]
    );
    res.json({ message: 'Permit closed' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to close' });
  }
});

// ─── POST /permits/:id/suspend ─────────────────────────────────
router.post('/permits/:id/suspend', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, suspended_by } = req.body;
    await pool().execute(
      `UPDATE permits SET status = 'Suspended', suspension_reason = ?, suspended_by = ?, suspended_at = NOW() WHERE id = ?`,
      [reason, suspended_by, id]
    );
    res.json({ message: 'Permit suspended' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to suspend' });
  }
});

// ─── POST /permits/:id/extend ──────────────────────────────────
router.post('/permits/:id/extend', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { extended_until_date, extended_until_time, custodian_name } = req.body;
    await pool().execute(
      `UPDATE permits SET status = 'Extended', extended_until_date = ?, extended_until_time = ?,
       extended_by_custodian = ? WHERE id = ?`,
      [extended_until_date, extended_until_time, custodian_name, id]
    );
    res.json({ message: 'Permit extended' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to extend' });
  }
});

export default router;
