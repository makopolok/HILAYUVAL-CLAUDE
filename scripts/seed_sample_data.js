// scripts/seed_sample_data.js
// Optional: Seed a sample project with two roles after a full reset.

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

(async () => {
  console.log('Seeding sample data...');
  try {
    await pool.query('BEGIN');
    const projectRes = await pool.query(
      `INSERT INTO projects (name, description, upload_method, director, production_company)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
  ['Sample Project', 'Demo seeded project', 'bunny', 'Demo Director', 'Demo Company']
    );
    const pid = projectRes.rows[0].id;
    await pool.query(`INSERT INTO roles (project_id, name) VALUES ($1,$2), ($1,$3)`, [pid, 'Lead', 'Support']);
    console.log('Seed complete. Project ID:', pid);
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    console.error('Seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
