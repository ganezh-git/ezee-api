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
    const [waitingOfficer] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM vehicle_entries WHERE status = 'with_officer'`);
    const [waitingSecondWeight] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM vehicle_entries WHERE status = 'waiting_second_weight'`);
    const [readyToExit] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as count FROM vehicle_entries WHERE status = 'ready_to_exit'`);

    const [purposeBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT purpose, COUNT(*) as count FROM vehicle_entries GROUP BY purpose ORDER BY count DESC`
    );
    const [vehicleStatus] = await pool().execute<RowDataPacket[]>(
      `SELECT status, COUNT(*) as count FROM vehicles WHERE is_active = 1 GROUP BY status`
    );
    const [recentEntries] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id ORDER BY ve.in_time DESC LIMIT 10`
    );
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
      waitingOfficer: waitingOfficer[0].count,
      waitingSecondWeight: waitingSecondWeight[0].count,
      readyToExit: readyToExit[0].count,
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
// VEHICLE ENTRIES — Step 1: First Weighment (Security)
// Truck arrives → gross weight recorded → basic details
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

// Step 1: Security creates entry with first weighment (gross weight)
router.post('/entries', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    const entry_no = await generateEntryNo();

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO vehicle_entries (entry_no, vehicle_no, vehicle_type, driver_name, driver_phone, driver_mobile,
        driver_license, license_validity, pollution_cert, pollution_cert_validity,
        company, purpose, department, dock_id, po_reference, material_desc,
        product_code, product_name, supplier_code, supplier_name,
        transporter_code, transporter_name, challan_no, challan_date, challan_weight, challan_uom,
        delivery_note_no, shift, gross_weight, in_time, in_weight,
        security_in_by, security_in_time, security_in_comments, status, security_remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,NOW(),?,?,?,?)`,
      [entry_no, b.vehicle_no, b.vehicle_type || 'truck',
        b.driver_name, b.driver_phone || null, b.driver_mobile || null,
        b.driver_license || null, b.license_validity || null,
        b.pollution_cert || null, b.pollution_cert_validity || null,
        b.company || null, b.purpose || 'delivery', b.department, b.dock_id || null,
        b.po_reference || null, b.material_desc || null,
        b.product_code || null, b.product_name || null,
        b.supplier_code || null, b.supplier_name || null,
        b.transporter_code || null, b.transporter_name || null,
        b.challan_no || null, b.challan_date || null, b.challan_weight || null, b.challan_uom || 'KG',
        b.delivery_note_no || null, b.shift || null,
        b.gross_weight || null, b.in_weight || null,
        req.user?.username || 'security', b.security_in_comments || null,
        'in', b.security_remarks || null, req.user?.sub || 0]
    );

    await pool().execute(
      `INSERT INTO vehicle_log (entry_id, vehicle_no, action, details, performed_by) VALUES (?,?,?,?,?)`,
      [result.insertId, b.vehicle_no, 'entry', `Entry ${entry_no}. Gross: ${b.gross_weight || '—'} kg`, req.user?.username || 'security']
    );

    res.json({ id: result.insertId, entry_no, status: 'in', message: 'Vehicle entry recorded' });
  } catch (err: any) {
    console.error('Create entry error:', err);
    res.status(500).json({ error: 'Failed to create entry' });
  }
});

// Step 2: Officer review/approval — adds PO, product details, COA
router.post('/entries/:id/officer-approve', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    const officerName = req.user?.username || 'officer';
    await pool().execute(
      `UPDATE vehicle_entries SET 
        product_code = COALESCE(?, product_code), product_name = COALESCE(?, product_name),
        supplier_code = COALESCE(?, supplier_code), supplier_name = COALESCE(?, supplier_name),
        transporter_code = COALESCE(?, transporter_code), transporter_name = COALESCE(?, transporter_name),
        challan_no = COALESCE(?, challan_no), challan_weight = COALESCE(?, challan_weight),
        delivery_note_no = COALESCE(?, delivery_note_no), po_reference = COALESCE(?, po_reference),
        coa_percent = ?, officer_name = ?, officer_comments = ?, officer_update_time = NOW(),
        vehicle_returned = ?, status = ?
       WHERE id = ?`,
      [b.product_code || null, b.product_name || null,
        b.supplier_code || null, b.supplier_name || null,
        b.transporter_code || null, b.transporter_name || null,
        b.challan_no || null, b.challan_weight || null,
        b.delivery_note_no || null, b.po_reference || null,
        b.coa_percent || null, officerName, b.officer_comments || null,
        b.vehicle_returned || 'na',
        b.vehicle_returned === 'yes' ? 'ready_to_exit' : 'with_qa',
        req.params.id]
    );

    const [entry] = await pool().execute<RowDataPacket[]>('SELECT entry_no, vehicle_no FROM vehicle_entries WHERE id = ?', [req.params.id]);
    if (entry.length) {
      await pool().execute(
        `INSERT INTO vehicle_log (entry_id, vehicle_no, action, details, performed_by) VALUES (?,?,?,?,?)`,
        [req.params.id, entry[0].vehicle_no, 'officer_approved', `Officer reviewed. COA: ${b.coa_percent || '—'}%`, officerName]
      );
    }
    res.json({ message: 'Officer review saved' });
  } catch (err: any) {
    console.error('Officer approve error:', err);
    res.status(500).json({ error: 'Failed to save officer review' });
  }
});

// Step 3: QA approval
router.post('/entries/:id/qa-approve', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    const qaOfficer = req.user?.username || 'qa';
    const nextStatus = b.approve ? 'loading' : 'ready_to_exit';
    
    await pool().execute(
      `UPDATE vehicle_entries SET qa_officer = ?, qa_comments = ?, qa_update_time = NOW(), status = ? WHERE id = ?`,
      [qaOfficer, b.qa_comments || null, nextStatus, req.params.id]
    );

    const [entry] = await pool().execute<RowDataPacket[]>('SELECT entry_no, vehicle_no FROM vehicle_entries WHERE id = ?', [req.params.id]);
    if (entry.length) {
      await pool().execute(
        `INSERT INTO vehicle_log (entry_id, vehicle_no, action, details, performed_by) VALUES (?,?,?,?,?)`,
        [req.params.id, entry[0].vehicle_no, b.approve ? 'qa_approved' : 'qa_rejected', b.qa_comments || 'No comments', qaOfficer]
      );
    }
    res.json({ message: b.approve ? 'QA approved — sent to loading' : 'QA rejected — sent to exit' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save QA review' });
  }
});

// Step 4: Second weighment (tare weight after loading/unloading)
router.post('/entries/:id/second-weight', async (req: Request, res: Response) => {
  try {
    const { tare_weight } = req.body;
    // Get gross weight
    const [entry] = await pool().execute<RowDataPacket[]>('SELECT gross_weight, entry_no, vehicle_no FROM vehicle_entries WHERE id = ?', [req.params.id]);
    if (!entry.length) { res.status(404).json({ error: 'Entry not found' }); return; }

    const gross = parseFloat(entry[0].gross_weight) || 0;
    const tare = parseFloat(tare_weight) || 0;
    const net = Math.abs(gross - tare);
    const approvedBy = req.user?.username || 'weighbridge';

    await pool().execute(
      `UPDATE vehicle_entries SET tare_weight = ?, net_weight = ?, out_weight = ?, weight_approved_by = ?, weight_approved_at = NOW(), status = 'ready_to_exit' WHERE id = ?`,
      [tare, net, tare, approvedBy, req.params.id]
    );

    await pool().execute(
      `INSERT INTO vehicle_log (entry_id, vehicle_no, action, details, performed_by) VALUES (?,?,?,?,?)`,
      [req.params.id, entry[0].vehicle_no, 'second_weight', `Tare: ${tare} kg, Net: ${net} kg`, approvedBy]
    );

    res.json({ message: 'Second weight recorded', gross_weight: gross, tare_weight: tare, net_weight: net });
  } catch (err: any) {
    console.error('Second weight error:', err);
    res.status(500).json({ error: 'Failed to record second weight' });
  }
});

// Step 5: Vehicle exit (checkout)
router.post('/entries/:id/checkout', async (req: Request, res: Response) => {
  try {
    const { gate_pass_no, security_remarks } = req.body;
    const security_out = req.user?.username || 'security';
    await pool().execute(
      `UPDATE vehicle_entries SET out_time = NOW(), gate_pass_no = ?, security_out_by = ?, security_out_comments = ?, status = 'out' WHERE id = ? AND status != 'out'`,
      [gate_pass_no || null, security_out, security_remarks || null, req.params.id]
    );

    const [entry] = await pool().execute<RowDataPacket[]>('SELECT entry_no, vehicle_no FROM vehicle_entries WHERE id = ?', [req.params.id]);
    if (entry.length) {
      await pool().execute(
        `INSERT INTO vehicle_log (entry_id, vehicle_no, action, details, performed_by) VALUES (?,?,?,?,?)`,
        [req.params.id, entry[0].vehicle_no, 'checkout', `Vehicle out. Pass: ${gate_pass_no || '—'}`, security_out]
      );
    }

    res.json({ message: 'Vehicle checked out' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to checkout' });
  }
});

// Status update (generic)
router.post('/entries/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const validStatuses = ['waiting_entry','in','with_officer','with_qa','loading','unloading','waiting_second_weight','ready_to_exit','out','cancelled'];
    if (!validStatuses.includes(status)) { res.status(400).json({ error: 'Invalid status' }); return; }
    await pool().execute('UPDATE vehicle_entries SET status = ? WHERE id = ?', [status, req.params.id]);

    const [entry] = await pool().execute<RowDataPacket[]>('SELECT entry_no, vehicle_no FROM vehicle_entries WHERE id = ?', [req.params.id]);
    if (entry.length) {
      await pool().execute(
        `INSERT INTO vehicle_log (entry_id, vehicle_no, action, details, performed_by) VALUES (?,?,?,?,?)`,
        [req.params.id, entry[0].vehicle_no, 'status_change', `Status → ${status}`, req.user?.username || 'system']
      );
    }
    res.json({ message: `Status updated to ${status}` });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Despatch challan / gate pass print data
router.get('/entries/:id/pass', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id WHERE ve.id = ?`, [req.params.id]
    );
    if (!rows.length) { res.status(404).json({ error: 'Entry not found' }); return; }
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load pass' });
  }
});

// Currently inside
router.get('/currently-inside', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id
       WHERE ve.status NOT IN ('out','cancelled') ORDER BY ve.in_time DESC`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load data' });
  }
});

// Entries by workflow stage
router.get('/by-status/:status', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id
       WHERE ve.status = ? ORDER BY ve.in_time`, [req.params.status]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load entries' });
  }
});

// Vehicle number lookup (auto-fill from history)
router.get('/lookup', async (req: Request, res: Response) => {
  try {
    const { phone, vehicle_no } = req.query;
    if (vehicle_no) {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT driver_name, driver_phone, driver_license, company, vehicle_no, vehicle_type,
          transporter_name, transporter_code, supplier_name, supplier_code
         FROM vehicle_entries WHERE vehicle_no LIKE ? ORDER BY id DESC LIMIT 1`,
        [`%${vehicle_no}%`]
      );
      const [countRows] = await pool().execute<RowDataPacket[]>(
        `SELECT COUNT(*) as visit_count FROM vehicle_entries WHERE vehicle_no LIKE ?`, [`%${vehicle_no}%`]
      );
      res.json(rows.length ? { found: true, entry: rows[0], visitCount: countRows[0].visit_count } : { found: false });
    } else if (phone) {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT driver_name, driver_phone, driver_license, company, vehicle_no, vehicle_type,
          transporter_name, transporter_code
         FROM vehicle_entries WHERE driver_phone LIKE ? OR driver_mobile LIKE ? ORDER BY id DESC LIMIT 1`,
        [`%${phone}%`, `%${phone}%`]
      );
      const [countRows] = await pool().execute<RowDataPacket[]>(
        `SELECT COUNT(*) as visit_count FROM vehicle_entries WHERE driver_phone LIKE ? OR driver_mobile LIKE ?`,
        [`%${phone}%`, `%${phone}%`]
      );
      res.json(rows.length ? { found: true, entry: rows[0], visitCount: countRows[0].visit_count } : { found: false });
    } else {
      res.json({ found: false });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Lookup failed' });
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
    res.status(500).json({ error: 'Failed to add vehicle' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DRIVERS & DOCKS
// ═══════════════════════════════════════════════════════════════

router.get('/drivers', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM drivers WHERE is_active = 1 ORDER BY name');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load drivers' });
  }
});

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
    if (vehicle_id) { await pool().execute(`UPDATE vehicles SET status = 'on_trip' WHERE id = ?`, [vehicle_id]); }
    res.json({ id: result.insertId, message: 'Gate out recorded' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record gate out' });
  }
});

router.post('/gate-log/:id/in', async (req: Request, res: Response) => {
  try {
    const { gate_in_km, remarks } = req.body;
    const [logs] = await pool().execute<RowDataPacket[]>('SELECT vehicle_id FROM gate_log WHERE id = ?', [req.params.id]);
    await pool().execute(
      `UPDATE gate_log SET gate_in_time = NOW(), gate_in_km = ?, gate_in_by = ?, remarks = ? WHERE id = ? AND gate_in_time IS NULL`,
      [gate_in_km || null, req.user?.username || 'security', remarks || null, req.params.id]
    );
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

router.post('/settings', async (req: Request, res: Response) => {
  try {
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await pool().execute(
        `INSERT INTO vehicle_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value = ?`,
        [key, value, value]
      );
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════

router.get('/reports', async (req: Request, res: Response) => {
  try {
    const { from, to, type } = req.query;
    const startDate = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const endDate = to || new Date().toISOString().slice(0, 10);

    let where = `DATE(ve.in_time) BETWEEN ? AND ?`;
    const params: any[] = [startDate, endDate];

    if (type === 'inside') { where += ` AND ve.status NOT IN ('out','cancelled')`; }
    else if (type === 'completed') { where += ` AND ve.status = 'out'`; }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT ve.*, d.dock_name FROM vehicle_entries ve LEFT JOIN docks d ON ve.dock_id = d.id WHERE ${where} ORDER BY ve.in_time DESC`, params
    );

    const [summary] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as totalEntries,
        SUM(CASE WHEN status = 'out' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status NOT IN ('out','cancelled') THEN 1 ELSE 0 END) as stillInside,
        ROUND(AVG(CASE WHEN out_time IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, in_time, out_time) END)) as avgDurationMins,
        SUM(COALESCE(net_weight,0)) as totalNetWeight,
        SUM(COALESCE(gross_weight,0)) as totalGrossWeight
       FROM vehicle_entries ve WHERE ${where}`, params
    );

    res.json({ entries: rows, summary: summary[0], from: startDate, to: endDate });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// Activity log
router.get('/log', async (req: Request, res: Response) => {
  try {
    const { entry_id, limit: lim } = req.query;
    const maxRows = Math.min(500, parseInt(lim as string) || 100);
    if (entry_id) {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT * FROM vehicle_log WHERE entry_id = ? ORDER BY performed_at DESC`, [entry_id]
      );
      res.json(rows);
    } else {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT * FROM vehicle_log ORDER BY performed_at DESC LIMIT ${Number(maxRows)}`
      );
      res.json(rows);
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load log' });
  }
});

export default router;