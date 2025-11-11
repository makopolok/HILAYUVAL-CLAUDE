const { getPool, closePool, registerPoolShutdown } = require('./utils/database');

const pool = getPool();
registerPoolShutdown({ exitOnFinish: true });

async function showAuditions() {
  try {
    console.log('=== AUDITIONS TABLE STRUCTURE ===');
    const tableInfo = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'auditions'
      ORDER BY ordinal_position;
    `);
    tableInfo.rows.forEach(row => console.log(row));

    console.log('\n=== SAMPLE AUDITIONS DATA ===');
    const result = await pool.query('SELECT * FROM auditions ORDER BY created_at DESC LIMIT 3');
    console.log('Number of auditions found:', result.rows.length);
    result.rows.forEach((row, index) => {
      console.log(`\nAudition ${index + 1}:`);
      console.log(JSON.stringify(row, null, 2));
    });
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await closePool('check_auditions:cleanup');
  }
}

showAuditions();
