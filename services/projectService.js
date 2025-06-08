// services/projectService.js
const { pool } = require('./auditionService');

// Add a new project and its roles
async function addProject(project) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO projects (id, name, description, upload_method, created_at, director, production_company)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [project.id, project.name, project.description, project.uploadMethod, project.createdAt, project.director, project.production_company]
    );
    for (const role of project.roles) {
      await client.query(
        `INSERT INTO roles (project_id, name, playlist_id)
         VALUES ($1, $2, $3)`,
        [project.id, role.name, role.playlistId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Get all projects with their roles
async function getAllProjects() {
  const projectsRes = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  const rolesRes = await pool.query('SELECT * FROM roles');
  return projectsRes.rows.map(project => ({
    ...project,
    roles: rolesRes.rows.filter(role => role.project_id === project.id)
  }));
}

// Get a project by ID
async function getProjectById(id) {
  const projectRes = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (projectRes.rows.length === 0) return null;
  const rolesRes = await pool.query('SELECT * FROM roles WHERE project_id = $1', [id]);
  return { ...projectRes.rows[0], roles: rolesRes.rows };
}

// Add a role to a project
async function addRoleToProject(projectId, role) {
  await pool.query(
    `INSERT INTO roles (project_id, name, playlist_id)
     VALUES ($1, $2, $3)`,
    [projectId, role.name, role.playlistId]
  );
}

module.exports = {
  addProject,
  getAllProjects,
  getProjectById,
  addRoleToProject
};
