// Simple migration runner for Heroku PostgreSQL
const fs = require('fs');
const path = require('path');
const { getPool, closePool, registerPoolShutdown } = require('./utils/database');

const pool = getPool();
registerPoolShutdown({ exitOnFinish: true });

async function runMigrations() {
  console.log('=== RUNNING DATABASE MIGRATIONS ===');
  
  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');

    // Get all migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    console.log(`Found ${migrationFiles.length} migration files:`);
    migrationFiles.forEach(file => console.log(`  - ${file}`));

    // Run each migration
    for (const file of migrationFiles) {
      console.log(`\n🔧 Running migration: ${file}`);
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      
      try {
        await pool.query(sql);
        console.log(`✅ Migration ${file} completed successfully`);
      } catch (err) {
        console.log(`⚠️  Migration ${file} error (might already exist): ${err.message}`);
      }
    }

    // Check final structure
    console.log('\n📋 Final table list:');
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    tablesResult.rows.forEach(row => {
      console.log(`  ✅ ${row.table_name}`);
    });

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack); // Log the full error stack
  } finally {
    await closePool('run_migrations:cleanup');
  }
}
runMigrations();
