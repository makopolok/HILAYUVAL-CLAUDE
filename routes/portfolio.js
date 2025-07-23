const express = require('express');
const router = express.Router();
const portfolioService = require('../services/portfolioService');

router.get('/', async (req, res) => {
    const projects = await portfolioService.getAllProjects();
    res.render('home', { 
        title: 'Hila Yuval Casting',
        projects 
    });
});

router.get('/projects', async (req, res) => {
    const projects = await portfolioService.getAllProjects();
    res.render('projects', { 
        title: 'Projects - Hila Yuval Casting',
        projects 
    });
});

module.exports = router;