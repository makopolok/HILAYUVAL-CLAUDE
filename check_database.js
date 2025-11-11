// Database structure checker for Heroku PostgreSQL
const { getPool, closePool, registerPoolShutdown } = require('./utils/database');

const pool = getPool();
registerPoolShutdown({ exitOnFinish: true });

async function checkDatabaseStructure() {
  console.log('=== DATABASE STRUCTURE CHECK ===');
  console.log('Timestamp:', new Date().toISOString());
  console.log('');

  try {
    // Check if database connection works
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection: SUCCESS');

    // List all tables
    console.log('\n📋 TABLES:');
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    if (tablesResult.rows.length === 0) {
      console.log('❌ No tables found in database');
    } else {
      tablesResult.rows.forEach(row => {
        console.log(`  - ${row.table_name}`);
      });
    }

    // Check each expected table
    const expectedTables = ['projects', 'roles', 'auditions'];
    
    for (const tableName of expectedTables) {
      console.log(`\n🔍 CHECKING TABLE: ${tableName}`);
      
      try {
        // Check if table exists and get column info
        const columnsResult = await pool.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns 
          WHERE table_name = $1 AND table_schema = 'public'
          ORDER BY ordinal_position;
        `, [tableName]);

        if (columnsResult.rows.length === 0) {
          console.log(`  ❌ Table '${tableName}' does not exist`);
        } else {
          console.log(`  ✅ Table '${tableName}' exists with ${columnsResult.rows.length} columns:`);
          columnsResult.rows.forEach(col => {
            console.log(`    - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
          });

          // Get row count
          const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
          console.log(`  📊 Row count: ${countResult.rows[0].count}`);
        }
      } catch (err) {
        console.log(`  ❌ Error checking table '${tableName}': ${err.message}`);
      }
    }

    // Show recent auditions if table exists
    try {
      console.log('\n🎬 RECENT AUDITIONS (last 10):');
      const auditionsResult = await pool.query(`
        SELECT id, project_id, role, first_name_en, last_name_en, email, created_at, video_url
        FROM auditions 
        ORDER BY created_at DESC 
        LIMIT 10
      `);
      
      if (auditionsResult.rows.length === 0) {
        console.log('  📭 No auditions found');
      } else {
        auditionsResult.rows.forEach((aud, idx) => {
          console.log(`  ${idx + 1}. ${aud.first_name_en} ${aud.last_name_en} (${aud.email})`);
          console.log(`     Project: ${aud.project_id}, Role: ${aud.role}`);
          console.log(`     Video: ${aud.video_url || 'No video'}`);
          console.log(`     Submitted: ${aud.created_at}`);
          console.log('');
        });
      }
    } catch (err) {
      console.log(`  ❌ Could not fetch auditions: ${err.message}`);
    }

    // Show projects
    try {
      console.log('\n🎯 PROJECTS:');
      const projectsResult = await pool.query(`
        SELECT p.id, p.name, p.description, p.upload_method, p.created_at,
               COUNT(r.id) as role_count
        FROM projects p
        LEFT JOIN roles r ON p.id = r.project_id
        GROUP BY p.id, p.name, p.description, p.upload_method, p.created_at
        ORDER BY p.created_at DESC
      `);
      
      if (projectsResult.rows.length === 0) {
        console.log('  📭 No projects found');
      } else {
        projectsResult.rows.forEach((proj, idx) => {
          console.log(`  ${idx + 1}. ${proj.name} (${proj.id})`);
          console.log(`     Upload method: ${proj.upload_method}`);
          console.log(`     Roles: ${proj.role_count}`);
          console.log(`     Created: ${proj.created_at}`);
          console.log('');
        });
      }
    } catch (err) {
      console.log(`  ❌ Could not fetch projects: ${err.message}`);
    }

  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('Connection string configured:', !!process.env.DATABASE_URL);
  } finally {
    await closePool('check_database:cleanup');
  }
}

// Run the check
checkDatabaseStructure()
  .then(() => {
    console.log('\n✅ Database check complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Database check failed:', error);
    process.exit(1);
  });
