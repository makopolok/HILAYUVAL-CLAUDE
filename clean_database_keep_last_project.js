// Keep only the most recent project and delete everything else.
const { getPool, closePool, registerPoolShutdown } = require('./utils/database');

const pool = getPool();
registerPoolShutdown({ exitOnFinish: true });

async function cleanDatabaseKeepLastProject() {
  console.log('=== DATABASE CLEANUP ===');
  console.log('This will keep the most recent project and delete all older projects.');
  console.log('');

  let inTransaction = false;
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');

    await pool.query('BEGIN');
    inTransaction = true;

    const latestProjectRes = await pool.query(`
      SELECT id, name, created_at
      FROM projects
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `);

    if (latestProjectRes.rows.length === 0) {
      await pool.query('ROLLBACK');
      console.log('No projects found. Nothing to clean.');
      return;
    }

    const latestProject = latestProjectRes.rows[0];
    console.log(`Keeping project #${latestProject.id}: ${latestProject.name}`);

    const deleteRes = await pool.query(
      'DELETE FROM projects WHERE id <> $1',
      [latestProject.id]
    );

    await pool.query('COMMIT');

    console.log(`✅ Removed ${deleteRes.rowCount} older project(s).`);
    console.log('✅ Related roles and auditions were removed automatically through cascade deletes.');
    console.log('✅ Cleanup complete.');
  } catch (error) {
    try {
      if (inTransaction) {
        await pool.query('ROLLBACK');
      }
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError.message);
    }
    console.error('❌ Cleanup failed:', error.message);
    throw error;
  } finally {
    await closePool('clean_database_keep_last_project:cleanup');
  }
}

cleanDatabaseKeepLastProject();
