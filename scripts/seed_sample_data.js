// scripts/seed_sample_data.js
// Optional: Seed a sample project with two roles after a full reset.

const { withClient, closePool, registerPoolShutdown } = require('../utils/database');

registerPoolShutdown({ exitOnFinish: true });

(async () => {
  console.log('Seeding sample data...');
  try {
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const projectRes = await client.query(
          `INSERT INTO projects (name, description, upload_method, director, production_company)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          ['Sample Project', 'Demo seeded project', 'bunny_stream', 'Demo Director', 'Demo Company']
        );
        const pid = projectRes.rows[0].id;
        await client.query(`INSERT INTO roles (project_id, name) VALUES ($1,$2), ($1,$3)`, [pid, 'Lead', 'Support']);
        console.log('Seed complete. Project ID:', pid);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    await closePool('seed_sample_data:cleanup');
  }
})();
