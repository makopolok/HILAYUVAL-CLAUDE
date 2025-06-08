// Usage: node scripts/migrate_projects_json_to_pg.js
const fs = require('fs');
const path = require('path');
const { pool } = require('../services/auditionService');

async function migrate() {
  const file = path.join(__dirname, '../data/projects.json');
  if (!fs.existsSync(file)) {
    console.error('projects.json not found');
    process.exit(1);
  }
  const projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const project of projects) {
    try {
      await pool.query(
        `INSERT INTO projects (id, name, description, upload_method, created_at, director, production_company)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [project.id, project.name, project.description, project.uploadMethod, project.createdAt, project.director, project.production_company]
      );
      for (const role of project.roles || []) {
        await pool.query(
          `INSERT INTO roles (project_id, name, playlist_id)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [project.id, role.name, role.playlistId]
        );
      }
      console.log(`Migrated project: ${project.name}`);
    } catch (err) {
      console.error('Error migrating project', project.id, err);
    }
  }
  await pool.end();
  console.log('Migration complete.');
}

migrate();
