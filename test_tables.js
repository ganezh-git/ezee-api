const mysql = require('mysql2/promise');

(async () => {
  const p = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'permit' });
  const tables = ['hot_permit','confined_permit','electrical_permit','excavation_permit','height_permit','pipeline_permit','general_permit','fragile_permit','unloading_permit','monomer_permit'];

  const baseCols = 'id, rdate, rtime, type, location, disc, estime, eetime, remark, issued, returned, loto, ladder, perowner, permitno, secname, perremark, idate, itime, secname1, loto1, ladder1, cdate, ctime, cloname, csdate, cstime, perremark1, emer, gwmapp, st, st2, clocomment, s1, c1, c2, c3, c4, c5, c6, c7';

  console.log('=== Testing base columns on each table ===');
  for (const t of tables) {
    try {
      const [r] = await p.query(`SELECT COUNT(*) as cnt FROM \`${t}\``);
      await p.query(`SELECT ${baseCols} FROM \`${t}\` LIMIT 1`);
      console.log(`OK  ${t} (${r[0].cnt} rows)`);
    } catch (e) {
      console.log(`FAIL ${t}: ${e.message}`);
    }
  }

  console.log('\n=== Testing optional columns per table ===');
  const optCols = ['perowner1','perowner2','peruser','peruser1','peruser2','matime','holidayapproval'];
  for (const t of tables) {
    const missing = [];
    for (const c of optCols) {
      try {
        await p.query(`SELECT \`${c}\` FROM \`${t}\` LIMIT 1`);
      } catch { missing.push(c); }
    }
    if (missing.length > 0) console.log(`  ${t} MISSING: ${missing.join(', ')}`);
    else console.log(`  ${t}: all optional cols present`);
  }

  console.log('\n=== Testing UNION ALL with permitSelectFrom logic ===');
  const fullSelect = (table) => {
    const missingAll = ['unloading_permit'];
    const missingHoliday = ['height_permit'];
    if (missingAll.includes(table)) {
      return `SELECT ${baseCols}, '' as perowner1, '' as perowner2, '' as peruser, '' as peruser1, '' as peruser2, '' as matime, 0 as holidayapproval, '${table}' as _table FROM \`${table}\` WHERE 1=1`;
    }
    if (missingHoliday.includes(table)) {
      return `SELECT ${baseCols}, perowner1, perowner2, peruser, peruser1, peruser2, matime, 0 as holidayapproval, '${table}' as _table FROM \`${table}\` WHERE 1=1`;
    }
    return `SELECT ${baseCols}, perowner1, perowner2, peruser, peruser1, peruser2, matime, holidayapproval, '${table}' as _table FROM \`${table}\` WHERE 1=1`;
  };

  // Test each individually
  for (const t of tables) {
    try {
      const [r] = await p.query(fullSelect(t) + ' LIMIT 1');
      console.log(`OK  ${t} full select`);
    } catch (e) {
      console.log(`FAIL ${t} full select: ${e.message}`);
    }
  }

  // Test the full UNION ALL
  console.log('\n=== Testing full UNION ALL ===');
  try {
    const union = tables.map(t => fullSelect(t)).join(' UNION ALL ');
    const [r] = await p.query(`SELECT * FROM (${union}) AS combined ORDER BY id DESC LIMIT 5`);
    console.log(`OK  Full UNION ALL returned ${r.length} rows`);
  } catch (e) {
    console.log(`FAIL Full UNION ALL: ${e.message}`);
  }

  // Test the dashboard stats query
  console.log('\n=== Testing dashboard stats UNION ===');
  try {
    const statsUnion = tables.map(t => `SELECT '${t}' as _table, id, rdate, estime, st2, emer FROM \`${t}\``).join(' UNION ALL ');
    const [r] = await p.query(`SELECT _table, COUNT(*) as total FROM (${statsUnion}) AS combined GROUP BY _table`);
    console.log(`OK  Dashboard stats - ${r.length} tables, total: ${r.reduce((s,x) => s + x.total, 0)} permits`);
  } catch (e) {
    console.log(`FAIL Dashboard stats: ${e.message}`);
  }

  await p.end();
  console.log('\nDone!');
})();
