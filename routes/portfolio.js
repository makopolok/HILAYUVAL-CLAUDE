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
            createdAt: p.created_at ? new Date(p.created_at).toLocaleString('en-GB') : '',
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