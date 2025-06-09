// services/projectService.js
const { pool } = require('./auditionService');
const db = require('../config/config.js'); // Assuming db.js is in a config folder

// Add a version log at the top for deployment verification
console.log('INFO: projectService.js version 2025-06-08_2100_DEBUG running');

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
const getProjectById = async (id) => {
  console.log(`PROJECT_SERVICE_GET_BY_ID_START: Fetching project with id: ${id}, timestamp = ${new Date().toISOString()}`);
  let project;
  try {
      const projectResult = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
      if (projectResult.rows.length > 0) {
          project = projectResult.rows[0];
          console.log(`PROJECT_SERVICE_GET_BY_ID_PROJECT_FOUND: Project data for ${id}: ${JSON.stringify(project)}`);

          const rolesResult = await pool.query('SELECT * FROM roles WHERE project_id = $1', [id]);
          project.roles = rolesResult.rows;
          console.log(`PROJECT_SERVICE_GET_BY_ID_ROLES_FETCHED: Roles for project ${id}: ${JSON.stringify(project.roles)}. Roles count: ${project.roles.length}. IsArray: ${Array.isArray(project.roles)}`);
          
          // Ensure roles is always an array, even if empty, to prevent .find issues later
          if (!Array.isArray(project.roles)) {
              console.warn(`PROJECT_SERVICE_GET_BY_ID_ROLES_NOT_ARRAY: Roles for project ${id} was not an array. Initializing to empty array. Original value: ${JSON.stringify(project.roles)}`);
              project.roles = [];
          }

      } else {
          console.log(`PROJECT_SERVICE_GET_BY_ID_PROJECT_NOT_FOUND: No project found with id: ${id}`);
          return null; // Return null if project not found
      }
  } catch (error) {
      console.error(`PROJECT_SERVICE_GET_BY_ID_DB_ERROR: Error fetching project or roles for id ${id}:`, error);
      // In case of DB error, it's safer to return null or throw, rather than a potentially incomplete project object.
      // If we return project here, it might be partially populated, leading to issues like project.roles being undefined.
      // For now, let's re-throw to make it clear that a DB operation failed.
      throw error; 
  }
  console.log(`PROJECT_SERVICE_GET_BY_ID_END: Returning project for id ${id}: ${project ? project.name : 'null'}. Roles count: ${project && project.roles ? project.roles.length : 'N/A'}`);
  return project;
};

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
