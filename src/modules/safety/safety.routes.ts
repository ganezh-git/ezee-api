import { Router, Request, Response } from 'express';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
const pool = () => db.safety();

// ─── Helpers ────────────────────────────────────────────────
async function generateNo(prefix: string, table: string, col: string): Promise<string> {
  const year = new Date().getFullYear();
  const pat = `${prefix}${year}-%`;
  const [rows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} LIKE ?`, [pat]);
  return `${prefix}${year}-${String((rows[0]?.cnt || 0) + 1).padStart(4, '0')}`;
}

async function getSetting(key: string, fallback: string = ''): Promise<string> {
  const [rows] = await pool().execute<RowDataPacket[]>('SELECT setting_value FROM safety_settings WHERE setting_key = ?', [key]);
  return rows[0]?.setting_value ?? fallback;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [incidents] = await pool().execute<RowDataPacket[]>('SELECT COUNT(*) as c FROM incidents');
    const [openIncidents] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM incidents WHERE status NOT IN ('closed')`);
    const [criticalIncidents] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM incidents WHERE severity = 'critical' AND status != 'closed'`);

    // Days since last incident (LTI)
    const [lastLti] = await pool().execute<RowDataPacket[]>(
      `SELECT DATEDIFF(CURDATE(), MAX(incident_date)) as days FROM incidents WHERE incident_type IN ('lost_time','lti','fatality')`
    );
    const daysSinceLastLTI = lastLti[0]?.days ?? 999;

    const [activePermits] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM work_permits WHERE status IN ('approved','active')`);
    const [pendingPermits] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM work_permits WHERE status = 'pending'`);
    const [completedAudits] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM safety_audits WHERE status = 'completed'`);
    const [scheduledAudits] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM safety_audits WHERE status = 'scheduled'`);
    const [avgAuditScore] = await pool().execute<RowDataPacket[]>(`SELECT COALESCE(AVG(score), 0) as avg FROM safety_audits WHERE status = 'completed' AND score IS NOT NULL`);
    const [upcomingTrainings] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM training_records WHERE status IN ('planned','scheduled') AND training_date >= CURDATE()`);
    const [completedTrainings] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM training_records WHERE status = 'completed'`);
    const [totalObservations] = await pool().execute<RowDataPacket[]>('SELECT COUNT(*) as c FROM safety_observations');
    const [unsafeObservations] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM safety_observations WHERE observation_type IN ('unsafe_act','unsafe_condition') AND status = 'open'`);
    const [ppeIssued] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM ppe_issuance WHERE MONTH(issue_date) = MONTH(CURDATE()) AND YEAR(issue_date) = YEAR(CURDATE())`);
    const [inspections] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM inspections WHERE status = 'completed' AND MONTH(inspection_date) = MONTH(CURDATE())`);

    // Incident trend (last 6 months)
    const [incidentTrend] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(incident_date, '%Y-%m') as month, COUNT(*) as count, incident_type
       FROM incidents WHERE incident_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY month, incident_type ORDER BY month`
    );

    // Incident by type
    const [incidentByType] = await pool().execute<RowDataPacket[]>(
      `SELECT incident_type, COUNT(*) as count FROM incidents GROUP BY incident_type ORDER BY count DESC`
    );

    // Incident by department
    const [incidentByDept] = await pool().execute<RowDataPacket[]>(
      `SELECT department, COUNT(*) as count FROM incidents GROUP BY department ORDER BY count DESC LIMIT 10`
    );

    // Severity breakdown
    const [severityBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT severity, COUNT(*) as count FROM incidents GROUP BY severity`
    );

    // Recent incidents
    const [recentIncidents] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM incidents ORDER BY created_at DESC LIMIT 10`
    );

    // Upcoming audits & trainings
    const [upcomingAuditsList] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM safety_audits WHERE audit_date >= CURDATE() ORDER BY audit_date LIMIT 5`
    );
    const [upcomingTrainingsList] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM training_records WHERE training_date >= CURDATE() ORDER BY training_date LIMIT 5`
    );

    // Observation trend
    const [observationTrend] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, observation_type, COUNT(*) as count
       FROM safety_observations WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY month, observation_type ORDER BY month`
    );

    res.json({
      totalIncidents: incidents[0].c,
      openIncidents: openIncidents[0].c,
      criticalIncidents: criticalIncidents[0].c,
      daysSinceLastLTI,
      activePermits: activePermits[0].c,
      pendingPermits: pendingPermits[0].c,
      completedAudits: completedAudits[0].c,
      scheduledAudits: scheduledAudits[0].c,
      avgAuditScore: parseFloat(avgAuditScore[0].avg).toFixed(1),
      upcomingTrainings: upcomingTrainings[0].c,
      completedTrainings: completedTrainings[0].c,
      totalObservations: totalObservations[0].c,
      unsafeObservations: unsafeObservations[0].c,
      ppeIssuedThisMonth: ppeIssued[0].c,
      inspectionsThisMonth: inspections[0].c,
      incidentTrend,
      incidentByType,
      incidentByDept,
      severityBreakdown,
      recentIncidents,
      upcomingAudits: upcomingAuditsList,
      upcomingTrainingsList,
      observationTrend,
    });
  } catch (err: any) {
    console.error('Safety stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// INCIDENTS
// ═══════════════════════════════════════════════════════════════
router.get('/incidents', async (req: Request, res: Response) => {
  try {
    const { search, type, severity, status, department, from, to, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (title LIKE ? OR description LIKE ? OR incident_no LIKE ? OR location LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (type) { where += ' AND incident_type = ?'; params.push(type); }
    if (severity) { where += ' AND severity = ?'; params.push(severity); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    if (from) { where += ' AND incident_date >= ?'; params.push(from); }
    if (to) { where += ' AND incident_date <= ?'; params.push(to); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM incidents WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM incidents WHERE ${where} ORDER BY incident_date DESC, created_at DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ incidents: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load incidents' });
  }
});

router.get('/incidents/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM incidents WHERE id = ?', [req.params.id]);
    if (!rows.length) { res.status(404).json({ error: 'Incident not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load incident' });
  }
});

router.post('/incidents', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const incNo = await generateNo('INC-', 'incidents', 'incident_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO incidents (incident_no, title, incident_type, severity, incident_date, incident_time, date_occurred,
        location, department, injured_person, injury_type, description, immediate_action, root_cause, corrective_action,
        preventive_action, witness_names, investigation_by, investigation_date, reported_by, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [incNo, d.title, d.incident_type, d.severity || 'low', d.incident_date, d.incident_time || null,
        d.date_occurred || d.incident_date, d.location, d.department, d.injured_person || null,
        d.injury_type || null, d.description, d.immediate_action || null, d.root_cause || null,
        d.corrective_action || null, d.preventive_action || null, d.witness_names || null,
        d.investigation_by || null, d.investigation_date || null, req.user?.username || d.reported_by || '',
        'reported', req.user?.sub || 0]
    );
    res.json({ id: result.insertId, incident_no: incNo, message: 'Incident reported' });
  } catch (err: any) {
    console.error('Add incident error:', err);
    res.status(500).json({ error: 'Failed to report incident' });
  }
});

router.put('/incidents/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE incidents SET title=?, incident_type=?, severity=?, incident_date=?, incident_time=?,
        location=?, department=?, injured_person=?, injury_type=?, description=?, immediate_action=?,
        root_cause=?, corrective_action=?, preventive_action=?, witness_names=?,
        investigation_by=?, investigation_date=?, status=? WHERE id = ?`,
      [d.title, d.incident_type, d.severity, d.incident_date, d.incident_time || null,
        d.location, d.department, d.injured_person || null, d.injury_type || null, d.description,
        d.immediate_action || null, d.root_cause || null, d.corrective_action || null,
        d.preventive_action || null, d.witness_names || null, d.investigation_by || null,
        d.investigation_date || null, d.status, req.params.id]
    );
    if (d.status === 'closed') {
      await pool().execute('UPDATE incidents SET closed_at = NOW() WHERE id = ? AND closed_at IS NULL', [req.params.id]);
    }
    res.json({ message: 'Incident updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update incident' });
  }
});

// ═══════════════════════════════════════════════════════════════
// WORK PERMITS
// ═══════════════════════════════════════════════════════════════
router.get('/permits', async (req: Request, res: Response) => {
  try {
    const { search, type, status, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (title LIKE ? OR permit_no LIKE ? OR requested_by LIKE ? OR contractor_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (type) { where += ' AND permit_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM work_permits WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM work_permits WHERE ${where} ORDER BY start_date DESC, created_at DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ permits: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load permits' });
  }
});

router.get('/permits/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM work_permits WHERE id = ?', [req.params.id]);
    if (!rows.length) { res.status(404).json({ error: 'Permit not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/permits', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const permitNo = await generateNo('WP-', 'work_permits', 'permit_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO work_permits (permit_no, permit_type, title, description, location, department,
        requested_by, contractor_name, start_date, start_time, end_date, end_time,
        hazards, precautions, ppe_required, safety_officer, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [permitNo, d.permit_type || 'general', d.title, d.description || null, d.location || null,
        d.department || null, d.requested_by || req.user?.username, d.contractor_name || null,
        d.start_date, d.start_time || null, d.end_date || null, d.end_time || null,
        d.hazards || null, d.precautions || null, d.ppe_required || null,
        d.safety_officer || null, 'pending', req.user?.sub || 0]
    );
    res.json({ id: result.insertId, permit_no: permitNo, message: 'Work permit created' });
  } catch (err: any) {
    console.error('Add permit error:', err);
    res.status(500).json({ error: 'Failed to create permit' });
  }
});

router.put('/permits/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE work_permits SET permit_type=?, title=?, description=?, location=?, department=?,
        requested_by=?, contractor_name=?, start_date=?, start_time=?, end_date=?, end_time=?,
        hazards=?, precautions=?, ppe_required=?, safety_officer=?, status=? WHERE id = ?`,
      [d.permit_type, d.title, d.description || null, d.location || null, d.department || null,
        d.requested_by || null, d.contractor_name || null, d.start_date, d.start_time || null,
        d.end_date || null, d.end_time || null, d.hazards || null, d.precautions || null,
        d.ppe_required || null, d.safety_officer || null, d.status, req.params.id]
    );
    if (d.status === 'approved') {
      await pool().execute('UPDATE work_permits SET approved_by = ?, approved_at = NOW() WHERE id = ?', [req.user?.username || 'admin', req.params.id]);
    }
    if (d.status === 'completed') {
      await pool().execute('UPDATE work_permits SET closed_by = ?, closed_at = NOW() WHERE id = ?', [req.user?.username || 'admin', req.params.id]);
    }
    res.json({ message: 'Permit updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update permit' });
  }
});

// ═══════════════════════════════════════════════════════════════
// INSPECTIONS
// ═══════════════════════════════════════════════════════════════
router.get('/inspections', async (req: Request, res: Response) => {
  try {
    const { search, type, status, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (area LIKE ? OR inspection_no LIKE ? OR inspector_name LIKE ? OR findings LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (type) { where += ' AND inspection_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM inspections WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM inspections WHERE ${where} ORDER BY inspection_date DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ inspections: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load inspections' });
  }
});

router.post('/inspections', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const inspNo = await generateNo('INS-', 'inspections', 'inspection_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO inspections (inspection_no, inspection_type, area, department, inspection_date,
        inspector_name, findings, observations, non_conformities, corrective_actions,
        due_date, overall_score, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inspNo, d.inspection_type || 'routine', d.area, d.department || null, d.inspection_date,
        d.inspector_name || req.user?.username, d.findings || null, d.observations || 0,
        d.non_conformities || 0, d.corrective_actions || null, d.due_date || null,
        d.overall_score || null, d.status || 'planned', d.remarks || null, req.user?.sub || 0]
    );
    res.json({ id: result.insertId, inspection_no: inspNo, message: 'Inspection created' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create inspection' });
  }
});

router.put('/inspections/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE inspections SET inspection_type=?, area=?, department=?, inspection_date=?,
        inspector_name=?, findings=?, observations=?, non_conformities=?, corrective_actions=?,
        due_date=?, overall_score=?, status=?, remarks=? WHERE id = ?`,
      [d.inspection_type, d.area, d.department, d.inspection_date, d.inspector_name,
        d.findings || null, d.observations || 0, d.non_conformities || 0,
        d.corrective_actions || null, d.due_date || null, d.overall_score || null,
        d.status, d.remarks || null, req.params.id]
    );
    res.json({ message: 'Inspection updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SAFETY OBSERVATIONS (BBS)
// ═══════════════════════════════════════════════════════════════
router.get('/observations', async (req: Request, res: Response) => {
  try {
    const { search, type, status, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (description LIKE ? OR location LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (type) { where += ' AND observation_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM safety_observations WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM safety_observations WHERE ${where} ORDER BY created_at DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ observations: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load observations' });
  }
});

router.post('/observations', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO safety_observations (observation_type, location, department, description, action_taken, reported_by, status)
       VALUES (?,?,?,?,?,?,?)`,
      [d.observation_type, d.location, d.department, d.description, d.action_taken || null,
        req.user?.sub || d.reported_by || 0, 'open']
    );
    res.json({ id: result.insertId, message: 'Observation recorded' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record observation' });
  }
});

router.put('/observations/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE safety_observations SET observation_type=?, location=?, department=?, description=?, action_taken=?, status=? WHERE id = ?`,
      [d.observation_type, d.location, d.department, d.description, d.action_taken || null, d.status, req.params.id]
    );
    res.json({ message: 'Observation updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TRAINING RECORDS
// ═══════════════════════════════════════════════════════════════
router.get('/trainings', async (req: Request, res: Response) => {
  try {
    const { search, type, status, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (title LIKE ? OR trainer_name LIKE ? OR training_no LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (type) { where += ' AND training_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM training_records WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM training_records WHERE ${where} ORDER BY training_date DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ trainings: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load trainings' });
  }
});

router.post('/trainings', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const trnNo = await generateNo('TRN-', 'training_records', 'training_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO training_records (training_no, title, training_type, trainer_name, training_date,
        duration_hours, location, department, attendees_count, attendees, topics_covered, remarks, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [trnNo, d.title, d.training_type || 'general', d.trainer_name, d.training_date,
        d.duration_hours || null, d.location || null, d.department || null,
        d.attendees_count || 0, d.attendees || null, d.topics_covered || null,
        d.remarks || null, d.status || 'planned', req.user?.sub || 0]
    );
    res.json({ id: result.insertId, training_no: trnNo, message: 'Training created' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create training' });
  }
});

router.put('/trainings/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE training_records SET title=?, training_type=?, trainer_name=?, training_date=?,
        duration_hours=?, location=?, department=?, attendees_count=?, attendees=?,
        topics_covered=?, remarks=?, status=? WHERE id = ?`,
      [d.title, d.training_type, d.trainer_name, d.training_date, d.duration_hours || null,
        d.location || null, d.department || null, d.attendees_count || 0,
        d.attendees || null, d.topics_covered || null, d.remarks || null, d.status, req.params.id]
    );
    res.json({ message: 'Training updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PPE MANAGEMENT
// ═══════════════════════════════════════════════════════════════
router.get('/ppe', async (req: Request, res: Response) => {
  try {
    const { search, item, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (employee_name LIKE ? OR employee_id LIKE ? OR ppe_item LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (item) { where += ' AND ppe_item = ?'; params.push(item); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM ppe_issuance WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM ppe_issuance WHERE ${where} ORDER BY issue_date DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );

    // PPE summary
    const [summary] = await pool().execute<RowDataPacket[]>(
      `SELECT ppe_item, COUNT(*) as total_issued, SUM(CASE WHEN returned_date IS NULL THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURDATE() AND returned_date IS NULL THEN 1 ELSE 0 END) as expired
       FROM ppe_issuance GROUP BY ppe_item ORDER BY total_issued DESC`
    );

    res.json({ records: rows, total: countRows[0].total, page: pg, limit: lm, summary });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load PPE records' });
  }
});

router.post('/ppe', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO ppe_issuance (employee_name, employee_id, department, ppe_item, quantity,
        issue_date, expiry_date, condition_on_issue, issued_by, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [d.employee_name, d.employee_id || null, d.department || null, d.ppe_item,
        d.quantity || 1, d.issue_date || new Date().toISOString().slice(0, 10),
        d.expiry_date || null, d.condition_on_issue || 'new',
        req.user?.username || d.issued_by || 'admin', d.remarks || null]
    );
    res.json({ id: result.insertId, message: 'PPE issued' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to issue PPE' });
  }
});

router.put('/ppe/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE ppe_issuance SET employee_name=?, employee_id=?, department=?, ppe_item=?,
        quantity=?, issue_date=?, expiry_date=?, condition_on_issue=?, returned_date=?,
        condition_on_return=?, remarks=? WHERE id = ?`,
      [d.employee_name, d.employee_id || null, d.department || null, d.ppe_item,
        d.quantity || 1, d.issue_date, d.expiry_date || null, d.condition_on_issue || 'new',
        d.returned_date || null, d.condition_on_return || null, d.remarks || null, req.params.id]
    );
    res.json({ message: 'PPE record updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SAFETY AUDITS
// ═══════════════════════════════════════════════════════════════
router.get('/audits', async (req: Request, res: Response) => {
  try {
    const { search, type, status, department, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (search) { where += ' AND (audit_no LIKE ? OR auditor LIKE ? OR summary LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (type) { where += ' AND audit_type = ?'; params.push(type); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM safety_audits WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM safety_audits WHERE ${where} ORDER BY audit_date DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ audits: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load audits' });
  }
});

router.post('/audits', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const audNo = await generateNo('AUD-', 'safety_audits', 'audit_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO safety_audits (audit_no, audit_type, audit_date, department, auditor,
        score, findings, critical_findings, status, summary, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [audNo, d.audit_type || 'internal', d.audit_date, d.department, d.auditor,
        d.score || null, d.findings || 0, d.critical_findings || 0,
        d.status || 'scheduled', d.summary || null, req.user?.sub || 0]
    );
    res.json({ id: result.insertId, audit_no: audNo, message: 'Audit created' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create audit' });
  }
});

router.put('/audits/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE safety_audits SET audit_type=?, audit_date=?, department=?, auditor=?,
        score=?, findings=?, critical_findings=?, status=?, summary=? WHERE id = ?`,
      [d.audit_type, d.audit_date, d.department, d.auditor, d.score || null,
        d.findings || 0, d.critical_findings || 0, d.status, d.summary || null, req.params.id]
    );
    res.json({ message: 'Audit updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const { type, from, to } = req.query;
    const startDate = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const endDate = to || new Date().toISOString().slice(0, 10);

    if (type === 'incident_summary') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT incident_type, severity, status, COUNT(*) as count
         FROM incidents WHERE incident_date BETWEEN ? AND ?
         GROUP BY incident_type, severity, status ORDER BY count DESC`, [startDate, endDate]
      );
      const [trend] = await pool().execute<RowDataPacket[]>(
        `SELECT DATE_FORMAT(incident_date, '%Y-%m') as month, COUNT(*) as count
         FROM incidents WHERE incident_date BETWEEN ? AND ?
         GROUP BY month ORDER BY month`, [startDate, endDate]
      );
      res.json({ type: 'incident_summary', data: rows, trend, from: startDate, to: endDate });
      return;
    }

    if (type === 'audit_summary') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT * FROM safety_audits WHERE audit_date BETWEEN ? AND ? ORDER BY audit_date DESC`, [startDate, endDate]
      );
      const [avgScore] = await pool().execute<RowDataPacket[]>(
        `SELECT department, AVG(score) as avg_score, COUNT(*) as count
         FROM safety_audits WHERE audit_date BETWEEN ? AND ? AND score IS NOT NULL
         GROUP BY department ORDER BY avg_score DESC`, [startDate, endDate]
      );
      res.json({ type: 'audit_summary', data: rows, avgByDept: avgScore, from: startDate, to: endDate });
      return;
    }

    if (type === 'training_summary') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT training_type, status, COUNT(*) as count, SUM(attendees_count) as total_attendees, SUM(duration_hours) as total_hours
         FROM training_records WHERE training_date BETWEEN ? AND ?
         GROUP BY training_type, status ORDER BY count DESC`, [startDate, endDate]
      );
      res.json({ type: 'training_summary', data: rows, from: startDate, to: endDate });
      return;
    }

    if (type === 'ppe_summary') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT ppe_item, department, COUNT(*) as issued, SUM(quantity) as total_qty,
          SUM(CASE WHEN returned_date IS NULL AND expiry_date < CURDATE() THEN 1 ELSE 0 END) as expired
         FROM ppe_issuance WHERE issue_date BETWEEN ? AND ?
         GROUP BY ppe_item, department ORDER BY issued DESC`, [startDate, endDate]
      );
      res.json({ type: 'ppe_summary', data: rows, from: startDate, to: endDate });
      return;
    }

    if (type === 'observation_summary') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT observation_type, department, status, COUNT(*) as count
         FROM safety_observations WHERE DATE(created_at) BETWEEN ? AND ?
         GROUP BY observation_type, department, status ORDER BY count DESC`, [startDate, endDate]
      );
      res.json({ type: 'observation_summary', data: rows, from: startDate, to: endDate });
      return;
    }

    // Default overview
    const [inc] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM incidents WHERE incident_date BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [aud] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM safety_audits WHERE audit_date BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [trn] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c, COALESCE(SUM(attendees_count),0) as attendees FROM training_records WHERE training_date BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [obs] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM safety_observations WHERE DATE(created_at) BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [ppe] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM ppe_issuance WHERE issue_date BETWEEN ? AND ?`, [startDate, endDate]
    );
    res.json({
      type: 'overview',
      incidents: inc[0].c, audits: aud[0].c,
      trainings: trn[0].c, trainingAttendees: trn[0].attendees,
      observations: obs[0].c, ppeIssued: ppe[0].c,
      from: startDate, to: endDate,
    });
  } catch (err: any) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM safety_settings ORDER BY id');
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.setting_key] = r.setting_value;
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.post('/settings', async (req: Request, res: Response) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await pool().execute(
        'INSERT INTO safety_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [key, value, value]
      );
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SAFETY ASSETS
// ═══════════════════════════════════════════════════════════════
router.get('/assets', async (req: Request, res: Response) => {
  try {
    const { search, category, inspection_status, condition_status, department, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const params: any[] = [];
    if (search) { where += ' AND (asset_name LIKE ? OR asset_no LIKE ? OR serial_no LIKE ? OR location LIKE ? OR make LIKE ? OR model LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (category) { where += ' AND asset_category = ?'; params.push(category); }
    if (inspection_status) { where += ' AND inspection_status = ?'; params.push(inspection_status); }
    if (condition_status) { where += ' AND condition_status = ?'; params.push(condition_status); }
    if (department) { where += ' AND department = ?'; params.push(department); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM safety_assets WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM safety_assets WHERE ${where} ORDER BY next_inspection_date ASC, asset_name LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    // Summary stats
    const [stats] = await pool().execute<RowDataPacket[]>(
      `SELECT
         COUNT(*) as total,
         SUM(inspection_status = 'valid') as valid,
         SUM(inspection_status = 'due') as due,
         SUM(inspection_status = 'overdue') as overdue,
         SUM(inspection_status = 'failed') as failed,
         SUM(condition_status = 'condemned') as condemned,
         COUNT(DISTINCT asset_category) as categories
       FROM safety_assets WHERE is_active = 1`
    );
    res.json({ assets: rows, total: countRows[0].total, page: pg, limit: lm, stats: stats[0] });
  } catch (err: any) {
    console.error('Get assets error:', err);
    res.status(500).json({ error: 'Failed to load assets' });
  }
});

router.get('/assets/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM safety_assets WHERE id = ?', [req.params.id]);
    if (!rows.length) { res.status(404).json({ error: 'Asset not found' }); return; }
    // Include inspection history
    const [inspections] = await pool().execute<RowDataPacket[]>(
      'SELECT * FROM asset_inspections WHERE asset_id = ? ORDER BY inspection_date DESC', [req.params.id]
    );
    res.json({ ...rows[0], inspections });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load asset' });
  }
});

router.post('/assets', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const assetNo = await generateNo('SA', 'safety_assets', 'asset_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO safety_assets (asset_no, asset_name, asset_category, make, model, serial_no,
        purchase_date, warranty_expiry, department, location, assigned_to, rated_capacity,
        specifications, last_inspection_date, next_inspection_date, inspection_frequency_days,
        inspection_status, condition_status, is_active, photo_path, qr_code, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [assetNo, d.asset_name, d.asset_category || 'other', d.make||null, d.model||null, d.serial_no||null,
        d.purchase_date||null, d.warranty_expiry||null, d.department||null, d.location||null,
        d.assigned_to||null, d.rated_capacity||null, d.specifications||null,
        d.last_inspection_date||null, d.next_inspection_date||null, d.inspection_frequency_days||90,
        d.inspection_status||'not_inspected', d.condition_status||'good', d.is_active??1,
        d.photo_path||null, d.qr_code||null, d.remarks||null, req.user?.sub||0]
    );
    res.json({ id: result.insertId, asset_no: assetNo, message: 'Asset registered' });
  } catch (err: any) {
    console.error('Add asset error:', err);
    res.status(500).json({ error: 'Failed to add asset' });
  }
});

router.put('/assets/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE safety_assets SET asset_name=?, asset_category=?, make=?, model=?, serial_no=?,
        purchase_date=?, warranty_expiry=?, department=?, location=?, assigned_to=?, rated_capacity=?,
        specifications=?, last_inspection_date=?, next_inspection_date=?, inspection_frequency_days=?,
        inspection_status=?, condition_status=?, is_active=?, photo_path=?, qr_code=?, remarks=?
       WHERE id = ?`,
      [d.asset_name, d.asset_category, d.make||null, d.model||null, d.serial_no||null,
        d.purchase_date||null, d.warranty_expiry||null, d.department||null, d.location||null,
        d.assigned_to||null, d.rated_capacity||null, d.specifications||null,
        d.last_inspection_date||null, d.next_inspection_date||null, d.inspection_frequency_days||90,
        d.inspection_status||'not_inspected', d.condition_status||'good', d.is_active??1,
        d.photo_path||null, d.qr_code||null, d.remarks||null, req.params.id]
    );
    res.json({ message: 'Asset updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ASSET INSPECTIONS
// ═══════════════════════════════════════════════════════════════
router.get('/asset-inspections', async (req: Request, res: Response) => {
  try {
    const { search, asset_id, inspection_type, result: inspResult, status, from, to, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const params: any[] = [];
    if (search) { where += ' AND (ai.inspection_no LIKE ? OR sa.asset_name LIKE ? OR ai.inspector_name LIKE ? OR ai.findings LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (asset_id) { where += ' AND ai.asset_id = ?'; params.push(asset_id); }
    if (inspection_type) { where += ' AND ai.inspection_type = ?'; params.push(inspection_type); }
    if (inspResult) { where += ' AND ai.result = ?'; params.push(inspResult); }
    if (status) { where += ' AND ai.status = ?'; params.push(status); }
    if (from) { where += ' AND ai.inspection_date >= ?'; params.push(from); }
    if (to) { where += ' AND ai.inspection_date <= ?'; params.push(to); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [countRows] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM asset_inspections ai JOIN safety_assets sa ON sa.id = ai.asset_id WHERE ${where}`, params
    );
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ai.*, sa.asset_name, sa.asset_no, sa.asset_category, sa.location as asset_location, sa.department as asset_department
       FROM asset_inspections ai JOIN safety_assets sa ON sa.id = ai.asset_id
       WHERE ${where} ORDER BY ai.inspection_date DESC LIMIT ${Number(lm)} OFFSET ${Number((pg - 1) * lm)}`, params
    );
    res.json({ inspections: rows, total: countRows[0].total, page: pg, limit: lm });
  } catch (err: any) {
    console.error('Get asset inspections error:', err);
    res.status(500).json({ error: 'Failed to load asset inspections' });
  }
});

router.post('/asset-inspections', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const inspNo = await generateNo('AI', 'asset_inspections', 'inspection_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO asset_inspections (inspection_no, asset_id, inspection_type, inspection_date, next_due_date,
        inspector_name, inspector_company, inspector_certification, checklist_items, findings,
        defects_found, critical_defects, corrective_actions, result, overall_score,
        certificate_no, certificate_expiry, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inspNo, d.asset_id, d.inspection_type||'periodic', d.inspection_date, d.next_due_date||null,
        d.inspector_name||null, d.inspector_company||null, d.inspector_certification||null,
        d.checklist_items||null, d.findings||null, d.defects_found||0, d.critical_defects||0,
        d.corrective_actions||null, d.result||'pass', d.overall_score||null,
        d.certificate_no||null, d.certificate_expiry||null, d.status||'completed',
        d.remarks||null, req.user?.sub||0]
    );
    // Update asset's inspection dates
    if (d.status === 'completed' || !d.status) {
      await pool().execute(
        `UPDATE safety_assets SET last_inspection_date = ?, next_inspection_date = ?,
          inspection_status = CASE WHEN ? IN ('pass','conditional') THEN 'valid' ELSE 'failed' END
         WHERE id = ?`,
        [d.inspection_date, d.next_due_date || null, d.result || 'pass', d.asset_id]
      );
    }
    res.json({ id: result.insertId, inspection_no: inspNo, message: 'Inspection recorded' });
  } catch (err: any) {
    console.error('Add asset inspection error:', err);
    res.status(500).json({ error: 'Failed to add inspection' });
  }
});

router.put('/asset-inspections/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE asset_inspections SET inspection_type=?, inspection_date=?, next_due_date=?,
        inspector_name=?, inspector_company=?, inspector_certification=?, checklist_items=?,
        findings=?, defects_found=?, critical_defects=?, corrective_actions=?, result=?,
        overall_score=?, certificate_no=?, certificate_expiry=?, status=?, remarks=?
       WHERE id = ?`,
      [d.inspection_type, d.inspection_date, d.next_due_date||null,
        d.inspector_name||null, d.inspector_company||null, d.inspector_certification||null,
        d.checklist_items||null, d.findings||null, d.defects_found||0, d.critical_defects||0,
        d.corrective_actions||null, d.result||'pass', d.overall_score||null,
        d.certificate_no||null, d.certificate_expiry||null, d.status||'completed',
        d.remarks||null, req.params.id]
    );
    // Update asset if completed
    if (d.status === 'completed' && d.asset_id) {
      await pool().execute(
        `UPDATE safety_assets SET last_inspection_date = ?, next_inspection_date = ?,
          inspection_status = CASE WHEN ? IN ('pass','conditional') THEN 'valid' ELSE 'failed' END
         WHERE id = ?`,
        [d.inspection_date, d.next_due_date || null, d.result || 'pass', d.asset_id]
      );
    }
    res.json({ message: 'Inspection updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update inspection' });
  }
});

export default router;
