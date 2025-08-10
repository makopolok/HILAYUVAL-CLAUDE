// scripts/create_auditions_table_if_missing.js
// Safely create 'auditions' table with integer project_id FK if it does not exist.

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

(async () => {
  console.log('Checking for auditions table...');
  try {
    const res = await pool.query("SELECT to_regclass('public.auditions') as exists");
    if (!res.rows[0].exists) {
      console.log('auditions table missing. Creating...');
      await pool.query(`CREATE TABLE auditions (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        first_name_he TEXT,
        last_name_he TEXT,
        first_name_en TEXT,
        last_name_en TEXT,
        phone TEXT,
        email TEXT,
        agency TEXT,
        age INTEGER,
        height INTEGER,
        profile_pictures JSONB,
        showreel_url TEXT,
        video_url TEXT,
        video_type TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_auditions_project_id ON auditions(project_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_auditions_role ON auditions(role)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_auditions_email ON auditions(email)');
      console.log('auditions table created successfully.');
    } else {
      console.log('auditions table already exists. No action taken.');
    }
  } catch (err) {
    console.error('Error ensuring auditions table exists:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
