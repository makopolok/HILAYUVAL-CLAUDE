const express = require('express');
const router = express.Router();
const portfolioService = require('../services/portfolioService');
const projectService = require('../services/projectService');

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
        res.render('editProject', { project, message: req.query.msg || null });
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

// Delete role
router.post('/projects/:projectId/roles/:roleId/delete', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        await projectService.deleteRole(projectId, roleId);
        return res.redirect(`/projects/${projectId}/edit?msg=${encodeURIComponent('Role deleted')}`);
    } catch (err) {
        console.error('PROJECT_DELETE_ROLE_ROUTE_ERROR:', err);
        res.redirect(`/projects/${req.params.projectId}/edit?msg=${encodeURIComponent('Failed to delete role')}`);
    }
});