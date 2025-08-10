// scripts/check_db_connection.js
// Lightweight diagnostic to verify PostgreSQL connectivity & basic structure.

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in environment.');
  process.exit(2);
}

function maskConnectionString(cs) {
  try {
    const url = new URL(cs);
    if (url.password) {
      url.password = '*****';
    }
    return url.toString();
  } catch (_) {
    return cs.replace(/:(?:[^:@/]+)@/, ':*****@');
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

(async () => {
  const start = Date.now();
  console.log('=== DB CONNECTION DIAGNOSTIC ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Connection String (masked):', maskConnectionString(process.env.DATABASE_URL));
  try {
    const nowRes = await pool.query('SELECT NOW() as now, current_database() as db, version() as version');
    const row = nowRes.rows[0];
    console.log('\n✅ Basic connection OK');
    console.log('Server time:', row.now);
    console.log('Database:', row.db);
    console.log('Version:', row.version.split('\n')[0]);

    // List public tables
    const tablesRes = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    console.log(`\n📋 Tables (${tablesRes.rows.length}):`);
    tablesRes.rows.forEach(t => console.log(' -', t.table_name));

    // Attempt to introspect expected tables
    const expected = ['projects','roles','auditions'];
    for (const t of expected) {
      const colRes = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
      if (colRes.rows.length === 0) {
        console.log(`\n❌ Missing table: ${t}`);
      } else {
        console.log(`\n✅ ${t} (${colRes.rows.length} cols)`);
        console.log('   Columns:', colRes.rows.map(c => `${c.column_name}:${c.data_type}`).join(', '));
        try {
          const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM ${t}`);
            console.log(`   Rows: ${countRes.rows[0].count}`);
        } catch (e) {
          console.log('   (Count query failed:', e.message, ')');
        }
      }
    }

    console.log(`\n⏱  Total latency: ${Date.now() - start} ms`);
    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Connection / query error:', err.message);
    console.error('Code:', err.code);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
