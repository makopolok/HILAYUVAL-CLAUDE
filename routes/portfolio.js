const express = require('express');
const router = express.Router();
const portfolioService = require('../services/portfolioService');
const projectService = require('../services/projectService');
const auditionService = require('../services/auditionService');
const { pool } = auditionService;
const { requireAdmin } = require('../middleware/auth');

router.get('/', async (req, res) => {
    const { projects, featuredProjects } = await portfolioService.getAllProjects();
    res.render('home', { 
        title: 'Hila Yuval Casting',
        projects,
        featuredProjects,
    });
});

router.use('/projects', requireAdmin);

const TAG_COLOR_STYLES = {
    gray:   { bg: '#f1f3f5', hover: '#e9ecef' },
    red:    { bg: '#fff5f5', hover: '#ffe3e3' },
    orange: { bg: '#fff4e6', hover: '#ffe8cc' },
    yellow: { bg: '#fff9db', hover: '#fff3bf' },
    green:  { bg: '#ebfbee', hover: '#d3f9d8' },
    blue:   { bg: '#e7f5ff', hover: '#d0ebff' },
    purple: { bg: '#f8f0fc', hover: '#f3d9fa' }
};

router.get('/projects', async (req, res) => {
    try {
        // Use DB-backed projects for the Projects admin page
        const dbProjects = await projectService.getAllProjects();
        // Normalize/format fields for the template
        const projects = dbProjects.map(p => {
            const colorStyle = p.tag_color ? TAG_COLOR_STYLES[p.tag_color] : null;
            return {
                id: p.id,
                name: p.name || p.title || '',
                description: p.description || p.storyline || '',
                createdAt: p.created_at ? new Date(p.created_at).toLocaleString('en-IL', { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jerusalem' }) : '',
                upload_method: p.upload_method,
                tag_color: p.tag_color || null,
                tag_color_bg: colorStyle ? colorStyle.bg : '',
                tag_color_hover: colorStyle ? colorStyle.hover : '',
                roles: Array.isArray(p.roles) ? p.roles : []
            };
        });

        // Get current Git commit hash and branch dynamically
        let currentCommit = 'unknown';
        let currentBranch = 'development';
        
        console.log('[VERSION_DEBUG] Environment variables check:');
        console.log('[VERSION_DEBUG] HEROKU_SLUG_COMMIT:', process.env.HEROKU_SLUG_COMMIT);
        console.log('[VERSION_DEBUG] SOURCE_VERSION:', process.env.SOURCE_VERSION);
        console.log('[VERSION_DEBUG] HEROKU_RELEASE_VERSION:', process.env.HEROKU_RELEASE_VERSION);
        
        try {
            const { execSync } = require('child_process');
            currentCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
            currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
            console.log('[VERSION_DEBUG] Git commands succeeded:', { currentCommit, currentBranch });
        } catch (error) {
            console.warn('[VERSION_DEBUG] Could not get Git information:', error.message);
            // Fallback: try reading from environment variable (useful for deployed environments)
            if (process.env.HEROKU_SLUG_COMMIT) {
                currentCommit = process.env.HEROKU_SLUG_COMMIT.substring(0, 7);
                console.log('[VERSION_DEBUG] Using HEROKU_SLUG_COMMIT:', currentCommit);
            } else if (process.env.SOURCE_VERSION) {
                currentCommit = process.env.SOURCE_VERSION.substring(0, 7);
                console.log('[VERSION_DEBUG] Using SOURCE_VERSION:', currentCommit);
            } else {
                console.warn('[VERSION_DEBUG] No environment fallback available');
            }
        }
        
        // Add version and deployment information
        const deploymentInfo = {
            commit: currentCommit, // Dynamic commit hash
            version: currentBranch, // Dynamic branch/version name
            branch: 'main (Heroku production)', // Since the app is only run on Heroku
            deployDate: new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }) // Current deployment date
        };
        
        console.log('[VERSION_DEBUG] Final deploymentInfo:', deploymentInfo);

        let trimmedName = (req.query.name || '').toString().trim();
        let trimmedEmail = (req.query.email || '').toString().trim();
        const rawTerm = (req.query.term || '').toString().trim();

        if (rawTerm) {
            if (rawTerm.includes('@')) {
                trimmedEmail = rawTerm;
                trimmedName = '';
            } else {
                trimmedName = rawTerm;
            }
        }

        const searchTerm = rawTerm || trimmedName || trimmedEmail;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        let searchResults = [];
        let searchError = null;
        let searchPerformed = false;
        if (trimmedName || trimmedEmail) {
            searchPerformed = true;
            try {
                const rawResults = await auditionService.searchAuditions({
                    name: trimmedName,
                    email: trimmedEmail,
                    limit,
                    offset,
                });

                const formatOpts = { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' };
                searchResults = rawResults.map((row) => {
                    const enName = [row.first_name_en, row.last_name_en].filter(Boolean).join(' ').trim();
                    const heName = [row.first_name_he, row.last_name_he].filter(Boolean).join(' ').trim();
                    const displayName = [heName, enName].filter(Boolean).join(' ') || 'Unknown performer';
                    const createdAtFormatted = row.created_at ? new Date(row.created_at).toLocaleString('en-IL', formatOpts) : '';
                    return {
                        id: row.id,
                        project_id: row.project_id,
                        project_name: row.project_name,
                        role: row.role,
                        email: row.email,
                        phone: row.phone,
                        display_name: displayName,
                        created_at: row.created_at,
                        created_at_formatted: createdAtFormatted,
                    };
                });
            } catch (searchErr) {
                console.error('[PROJECTS_ROUTE_SEARCH_ERROR]', searchErr);
                searchError = searchErr.message || 'Search failed';
            }
        }

        res.render('projects', {
            title: 'Projects - Hila Yuval Casting',
            projects,
            query: {
                term: searchTerm,
                name: trimmedName,
                email: trimmedEmail,
                limit,
                offset,
            },
            deploymentInfo,
            searchResults,
            searchPerformed,
            searchError,
        });
    } catch (err) {
        console.error('PROJECTS_ROUTE_ERROR:', err);
        res.status(500).render('error/500', { message: 'Failed to load projects.' });
    }
});

router.post('/projects/:projectId/tag-color', async (req, res) => {
    try {
        const projectId = Number(req.params.projectId);
        if (!Number.isInteger(projectId)) {
            return res.status(400).json({ ok: false, error: 'Invalid project id.' });
        }
        const tagColor = req.body ? req.body.tagColor : null;
        const result = await projectService.updateProjectTagColor(projectId, tagColor);
        if (!result.ok) {
            if (result.reason === 'invalid_color') {
                return res.status(400).json({ ok: false, error: 'Invalid color value.' });
            }
            if (result.reason === 'not_found') {
                return res.status(404).json({ ok: false, error: 'Project not found.' });
            }
            return res.status(400).json({ ok: false, error: 'Unable to update color.' });
        }
        const colorStyle = result.row.tag_color ? TAG_COLOR_STYLES[result.row.tag_color] : null;
        return res.json({
            ok: true,
            tagColor: result.row.tag_color,
            tagColorBg: colorStyle ? colorStyle.bg : '',
            tagColorHover: colorStyle ? colorStyle.hover : ''
        });
    } catch (err) {
        console.error('PROJECT_TAG_COLOR_ROUTE_ERROR:', err);
        return res.status(500).json({ ok: false, error: 'Failed to save color.' });
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
    res.render('editProject', { project, deletedRoles });
    } catch (err) {
        console.error('PROJECT_EDIT_ROUTE_ERROR:', err);
        res.status(500).render('error/500', { message: 'Failed to load project editor.' });
    }
});

// Update project description
router.post('/projects/:projectId/update-description', async (req, res) => {
    try {
        const { projectId } = req.params;
        const description = (req.body.description || '').toString().trim();
        await projectService.updateProject(projectId, { description });
        req.flash('success', 'Description updated');
        return res.redirect(`/projects/${projectId}/edit`);
    } catch (err) {
        console.error('PROJECT_UPDATE_DESCRIPTION_ERROR:', err);
        req.flash('error', 'Failed to update description');
        res.redirect(`/projects/${req.params.projectId}/edit`);
    }
});

// Add a role to a project
router.post('/projects/:projectId/add-role', async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const roleName = (req.body.newRole || '').toString().trim();
        if (!roleName) {
            req.flash('error', 'Role name is required');
            return res.redirect(`/projects/${projectId}/edit`);
        }
                const project = await projectService.getProjectById(projectId);
        if (!project) {
            return res.status(404).render('error/404', { message: 'Project not found.' });
        }
                const exists = Array.isArray(project.roles) && project.roles.some(r => (r.name || '').toLowerCase() === roleName.toLowerCase());
                if (exists) {
                        req.flash('error', 'Role already exists');
                        return res.redirect(`/projects/${projectId}/edit`);
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
                        req.flash('success', 'Role restored from Trash');
                        return res.redirect(`/projects/${projectId}/edit`);
                    } catch (e) {
                        // Fall back to create if restore fails for unexpected reason
                        console.warn('ADD_ROLE_RESTORE_FAILED_FALLBACK_CREATE:', e.message);
                    }
                }
                await projectService.addRoleToProject(projectId, { name: roleName, playlistId: null });
                req.flash('success', 'Role added');
                return res.redirect(`/projects/${projectId}/edit`);
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
            req.flash('error', 'New name is required');
            return res.redirect(`/projects/${projectId}/edit`);
        }
        await projectService.renameRole(projectId, roleId, newName);
    req.flash('success', 'Role renamed');
    return res.redirect(`/projects/${projectId}/edit`);
    } catch (err) {
        console.error('PROJECT_RENAME_ROLE_ROUTE_ERROR:', err);
    const msg = err && err.message ? err.message : 'Failed to rename role';
    req.flash('error', msg);
    res.redirect(`/projects/${req.params.projectId}/edit`);
    }
});

// Delete role (soft-delete)
router.post('/projects/:projectId/roles/:roleId/delete', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        await projectService.deleteRole(projectId, roleId);
    req.flash('success', 'Role moved to Trash');
    return res.redirect(`/projects/${projectId}/edit`);
    } catch (err) {
        console.error('PROJECT_DELETE_ROLE_ROUTE_ERROR:', err);
    req.flash('error', 'Failed to delete role');
    res.redirect(`/projects/${req.params.projectId}/edit`);
    }
});

// Restore a soft-deleted role
router.post('/projects/:projectId/roles/:roleId/restore', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        const ok = await projectService.restoreRole(projectId, roleId);
    const msg = ok ? 'Role restored' : 'Role not found or not deleted';
    req.flash(ok ? 'success' : 'error', msg);
    return res.redirect(`/projects/${projectId}/edit`);
    } catch (err) {
        console.error('PROJECT_RESTORE_ROLE_ROUTE_ERROR:', err);
    const msg = err && err.message ? err.message : 'Failed to restore role';
    req.flash('error', msg);
    res.redirect(`/projects/${req.params.projectId}/edit`);
    }
});

// Permanently purge a soft-deleted role
router.post('/projects/:projectId/roles/:roleId/purge', async (req, res) => {
    try {
        const { projectId, roleId } = req.params;
        await projectService.purgeRole(projectId, roleId);
    req.flash('success', 'Role permanently deleted');
    return res.redirect(`/projects/${projectId}/edit`);
    } catch (err) {
        console.error('PROJECT_PURGE_ROLE_ROUTE_ERROR:', err);
    req.flash('error', 'Failed to permanently delete role');
    res.redirect(`/projects/${req.params.projectId}/edit`);
    }
});
