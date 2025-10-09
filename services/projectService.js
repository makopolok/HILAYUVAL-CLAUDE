// services/projectService.js
// Forcing a new build by adding a comment
const { pool } = require('./auditionService');

// Add a version log at the top for deployment verification
console.log('INFO: projectService.js version 2025-06-08_2100_DEBUG running');

// Add a new project and its roles
async function addProject(project) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Let DB generate primary key (SERIAL/BIGSERIAL). Return id.
    const insertRes = await client.query(
      `INSERT INTO projects (name, description, upload_method, created_at, director, production_company)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [project.name, project.description, project.uploadMethod, project.createdAt, project.director, project.production_company]
    );
    const newProjectId = insertRes.rows[0].id;
    // Insert roles referencing generated id
    for (const role of project.roles) {
      await client.query(
        `INSERT INTO roles (project_id, name, playlist_id)
         VALUES ($1, $2, $3)`,
        [newProjectId, role.name, role.playlistId]
      );
    }
    await client.query('COMMIT');
    return newProjectId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getAllProjects() {
    const projectsRes = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
    // Only non-deleted roles
    const rolesRes = await pool.query('SELECT * FROM roles WHERE COALESCE(is_deleted, FALSE) = FALSE');
    console.log('PROJECT_SERVICE_GET_ALL_PROJECTS:', { projects: projectsRes.rows, roles: rolesRes.rows });
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

          const rolesResult = await pool.query('SELECT * FROM roles WHERE project_id = $1 AND COALESCE(is_deleted, FALSE) = FALSE', [id]);
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

// Rename a role; also update existing auditions to the new name for this project
async function renameRole(projectId, roleId, newName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Fetch current role and validate project ownership
    const { rows } = await client.query('SELECT id, project_id, name FROM roles WHERE id=$1 AND project_id=$2', [roleId, projectId]);
    if (rows.length === 0) {
      throw new Error('Role not found for this project');
    }
    const current = rows[0];
    // Prevent duplicate name within the same project (case-insensitive)
    const dupCheck = await client.query(
      'SELECT 1 FROM roles WHERE project_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3 AND COALESCE(is_deleted, FALSE)=FALSE LIMIT 1',
      [projectId, newName, roleId]
    );
    if (dupCheck.rows.length > 0) {
      throw new Error('A role with this name already exists');
    }
    // Update role name
    await client.query('UPDATE roles SET name=$1 WHERE id=$2 AND project_id=$3', [newName, roleId, projectId]);
    // Cascade rename in auditions for consistency
    await client.query('UPDATE auditions SET role=$1 WHERE project_id=$2 AND role=$3', [newName, projectId, current.name]);
    await client.query('COMMIT');
    return { oldName: current.name, newName };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Soft delete a role (mark as deleted). Existing auditions keep their role text.
async function softDeleteRole(projectId, roleId) {
  const res = await pool.query(
    'UPDATE roles SET is_deleted=TRUE, deleted_at=NOW() WHERE id=$1 AND project_id=$2 AND COALESCE(is_deleted, FALSE)=FALSE',
    [roleId, projectId]
  );
  return res.rowCount > 0;
}

// Restore a previously soft-deleted role
async function restoreRole(projectId, roleId) {
  // Prevent restoring to a duplicate active name
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, name FROM roles WHERE id=$1 AND project_id=$2 AND COALESCE(is_deleted, FALSE)=TRUE', [roleId, projectId]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const role = rows[0];
    const dup = await client.query('SELECT 1 FROM roles WHERE project_id=$1 AND LOWER(name)=LOWER($2) AND COALESCE(is_deleted, FALSE)=FALSE LIMIT 1', [projectId, role.name]);
    if (dup.rows.length > 0) {
      throw new Error('Cannot restore: an active role with the same name exists');
    }
    await client.query('UPDATE roles SET is_deleted=FALSE, deleted_at=NULL WHERE id=$1 AND project_id=$2', [roleId, projectId]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Permanently purge a soft-deleted role row
async function purgeRole(projectId, roleId) {
  const res = await pool.query('DELETE FROM roles WHERE id=$1 AND project_id=$2 AND COALESCE(is_deleted, FALSE)=TRUE', [roleId, projectId]);
  return res.rowCount > 0;
}

// Delete a role from a project (backward-compatible, now soft delete)
async function deleteRole(projectId, roleId) {
  return softDeleteRole(projectId, roleId);
}

module.exports.renameRole = renameRole;
module.exports.deleteRole = deleteRole;
module.exports.softDeleteRole = softDeleteRole;
module.exports.restoreRole = restoreRole;
module.exports.purgeRole = purgeRole;
