import { Router, Request, Response } from 'express';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
const pool = () => db.reception();

async function generateNo(prefix: string, table: string, col: string): Promise<string> {
  const year = new Date().getFullYear();
  const pat = `${prefix}${year}-%`;
  const [rows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} LIKE ?`, [pat]);
  return `${prefix}${year}-${String((rows[0]?.cnt || 0) + 1).padStart(4, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [visitors] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM visitors WHERE DATE(check_in)=?`, [today]);
    const [checkedIn] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM visitors WHERE status='checked_in'`);
    const [parcelsToday] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM parcels WHERE DATE(received_at)=?`, [today]);
    const [parcelsUncollected] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM parcels WHERE status IN ('received','notified')`);
    const [couriersToday] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM courier_log WHERE DATE(received_at)=? OR DATE(dispatched_at)=?`, [today, today]);
    const [couriersUncollected] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM courier_log WHERE status IN ('received','notified')`);
    const [keysIssued] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM key_register WHERE status='issued'`);
    const [bookingsToday] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM room_bookings WHERE booking_date=? AND status='booked'`, [today]);
    const [taxiToday] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM taxi_bookings WHERE pickup_date=? AND status NOT IN ('cancelled','completed')`, [today]);
    const [complaintsOpen] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM complaint_register WHERE status IN ('open','in_progress','escalated')`);
    const [amenitiesPending] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM amenity_requests WHERE status IN ('requested','approved')`);
    const [badgesAvail] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM badges WHERE is_available=1`);

    // Recent visitors
    const [recentVisitors] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visitors ORDER BY check_in DESC LIMIT 5`);
    // Today's bookings
    const [todayBookings] = await pool().execute<RowDataPacket[]>(
      `SELECT rb.*, mr.name as room_name, mr.location as room_location FROM room_bookings rb JOIN meeting_rooms mr ON mr.id=rb.room_id WHERE rb.booking_date=? ORDER BY rb.start_time`, [today]
    );
    // Pending parcels
    const [pendingParcels] = await pool().execute<RowDataPacket[]>(`SELECT * FROM parcels WHERE status IN ('received','notified') ORDER BY received_at DESC LIMIT 5`);
    // Open complaints
    const [openComplaints] = await pool().execute<RowDataPacket[]>(`SELECT * FROM complaint_register WHERE status IN ('open','in_progress','escalated') ORDER BY FIELD(priority,'urgent','high','medium','low'), created_at DESC LIMIT 5`);

    res.json({
      visitorsToday: visitors[0].c, checkedIn: checkedIn[0].c,
      parcelsToday: parcelsToday[0].c, parcelsUncollected: parcelsUncollected[0].c,
      couriersToday: couriersToday[0].c, couriersUncollected: couriersUncollected[0].c,
      keysIssued: keysIssued[0].c, bookingsToday: bookingsToday[0].c,
      taxiToday: taxiToday[0].c, complaintsOpen: complaintsOpen[0].c,
      amenitiesPending: amenitiesPending[0].c, badgesAvailable: badgesAvail[0].c,
      recentVisitors, todayBookings, pendingParcels, openComplaints,
    });
  } catch (err: any) {
    console.error('Reception stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// VISITORS
// ═══════════════════════════════════════════════════════════════
router.get('/visitors', async (req: Request, res: Response) => {
  try {
    const { search, status, visitor_type, from, to, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (visitor_name LIKE ? OR company LIKE ? OR phone LIKE ? OR host_name LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (visitor_type) { where += ' AND visitor_type=?'; p.push(visitor_type); }
    if (from) { where += ' AND DATE(check_in)>=?'; p.push(from); }
    if (to) { where += ' AND DATE(check_in)<=?'; p.push(to); }
    const pg = Math.max(1, parseInt(page as string));
    const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM visitors WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM visitors WHERE ${where} ORDER BY check_in DESC LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ visitors: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load visitors' }); }
});

router.post('/visitors', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO visitors (visitor_name,visitor_type,company,phone,email,id_type,id_number,purpose,host_name,host_department,badge_no,vehicle_no,items_carried,check_in,status,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?)`,
      [d.visitor_name, d.visitor_type||'visitor', d.company||null, d.phone||null, d.email||null,
       d.id_type||null, d.id_number||null, d.purpose, d.host_name, d.host_department,
       d.badge_no||null, d.vehicle_no||null, d.items_carried||null, 'checked_in', req.user?.sub||0]
    );
    if (d.badge_no) await pool().execute('UPDATE badges SET is_available=0 WHERE badge_no=?', [d.badge_no]);
    res.json({ id: result.insertId, message: 'Visitor checked in' });
  } catch (err: any) { console.error(err); res.status(500).json({ error: 'Failed to check in visitor' }); }
});

router.put('/visitors/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    if (d.action === 'checkout') {
      await pool().execute(`UPDATE visitors SET check_out=NOW(), status='checked_out' WHERE id=?`, [req.params.id]);
      const [v] = await pool().execute<RowDataPacket[]>('SELECT badge_no FROM visitors WHERE id=?', [req.params.id]);
      if (v[0]?.badge_no) await pool().execute('UPDATE badges SET is_available=1 WHERE badge_no=?', [v[0].badge_no]);
    } else {
      await pool().execute(
        `UPDATE visitors SET visitor_name=?,visitor_type=?,company=?,phone=?,email=?,id_type=?,id_number=?,purpose=?,host_name=?,host_department=?,badge_no=?,vehicle_no=?,items_carried=?,status=?,remarks=? WHERE id=?`,
        [d.visitor_name,d.visitor_type,d.company||null,d.phone||null,d.email||null,d.id_type||null,d.id_number||null,d.purpose,d.host_name,d.host_department,d.badge_no||null,d.vehicle_no||null,d.items_carried||null,d.status,d.remarks||null,req.params.id]
      );
    }
    res.json({ message: 'Visitor updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update visitor' }); }
});

// ═══════════════════════════════════════════════════════════════
// PARCELS
// ═══════════════════════════════════════════════════════════════
router.get('/parcels', async (req: Request, res: Response) => {
  try {
    const { search, status, parcel_type, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (tracking_no LIKE ? OR sender_name LIKE ? OR recipient_name LIKE ? OR sender_company LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (parcel_type) { where += ' AND parcel_type=?'; p.push(parcel_type); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM parcels WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM parcels WHERE ${where} ORDER BY received_at DESC LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ parcels: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load parcels' }); }
});

router.post('/parcels', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO parcels (tracking_no,sender_name,sender_company,recipient_name,recipient_dept,parcel_type,status,remarks,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [d.tracking_no||null,d.sender_name||null,d.sender_company||null,d.recipient_name,d.recipient_dept||null,d.parcel_type||'courier',d.status||'received',d.remarks||null,req.user?.sub||0]
    );
    res.json({ id: result.insertId, message: 'Parcel logged' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to log parcel' }); }
});

router.put('/parcels/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    if (d.action === 'collect') {
      await pool().execute(`UPDATE parcels SET status='collected', collected_at=NOW(), collected_by=? WHERE id=?`, [d.collected_by||'', req.params.id]);
    } else {
      await pool().execute(
        `UPDATE parcels SET tracking_no=?,sender_name=?,sender_company=?,recipient_name=?,recipient_dept=?,parcel_type=?,status=?,remarks=? WHERE id=?`,
        [d.tracking_no||null,d.sender_name||null,d.sender_company||null,d.recipient_name,d.recipient_dept||null,d.parcel_type,d.status,d.remarks||null,req.params.id]
      );
    }
    res.json({ message: 'Parcel updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update parcel' }); }
});

// ═══════════════════════════════════════════════════════════════
// COURIER LOG
// ═══════════════════════════════════════════════════════════════
router.get('/couriers', async (req: Request, res: Response) => {
  try {
    const { search, status, type, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (tracking_no LIKE ? OR sender_name LIKE ? OR recipient_name LIKE ? OR courier_company LIKE ? OR awb_no LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (type) { where += ' AND type=?'; p.push(type); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM courier_log WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM courier_log WHERE ${where} ORDER BY received_at DESC, dispatched_at DESC LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ couriers: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load couriers' }); }
});

router.post('/couriers', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO courier_log (tracking_no,courier_company,type,sender_name,sender_company,sender_phone,recipient_name,recipient_dept,description,weight,status,awb_no,remarks,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.tracking_no||null,d.courier_company||null,d.type||'inbound',d.sender_name||null,d.sender_company||null,d.sender_phone||null,
       d.recipient_name,d.recipient_dept||null,d.description||null,d.weight||null,d.status||'received',d.awb_no||null,d.remarks||null,req.user?.sub||0]
    );
    res.json({ id: result.insertId, message: 'Courier logged' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to log courier' }); }
});

router.put('/couriers/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    if (d.action === 'collect') {
      await pool().execute(`UPDATE courier_log SET status='collected', collected_at=NOW(), collected_by=? WHERE id=?`, [d.collected_by||'', req.params.id]);
    } else if (d.action === 'dispatch') {
      await pool().execute(`UPDATE courier_log SET status='dispatched', dispatched_at=NOW() WHERE id=?`, [req.params.id]);
    } else {
      await pool().execute(
        `UPDATE courier_log SET tracking_no=?,courier_company=?,type=?,sender_name=?,sender_company=?,sender_phone=?,recipient_name=?,recipient_dept=?,description=?,weight=?,status=?,awb_no=?,remarks=? WHERE id=?`,
        [d.tracking_no||null,d.courier_company||null,d.type,d.sender_name||null,d.sender_company||null,d.sender_phone||null,
         d.recipient_name,d.recipient_dept||null,d.description||null,d.weight||null,d.status,d.awb_no||null,d.remarks||null,req.params.id]
      );
    }
    res.json({ message: 'Courier updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update courier' }); }
});

// ═══════════════════════════════════════════════════════════════
// ROOM BOOKINGS & MEETING ROOMS
// ═══════════════════════════════════════════════════════════════
router.get('/rooms', async (_req: Request, res: Response) => {
  try {
    const [rooms] = await pool().execute<RowDataPacket[]>('SELECT * FROM meeting_rooms WHERE is_active=1 ORDER BY name');
    res.json(rooms);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load rooms' }); }
});

router.get('/bookings', async (req: Request, res: Response) => {
  try {
    const { date, room_id, status, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (date) { where += ' AND rb.booking_date=?'; p.push(date); }
    if (room_id) { where += ' AND rb.room_id=?'; p.push(room_id); }
    if (status) { where += ' AND rb.status=?'; p.push(status); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM room_bookings rb WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT rb.*, mr.name as room_name, mr.capacity, mr.location as room_location, mr.amenities
       FROM room_bookings rb JOIN meeting_rooms mr ON mr.id=rb.room_id WHERE ${where}
       ORDER BY rb.booking_date DESC, rb.start_time LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p
    );
    res.json({ bookings: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load bookings' }); }
});

router.post('/bookings', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    // Check for conflicts
    const [conflicts] = await pool().execute<RowDataPacket[]>(
      `SELECT id FROM room_bookings WHERE room_id=? AND booking_date=? AND status='booked' AND ((start_time<? AND end_time>?) OR (start_time<? AND end_time>?) OR (start_time>=? AND end_time<=?))`,
      [d.room_id, d.booking_date, d.end_time, d.start_time, d.end_time, d.start_time, d.start_time, d.end_time]
    );
    if (conflicts.length) { res.status(409).json({ error: 'Room already booked for this time slot' }); return; }
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO room_bookings (room_id,booked_by,department,purpose,booking_date,start_time,end_time,status,remarks,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [d.room_id,d.booked_by,d.department||null,d.purpose||null,d.booking_date,d.start_time,d.end_time,'booked',d.remarks||null,req.user?.sub||0]
    );
    res.json({ id: result.insertId, message: 'Room booked' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to book room' }); }
});

router.put('/bookings/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE room_bookings SET room_id=?,booked_by=?,department=?,purpose=?,booking_date=?,start_time=?,end_time=?,status=?,remarks=? WHERE id=?`,
      [d.room_id,d.booked_by,d.department||null,d.purpose||null,d.booking_date,d.start_time,d.end_time,d.status||'booked',d.remarks||null,req.params.id]
    );
    res.json({ message: 'Booking updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update booking' }); }
});

// ═══════════════════════════════════════════════════════════════
// KEY REGISTER
// ═══════════════════════════════════════════════════════════════
router.get('/keys', async (req: Request, res: Response) => {
  try {
    const { search, status, key_type, page = '1', limit = '50' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (key_tag LIKE ? OR key_label LIKE ? OR issued_to LIKE ? OR location LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (key_type) { where += ' AND key_type=?'; p.push(key_type); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM key_register WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM key_register WHERE ${where} ORDER BY FIELD(status,'issued','available','lost','damaged'), key_tag LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ keys: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load keys' }); }
});

router.post('/keys', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO key_register (key_tag,key_label,key_type,location,status,remarks) VALUES (?,?,?,?,?,?)`,
      [d.key_tag,d.key_label,d.key_type||'other',d.location||null,'available',d.remarks||null]
    );
    res.json({ id: result.insertId, message: 'Key registered' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to register key' }); }
});

router.put('/keys/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    if (d.action === 'issue') {
      await pool().execute(`UPDATE key_register SET issued_to=?,issued_by=?,issued_at=NOW(),status='issued',remarks=? WHERE id=?`, [d.issued_to,d.issued_by||'Reception',d.remarks||null,req.params.id]);
    } else if (d.action === 'return') {
      await pool().execute(`UPDATE key_register SET returned_at=NOW(),returned_to=?,status='available',remarks=? WHERE id=?`, [d.returned_to||'Reception',d.remarks||null,req.params.id]);
    } else {
      await pool().execute(`UPDATE key_register SET key_tag=?,key_label=?,key_type=?,location=?,status=?,remarks=? WHERE id=?`,
        [d.key_tag,d.key_label,d.key_type,d.location||null,d.status,d.remarks||null,req.params.id]);
    }
    res.json({ message: 'Key updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update key' }); }
});

// ═══════════════════════════════════════════════════════════════
// PHONE DIRECTORY
// ═══════════════════════════════════════════════════════════════
router.get('/directory', async (req: Request, res: Response) => {
  try {
    const { search, department } = req.query;
    let where = 'is_active=1'; const p: any[] = [];
    if (search) { where += ' AND (name LIKE ? OR designation LIKE ? OR department LIKE ? OR ext_no LIKE ? OR phone LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (department) { where += ' AND department=?'; p.push(department); }
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM phone_directory WHERE ${where} ORDER BY department, name`, p);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load directory' }); }
});

router.post('/directory', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO phone_directory (name,designation,department,ext_no,phone,email,is_active) VALUES (?,?,?,?,?,?,1)`,
      [d.name,d.designation||null,d.department||null,d.ext_no||null,d.phone||null,d.email||null]
    );
    res.json({ id: result.insertId, message: 'Contact added' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to add contact' }); }
});

router.put('/directory/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(`UPDATE phone_directory SET name=?,designation=?,department=?,ext_no=?,phone=?,email=?,is_active=? WHERE id=?`,
      [d.name,d.designation||null,d.department||null,d.ext_no||null,d.phone||null,d.email||null,d.is_active??1,req.params.id]);
    res.json({ message: 'Contact updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update contact' }); }
});

// ═══════════════════════════════════════════════════════════════
// TAXI BOOKINGS
// ═══════════════════════════════════════════════════════════════
router.get('/taxi', async (req: Request, res: Response) => {
  try {
    const { search, status, from, to, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (booking_no LIKE ? OR requested_by LIKE ? OR passenger_name LIKE ? OR drop_location LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (from) { where += ' AND pickup_date>=?'; p.push(from); }
    if (to) { where += ' AND pickup_date<=?'; p.push(to); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM taxi_bookings WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM taxi_bookings WHERE ${where} ORDER BY pickup_date DESC, pickup_time DESC LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ bookings: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load taxi bookings' }); }
});

router.post('/taxi', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const bookNo = await generateNo('TX', 'taxi_bookings', 'booking_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO taxi_bookings (booking_no,requested_by,department,passenger_name,passenger_phone,pickup_location,drop_location,pickup_date,pickup_time,return_trip,return_date,return_time,num_passengers,taxi_company,driver_name,driver_phone,vehicle_no,fare_estimate,purpose,status,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [bookNo,d.requested_by,d.department||null,d.passenger_name||null,d.passenger_phone||null,d.pickup_location,d.drop_location,d.pickup_date,d.pickup_time,d.return_trip||0,d.return_date||null,d.return_time||null,d.num_passengers||1,d.taxi_company||null,d.driver_name||null,d.driver_phone||null,d.vehicle_no||null,d.fare_estimate||null,d.purpose||null,d.status||'requested',req.user?.sub||0]
    );
    res.json({ id: result.insertId, booking_no: bookNo, message: 'Taxi booked' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to book taxi' }); }
});

router.put('/taxi/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    await pool().execute(
      `UPDATE taxi_bookings SET requested_by=?,department=?,passenger_name=?,passenger_phone=?,pickup_location=?,drop_location=?,pickup_date=?,pickup_time=?,return_trip=?,return_date=?,return_time=?,num_passengers=?,taxi_company=?,driver_name=?,driver_phone=?,vehicle_no=?,fare_estimate=?,actual_fare=?,purpose=?,status=?,remarks=? WHERE id=?`,
      [d.requested_by,d.department||null,d.passenger_name||null,d.passenger_phone||null,d.pickup_location,d.drop_location,d.pickup_date,d.pickup_time,d.return_trip||0,d.return_date||null,d.return_time||null,d.num_passengers||1,d.taxi_company||null,d.driver_name||null,d.driver_phone||null,d.vehicle_no||null,d.fare_estimate||null,d.actual_fare||null,d.purpose||null,d.status,d.remarks||null,req.params.id]
    );
    res.json({ message: 'Taxi booking updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update taxi' }); }
});

// ═══════════════════════════════════════════════════════════════
// COMPLAINTS
// ═══════════════════════════════════════════════════════════════
router.get('/complaints', async (req: Request, res: Response) => {
  try {
    const { search, status, category, priority, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (complaint_no LIKE ? OR complainant_name LIKE ? OR description LIKE ? OR location LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (category) { where += ' AND category=?'; p.push(category); }
    if (priority) { where += ' AND priority=?'; p.push(priority); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM complaint_register WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM complaint_register WHERE ${where} ORDER BY FIELD(priority,'urgent','high','medium','low'), created_at DESC LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ complaints: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load complaints' }); }
});

router.post('/complaints', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const no = await generateNo('CR', 'complaint_register', 'complaint_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO complaint_register (complaint_no,complainant_name,department,category,priority,location,description,assigned_to,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [no,d.complainant_name,d.department||null,d.category||'other',d.priority||'medium',d.location||null,d.description,d.assigned_to||null,'open',req.user?.sub||0]
    );
    res.json({ id: result.insertId, complaint_no: no, message: 'Complaint registered' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to register complaint' }); }
});

router.put('/complaints/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    let extra = '';
    if (d.status === 'resolved' || d.status === 'closed') extra = ', resolved_at=NOW()';
    await pool().execute(
      `UPDATE complaint_register SET complainant_name=?,department=?,category=?,priority=?,location=?,description=?,assigned_to=?,resolution=?,status=?${extra} WHERE id=?`,
      [d.complainant_name,d.department||null,d.category,d.priority,d.location||null,d.description,d.assigned_to||null,d.resolution||null,d.status,req.params.id]
    );
    res.json({ message: 'Complaint updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update complaint' }); }
});

// ═══════════════════════════════════════════════════════════════
// AMENITY REQUESTS
// ═══════════════════════════════════════════════════════════════
router.get('/amenities', async (req: Request, res: Response) => {
  try {
    const { search, status, amenity_type, page = '1', limit = '20' } = req.query;
    let where = '1=1'; const p: any[] = [];
    if (search) { where += ' AND (request_no LIKE ? OR requested_by LIKE ? OR location LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    if (status) { where += ' AND status=?'; p.push(status); }
    if (amenity_type) { where += ' AND amenity_type=?'; p.push(amenity_type); }
    const pg = Math.max(1, parseInt(page as string)); const lm = Math.min(100, parseInt(limit as string));
    const [cnt] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM amenity_requests WHERE ${where}`, p);
    const [rows] = await pool().execute<RowDataPacket[]>(`SELECT * FROM amenity_requests WHERE ${where} ORDER BY created_at DESC LIMIT ${lm} OFFSET ${(pg-1)*lm}`, p);
    res.json({ requests: rows, total: cnt[0].total, page: pg });
  } catch (err: any) { res.status(500).json({ error: 'Failed to load amenities' }); }
});

router.post('/amenities', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const no = await generateNo('AR', 'amenity_requests', 'request_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO amenity_requests (request_no,requested_by,department,amenity_type,location,quantity,needed_by,status,remarks,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [no,d.requested_by,d.department||null,d.amenity_type||'other',d.location||null,d.quantity||1,d.needed_by||null,'requested',d.remarks||null,req.user?.sub||0]
    );
    res.json({ id: result.insertId, request_no: no, message: 'Request submitted' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to submit request' }); }
});

router.put('/amenities/:id', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    let extra = '';
    if (d.status === 'fulfilled') extra = ', fulfilled_at=NOW()';
    await pool().execute(
      `UPDATE amenity_requests SET requested_by=?,department=?,amenity_type=?,location=?,quantity=?,needed_by=?,status=?,fulfilled_by=?,remarks=?${extra} WHERE id=?`,
      [d.requested_by,d.department||null,d.amenity_type,d.location||null,d.quantity||1,d.needed_by||null,d.status,d.fulfilled_by||null,d.remarks||null,req.params.id]
    );
    res.json({ message: 'Request updated' });
  } catch (err: any) { res.status(500).json({ error: 'Failed to update request' }); }
});

// ═══════════════════════════════════════════════════════════════
// BADGES
// ═══════════════════════════════════════════════════════════════
router.get('/badges', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM badges ORDER BY badge_type, badge_no');
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: 'Failed to load badges' }); }
});

export default router;
