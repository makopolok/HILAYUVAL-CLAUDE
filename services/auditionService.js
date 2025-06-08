// services/auditionService.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
  `;
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
    audition.age ? parseInt(audition.age) : null,
    audition.height ? parseInt(audition.height) : null,
    audition.profile_pictures,
    audition.showreel_url,
    audition.video_url,
    audition.video_type
  ];
  const result = await pool.query(query, values);
  return result.rows[0];
}

module.exports = {
  insertAudition,
  pool,
};
