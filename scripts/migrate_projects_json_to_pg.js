// Usage: node scripts/migrate_projects_json_to_pg.js
const fs = require('fs');
const path = require('path');
const { getPool, closePool, registerPoolShutdown, withClient } = require('../utils/database');

getPool();
registerPoolShutdown({ exitOnFinish: true });

async function migrate() {
  const file = path.join(__dirname, '../data/projects.json');
  if (!fs.existsSync(file)) {
    console.error('projects.json not found');
    process.exit(1);
  }
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const project of projects) {
    try {
      await withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO projects (id, name, description, upload_method, created_at, director, production_company)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO NOTHING`,
            [project.id, project.name, project.description, project.uploadMethod, project.createdAt, project.director, project.production_company]
          );
          for (const role of project.roles || []) {
            await client.query(
              `INSERT INTO roles (project_id, name, playlist_id)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [project.id, role.name, role.playlistId]
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      console.log(`Migrated project: ${project.name}`);
    } catch (err) {
      console.error('Error migrating project', project.id, err);
    }
  }
  await closePool('migrate_projects_json_to_pg:cleanup');
  console.log('Migration complete.');
}

migrate();
