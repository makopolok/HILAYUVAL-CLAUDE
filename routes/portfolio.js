const express = require('express');
const router = express.Router();
const portfolioService = require('../services/portfolioService');
const projectService = require('../services/projectService');
const { pool } = require('../services/auditionService');

router.get('/', async (req, res) => {
    const projects = await portfolioService.getAllProjects();
    res.render('home', { 
        title: 'Hila Yuval Casting',
        projects 
    });
});

router.get('/projects', async (req, res) => {
    try {
        // Use DB-backed projects for the Projects admin page
        const dbProjects = await projectService.getAllProjects();
        // Normalize/format fields for the template
        const projects = dbProjects.map(p => ({
            id: p.id,
            name: p.name || p.title || '',
            description: p.description || p.storyline || '',
            createdAt: p.created_at ? new Date(p.created_at).toLocaleString('en-IL', { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jerusalem' }) : '',
            upload_method: p.upload_method,
            roles: Array.isArray(p.roles) ? p.roles : []
        }));
        res.render('projects', {
            title: 'Projects - Hila Yuval Casting',
            projects,
            query: req.query || {}
        });
    } catch (err) {
        console.error('PROJECTS_ROUTE_ERROR:', err);
        res.status(500).render('error/500', { message: 'Failed to load projects.' });
    }
});

module.exports = router;

// --- Project edit and roles management ---
// Show edit page for a project (add roles, view existing)
router.get('/projects/:projectId/edit', async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const project = await projectService.getProjectById(projectId);
        if (!project) {
            return res.status(404).render('error/404', { message: 'Project not found.' });
        }
        // Also fetch deleted roles for Undo/Purge section
        const deletedRolesResult = await pool.query('SELECT * FROM roles WHERE project_id=$1 AND COALESCE(is_deleted, FALSE)=TRUE ORDER BY deleted_at DESC NULLS LAST, id DESC', [projectId]);
        const deletedRoles = deletedRolesResult.rows;
        res.render('editProject', { project, deletedRoles, message: req.query.msg || null });
    } catch (err) {
        console.error('PROJECT_EDIT_ROUTE_ERROR:', err);
        res.status(500).render('error/500', { message: 'Failed to load project editor.' });
    }
});

// Add a role to a project
router.post('/projects/:projectId/add-role', async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const roleName = (req.body.newRole || '').toString().trim();
        if (!roleName) {
            return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role name is required')}`);
        }
                const project = await projectService.getProjectById(projectId);
        if (!project) {
            return res.status(404).render('error/404', { message: 'Project not found.' });
        }
                const exists = Array.isArray(project.roles) && project.roles.some(r => (r.name || '').toLowerCase() === roleName.toLowerCase());
                if (exists) {
                        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role already exists')}`);
                }
                // If there is a soft-deleted role with the same name, restore it instead of creating a duplicate row
                const deletedByName = await pool.query(
                    'SELECT id FROM roles WHERE project_id=$1 AND LOWER(name)=LOWER($2) AND COALESCE(is_deleted, FALSE)=TRUE LIMIT 1',
                    [projectId, roleName]
                );
                if (deletedByName.rows.length > 0) {
                    const roleId = deletedByName.rows[0].id;
                    try {
                        await projectService.restoreRole(projectId, roleId);
                        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role restored from Trash')}`);
                    } catch (e) {
                        // Fall back to create if restore fails for unexpected reason
                        console.warn('ADD_ROLE_RESTORE_FAILED_FALLBACK_CREATE:', e.message);
                    }
                }
                await projectService.addRoleToProject(projectId, { name: roleName, playlistId: null });
                return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role added')}`);
    } catch (err) {
        console.error('PROJECT_ADD_ROLE_ROUTE_ERROR:', err);
        res.status(500).render('error/500', { message: 'Failed to add role.' });
    }
});

// Rename role
router.post('/projects/:projectId/roles/:roleId/rename', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        const newName = (req.body.newName || '').toString().trim();
        if (!newName) {
            return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('New name is required')}`);
        }
        await projectService.renameRole(projectId, roleId, newName);
        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role renamed')}`);
    } catch (err) {
        console.error('PROJECT_RENAME_ROLE_ROUTE_ERROR:', err);
        const msg = err && err.message ? err.message : 'Failed to rename role';
        res.redirect(`/projects/${req.params.projectId}/edit?msg=${encodeURIComponent(msg)}`);
    }
});

// Delete role (soft-delete)
router.post('/projects/:projectId/roles/:roleId/delete', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        await projectService.deleteRole(projectId, roleId);
        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role moved to trash')}`);
    } catch (err) {
        console.error('PROJECT_DELETE_ROLE_ROUTE_ERROR:', err);
        res.redirect(`/projects/${req.params.projectId}/edit?msg=${encodeURIComponent('Failed to delete role')}`);
    }
});

// Restore a soft-deleted role
router.post('/projects/:projectId/roles/:roleId/restore', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        const ok = await projectService.restoreRole(projectId, roleId);
        const msg = ok ? 'Role restored' : 'Role not found or not deleted';
        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent(msg)}`);
    } catch (err) {
        console.error('PROJECT_RESTORE_ROLE_ROUTE_ERROR:', err);
        const msg = err && err.message ? err.message : 'Failed to restore role';
        res.redirect(`/projects/${req.params.projectId}/edit?msg=${encodeURIComponent(msg)}`);
    }
});

// Permanently purge a soft-deleted role
router.post('/projects/:projectId/roles/:roleId/purge', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        await projectService.purgeRole(projectId, roleId);
        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role permanently deleted')}`);
    } catch (err) {
        console.error('PROJECT_PURGE_ROLE_ROUTE_ERROR:', err);
        res.redirect(`/projects/${req.params.projectId}/edit?msg=${encodeURIComponent('Failed to permanently delete role')}`);
    }
});