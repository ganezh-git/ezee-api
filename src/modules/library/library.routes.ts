import { Router, Request, Response } from 'express';
import { db } from '../../config/database';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const router = Router();
const pool = () => db.library();

// ─── Helpers ────────────────────────────────────────────────
async function generateNo(prefix: string, table: string, col: string): Promise<string> {
  const year = new Date().getFullYear();
  const pat = `${prefix}${year}-%`;
  const [rows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} LIKE ?`, [pat]);
  return `${prefix}${year}-${String((rows[0]?.cnt || 0) + 1).padStart(5, '0')}`;
}

async function getSetting(key: string, fallback: string = '0'): Promise<string> {
  const [rows] = await pool().execute<RowDataPacket[]>('SELECT setting_value FROM lib_settings WHERE setting_key = ?', [key]);
  return rows[0]?.setting_value ?? fallback;
}

function logActivity(entityType: string, entityId: number, action: string, details: string, by: string) {
  pool().execute('INSERT INTO lib_activity_log (entity_type, entity_id, action, details, performed_by) VALUES (?,?,?,?,?)',
    [entityType, entityId, action, details, by]).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [totalBooks] = await pool().execute<RowDataPacket[]>('SELECT COUNT(*) as c, SUM(quantity) as qty, SUM(available_qty) as avail FROM books WHERE is_active = 1');
    const [totalMembers] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM members WHERE status = 'active'`);
    const [activeIssues] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM book_issues WHERE status = 'issued'`);
    const [overdueCount] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM book_issues WHERE status = 'issued' AND due_date < CURDATE()`);
    const [todayIssued] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM book_issues WHERE DATE(issue_date) = CURDATE()`);
    const [todayReturned] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM book_issues WHERE DATE(return_date) = CURDATE()`);
    const [pendingFines] = await pool().execute<RowDataPacket[]>(`SELECT COALESCE(SUM(amount - paid_amount - waived_amount), 0) as total FROM fines WHERE status IN ('pending','partial')`);
    const [activeReservations] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM book_reservations WHERE status = 'active'`);
    const [digitalDocs] = await pool().execute<RowDataPacket[]>('SELECT COUNT(*) as c FROM digital_docs WHERE is_active = 1');

    const [categoryBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT c.name as category, COUNT(b.id) as count FROM books b LEFT JOIN lib_categories c ON b.category_id = c.id WHERE b.is_active = 1 GROUP BY c.name ORDER BY count DESC LIMIT 10`
    );
    const [recentIssues] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, b.title, b.isbn, b.authors, m.name as member_name, m.member_no FROM book_issues bi JOIN books b ON bi.book_id = b.id JOIN members m ON bi.member_id = m.id ORDER BY bi.issue_date DESC LIMIT 10`
    );
    const [popularBooks] = await pool().execute<RowDataPacket[]>(
      `SELECT b.id, b.title, b.authors, b.cover_url, COUNT(bi.id) as issue_count FROM books b JOIN book_issues bi ON b.id = bi.book_id GROUP BY b.id ORDER BY issue_count DESC LIMIT 5`
    );
    const [dailyActivity] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(issue_date, '%Y-%m-%d') as date, COUNT(*) as issues FROM book_issues WHERE issue_date >= DATE_SUB(CURDATE(), INTERVAL 15 DAY) GROUP BY DATE_FORMAT(issue_date, '%Y-%m-%d') ORDER BY date`
    );

    res.json({
      totalTitles: totalBooks[0].c,
      totalCopies: totalBooks[0].qty || 0,
      availableCopies: totalBooks[0].avail || 0,
      totalMembers: totalMembers[0].c,
      activeIssues: activeIssues[0].c,
      overdueBooks: overdueCount[0].c,
      todayIssued: todayIssued[0].c,
      todayReturned: todayReturned[0].c,
      pendingFines: pendingFines[0].total,
      activeReservations: activeReservations[0].c,
      digitalDocs: digitalDocs[0].c,
      categoryBreakdown,
      recentIssues,
      popularBooks,
      dailyActivity,
    });
  } catch (err: any) {
    console.error('Library stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BOOKS / CATALOG
// ═══════════════════════════════════════════════════════════════

router.get('/books', async (req: Request, res: Response) => {
  try {
    const { search, category_id, material_type, available, page = '1', limit = '20' } = req.query;
    let where = 'b.is_active = 1';
    const params: any[] = [];

    if (search) { where += ` AND MATCH(b.title, b.subtitle, b.authors, b.subject, b.tags, b.description) AGAINST(? IN BOOLEAN MODE)`; params.push(`${search}*`); }
    if (category_id) { where += ' AND b.category_id = ?'; params.push(category_id); }
    if (material_type) { where += ' AND b.material_type = ?'; params.push(material_type); }
    if (available === 'true') { where += ' AND b.available_qty > 0'; }

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM books b WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT b.*, c.name as category_name, l.name as location_name FROM books b LEFT JOIN lib_categories c ON b.category_id = c.id LEFT JOIN lib_locations l ON b.location_id = l.id WHERE ${where} ORDER BY b.created_at DESC LIMIT ${Number(limitNum)} OFFSET ${Number(offset)}`, params
    );

    res.json({ books: rows, total: countRows[0].total, page: pageNum, limit: limitNum });
  } catch (err: any) {
    console.error('List books error:', err);
    res.status(500).json({ error: 'Failed to load books' });
  }
});

router.get('/books/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT b.*, c.name as category_name, l.name as location_name FROM books b LEFT JOIN lib_categories c ON b.category_id = c.id LEFT JOIN lib_locations l ON b.location_id = l.id WHERE b.id = ?`, [req.params.id]
    );
    if (!rows.length) { res.status(404).json({ error: 'Book not found' }); return; }

    // Get issue history
    const [issues] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, m.name as member_name, m.member_no FROM book_issues bi JOIN members m ON bi.member_id = m.id WHERE bi.book_id = ? ORDER BY bi.issue_date DESC LIMIT 20`, [req.params.id]
    );
    res.json({ ...rows[0], issues });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load book' });
  }
});

router.post('/books', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    const accession = b.accession_no || await generateNo('ACC', 'books', 'accession_no');
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO books (isbn, title, subtitle, authors, publisher, publish_date, edition, language, pages, description, cover_url,
        category_id, location_id, material_type, subject, call_number, accession_no, barcode, quantity, available_qty,
        price, vendor, purchase_date, condition_status, is_reference_only, is_digital, digital_url, file_path, tags, open_library_key, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.isbn||null, b.title, b.subtitle||null, b.authors||null, b.publisher||null, b.publish_date||null,
        b.edition||null, b.language||'English', b.pages||null, b.description||null, b.cover_url||null,
        b.category_id||null, b.location_id||null, b.material_type||'book', b.subject||null,
        b.call_number||null, accession, b.barcode||null, b.quantity||1, b.quantity||1,
        b.price||null, b.vendor||null, b.purchase_date||null, b.condition_status||'new',
        b.is_reference_only||0, b.is_digital||0, b.digital_url||null, b.file_path||null,
        b.tags||null, b.open_library_key||null, b.notes||null, req.user?.sub||0]
    );
    logActivity('book', result.insertId, 'added', `Book "${b.title}" added (${accession})`, req.user?.username || 'admin');
    res.json({ id: result.insertId, accession_no: accession, message: 'Book added' });
  } catch (err: any) {
    console.error('Add book error:', err);
    res.status(500).json({ error: 'Failed to add book' });
  }
});

router.put('/books/:id', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    await pool().execute(
      `UPDATE books SET isbn=?, title=?, subtitle=?, authors=?, publisher=?, publish_date=?, edition=?, language=?, pages=?,
        description=?, cover_url=?, category_id=?, location_id=?, material_type=?, subject=?, call_number=?, barcode=?,
        quantity=?, price=?, vendor=?, condition_status=?, is_reference_only=?, is_digital=?, digital_url=?, file_path=?, tags=?, notes=?
       WHERE id = ?`,
      [b.isbn||null, b.title, b.subtitle||null, b.authors||null, b.publisher||null, b.publish_date||null,
        b.edition||null, b.language||'English', b.pages||null, b.description||null, b.cover_url||null,
        b.category_id||null, b.location_id||null, b.material_type||'book', b.subject||null,
        b.call_number||null, b.barcode||null, b.quantity||1, b.price||null, b.vendor||null,
        b.condition_status||'good', b.is_reference_only||0, b.is_digital||0, b.digital_url||null,
        b.file_path||null, b.tags||null, b.notes||null, req.params.id]
    );
    logActivity('book', parseInt(req.params.id), 'updated', `Book "${b.title}" updated`, req.user?.username || 'admin');
    res.json({ message: 'Book updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update book' });
  }
});

// ISBN lookup via Open Library
router.get('/isbn-lookup/:isbn', async (req: Request, res: Response) => {
  try {
    const isbn = req.params.isbn.replace(/[-\s]/g, '');
    const response = await fetch(`https://openlibrary.org/isbn/${isbn}.json`, {
      headers: { 'User-Agent': 'EZEELibrary (contact@ezeetech.in)' }
    });
    if (!response.ok) { res.json({ found: false }); return; }
    const data: any = await response.json();

    // Get author names
    let authors = '';
    if (data.authors?.length) {
      const authorKeys = data.authors.map((a: any) => a.key);
      const authorNames: string[] = [];
      for (const key of authorKeys.slice(0, 3)) {
        try {
          const aRes = await fetch(`https://openlibrary.org${key}.json`, {
            headers: { 'User-Agent': 'EZEELibrary (contact@ezeetech.in)' }
          });
          if (aRes.ok) { const aData: any = await aRes.json(); authorNames.push(aData.name || ''); }
        } catch {}
      }
      authors = authorNames.filter(Boolean).join(', ');
    }

    const coverId = data.covers?.[0];
    res.json({
      found: true,
      title: data.title || '',
      subtitle: data.subtitle || '',
      authors,
      publisher: Array.isArray(data.publishers) ? data.publishers[0] : '',
      publish_date: data.publish_date || '',
      pages: data.number_of_pages || null,
      description: typeof data.description === 'string' ? data.description : data.description?.value || '',
      cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : '',
      open_library_key: data.key || '',
      subject: Array.isArray(data.subjects) ? data.subjects.slice(0, 5).join(', ') : '',
    });
  } catch (err: any) {
    res.json({ found: false });
  }
});

// ═══════════════════════════════════════════════════════════════
// MEMBERS
// ═══════════════════════════════════════════════════════════════

router.get('/members', async (req: Request, res: Response) => {
  try {
    const { search, member_type, status, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];

    if (search) { where += ' AND (name LIKE ? OR member_no LIKE ? OR email LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (member_type) { where += ' AND member_type = ?'; params.push(member_type); }
    if (status) { where += ' AND status = ?'; params.push(status); }

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM members WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM members WHERE ${where} ORDER BY created_at DESC LIMIT ${Number(limitNum)} OFFSET ${Number(offset)}`, params
    );

    res.json({ members: rows, total: countRows[0].total, page: pageNum, limit: limitNum });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load members' });
  }
});

router.get('/members/:id', async (req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM members WHERE id = ?', [req.params.id]);
    if (!rows.length) { res.status(404).json({ error: 'Member not found' }); return; }

    const [issues] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, b.title, b.isbn, b.authors FROM book_issues bi JOIN books b ON bi.book_id = b.id WHERE bi.member_id = ? ORDER BY bi.issue_date DESC LIMIT 30`, [req.params.id]
    );
    const [fines] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM fines WHERE member_id = ? ORDER BY created_at DESC`, [req.params.id]
    );
    res.json({ ...rows[0], issues, fines });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load member' });
  }
});

router.post('/members', async (req: Request, res: Response) => {
  try {
    const m = req.body;
    const memberNo = m.member_no || await generateNo('LM', 'members', 'member_no');
    const maxBooks = m.max_books || parseInt(await getSetting('default_max_books', '3'));
    const maxDays = m.max_days || parseInt(await getSetting('default_loan_days', '14'));
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO members (member_no, name, email, phone, photo_url, member_type, department, designation, institution,
        class_section, roll_no, address, id_proof_type, id_proof_no, membership_date, expiry_date, max_books, max_days, status, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [memberNo, m.name, m.email||null, m.phone||null, m.photo_url||null, m.member_type||'student',
        m.department||null, m.designation||null, m.institution||null, m.class_section||null, m.roll_no||null,
        m.address||null, m.id_proof_type||null, m.id_proof_no||null,
        m.membership_date || new Date().toISOString().slice(0, 10), m.expiry_date||null,
        maxBooks, maxDays, 'active', m.notes||null, req.user?.sub||0]
    );
    logActivity('member', result.insertId, 'registered', `Member "${m.name}" registered (${memberNo})`, req.user?.username || 'admin');
    res.json({ id: result.insertId, member_no: memberNo, message: 'Member registered' });
  } catch (err: any) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

router.put('/members/:id', async (req: Request, res: Response) => {
  try {
    const m = req.body;
    await pool().execute(
      `UPDATE members SET name=?, email=?, phone=?, member_type=?, department=?, designation=?, institution=?,
        class_section=?, roll_no=?, address=?, id_proof_type=?, id_proof_no=?, expiry_date=?, max_books=?, max_days=?, status=?, notes=? WHERE id = ?`,
      [m.name, m.email||null, m.phone||null, m.member_type||'student', m.department||null, m.designation||null,
        m.institution||null, m.class_section||null, m.roll_no||null, m.address||null,
        m.id_proof_type||null, m.id_proof_no||null, m.expiry_date||null,
        m.max_books||3, m.max_days||14, m.status||'active', m.notes||null, req.params.id]
    );
    res.json({ message: 'Member updated' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ISSUE / RETURN (Circulation)
// ═══════════════════════════════════════════════════════════════

router.get('/issues', async (req: Request, res: Response) => {
  try {
    const { status, member_id, overdue, page = '1', limit = '20' } = req.query;
    let where = '1=1';
    const params: any[] = [];

    if (status) { where += ' AND bi.status = ?'; params.push(status); }
    if (member_id) { where += ' AND bi.member_id = ?'; params.push(member_id); }
    if (overdue === 'true') { where += ` AND bi.status = 'issued' AND bi.due_date < CURDATE()`; }

    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(100, parseInt(limit as string));
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as total FROM book_issues bi WHERE ${where}`, params);
    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, b.title, b.isbn, b.authors, b.cover_url, b.accession_no, m.name as member_name, m.member_no, m.member_type
       FROM book_issues bi JOIN books b ON bi.book_id = b.id JOIN members m ON bi.member_id = m.id
       WHERE ${where} ORDER BY bi.issue_date DESC LIMIT ${Number(limitNum)} OFFSET ${Number(offset)}`, params
    );

    res.json({ issues: rows, total: countRows[0].total, page: pageNum, limit: limitNum });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load issues' });
  }
});

// Issue a book
router.post('/issues', async (req: Request, res: Response) => {
  try {
    const { book_id, member_id, due_days } = req.body;
    // Validate book availability
    const [book] = await pool().execute<RowDataPacket[]>('SELECT id, title, available_qty, is_reference_only FROM books WHERE id = ?', [book_id]);
    if (!book.length) { res.status(404).json({ error: 'Book not found' }); return; }
    if (book[0].is_reference_only) { res.status(400).json({ error: 'Reference book — cannot be issued' }); return; }
    if (book[0].available_qty <= 0) { res.status(400).json({ error: 'No copies available' }); return; }

    // Validate member
    const [member] = await pool().execute<RowDataPacket[]>('SELECT id, name, status, max_books, max_days FROM members WHERE id = ?', [member_id]);
    if (!member.length) { res.status(404).json({ error: 'Member not found' }); return; }
    if (member[0].status !== 'active') { res.status(400).json({ error: `Member is ${member[0].status}` }); return; }

    // Check borrowing limit
    const [activeCount] = await pool().execute<RowDataPacket[]>(`SELECT COUNT(*) as c FROM book_issues WHERE member_id = ? AND status = 'issued'`, [member_id]);
    if (activeCount[0].c >= member[0].max_books) { res.status(400).json({ error: `Borrowing limit reached (${member[0].max_books} books)` }); return; }

    // Check pending fines
    const [pendingFine] = await pool().execute<RowDataPacket[]>(`SELECT COALESCE(SUM(amount - paid_amount - waived_amount), 0) as total FROM fines WHERE member_id = ? AND status IN ('pending','partial')`, [member_id]);
    if (pendingFine[0].total > 0) { res.status(400).json({ error: `Member has pending fine of ₹${pendingFine[0].total}` }); return; }

    const issueNo = await generateNo('ISS', 'book_issues', 'issue_no');
    const loanDays = due_days || member[0].max_days || parseInt(await getSetting('default_loan_days', '14'));

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO book_issues (issue_no, book_id, member_id, issue_date, due_date, status, issued_by) VALUES (?,?,?,NOW(),DATE_ADD(CURDATE(), INTERVAL ? DAY),?,?)`,
      [issueNo, book_id, member_id, loanDays, 'issued', req.user?.username || 'librarian']
    );

    // Decrease available qty
    await pool().execute('UPDATE books SET available_qty = available_qty - 1 WHERE id = ? AND available_qty > 0', [book_id]);

    // Fulfill any reservation
    await pool().execute(`UPDATE book_reservations SET status = 'fulfilled' WHERE book_id = ? AND member_id = ? AND status = 'active'`, [book_id, member_id]);

    logActivity('issue', result.insertId, 'issued', `"${book[0].title}" issued to ${member[0].name} (${issueNo})`, req.user?.username || 'librarian');
    res.json({ id: result.insertId, issue_no: issueNo, due_date: new Date(Date.now() + loanDays * 86400000).toISOString().slice(0, 10), message: 'Book issued' });
  } catch (err: any) {
    console.error('Issue book error:', err);
    res.status(500).json({ error: 'Failed to issue book' });
  }
});

// Return a book
router.post('/issues/:id/return', async (req: Request, res: Response) => {
  try {
    const { condition_at_return, remarks } = req.body;
    const [issue] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, b.title FROM book_issues bi JOIN books b ON bi.book_id = b.id WHERE bi.id = ? AND bi.status = 'issued'`, [req.params.id]
    );
    if (!issue.length) { res.status(400).json({ error: 'Issue not found or already returned' }); return; }

    const i = issue[0];
    const today = new Date();
    const dueDate = new Date(i.due_date);
    let fineAmount = 0;

    // Calculate late fine
    if (today > dueDate) {
      const daysLate = Math.ceil((today.getTime() - dueDate.getTime()) / 86400000);
      const finePerDay = parseFloat(await getSetting('fine_per_day', '2'));
      fineAmount = daysLate * finePerDay;
    }

    // Condition fine
    if (condition_at_return === 'damaged') {
      fineAmount += parseFloat(await getSetting('damaged_book_fine', '50'));
    }

    await pool().execute(
      `UPDATE book_issues SET return_date = NOW(), status = 'returned', condition_at_return = ?, fine_amount = ?, returned_to = ?, remarks = ? WHERE id = ?`,
      [condition_at_return || 'good', fineAmount, req.user?.username || 'librarian', remarks || null, req.params.id]
    );

    // Increase available qty
    await pool().execute('UPDATE books SET available_qty = available_qty + 1 WHERE id = ?', [i.book_id]);

    // Create fine record if needed
    if (fineAmount > 0) {
      await pool().execute(
        `INSERT INTO fines (member_id, issue_id, fine_type, amount, description, created_by) VALUES (?,?,?,?,?,?)`,
        [i.member_id, req.params.id, condition_at_return === 'damaged' ? 'damaged_book' : 'late_return',
          fineAmount, `Fine for "${i.title}" — ${fineAmount > 0 ? 'Late/Damage' : ''}`, req.user?.username || 'librarian']
      );
    }

    logActivity('issue', parseInt(req.params.id), 'returned', `"${i.title}" returned. Fine: ₹${fineAmount}`, req.user?.username || 'librarian');
    res.json({ message: 'Book returned', fine_amount: fineAmount });
  } catch (err: any) {
    console.error('Return error:', err);
    res.status(500).json({ error: 'Failed to return book' });
  }
});

// Renew a book
router.post('/issues/:id/renew', async (req: Request, res: Response) => {
  try {
    const maxRenewals = parseInt(await getSetting('max_renewals', '2'));
    const [issue] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, m.max_days FROM book_issues bi JOIN members m ON bi.member_id = m.id WHERE bi.id = ? AND bi.status = 'issued'`, [req.params.id]
    );
    if (!issue.length) { res.status(400).json({ error: 'Issue not found' }); return; }
    if (issue[0].renewed_count >= maxRenewals) { res.status(400).json({ error: `Max renewals (${maxRenewals}) reached` }); return; }

    // Check if someone reserved this book
    const [reservations] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM book_reservations WHERE book_id = ? AND status = 'active'`, [issue[0].book_id]
    );
    if (reservations[0].c > 0) { res.status(400).json({ error: 'Book has active reservations — cannot renew' }); return; }

    const loanDays = issue[0].max_days || parseInt(await getSetting('default_loan_days', '14'));
    await pool().execute(
      `UPDATE book_issues SET due_date = DATE_ADD(CURDATE(), INTERVAL ? DAY), renewed_count = renewed_count + 1 WHERE id = ?`,
      [loanDays, req.params.id]
    );

    logActivity('issue', parseInt(req.params.id), 'renewed', `Renewed (#${issue[0].renewed_count + 1})`, req.user?.username || 'librarian');
    res.json({ message: 'Book renewed', new_due_date: new Date(Date.now() + loanDays * 86400000).toISOString().slice(0, 10) });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to renew' });
  }
});

// Mark as lost
router.post('/issues/:id/lost', async (req: Request, res: Response) => {
  try {
    const [issue] = await pool().execute<RowDataPacket[]>(
      `SELECT bi.*, b.title, b.price FROM book_issues bi JOIN books b ON bi.book_id = b.id WHERE bi.id = ?`, [req.params.id]
    );
    if (!issue.length) { res.status(404).json({ error: 'Issue not found' }); return; }

    const multiplier = parseFloat(await getSetting('lost_book_multiplier', '3'));
    const fineAmount = (issue[0].price || 500) * multiplier;

    await pool().execute(`UPDATE book_issues SET status = 'lost', fine_amount = ? WHERE id = ?`, [fineAmount, req.params.id]);
    await pool().execute('UPDATE books SET available_qty = GREATEST(available_qty - 1, 0), quantity = quantity - 1 WHERE id = ?', [issue[0].book_id]);

    await pool().execute(
      `INSERT INTO fines (member_id, issue_id, fine_type, amount, description, created_by) VALUES (?,?,?,?,?,?)`,
      [issue[0].member_id, req.params.id, 'lost_book', fineAmount, `Lost: "${issue[0].title}" — ₹${fineAmount}`, req.user?.username || 'librarian']
    );

    logActivity('issue', parseInt(req.params.id), 'lost', `"${issue[0].title}" marked lost. Fine: ₹${fineAmount}`, req.user?.username || 'librarian');
    res.json({ message: 'Marked as lost', fine_amount: fineAmount });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to mark lost' });
  }
});

// ═══════════════════════════════════════════════════════════════
// RESERVATIONS
// ═══════════════════════════════════════════════════════════════

router.get('/reservations', async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (status) { where += ' AND br.status = ?'; params.push(status); }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT br.*, b.title, b.isbn, b.authors, b.available_qty, m.name as member_name, m.member_no
       FROM book_reservations br JOIN books b ON br.book_id = b.id JOIN members m ON br.member_id = m.id
       WHERE ${where} ORDER BY br.reserved_date DESC LIMIT 100`, params
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load reservations' });
  }
});

router.post('/reservations', async (req: Request, res: Response) => {
  try {
    const { book_id, member_id } = req.body;
    const expiryDays = parseInt(await getSetting('reservation_expiry_days', '3'));

    // Check if already reserved
    const [existing] = await pool().execute<RowDataPacket[]>(
      `SELECT id FROM book_reservations WHERE book_id = ? AND member_id = ? AND status = 'active'`, [book_id, member_id]
    );
    if (existing.length) { res.status(400).json({ error: 'Already reserved' }); return; }

    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO book_reservations (book_id, member_id, expiry_date, status) VALUES (?,?,DATE_ADD(NOW(), INTERVAL ? DAY),'active')`,
      [book_id, member_id, expiryDays]
    );

    logActivity('reservation', result.insertId, 'reserved', `Book reserved`, req.user?.username || 'librarian');
    res.json({ id: result.insertId, message: 'Book reserved' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reserve' });
  }
});

router.post('/reservations/:id/cancel', async (_req: Request, res: Response) => {
  try {
    await pool().execute(`UPDATE book_reservations SET status = 'cancelled' WHERE id = ?`, [_req.params.id]);
    res.json({ message: 'Reservation cancelled' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to cancel' });
  }
});

// ═══════════════════════════════════════════════════════════════
// FINES
// ═══════════════════════════════════════════════════════════════

router.get('/fines', async (req: Request, res: Response) => {
  try {
    const { status, member_id } = req.query;
    let where = '1=1';
    const params: any[] = [];
    if (status) { where += ' AND f.status = ?'; params.push(status); }
    if (member_id) { where += ' AND f.member_id = ?'; params.push(member_id); }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT f.*, m.name as member_name, m.member_no, bi.issue_no, b.title as book_title
       FROM fines f JOIN members m ON f.member_id = m.id
       LEFT JOIN book_issues bi ON f.issue_id = bi.id LEFT JOIN books b ON bi.book_id = b.id
       WHERE ${where} ORDER BY f.created_at DESC LIMIT 200`, params
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load fines' });
  }
});

router.post('/fines/:id/pay', async (req: Request, res: Response) => {
  try {
    const { amount, payment_method, receipt_no } = req.body;
    const [fine] = await pool().execute<RowDataPacket[]>('SELECT * FROM fines WHERE id = ?', [req.params.id]);
    if (!fine.length) { res.status(404).json({ error: 'Fine not found' }); return; }

    const newPaid = (fine[0].paid_amount || 0) + parseFloat(amount);
    const remaining = fine[0].amount - newPaid - (fine[0].waived_amount || 0);
    const newStatus = remaining <= 0 ? 'paid' : 'partial';

    await pool().execute(
      `UPDATE fines SET paid_amount = ?, status = ?, paid_date = NOW(), payment_method = ?, receipt_no = ? WHERE id = ?`,
      [newPaid, newStatus, payment_method || 'cash', receipt_no || null, req.params.id]
    );

    // Update book_issues fine_paid flag
    if (fine[0].issue_id && newStatus === 'paid') {
      await pool().execute(`UPDATE book_issues SET fine_paid = 1 WHERE id = ?`, [fine[0].issue_id]);
    }

    logActivity('fine', parseInt(req.params.id), 'paid', `₹${amount} paid. Status: ${newStatus}`, req.user?.username || 'librarian');
    res.json({ message: `₹${amount} paid`, status: newStatus, remaining: Math.max(0, remaining) });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

router.post('/fines/:id/waive', async (req: Request, res: Response) => {
  try {
    const { amount, reason } = req.body;
    const [fine] = await pool().execute<RowDataPacket[]>('SELECT * FROM fines WHERE id = ?', [req.params.id]);
    if (!fine.length) { res.status(404).json({ error: 'Fine not found' }); return; }

    const newWaived = (fine[0].waived_amount || 0) + parseFloat(amount);
    const remaining = fine[0].amount - (fine[0].paid_amount || 0) - newWaived;
    const newStatus = remaining <= 0 ? 'waived' : fine[0].status;

    await pool().execute(`UPDATE fines SET waived_amount = ?, status = ?, description = CONCAT(COALESCE(description,''), ' | Waived: ', ?) WHERE id = ?`,
      [newWaived, newStatus, reason || 'No reason', req.params.id]);

    logActivity('fine', parseInt(req.params.id), 'waived', `₹${amount} waived. Reason: ${reason || '—'}`, req.user?.username || 'admin');
    res.json({ message: `₹${amount} waived`, status: newStatus });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to waive' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DIGITAL LIBRARY
// ═══════════════════════════════════════════════════════════════

router.get('/digital', async (req: Request, res: Response) => {
  try {
    const { search, doc_type, department } = req.query;
    let where = 'dd.is_active = 1';
    const params: any[] = [];
    if (search) { where += ` AND MATCH(dd.title, dd.description, dd.tags) AGAINST(? IN BOOLEAN MODE)`; params.push(`${search}*`); }
    if (doc_type) { where += ' AND dd.doc_type = ?'; params.push(doc_type); }
    if (department) { where += ' AND dd.department = ?'; params.push(department); }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT dd.*, c.name as category_name FROM digital_docs dd LEFT JOIN lib_categories c ON dd.category_id = c.id WHERE ${where} ORDER BY dd.created_at DESC LIMIT 100`, params
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

router.post('/digital', async (req: Request, res: Response) => {
  try {
    const d = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      `INSERT INTO digital_docs (title, doc_type, category_id, department, file_name, file_path, file_size, mime_type, version, description, tags, access_level, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.title, d.doc_type||'other', d.category_id||null, d.department||null, d.file_name||null, d.file_path||null,
        d.file_size||null, d.mime_type||null, d.version||'1.0', d.description||null, d.tags||null,
        d.access_level||'internal', req.user?.username||'admin']
    );
    logActivity('document', result.insertId, 'uploaded', `"${d.title}" uploaded`, req.user?.username || 'admin');
    res.json({ id: result.insertId, message: 'Document added' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add document' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CATEGORIES & LOCATIONS
// ═══════════════════════════════════════════════════════════════

router.get('/categories', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM lib_categories WHERE is_active = 1 ORDER BY name');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

router.post('/categories', async (req: Request, res: Response) => {
  try {
    const { name, description, parent_id } = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      'INSERT INTO lib_categories (name, description, parent_id) VALUES (?,?,?)', [name, description||null, parent_id||null]
    );
    res.json({ id: result.insertId, message: 'Category added' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add category' });
  }
});

router.get('/locations', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM lib_locations WHERE is_active = 1 ORDER BY name');
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load locations' });
  }
});

router.post('/locations', async (req: Request, res: Response) => {
  try {
    const { name, floor, section, shelf, capacity, library_type } = req.body;
    const [result] = await pool().execute<ResultSetHeader>(
      'INSERT INTO lib_locations (name, floor, section, shelf, capacity, library_type) VALUES (?,?,?,?,?,?)',
      [name, floor||null, section||null, shelf||null, capacity||0, library_type||'corporate']
    );
    res.json({ id: result.insertId, message: 'Location added' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add location' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════

router.get('/reports', async (req: Request, res: Response) => {
  try {
    const { from, to, type } = req.query;
    const startDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = to || new Date().toISOString().slice(0, 10);

    if (type === 'overdue') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT bi.*, b.title, b.isbn, b.authors, m.name as member_name, m.member_no, m.phone, m.email,
          DATEDIFF(CURDATE(), bi.due_date) as days_overdue
         FROM book_issues bi JOIN books b ON bi.book_id = b.id JOIN members m ON bi.member_id = m.id
         WHERE bi.status = 'issued' AND bi.due_date < CURDATE() ORDER BY days_overdue DESC`
      );
      res.json({ type: 'overdue', data: rows });
      return;
    }

    if (type === 'fines') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT f.*, m.name as member_name, m.member_no FROM fines f JOIN members m ON f.member_id = m.id
         WHERE DATE(f.created_at) BETWEEN ? AND ? ORDER BY f.created_at DESC`, [startDate, endDate]
      );
      const [summary] = await pool().execute<RowDataPacket[]>(
        `SELECT COUNT(*) as total_fines, COALESCE(SUM(amount),0) as total_amount, COALESCE(SUM(paid_amount),0) as total_paid, COALESCE(SUM(waived_amount),0) as total_waived
         FROM fines WHERE DATE(created_at) BETWEEN ? AND ?`, [startDate, endDate]
      );
      res.json({ type: 'fines', data: rows, summary: summary[0] });
      return;
    }

    if (type === 'popular') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT b.id, b.title, b.authors, b.isbn, b.cover_url, COUNT(bi.id) as issue_count, MAX(bi.issue_date) as last_issued
         FROM books b JOIN book_issues bi ON b.id = bi.book_id
         WHERE DATE(bi.issue_date) BETWEEN ? AND ?
         GROUP BY b.id ORDER BY issue_count DESC LIMIT 50`, [startDate, endDate]
      );
      res.json({ type: 'popular', data: rows });
      return;
    }

    if (type === 'members') {
      const [rows] = await pool().execute<RowDataPacket[]>(
        `SELECT m.*, COUNT(bi.id) as total_issues,
          SUM(CASE WHEN bi.status = 'issued' THEN 1 ELSE 0 END) as active_issues,
          COALESCE((SELECT SUM(amount - paid_amount - waived_amount) FROM fines WHERE member_id = m.id AND status IN ('pending','partial')), 0) as pending_fine
         FROM members m LEFT JOIN book_issues bi ON m.id = bi.member_id
         WHERE m.status = 'active' GROUP BY m.id ORDER BY total_issues DESC LIMIT 100`
      );
      res.json({ type: 'members', data: rows });
      return;
    }

    // Default: circulation summary
    const [issued] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM book_issues WHERE DATE(issue_date) BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [returned] = await pool().execute<RowDataPacket[]>(
      `SELECT COUNT(*) as c FROM book_issues WHERE DATE(return_date) BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [finesCollected] = await pool().execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(paid_amount),0) as total FROM fines WHERE DATE(paid_date) BETWEEN ? AND ?`, [startDate, endDate]
    );
    const [dailyBreakdown] = await pool().execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(issue_date, '%Y-%m-%d') as date, COUNT(*) as issues FROM book_issues WHERE DATE(issue_date) BETWEEN ? AND ? GROUP BY DATE_FORMAT(issue_date, '%Y-%m-%d') ORDER BY date`, [startDate, endDate]
    );

    res.json({
      type: 'circulation',
      summary: { totalIssued: issued[0].c, totalReturned: returned[0].c, finesCollected: finesCollected[0].total },
      dailyBreakdown,
      from: startDate, to: endDate,
    });
  } catch (err: any) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTINGS & LOG
// ═══════════════════════════════════════════════════════════════

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool().execute<RowDataPacket[]>('SELECT * FROM lib_settings ORDER BY id');
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
      await pool().execute('INSERT INTO lib_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value = ?', [key, value, value]);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

router.get('/log', async (req: Request, res: Response) => {
  try {
    const { entity_type, limit: lim } = req.query;
    const maxRows = Math.min(500, parseInt(lim as string) || 100);
    let where = '1=1';
    const params: any[] = [];
    if (entity_type) { where += ' AND entity_type = ?'; params.push(entity_type); }

    const [rows] = await pool().execute<RowDataPacket[]>(
      `SELECT * FROM lib_activity_log WHERE ${where} ORDER BY performed_at DESC LIMIT ${Number(maxRows)}`, params
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load log' });
  }
});

export default router;
