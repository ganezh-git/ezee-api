const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({host:'localhost',user:'root',password:'',database:'permit_birla'});

  const [types] = await c.execute('SELECT id, code FROM permit_types');
  const [depts] = await c.execute('SELECT id FROM departments WHERE active = 1');
  const [locs] = await c.execute('SELECT id FROM work_locations WHERE active = 1');
  const [personnel] = await c.execute('SELECT id, is_initiator, is_issuer, is_custodian FROM personnel WHERE active = 1');

  const initiators = personnel.filter(p => p.is_initiator);
  const issuers = personnel.filter(p => p.is_issuer);
  const custodians = personnel.filter(p => p.is_custodian);

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const statuses = ['Initiated','Issued','Custodian_Approved','Active','Active','Active','Closed','Closed','Suspended','Extended'];
  
  const descriptions = [
    'Welding work on overhead pipeline at Unit-3 reactor section',
    'Electrical cable laying in cable trench area B2',
    'Scaffolding erection for painting work at tank farm',
    'Hot tapping operation on process line PL-103',
    'Confined space entry for vessel V-201 internal inspection',
    'Excavation work near underground utilities',
    'Crane operation for equipment lifting at compressor house',
    'LOTOTO for maintenance of pump P-401A',
    'Monomer barrel handling and storage at warehouse',
    'Monomer tanker unloading at tank lorry bay',
    'General maintenance on conveyor belt system',
    'Electrical panel modification at MCC room',
    'Height work for antenna installation on tower',
    'Grinding and cutting work on structural steel',
    'Gas pipeline repair work at plant boundary',
    'Tank cleaning operation for storage tank T-105',
    'Roof repair work at administration building',
    'Underground cable repair near transformer area',
    'Pressure testing of newly installed piping',
    'Insulation removal work on steam line',
    'Fire hydrant maintenance and flow testing',
    'Chemical dosing system installation',
    'Ventilation duct cleaning in production area',
    'Emergency generator maintenance work',
    'Boiler tube inspection and repair work',
    'Water treatment plant chemical handling',
    'Loading dock repair and painting work',
    'Control room instrument calibration',
    'Safety shower and eyewash station testing',
    'Transformer oil sampling and testing',
    'Cooling tower fan motor replacement',
    'Acid storage tank inspection work',
    'Railway siding track maintenance',
    'Waste treatment plant equipment repair',
    'Air compressor overhaul maintenance',
  ];

  await c.execute('DELETE FROM permit_sequence');

  // Clear existing test data and start fresh
  await c.execute('DELETE FROM permit_audit_log');
  await c.execute('DELETE FROM permit_hazards');
  await c.execute('DELETE FROM permit_ppe');
  await c.execute('DELETE FROM permit_checklist_items');
  await c.execute('DELETE FROM permits');
  console.log('Cleared existing data');

  const prefixMap = {
    HEIGHT:'HWP', CONFINED:'CSP', ELECTRICAL:'EWP', EXCAVATION:'EXP',
    GENERAL:'GWP', LOTOTO:'LTP', LIFTING:'MLP',
    MONOMER_BARREL:'MBP', MONOMER_TANKER:'MTP', HOT_WORK:'HTP'
  };

  let created = 0;
  for (let i = 0; i < 35; i++) {
    const type = pick(types);
    const dept = pick(depts);
    const loc = pick(locs);
    const initiator = pick(initiators);
    const status = pick(statuses);
    
    const daysAgo = Math.floor(Math.random() * 15);
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];
    const hour = 7 + Math.floor(Math.random() * 10);
    const min = Math.floor(Math.random() * 60);
    const timeStr = String(hour).padStart(2,'0') + ':' + String(min).padStart(2,'0');
    const validHour = Math.min(hour + 8, 23);
    const validTimeStr = String(validHour).padStart(2,'0') + ':' + String(min).padStart(2,'0');

    const pfx = prefixMap[type.code] || 'PTW';
    const year = d.getFullYear();
    
    await c.execute(
      'INSERT INTO permit_sequence (permit_type_code, year, last_number) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_number = last_number + 1',
      [type.code, year]
    );
    const [seqRows] = await c.execute('SELECT last_number FROM permit_sequence WHERE permit_type_code = ? AND year = ?', [type.code, year]);
    const num = seqRows[0].last_number;
    const permitNo = pfx + '-' + year + '-' + String(num).padStart(4, '0');
    
    const desc = descriptions[i % descriptions.length];
    
    let issId = null, issSignedAt = null, custId = null, custSignedAt = null;
    let coName = null, coSignedAt = null, closedAt = null;
    let suspReason = null, suspBy = null, suspAt = null;
    let extDate = null, extTime = null, extBy = null;
    
    if (['Issued','Custodian_Approved','Active','Closed','Suspended','Extended'].includes(status)) {
      const iss = pick(issuers);
      issId = iss.id;
      issSignedAt = dateStr + ' ' + String(Math.min(hour+1,23)).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':00';
    }
    if (['Custodian_Approved','Active','Closed','Suspended','Extended'].includes(status)) {
      const cust = pick(custodians);
      custId = cust.id;
      custSignedAt = dateStr + ' ' + String(Math.min(hour+2,23)).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':00';
    }
    if (['Active','Closed','Suspended','Extended'].includes(status)) {
      coName = pick(['Ramesh Kumar','Sunil Sharma','Vikash Singh','Pradeep Yadav','Ajay Gupta']);
      coSignedAt = dateStr + ' ' + String(Math.min(hour+3,23)).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':00';
    }
    if (status === 'Closed') {
      closedAt = dateStr + ' ' + String(Math.min(hour+6,23)).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':00';
    }
    if (status === 'Suspended') {
      suspReason = pick(['Unsafe condition observed','Heavy rain - work stopped','Gas leak detected in adjacent area','Equipment malfunction']);
      suspBy = 'Safety Officer';
      suspAt = dateStr + ' ' + String(Math.min(hour+4,23)).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':00';
    }
    if (status === 'Extended') {
      const ed = new Date(d);
      ed.setDate(ed.getDate() + 1);
      extDate = ed.toISOString().split('T')[0];
      extTime = '18:00';
      extBy = 'Area Custodian';
    }

    await c.execute(
      `INSERT INTO permits (permit_no, permit_type_id, department_id, location_id,
        issued_date, issued_time, valid_until_date, valid_until_time,
        work_description, initiator_id, initiator_signed_at,
        issuer_id, issuer_signed_at, custodian_id, custodian_signed_at,
        co_permittee_name, co_permittee_signed_at,
        closed_at, closure_debris_removed, closure_tools_removed, closure_equipment_ready,
        suspension_reason, suspended_by, suspended_at,
        extended_until_date, extended_until_time, extended_by_custodian,
        isolation_electrical, isolation_services, isolation_process,
        status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [permitNo, type.id, dept.id, loc.id,
       dateStr, timeStr, dateStr, validTimeStr,
       desc, initiator.id, dateStr + ' ' + timeStr + ':00',
       issId, issSignedAt, custId, custSignedAt,
       coName, coSignedAt,
       closedAt, status==='Closed'?1:0, status==='Closed'?1:0, status==='Closed'?1:0,
       suspReason, suspBy, suspAt,
       extDate, extTime, extBy,
       pick(['YES','NA']), pick(['YES','NA']), pick(['YES','NA']),
       status, dateStr + ' ' + timeStr + ':00']
    );

    const permitId = (await c.execute('SELECT LAST_INSERT_ID() as id'))[0][0].id;
    
    // Add hazards
    const usedHazards = new Set();
    for (let h = 0; h < 1 + Math.floor(Math.random() * 4); h++) {
      const hid = 1 + Math.floor(Math.random() * 23);
      if (!usedHazards.has(hid)) {
        usedHazards.add(hid);
        try { await c.execute('INSERT INTO permit_hazards (permit_id, hazard_type_id) VALUES (?, ?)', [permitId, hid]); } catch(e) {}
      }
    }
    
    // Add PPE
    const usedPpe = new Set();
    for (let pp = 0; pp < 1 + Math.floor(Math.random() * 5); pp++) {
      const pid = 1 + Math.floor(Math.random() * 18);
      if (!usedPpe.has(pid)) {
        usedPpe.add(pid);
        try { await c.execute('INSERT INTO permit_ppe (permit_id, ppe_type_id) VALUES (?, ?)', [permitId, pid]); } catch(e) {}
      }
    }

    await c.execute('INSERT INTO permit_audit_log (permit_id, action, details, performed_by, performed_at) VALUES (?, ?, ?, ?, ?)',
      [permitId, 'CREATED', 'Permit ' + permitNo + ' created', 'system', dateStr + ' ' + timeStr + ':00']);

    created++;
    process.stdout.write('.');
  }

  console.log('\nCreated ' + created + ' test permits');
  await c.end();
})().catch(e => console.error(e));
