// services/auditionService.js
const { Pool } = require('pg');
require('dotenv').config();

// Create a singleton Pool. Provide clear logging to help diagnose connection issues.
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set. Database operations will fail until it is provided.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Heroku & many managed Postgres providers require SSL; for local dev you can disable by omitting ssl.
  // We keep rejectUnauthorized false to avoid issues with self-signed certs in managed environments.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Optional: basic connectivity check helper (used by app.js /health route)
async function checkDbConnection() {
  const start = Date.now();
  try {
    const res = await pool.query('SELECT 1 as ok');
    return { ok: true, result: res.rows[0], latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code, latency_ms: Date.now() - start };
  }
}

// Capture pool error events (e.g., sudden disconnects) and log visibly
pool.on('error', (err) => {
  console.error('FATAL: Unexpected PG pool error (likely idle client error).', {
    message: err.message,
    code: err.code,
    stack: err.stack,
    time: new Date().toISOString()
  });
});

async function insertAudition(audition) {
  const query = `
    INSERT INTO auditions (
      project_id, role, first_name_he, last_name_he, first_name_en, last_name_en,
      phone, email, agency, age, height, profile_pictures, showreel_url, video_url, video_type
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13, $14, $15
    ) RETURNING *;
  `;  const values = [
    audition.project_id,
    audition.role,
    audition.first_name_he,
    audition.last_name_he,
    audition.first_name_en,
    audition.last_name_en,
    audition.phone,
    audition.email,
    audition.agency,
    audition.age ? parseInt(audition.age) : null,
    audition.height ? parseInt(audition.height) : null,
    (audition.profile_pictures && typeof audition.profile_pictures === 'object') ? JSON.stringify(audition.profile_pictures) : (audition.profile_pictures || null),
    audition.showreel_url,
    audition.video_url,
    audition.video_type
  ];
  const result = await pool.query(query, values);
  return result.rows[0];
}

// Fetch auditions for a given project with optional filters
async function getAuditionsByProjectId(projectId, query = {}) {
  const where = ['project_id = $1'];
  const params = [projectId];

  if (query.role) {
    params.push(query.role);
    where.push(`role = $${params.length}`);
  }

  if (query.email) {
    params.push(`%${query.email}%`);
    where.push(`email ILIKE $${params.length}`);
  }

  if (query.name) {
    params.push(`%${query.name}%`);
    // Match either Hebrew full name or English full name
    where.push(`( (COALESCE(first_name_he,'') || ' ' || COALESCE(last_name_he,'')) ILIKE $${params.length}
                 OR (COALESCE(first_name_en,'') || ' ' || COALESCE(last_name_en,'')) ILIKE $${params.length} )`);
  }

  const sql = `SELECT * FROM auditions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  insertAudition,
  pool,
  checkDbConnection,
  getAuditionsByProjectId,
};
