import { Router, Request, Response } from 'express';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
const pool = () => db.vehicle();

// ─── Helper: Generate Entry Number ─────────────────────────────
async function generateEntryNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT COUNT(*) as cnt FROM vehicle_entries WHERE entry_no LIKE ?`, [`VE${year}-%`]
  );
  const next = (rows[0]?.cnt || 0) + 1;
  return `VE${year}-${String(next).padStart(4, '0')}`;
}

async function generateTripNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [rows] = await pool().execute<RowDataPacket[]>(
    `SELECT COUNT(*) as cnt FROM trip_requests WHERE request_no LIKE ?`, [`TR${year}-%`]
  );
  const next = (rows[0]?.cnt || 0) + 1;
  return `TR${year}-${String(next).padStart(4, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & STATS
// ═══════════════════════════════════════════════════════════════

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [vehicleCount] = await pool().execute<RowDataPacket[]>('SELECT COUNT(*) as count FROM vehicles WHERE is_active = 1');
    const [activeEntries] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM vehicle_entries WHERE status NOT IN ('out','cancelled')`);
    const [todayEntries] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM vehicle_entries WHERE DATE(in_time) = CURDATE()`);
    const [pendingTrips] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM trip_requests WHERE status = 'pending'`);
    const [todayGateOut] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM gate_log WHERE DATE(gate_out_time) = CURDATE()`);
    const [currentlyOut] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM gate_log WHERE gate_in_time IS NULL`);

    // Purpose breakdown for entries
    const [purposeBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT purpose, COUNT(*) as count FROM vehicle_entries GROUP BY purpose ORDER BY count DESC`
    );

    // Vehicle status breakdown
    const [vehicleStatus] = await pool().execute<RowDataPacket[]>(
      `SELECT status, COUNT(*) as count FROM vehicles WHERE is_active = 1 GROUP BY status`
    );

    // Recent entries
    const [recentEntries] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id ORDER BY ve.in_time DESC LIMIT 10`
    );

    // Daily entry counts (last 15 days)
    const [dailyCounts] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(in_time, '%Y-%m-%d') as date, COUNT(*) as count FROM vehicle_entries WHERE in_time >= DATE_SUB(CURDATE(), INTERVAL 15 DAY) GROUP BY DATE_FORMAT(in_time, '%Y-%m-%d') ORDER BY date`
    );

    res.json({
      totalVehicles: vehicleCount[0].count,
      activeEntries: activeEntries[0].count,
      todayEntries: todayEntries[0].count,
      pendingTrips: pendingTrips[0].count,
      todayGateOut: todayGateOut[0].count,
      currentlyOut: currentlyOut[0].count,
      purposeBreakdown,
      vehicleStatus,
      recentEntries,
      dailyCounts,
    });
  } catch (err: any) {
    console.error('Vehicle stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// VEHICLE ENTRIES (External vehicles)
// ═══════════════════════════════════════════════════════════════

router.get('/entries', async (req: Request, res: Response) => {
  try {
    const { status, purpose, date, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];

    if (status) { where += ' AND ve.status = ?'; params.push(status); }
    if (purpose) { where += ' AND ve.purpose = ?'; params.push(purpose); }
    if (date) { where += ' AND DATE(ve.in_time) = ?'; params.push(date); }

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM vehicle_entries ve WHERE ${where}`, params
    );

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id WHERE ${where} ORDER BY ve.in_time DESC LIMIT ${Number(limitNum)} OFFSET ${Number(offset)}`, params
    );

    res.json({ entries: rows, total: countRows[0].total, page: pageNum, limit: limitNum });
  } catch (err: any) {
    console.error('List entries error:', err);
    res.status(500).json({ error: 'Failed to load entries' });
  }
});

router.get('/entries/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id WHERE ve.id = ?`, [req.params.id]
    );
    if (!rows.length) { res.status(404).json({ error: 'Entry not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load entry' });
  }
});

router.post('/entries', async (req: Request, res: Response) => {
  try {
    const { vehicle_no, vehicle_type, driver_name, driver_phone, driver_license, company, purpose, department, dock_id, po_reference, material_desc, in_weight, security_remarks } = req.body;
    const entry_no = await generateEntryNo();

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO vehicle_entries (entry_no, vehicle_no, vehicle_type, driver_name, driver_phone, driver_license, company, purpose, department, dock_id, po_reference, material_desc, in_time, in_weight, status, security_remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?)`,
      [entry_no, vehicle_no, vehicle_type || 'truck', driver_name, driver_phone || null, driver_license || null, company || null, purpose || 'delivery', department, dock_id || null, po_reference || null, material_desc || null, in_weight || null, 'in', security_remarks || null, req.user?.sub || 0]
    );

    res.json({ id: result.insertId, entry_no, status: 'in', message: 'Vehicle entry recorded' });
  } catch (err: any) {
    console.error('Create entry error:', err);
    res.status(500).json({ error: 'Failed to create entry' });
  }
});

router.post('/entries/:id/checkout', async (req: Request, res: Response) => {
  try {
    const { out_weight, gate_pass_no, security_remarks } = req.body;
    await pool().execute(
      `UPDATE vehicle_entries SET out_time = NOW(), out_weight = ?, gate_pass_no = ?, security_remarks = CONCAT(COALESCE(security_remarks,''), ?, ''), status = 'out' WHERE id = ? AND status != 'out'`,
      [out_weight || null, gate_pass_no || null, security_remarks ? '\nCheckout: ' + security_remarks : '', req.params.id]
    );
    res.json({ message: 'Vehicle checked out' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to checkout' });
  }
});

router.post('/entries/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const validStatuses = ['in', 'docked', 'loading', 'unloading', 'out', 'cancelled'];
    if (!validStatuses.includes(status)) { res.status(400).json({ error: 'Invalid status' }); return; }
    await pool().execute('UPDATE vehicle_entries SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ message: `Status updated to ${status}` });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ═══════════════════════════════════════════════════════════════
// VEHICLES (Company fleet)
// ═══════════════════════════════════════════════════════════════

router.get('/fleet', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT v.*, dr.name as driver_name FROM vehicles v LEFT JOIN drivers dr ON v.assigned_driver_id = dr.id WHERE v.is_active = 1 ORDER BY v.vehicle_no`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load fleet' });
  }
});

router.get('/fleet/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT v.*, dr.name as driver_name FROM vehicles v LEFT JOIN drivers dr ON v.assigned_driver_id = dr.id WHERE v.id = ?`, [req.params.id]
    );
    if (!rows.length) { res.status(404).json({ error: 'Vehicle not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load vehicle' });
  }
});

router.post('/fleet', async (req: Request, res: Response) => {
  try {
    const { vehicle_no, vehicle_type, make, model, year, color, fuel_type, seating_capacity, registration_date, insurance_expiry, fitness_expiry, puc_expiry, assigned_department, assigned_driver_id, current_km, remarks } = req.body;

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO vehicles (vehicle_no, vehicle_type, make, model, year, color, fuel_type, seating_capacity, registration_date, insurance_expiry, fitness_expiry, puc_expiry, assigned_department, assigned_driver_id, current_km, remarks, is_active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [vehicle_no, vehicle_type || 'car', make || null, model || null, year || null, color || null, fuel_type || 'diesel', seating_capacity || 4, registration_date || null, insurance_expiry || null, fitness_expiry || null, puc_expiry || null, assigned_department || null, assigned_driver_id || null, current_km || 0, remarks || null, req.user?.username || 'admin']
    );
    res.json({ id: result.insertId, message: 'Vehicle added' });
  } catch (err: any) {
    console.error('Add vehicle error:', err);
    res.status(500).json({ error: 'Failed to add vehicle' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DRIVERS
// ═══════════════════════════════════════════════════════════════

router.get('/drivers', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM drivers WHERE is_active = 1 ORDER BY name');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load drivers' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DOCKS
// ═══════════════════════════════════════════════════════════════

router.get('/docks', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM docks ORDER BY dock_name');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load docks' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GATE LOG (company vehicle movements)
// ═══════════════════════════════════════════════════════════════

router.get('/gate-log', async (req: Request, res: Response) => {
  try {
    const { date, pending } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (date) { where += ' AND DATE(gl.gate_out_time) = ?'; params.push(date); }
    if (pending === 'true') { where += ' AND gl.gate_in_time IS NULL'; }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT gl.*, v.vehicle_no, v.make, v.model FROM gate_log gl LEFT JOIN vehicles v ON gl.vehicle_id = v.id WHERE ${where} ORDER BY gl.gate_out_time DESC LIMIT 100`, params
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load gate log' });
  }
});

router.post('/gate-log/out', async (req: Request, res: Response) => {
  try {
    const { vehicle_id, driver_id, driver_name, gate_out_km, gate_name, purpose, destination } = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO gate_log (vehicle_id, driver_id, driver_name, gate_out_time, gate_out_km, gate_out_by, gate_name, purpose, destination) VALUES (?,?,?,NOW(),?,?,?,?,?)`,
      [vehicle_id, driver_id || null, driver_name, gate_out_km || null, req.user?.username || 'security', gate_name || 'Main Gate', purpose, destination || null]
    );
    // Update vehicle status
    if (vehicle_id) {
      await pool().execute(`UPDATE vehicles SET status = 'on_trip' WHERE id = ?`, [vehicle_id]);
    }
    res.json({ id: result.insertId, message: 'Gate out recorded' });
  } catch (err: any) {
    console.error('Gate out error:', err);
    res.status(500).json({ error: 'Failed to record gate out' });
  }
});

router.post('/gate-log/:id/in', async (req: Request, res: Response) => {
  try {
    const { gate_in_km, remarks } = req.body;
    // Get vehicle_id first
    const [logs] = await pool().execute<RowDataPacket[]>('SELECT vehicle_id FROM gate_log WHERE id = ?', [req.params.id]);
    await pool().execute(
      `UPDATE gate_log SET gate_in_time = NOW(), gate_in_km = ?, gate_in_by = ?, remarks = ? WHERE id = ? AND gate_in_time IS NULL`,
      [gate_in_km || null, req.user?.username || 'security', remarks || null, req.params.id]
    );
    // Update vehicle status back
    if (logs.length && logs[0].vehicle_id) {
      await pool().execute(`UPDATE vehicles SET status = 'available', current_km = COALESCE(?, current_km) WHERE id = ?`, [gate_in_km || null, logs[0].vehicle_id]);
    }
    res.json({ message: 'Gate in recorded' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record gate in' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TRIP REQUESTS
// ═══════════════════════════════════════════════════════════════

router.get('/trips', async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (status) { where += ' AND tr.status = ?'; params.push(status); }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT tr.*, v.vehicle_no, v.make, v.model, dr.name as driver_name_full FROM trip_requests tr LEFT JOIN vehicles v ON tr.vehicle_id = v.id LEFT JOIN drivers dr ON tr.driver_id = dr.id WHERE ${where} ORDER BY tr.created_at DESC`, params
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load trip requests' });
  }
});

router.post('/trips', async (req: Request, res: Response) => {
  try {
    const { requested_by, department, vehicle_id, driver_id, purpose, destination, trip_date, trip_time, return_date, return_time, passengers, passenger_names, remarks } = req.body;
    const request_no = await generateTripNo();

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO trip_requests (request_no, requested_by, department, vehicle_id, driver_id, purpose, destination, trip_date, trip_time, return_date, return_time, passengers, passenger_names, status, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [request_no, requested_by, department || null, vehicle_id || null, driver_id || null, purpose, destination || null, trip_date, trip_time || null, return_date || null, return_time || null, passengers || 1, passenger_names || null, 'pending', remarks || null, req.user?.sub || 0]
    );
    res.json({ id: result.insertId, request_no, message: 'Trip request created' });
  } catch (err: any) {
    console.error('Create trip error:', err);
    res.status(500).json({ error: 'Failed to create trip request' });
  }
});

router.post('/trips/:id/approve', async (req: Request, res: Response) => {
  try {
    const { action, remarks, vehicle_id, driver_id } = req.body;
    if (action === 'approve') {
      await pool().execute(
        `UPDATE trip_requests SET status = 'approved', approved_by = ?, approved_at = NOW(), remarks = ?, vehicle_id = COALESCE(?, vehicle_id), driver_id = COALESCE(?, driver_id) WHERE id = ? AND status = 'pending'`,
        [req.user?.sub || 0, remarks || null, vehicle_id || null, driver_id || null, req.params.id]
      );
      res.json({ message: 'Trip approved' });
    } else {
      await pool().execute(
        `UPDATE trip_requests SET status = 'rejected', approved_by = ?, approved_at = NOW(), remarks = ? WHERE id = ? AND status = 'pending'`,
        [req.user?.sub || 0, remarks || null, req.params.id]
      );
      res.json({ message: 'Trip rejected' });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update trip' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTINGS & REFERENCE
// ═══════════════════════════════════════════════════════════════

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM vehicle_settings ORDER BY id');
    const settings: Record<string, string> = {};
    for (const r of rows) { settings[r.setting_key] = r.setting_value; }
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

export default router;
