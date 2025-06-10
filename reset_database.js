// Fresh database setup - drops everything and recreates from scratch
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function resetDatabase() {
  console.log('=== FRESH DATABASE SETUP ===');
  console.log('⚠️  This will DELETE ALL existing data!');
  console.log('');

  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');

    // Drop all tables (in reverse dependency order)
    console.log('\n🗑️  Dropping all existing tables...');
    await pool.query('DROP TABLE IF EXISTS auditions CASCADE;');
    await pool.query('DROP TABLE IF EXISTS roles CASCADE;');
    await pool.query('DROP TABLE IF EXISTS projects CASCADE;');
    console.log('✅ All tables dropped');

    // Create projects table
    console.log('\n📋 Creating projects table...');
    await pool.query(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        upload_method TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        director TEXT,
        production_company TEXT
      );
    `);
    console.log('✅ Projects table created');

    // Create roles table
    console.log('\n👥 Creating roles table...');
    await pool.query(`
      CREATE TABLE roles (
        id SERIAL PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        playlist_id TEXT
      );
    `);
    console.log('✅ Roles table created');

    // Create auditions table
    console.log('\n🎬 Creating auditions table...');
    await pool.query(`
      CREATE TABLE auditions (
        id SERIAL PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
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
      );
    `);
    console.log('✅ Auditions table created');

    // Create indexes for performance
    console.log('\n🔍 Creating indexes...');
    await pool.query('CREATE INDEX idx_auditions_project_id ON auditions(project_id);');
    await pool.query('CREATE INDEX idx_auditions_role ON auditions(role);');
    await pool.query('CREATE INDEX idx_auditions_email ON auditions(email);');
    await pool.query('CREATE INDEX idx_roles_project_id ON roles(project_id);');
    console.log('✅ Indexes created');

    // Verify final structure
    console.log('\n📊 Final table structure:');
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    tablesResult.rows.forEach(row => {
      console.log(`  ✅ ${row.table_name}`);
    });

    console.log('\n🎉 Fresh database setup complete!');
    console.log('Your database is now ready with clean, empty tables.');

  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

resetDatabase();
