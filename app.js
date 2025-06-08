require('dotenv').config(); // Load environment variables
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const express = require('express');
const { engine } = require('express-handlebars');
// const Handlebars = require('handlebars'); // No longer directly needed here for SafeString/Utils if helpers are self-contained
const customHelpers = require('./helpers/handlebarsHelpers'); // Import custom helpers
const errorHandler = require('./middleware/errorHandler');
const portfolioRoutes = require('./routes/portfolio');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // Store uploads temporarily on disk
const projectService = require('./services/projectService');
const nodemailer = require('nodemailer');
const youtubeUploadService = require('./services/youtubeUploadService');
const cloudUploadService = require('./services/cloudUploadService');
const cloudflareUploadService = require('./services/cloudflareUploadService');
const auditionService = require('./services/auditionService');

const app = express();
const PORT = process.env.PORT || 3000;

// Google OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Scopes define the level of access you are requesting.
// For uploading videos and managing playlists, we need both scopes.
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube'
];

// Store authenticated client globally for simplicity in this example
// In a production app, you'd manage tokens more robustly (e.g., store in session or database)
let authenticatedClient = null;
let REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || null; // Load refresh token from .env

// If we have a refresh token, set it on the OAuth2 client
if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

// Handlebars setup
app.engine('handlebars', engine({
    // Helpers defined here are globally available in all Handlebars templates.
    helpers: customHelpers // Use the imported helpers
}));
app.set('view engine', 'handlebars');
app.set('views', './views');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/', portfolioRoutes);

// Route to render audition submission form
app.get('/audition', (req, res) => {
  res.render('audition');
});

// POST route to handle audition form submission and upload to YouTube
app.post('/audition', upload.single('video'), async (req, res) => {
  const { name, email, role } = req.body;
  const videoFile = req.file;

  if (!videoFile) {
    return res.status(400).send('No video file uploaded.');
  }

  try {
    // Set up OAuth2 client with refresh token
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    // Upload video to YouTube
    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: `Audition: ${name}${role ? ' for ' + role : ''}`,
          description: `Audition submitted by ${name} (${email})${role ? ' for role: ' + role : ''}.`,
        },
        status: {
          privacyStatus: 'unlisted', // Not public, but accessible via link
        },
      },
      media: {
        body: fs.createReadStream(videoFile.path),
      },
    });

    // Clean up uploaded file
    fs.unlinkSync(videoFile.path);

    // Get YouTube video link
    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Render a success page or send a response
    res.send(`<h2>Thank you for your submission!</h2><p>Your audition has been received.</p><p>YouTube Link: <a href="${videoUrl}" target="_blank">${videoUrl}</a></p>`);
  } catch (error) {
    console.error('Error uploading audition:', error);
    res.status(500).send(`<h2>Error uploading audition.</h2><pre>${error && error.message ? error.message : error}</pre><pre>${error && error.response && error.response.data ? JSON.stringify(error.response.data, null, 2) : ''}</pre>`);
  }
});

// --- YouTube OAuth Routes ---
// Route to initiate OAuth2 flow
app.get('/auth/google', (req, res) => {
  if (!REFRESH_TOKEN) { // Only redirect if we don't have a refresh token yet
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Important to get a refresh token
      scope: YOUTUBE_SCOPES,
      prompt: 'consent' // Ensures you are prompted for consent, good for the first time
    });
    res.redirect(authUrl);
  } else {
    res.send('Application is already authorized. Refresh token is present.');
  }
});

// Callback route for OAuth2
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (code) {
    try {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      authenticatedClient = oauth2Client; // Store the authorized client

      console.log('Access Token:', tokens.access_token);
      if (tokens.refresh_token) {
        console.log('***************************************************************************');
        console.log('IMPORTANT: Received Refresh Token. ADD THIS TO YOUR .env FILE as GOOGLE_REFRESH_TOKEN:');
        console.log(tokens.refresh_token);
        console.log('***************************************************************************');
        REFRESH_TOKEN = tokens.refresh_token; // Store it for current session
        // In a real app, you'd securely store this refresh_token (e.g., in .env or a secure database)
        // For now, we will log it, and you should manually add it to your .env file.
        res.send('Authentication successful! Refresh token obtained and logged to console. Please add it to your .env file as GOOGLE_REFRESH_TOKEN and restart the server.');
      } else {
        res.send('Authentication successful, but no new refresh token was provided (this is normal if you have authorized before). Ensure GOOGLE_REFRESH_TOKEN is in your .env file.');
      }
    } catch (error) {
      console.error('Error authenticating with Google:', error);
      res.status(500).send('Error during authentication.');
    }
  } else {
    res.status(400).send('Authentication failed: No code provided.');
  }
});
// --- End YouTube OAuth Routes ---

// Route to render the create project form
app.get('/projects/create', (req, res) => {
  res.render('createProject');
});

// Route to handle project creation
app.post('/projects/create', async (req, res) => {
  const { name, description, uploadMethod } = req.body;
  let rolesInput = req.body.roles;
  if (!name || !rolesInput) {
    return res.status(400).send('Project name and at least one role are required.');
  }
  // rolesInput is an array of objects: [{name, playlist}, ...]
  if (!Array.isArray(rolesInput)) {
    // If only one role, it may come as an object
    rolesInput = [rolesInput];
  }
  // Filter out empty role names
  const rolesToCreate = rolesInput.filter(r => r.name && r.name.trim());
  if (rolesToCreate.length === 0) {
    return res.status(400).send('At least one role is required.');
  }
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const playlists = [];
  const defaultPlaylistId = 'PLjbMUg1d7vaXP1qiq_5z1nB3Uj4P2f1gj';
  let usedDefault = false;
  for (const role of rolesToCreate) {
    let playlistId = '';
    if (role.playlist && role.playlist.trim()) {
      // Extract playlistId from URL or use as is
      const match = role.playlist.match(/[?&]list=([a-zA-Z0-9_-]+)/);
      playlistId = match ? match[1] : role.playlist.trim();
    } else {
      // Try to create a new playlist (with exponential backoff)
      let retries = 0;
      const maxRetries = 5;
      let delay = 1000;
      let playlistRes = null;
      while (retries < maxRetries) {
        try {
          playlistRes = await youtube.playlists.insert({
            part: ['snippet', 'status'],
            requestBody: {
              snippet: {
                title: `${name} - ${role.name} Auditions`,
                description: `Auditions for the role of ${role.name} in project ${name}.`,
              },
              status: {
                privacyStatus: 'unlisted',
              },
            },
          });
          playlistId = playlistRes.data.id;
          break;
        } catch (err) {
          const isRateLimitError = err && err.response && err.response.status === 429;
          const isQuotaExceededError = err && err.response && err.response.status === 403 &&
                                     err.response.data && err.response.data.error &&
                                     err.response.data.error.errors && err.response.data.error.errors.length > 0 &&
                                     err.response.data.error.errors[0].reason === 'quotaExceeded';

          if (isRateLimitError) {
            if (retries === maxRetries - 1) {
              console.warn(`Max retries reached for playlist creation (429 error) for role ${role.name}. Using default playlist.`);
              usedDefault = true;
              playlistId = defaultPlaylistId;
              break;
            }
            console.warn(`Rate limit hit for playlist creation, retrying (attempt ${retries + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
            retries++;
            continue;
          } else if (isQuotaExceededError) {
            console.warn(`YouTube API quota exceeded for playlist creation for role ${role.name}. Using default playlist.`);
            usedDefault = true;
            playlistId = defaultPlaylistId;
            break; // No point in retrying if quota is exceeded
          } else {
            console.error(`Error creating playlist for role ${role.name}:`, err);
            let errorDetails = err && err.response && err.response.data ? JSON.stringify(err.response.data, null, 2) : (err.stack || err.toString());
            // Avoid sending raw error details to client in production for security, but useful for dev
            // For now, keeping the detailed error response for debugging.
            return res.status(500).send(`Error creating playlist for role ${role.name}:<br><pre>${errorDetails}</pre>`);
          }
        }
      }
      if (!playlistId) playlistId = defaultPlaylistId;
    }
    playlists.push({ name: role.name, playlistId });
  }

  // Add project to JSON
  const project = {
    id: `proj_${Date.now()}`,
    name,
    description,
    uploadMethod: uploadMethod || 'youtube',
    roles: playlists,
    createdAt: new Date().toISOString(),
    director: req.body.director,
    production_company: req.body.production_company
  };
  await projectService.addProject(project);
  const auditionUrl = `${req.protocol}://${req.get('host')}/audition/${project.id}`;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    try {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: 'emmanuel.delman@gmail.com',
        subject: `New Audition Project Created: ${name}`,
        text: `A new project has been created: ${name}\n\nAudition form link: ${auditionUrl}`,
        html: `<p>A new project has been created: <b>${name}</b></p><p>Audition form link: <a href="${auditionUrl}">${auditionUrl}</a></p>`
      });
    } catch (err) {
      console.error('Failed to send email:', err);
    }
  }
  // Show all roles and their audition form URLs
  let rolesListHtml = '<ul>';
  for (const role of playlists) {
    const formUrl = `${req.protocol}://${req.get('host')}/audition/${project.id}`;
    rolesListHtml += `<li><b>${role.name}</b> &mdash; <a href="${formUrl}" target="_blank">Audition Form</a></li>`;
  }
  rolesListHtml += '</ul>';
  if (usedDefault) {
    return res.send(`<h2>Project created, but some or all roles were assigned to the default playlist due to YouTube quota limits.</h2><p>Please check your YouTube quota or try again later for dedicated playlists.</p>${rolesListHtml}<a href="/projects">Back to Projects</a><pre>${JSON.stringify(project, null, 2)}</pre>`);
  }
  res.send(`<h2>Project created!</h2>${rolesListHtml}<p><a href="/projects/create">Create another</a></p><pre>${JSON.stringify(project, null, 2)}</pre>`);
});

// Route to render project-specific audition form
app.get('/audition/:projectId', (req, res) => {
  const project = projectService.getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).send('Project not found.');
  }
  res.render('audition', { project });
});

// Update multer to handle multiple profile pictures and a video
const auditionUpload = multer({ dest: 'uploads/' });

// Updated POST route to handle project-specific audition form submission and upload
app.post('/audition/:projectId', auditionUpload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'profile_pictures', maxCount: 10 }
]), async (req, res) => {
  const project = projectService.getProjectById(req.params.projectId);
  if (!project) {
    return res.status(404).send('Project not found.');
  }
  const body = req.body;
  const files = req.files;
  // Validate video
  if (!files || !files.video || !files.video[0]) {
    return res.status(400).send('No video file uploaded.');
  }
  // Validate profile pictures
  if (!files.profile_pictures || files.profile_pictures.length === 0) {
    return res.status(400).send('At least one profile picture is required.');
  }
  // Find selected role
  const selectedRole = project.roles.find(r => r.name === body.role);
  if (!selectedRole) {
    return res.status(400).send('Invalid role selected.');
  }
  // Handle video upload (Cloudflare or YouTube)
  let video_url = null;
  let video_type = null;
  try {
    if (project.uploadMethod === 'cloud') {
      // Cloudflare upload
      const result = await cloudflareUploadService.uploadVideo(files.video[0]);
      video_url = result.uid; // Store Cloudflare UID
      video_type = 'cloudflare';
    } else {
      // YouTube upload
      const result = await youtubeUploadService.uploadVideo(files.video[0], body, selectedRole);
      video_url = result.url; // Store YouTube URL
      video_type = 'youtube';
    }
  } catch (err) {
    return res.status(500).send('Video upload failed: ' + err.message);
  }
  // Handle profile picture uploads (just store file paths for now)
  const profilePicturePaths = files.profile_pictures.map(f => f.path);
  // Prepare audition object
  const audition = {
    project_id: project.id,
    role: body.role,
    first_name_he: body.first_name_he,
    last_name_he: body.last_name_he,
    first_name_en: body.first_name_en,
    last_name_en: body.last_name_en,
    phone: body.phone,
    email: body.email,
    agency: body.agency,
    age: body.age,
    height: body.height,
    profile_pictures: profilePicturePaths,
    showreel_url: body.showreel_url,
    video_url,
    video_type
  };
  try {
    await auditionService.insertAudition(audition);
    res.send('<h2>Thank you for your submission!</h2><p>Your audition has been received.</p>');
  } catch (err) {
    res.status(500).send('Failed to save audition: ' + err.message);
  }
});

// Route to list all projects
app.get('/projects', async (req, res) => {
  const projects = await projectService.getAllProjects();
  const { name, email, role } = req.query;
  let filteredProjects = projects;
  // If global search is used, filter projects to only those with matching auditions or role names
  if ((name && name.trim()) || (email && email.trim()) || (role && role.trim())) {
    filteredProjects = projects.map(project => {
      // For each role, filter auditions and/or match role name
      const roles = (project.roles || []).map(r => {
        let auditions = r.auditions || [];
        let roleMatch = false;
        if (role && role.trim()) {
          roleMatch = r.name && r.name.toLowerCase().includes(role.toLowerCase());
        }
        if (name && name.trim()) {
          auditions = auditions.filter(a => a.name && a.name.toLowerCase().includes(name.toLowerCase()));
        }
        if (email && email.trim()) {
          auditions = auditions.filter(a => a.email && a.email.toLowerCase().includes(email.toLowerCase()));
        }
        // If role name matches, show all auditions for that role
        if (roleMatch && !name && !email) {
          return { ...r };
        }
        // Otherwise, only show roles with matching auditions
        return { ...r, auditions };
      }).filter(r => (role && role.trim()) ? (r.name && r.name.toLowerCase().includes(role.toLowerCase())) || (r.auditions && r.auditions.length > 0) : (r.auditions && r.auditions.length > 0));
      return { ...project, roles };
    }).filter(project => project.roles.length > 0);
  }
  res.render('projects', { projects: filteredProjects, query: req.query });
});

// Route to render the edit project form
app.get('/projects/:id/edit', async (req, res) => {
  const project = await projectService.getProjectById(req.params.id);
  if (!project) {
    return res.status(404).send('Project not found.');
  }
  res.render('editProject', { project });
});

// Route to handle adding a new role to a project
app.post('/projects/:id/add-role', async (req, res) => {
  const project = projectService.getProjectById(req.params.id);
  if (!project) {
    return res.status(404).send('Project not found.');
  }
  const { newRole } = req.body;
  if (!newRole || !newRole.trim()) {
    return res.status(400).send('Role name is required.');
  }
  // Check if role already exists
  if (project.roles.some(r => r.name.toLowerCase() === newRole.trim().toLowerCase())) {
    return res.status(400).send('Role already exists in this project.');
  }
  // Exponential backoff for YouTube playlist creation (handles 429 rate limit)
  let retries = 0;
  const maxRetries = 5;
  let delay = 1000; // Start with 1 second
  let playlistRes = null;
  let usedDefault = false;
  while (retries < maxRetries) {
    try {
      oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      playlistRes = await youtube.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: `${project.name} - ${newRole} Auditions`,
            description: `Auditions for the role of ${newRole} in project ${project.name}.`,
          },
          status: {
            privacyStatus: 'unlisted',
          },
        },
      });
      break; // Success, exit loop
    } catch (err) {
      if (err && err.response && err.response.status === 429) {
        // Exponential backoff: wait, then retry
        if (retries === maxRetries - 1) {
          // Use default playlist if quota is exceeded after all retries
          usedDefault = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Double the delay for next retry
        retries++;
        continue;
      } else {
        // Other errors: show details
        console.error(`Error creating playlist for new role ${newRole}:`, err);
        let errorDetails = err && err.response && err.response.data ? JSON.stringify(err.response.data, null, 2) : err.stack || err.toString();
        return res.status(500).send(`Error creating playlist for new role ${newRole}:<br><pre>${errorDetails}</pre>`);
      }
    }
  }
  // If playlist creation succeeded, add the new role; otherwise use default playlist
  const defaultPlaylistId = 'PLjbMUg1d7vaXP1qiq_5z1nB3Uj4P2f1gj';
  const playlistId = usedDefault ? defaultPlaylistId : playlistRes.data.id;
  const newRoleObj = { name: newRole, playlistId };
  await projectService.addRoleToProject(project.id, newRoleObj);
  // Optionally, show a message if default playlist was used
  if (usedDefault) {
    return res.send(`<h2>Role added with default playlist due to YouTube quota limits.</h2><p>The new role <b>${newRole}</b> was assigned to the default playlist. Please check your YouTube quota or try again later for dedicated playlists.</p><a href="/projects/${project.id}/edit">Back to Edit Project</a>`);
  }
  res.redirect(`/projects/${project.id}/edit`);
});

// Route to display all auditions for a project (Cloudflare Stream playlist equivalent)
app.get('/projects/:id/auditions', async (req, res) => {
  const project = projectService.getProjectById(req.params.id);
  if (!project) {
    return res.status(404).send('Project not found.');
  }
  // Fetch all auditions for this project from Postgres
  const { name, email, role } = req.query;
  let query = 'SELECT * FROM auditions WHERE project_id = $1';
  const params = [project.id];
  let paramIdx = 2;
  if (role && role.trim()) {
    query += ` AND role = $${paramIdx++}`;
    params.push(role);
  }
  if (name && name.trim()) {
    query += ` AND (LOWER(first_name_he) LIKE $${paramIdx} OR LOWER(last_name_he) LIKE $${paramIdx} OR LOWER(first_name_en) LIKE $${paramIdx} OR LOWER(last_name_en) LIKE $${paramIdx})`;
    params.push(`%${name.toLowerCase()}%`);
    paramIdx++;
  }
  if (email && email.trim()) {
    query += ` AND LOWER(email) LIKE $${paramIdx}`;
    params.push(`%${email.toLowerCase()}%`);
    paramIdx++;
  }
  query += ' ORDER BY created_at DESC';
  let auditions = [];
  try {
    const { rows } = await auditionService.pool.query(query, params);
    auditions = rows;
  } catch (err) {
    return res.status(500).send('Failed to fetch auditions: ' + err.message);
  }
  // Group auditions by role for the view
  const roles = (project.roles || []).map(r => ({
    name: r.name,
    auditions: auditions.filter(a => a.role === r.name)
  }));
  res.render('auditions', { project: { ...project, roles }, query: req.query });
});

// Error handling
app.use((req, res) => {
    res.status(404).render('error/404');
});

// Add at the end of middleware chain, before app.listen
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;