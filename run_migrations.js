// Simple migration runner for Heroku PostgreSQL
const fs = require('fs');
const path = require('path');
const { getPool, closePool, registerPoolShutdown } = require('./utils/database');

// Step 1: Give Heroku release a little more breathing room.
// A cold Postgres add-on can take a moment to accept the first SSL connection.
const pool = getPool({
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000
});
registerPoolShutdown({ exitOnFinish: true });

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(retries = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT NOW()');
      return;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️  Database connection attempt ${attempt} failed: ${error.message}`);
      if (attempt < retries) {
        await wait(1000 * attempt);
      }
    }
  }

  throw lastError;
}

async function runMigrations() {
  console.log('=== RUNNING DATABASE MIGRATIONS ===');
  
  try {
    // Test connection
    await connectWithRetry();
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
