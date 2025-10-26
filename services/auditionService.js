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

const NAME_SEARCH_SQL = "COALESCE(first_name_en,'') || ' ' || COALESCE(last_name_en,'') || ' ' || COALESCE(first_name_he,'') || ' ' || COALESCE(last_name_he,'')";

async function insertAudition(audition) {
  const query = `
    INSERT INTO auditions (
      project_id, role, first_name_he, last_name_he, first_name_en, last_name_en,
      phone, email, agency, age, height, profile_pictures, showreel_url, video_url, video_type
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15
    ) RETURNING *;
  `;
  const profilePictures = Array.isArray(audition.profile_pictures)
    ? audition.profile_pictures
    : (audition.profile_pictures || []);
  const values = [
    audition.project_id,
    audition.role,
    audition.first_name_he,
    audition.last_name_he,
    audition.first_name_en,
    audition.last_name_en,
    audition.phone,
    audition.email,
    audition.agency,
    audition.age ? parseInt(audition.age, 10) : null,
    audition.height ? parseInt(audition.height, 10) : null,
    JSON.stringify(profilePictures),
    audition.showreel_url,
    audition.video_url,
    audition.video_type
  ];
  const result = await pool.query(query, values);
  return result.rows[0];
}

function applyNameFilters(tokens, params, clauses) {
  tokens.forEach((token) => {
    params.push(`%${token.toLowerCase()}%`);
    clauses.push(`LOWER(${NAME_SEARCH_SQL}) LIKE $${params.length}`);
  });
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

  const nameTokens = (query.name || '')
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (nameTokens.length > 0) {
    applyNameFilters(nameTokens, params, where);
  }

  const sql = `SELECT * FROM auditions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function searchAuditions(filters = {}) {
  const name = (filters.name || '').toString().trim();
  const email = (filters.email || '').toString().trim();

  if (!name && !email) {
    return [];
  }

  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const whereClauses = [];
  const params = [];

  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    applyNameFilters(tokens, params, whereClauses);
  }

  if (email) {
    params.push(`%${email.toLowerCase()}%`);
    whereClauses.push(`LOWER(email) LIKE $${params.length}`);
  }

  if (whereClauses.length === 0) {
    // Should not happen because we guard above, but keep safety net intact.
    return [];
  }

  const baseSql = `
    SELECT a.*, p.name AS project_name,
           ${NAME_SEARCH_SQL} AS search_name_expr
    FROM auditions a
    JOIN projects p ON p.id = a.project_id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  params.push(limit, offset);
  const { rows } = await pool.query(baseSql, params);
  return rows;
}

module.exports = {
  insertAudition,
  pool,
  checkDbConnection,
  getAuditionsByProjectId,
  searchAuditions,
};
