require('dotenv').config(); // Load environment variables
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer'); // Added nodemailer import

const express = require('express');
const multer = require('multer'); // Added multer require
const { engine } = require('express-handlebars');
// const Handlebars = require('handlebars'); // No longer directly needed here for SafeString/Utils if helpers are self-contained
const customHelpers = require('./helpers/handlebarsHelpers'); // Import custom helpers
const projectService = require('./services/projectService');
const auditionService = require('./services/auditionService');
const cloudflareUploadService = require('./services/cloudflareUploadService'); // MODIFIED - Correctly import the service
const errorHandler = require('./middleware/errorHandler');
const handlebarsHelpers = require('./helpers/handlebarsHelpers');
const rateLimit = require('express-rate-limit');
const portfolioRoutes = require('./routes/portfolio'); // Define portfolioRoutes

// Add a version log at the top for deployment verification
console.log('INFO: app.js version 2025-06-08_2100_DEBUG running');

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

// Define multer instance for the general /audition route (YouTube upload)
const generalAuditionUpload = multer({ dest: 'uploads/' }); // ADDED

// Routes
app.use('/', portfolioRoutes);

// Route to render audition submission form
app.get('/audition', (req, res) => {
  res.render('audition');
});

// POST route to handle audition form submission and upload to YouTube
app.post('/audition', generalAuditionUpload.single('video'), async (req, res) => { // MODIFIED - Use the new multer instance
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
    const videoId = response.data.id;    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Render beautiful success page for YouTube upload
    const submissionData = {
      actor_name: name || 'Actor',
      email: email,
      role: role,
      video_url: videoId, // For YouTube, we store the video ID
      video_type: 'youtube',
      profile_pictures: [],
      submitted_time: new Date().toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      project: { name: 'General Audition', id: 'general' }
    };
    
    res.render('audition-success', submissionData);
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
app.post('/projects/create', async (req, res, next) => { // Added next
  try { // Added try
    const { name, description, uploadMethod: projectUploadMethod } = req.body;
    const effectiveUploadMethod = projectUploadMethod || 'cloudflare'; // Default to cloudflare

    let rolesInput = req.body.roles;
    if (!name || !rolesInput) {
      return res.status(400).send('Project name and at least one role are required.');
    }
    if (!Array.isArray(rolesInput)) {
      rolesInput = [rolesInput];
    }
    const rolesToCreate = rolesInput.filter(r => r.name && r.name.trim());
    if (rolesToCreate.length === 0) {
      return res.status(400).send('At least one role is required.');
    }

    const finalProjectRoles = [];
    let youtube; // YouTube client, initialized if needed
    const defaultPlaylistId = 'PLjbMUg1d7vaXP1qiq_5z1nB3Uj4P2f1gj';
    let usedDefault = false; // Project-level flag if any role used default YT playlist

    // Initialize YouTube client only if the project is 'youtube' AND some roles might need playlist creation
    if (effectiveUploadMethod === 'youtube' && rolesToCreate.some(r => !(r.playlist && r.playlist.trim()))) {
      if (!process.env.GOOGLE_REFRESH_TOKEN) {
        console.error('PROJECT_CREATE_ERROR: GOOGLE_REFRESH_TOKEN is not set. Cannot create YouTube playlists for a YouTube-designated project if roles are missing playlist URLs.');
        // Pass error to error handler
        const err = new Error('Server configuration error: YouTube integration is not properly set up. Cannot create new YouTube playlists.');
        err.status = 500;
        return next(err);
      }
      oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    }

    for (const role of rolesToCreate) {
      let currentRolePlaylistId = null;

      if (role.playlist && role.playlist.trim()) { // User explicitly provided a playlist URL
        const match = role.playlist.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        currentRolePlaylistId = match ? match[1] : role.playlist.trim();
      } else if (effectiveUploadMethod === 'youtube') { // No playlist provided, AND project is YouTube type
        if (!youtube) { // Should have been initialized if GOOGLE_REFRESH_TOKEN was present
          console.error('PROJECT_CREATE_ERROR: YouTube client not available for YouTube project requiring playlist creation. This might indicate a missing refresh token that wasn\'t caught earlier.');
          // Pass error to error handler
          const err = new Error('Internal server error: YouTube client setup failed for playlist creation. Check server logs and GOOGLE_REFRESH_TOKEN.');
          err.status = 500;
          return next(err);
        }
        
        let retries = 0;
        const maxRetries = 5;
        let delay = 1000;
        let playlistRes = null;
        let createdPlaylistIdForRole = null;
        let usedDefaultForThisRole = false;

        while (retries < maxRetries) {
          try {
            playlistRes = await youtube.playlists.insert({
              part: ['snippet', 'status'],
              requestBody: {
                snippet: {
                  title: `${name} - ${role.name} Auditions`,
                  description: `Auditions for the role of ${role.name} in project ${name}.`,
                },
                status: { privacyStatus: 'unlisted' },
              },
            });
            createdPlaylistIdForRole = playlistRes.data.id;
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
                usedDefaultForThisRole = true; createdPlaylistIdForRole = defaultPlaylistId; break;
              }
              console.warn(`Rate limit hit for playlist creation, retrying (attempt ${retries + 1}/${maxRetries}) for role ${role.name}...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              delay *= 2; retries++; continue;
            } else if (isQuotaExceededError) {
              console.warn(`YouTube API quota exceeded for playlist creation for role ${role.name}. Using default playlist.`);
              usedDefaultForThisRole = true; createdPlaylistIdForRole = defaultPlaylistId; break;
            } else {
              console.error(`Error creating playlist for role ${role.name}:`, err);
              // Pass error to error handler
              const newErr = new Error(`Error creating playlist for role ${role.name} in YouTube project.`);
              newErr.status = 500;
              newErr.details = err && err.response && err.response.data ? JSON.stringify(err.response.data, null, 2) : (err.stack || err.toString());
              return next(newErr);
            }
          }
        }
        if (!createdPlaylistIdForRole) { 
            console.warn(`Playlist ID not obtained for role ${role.name} after attempts. Using default.`);
            createdPlaylistIdForRole = defaultPlaylistId;
            usedDefaultForThisRole = true;
        }
        currentRolePlaylistId = createdPlaylistIdForRole;
        if (usedDefaultForThisRole) usedDefault = true; 
      }
      finalProjectRoles.push({ name: role.name, playlistId: currentRolePlaylistId });
    }

    const project = {
      id: `proj_${Date.now()}`,
      name,
      description,
      uploadMethod: effectiveUploadMethod,
      roles: finalProjectRoles,
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
        console.error('Failed to send email:', err); // Log email error but don't fail the request
      }
    }  // Show all roles and their audition form URLs
    const auditionBaseUrl = `${req.protocol}://${req.get('host')}/audition`;
    
    const projectData = {
      project,
      audition_base_url: auditionBaseUrl,
      used_default_playlist: usedDefault,
      submitted_time: new Date().toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    };
    
    res.render('project-success', projectData);
  } catch (error) { // Added catch
    next(error); // Pass error to the error handler
  }
});

// Route to render project-specific audition form
app.get('/audition/:projectId', async (req, res) => {
  const project = await projectService.getProjectById(req.params.projectId);
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
]), async (req, res, next) => { // Added next for error handling
  // LOGS AT THE VERY START OF THE HANDLER
  console.log(`POST_AUDITION_HANDLER_ENTRY: projectId = ${req.params.projectId}, timestamp = ${new Date().toISOString()}`);
  console.log(`POST_AUDITION_HANDLER_REQ_BODY_RAW: ${JSON.stringify(req.body)}`);
  console.log(`POST_AUDITION_HANDLER_REQ_FILES_RAW: ${JSON.stringify(req.files)}`);

  try {
    console.log(`POST_AUDITION_TRY_BLOCK_START: projectId = ${req.params.projectId}`);
    const project = await projectService.getProjectById(req.params.projectId);

    if (project) {
      console.log(`POST_AUDITION_PROJECT_FETCHED: project ID = ${project.id}, project name = ${project.name}`);
      if (project.roles) {
        console.log(`POST_AUDITION_PROJECT_ROLES_EXIST: Roles count = ${project.roles.length}, Roles type = ${typeof project.roles}, isArray = ${Array.isArray(project.roles)}, Content = ${JSON.stringify(project.roles)}`);
      } else {
        console.log(`POST_AUDITION_PROJECT_ROLES_MISSING: project.roles is null, undefined or falsy.`);
      }
    } else {
      console.log(`POST_AUDITION_PROJECT_NOT_FOUND: Project is null or undefined for projectId = ${req.params.projectId}`);
      // It's crucial to stop if project is not found.
      return res.status(404).send('Project not found');
    }

    // This check is critical. If project was found but roles are bad, log it.
    if (!project.roles || !Array.isArray(project.roles)) {
      console.error(`POST_AUDITION_ROLES_INVALID: Project roles are missing or not an array for project ID: ${req.params.projectId}. Current roles value: ${JSON.stringify(project.roles)}`);
      // If roles are not an array, the .find() will crash.
      // Consider sending an error response here, but for now, let it proceed to the crash line to confirm.
      // return res.status(500).send('Project data is incomplete (roles).');
    }

    const body = req.body;
    console.log(`POST_AUDITION_BODY_CONTENT: ${JSON.stringify(body)}`);
    
    // Defensive check for project and project.roles before the .find() call
    if (!(project && project.roles && Array.isArray(project.roles))) {
      console.error(`POST_AUDITION_PRE_FIND_ERROR: project or project.roles is not in a valid state to call .find(). Project exists: ${!!project}, Roles exist and is array: ${!!(project && project.roles && Array.isArray(project.roles))}`);
      // This indicates a serious issue if we reach here and project.roles is not a findable array.
      return res.status(500).send('Internal server error: project data integrity issue.');
    }
    
    console.log(`POST_AUDITION_BEFORE_FIND: Attempting to find role: "${body.role}" in roles: ${JSON.stringify(project.roles.map(r => r.name))}`);
    const selectedRole = project.roles.find(r => r.name === body.role); // This is the original crashing line area

    if (selectedRole) {
      console.log(`POST_AUDITION_SELECTED_ROLE_FOUND: ${JSON.stringify(selectedRole)}`);
    } else {
      console.error(`POST_AUDITION_ROLE_NOT_FOUND_IN_PROJECT: Role "${body.role}" not found in project ${req.params.projectId}. Available roles: ${project.roles.map(r => r.name).join(', ')}`);
      return res.status(400).send('Selected role not found for this project.');
    }

    const { name, email, phone, message } = body;
    const videoFile = req.files && req.files.video ? req.files.video[0] : null;
    const profilePictureFiles = req.files && req.files.profile_pictures ? req.files.profile_pictures : [];

    console.log(`POST_AUDITION_DATA_EXTRACTED: Name=${name}, Email=${email}, Role=${body.role}`);
    if(videoFile) console.log(`POST_AUDITION_VIDEO_FILE: ${videoFile.originalname}, Path: ${videoFile.path}`);
    console.log(`POST_AUDITION_PROFILE_PICTURE_FILES_COUNT: ${profilePictureFiles.length}`);

    // For Cloudflare upload, use uploadImageToCloudflareImages for profile pictures
    let profilePictureUploadResults = [];
    if (profilePictureFiles && profilePictureFiles.length > 0) {
      profilePictureUploadResults = await Promise.all(profilePictureFiles.map(async (file) => {
        console.log(`POST_AUDITION_UPLOADING_PROFILE_PICTURE: ${file.originalname}`);
        const result = await cloudflareUploadService.uploadImageToCloudflareImages(file);
        // result will be an object like { id: '...', url: '...' }
        console.log(`POST_AUDITION_PROFILE_PICTURE_UPLOADED: ${file.originalname}, ID: ${result.id}, URL: ${result.url}`);
        return result; 
      }));
    } else {
      console.log('POST_AUDITION_NO_PROFILE_PICTURES_UPLOADED');
    }    let videoUploadResult = null;
    let videoType = null;
    let finalVideoUrl = null; // Using a more descriptive name

    if (videoFile) {
      console.log(`POST_AUDITION_UPLOADING_VIDEO: ${videoFile.originalname} for project ${project.id}. Project's uploadMethod: ${project.uploadMethod}`);
      
      if (project.uploadMethod === 'youtube') {
        console.log(`POST_AUDITION_ATTEMPTING_YOUTUBE_UPLOAD: Role: ${selectedRole.name}, Playlist ID: ${selectedRole.playlistId}`);
        if (!REFRESH_TOKEN) {
          console.error('POST_AUDITION_YOUTUBE_ERROR: Google Refresh Token not configured.');
          throw new Error('Google Refresh Token not configured. Cannot upload to YouTube.');
        }
        if (!selectedRole.playlistId) {
          console.warn(`POST_AUDITION_YOUTUBE_WARN: No playlistId found for role ${selectedRole.name} in project ${project.name}. Video will be uploaded without adding to a playlist.`);
        }

        oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        const videoTitle = `Audition: ${body.first_name_en || body.first_name_he} ${body.last_name_en || body.last_name_he} for ${selectedRole.name} in ${project.name}`;
        const videoDescription = `Audition by ${body.first_name_en || body.first_name_he} ${body.last_name_en || body.last_name_he} (${body.email}) for ${selectedRole.name} in ${project.name}. Project ID: ${project.id}. Submitted: ${new Date().toISOString()}`;
        
        try {
          const youtubeResponse = await youtube.videos.insert({
            part: ['snippet', 'status'],
            requestBody: {
              snippet: {
                title: videoTitle,
                description: videoDescription,
                playlistId: selectedRole.playlistId, // This can be null/undefined if not available
              },
              status: {
                privacyStatus: 'unlisted',
              },
            },
            media: {
              body: fs.createReadStream(videoFile.path),
            },
          });

          if (fs.existsSync(videoFile.path)) { // Ensure file exists before unlinking
            fs.unlinkSync(videoFile.path);
          }

          const youtubeVideoId = youtubeResponse.data.id;
          finalVideoUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
          videoType = 'youtube';
          videoUploadResult = { id: youtubeVideoId, url: finalVideoUrl }; 
          console.log(`POST_AUDITION_VIDEO_UPLOADED_YOUTUBE: ${videoFile.originalname}, ID: ${youtubeVideoId}, URL: ${finalVideoUrl}`);
        } catch (ytError) {
          console.error('POST_AUDITION_YOUTUBE_UPLOAD_ERROR: Failed to upload video to YouTube.', ytError);
          if (fs.existsSync(videoFile.path)) { // Clean up temp file on error too
            fs.unlinkSync(videoFile.path);
          }
          throw ytError; // Re-throw to be caught by the main try-catch
        }

      } else { // Default to Cloudflare Stream (if uploadMethod is 'cloudflare' or anything else)
        console.log(`POST_AUDITION_UPLOADING_TO_CLOUDFLARE_STREAM: ${videoFile.originalname}`);
        try {
          const cfStreamResult = await cloudflareUploadService.uploadVideo(videoFile); // uploadVideo already handles unlinking path
          finalVideoUrl = cfStreamResult.uid; 
          videoType = 'cloudflare_stream';
          videoUploadResult = { id: cfStreamResult.uid }; 
          console.log(`POST_AUDITION_VIDEO_UPLOADED_CLOUDFLARE: ${videoFile.originalname}, UID: ${cfStreamResult.uid}`);
        } catch (cfError) {
          console.error('POST_AUDITION_CLOUDFLARE_UPLOAD_ERROR: Failed to upload video to Cloudflare Stream.', cfError);
          // cloudflareUploadService.uploadVideo should handle unlinking its temp file on error
          throw cfError; // Re-throw
        }
      }
    } else {
      console.log('POST_AUDITION_NO_VIDEO_UPLOADED: User submitted audition without video');
      finalVideoUrl = null;
      videoType = null;
    }

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
      profile_pictures: profilePictureUploadResults, 
      showreel_url: body.showreel_url,
      video_url: finalVideoUrl, 
      video_type: videoType 
    };
    // Corrected logging to use req.params.projectId as projectId is not defined in this scope
    console.log(`[App.js POST /audition/:${req.params.projectId}] Prepared audition object: ${JSON.stringify(audition)}`);    await auditionService.insertAudition(audition);
    console.log(`[App.js POST /audition/:${req.params.projectId}] Audition saved successfully.`);
    
    // Render beautiful success page
    const actorName = [body.first_name_he, body.last_name_he, body.first_name_en, body.last_name_en]
      .filter(name => name && name.trim())
      .join(' ') || 'Actor';
    
    const submissionData = {
      project,
      role: body.role,
      actor_name: actorName,
      email: body.email,
      phone: body.phone,
      video_url: finalVideoUrl,
      video_type: videoType,
      profile_pictures: profilePictureUploadResults || [],
      showreel_url: body.showreel_url,
      submitted_time: new Date().toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    };
    
    res.render('audition-success', submissionData);

  } catch (error) {
    console.error(`[App.js POST /audition/:${req.params.projectId}] Critical error in route:`, error.message, error.stack);
    next(error); // Pass to the main error handler
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

const server = app.listen(PORT, () => {
    console.log(`INFO: Server attempting to run on port ${PORT}. Heroku process.env.PORT: ${process.env.PORT}. Timestamp: ${new Date().toISOString()}`);
    // Example: Check DB connection after server starts (if auditionService has such a method)
    if (auditionService && typeof auditionService.checkDbConnection === 'function') {
        auditionService.checkDbConnection()
            .then(() => console.log("INFO: DB connection check successful after server start."))
            .catch(err => console.error("ERROR: DB connection check failed after server start:", err));
    } else {
        console.warn("WARN: auditionService.checkDbConnection function not found. Skipping post-start DB check.");
    }
});

server.on('listening', () => {
    console.log(`INFO: Server successfully listening on port ${PORT}. Timestamp: ${new Date().toISOString()}`);
});

server.on('error', (error) => {
    console.error(`FATAL_SERVER_ERROR: Failed to start/run server on port ${PORT}. Code: ${error.code}, Syscall: ${error.syscall}. Timestamp: ${new Date().toISOString()}`, error);
    if (error.syscall !== 'listen') {
        // If it's not a listen error, it might be an unhandled error during server operation if not caught by route handlers
        // For listen errors, specific handling:
        switch (error.code) {
            case 'EACCES':
                console.error(`FATAL_PERMISSIONS: Port ${PORT} requires elevated privileges.`);
                process.exit(1);
                break;
            case 'EADDRINUSE':
                console.error(`FATAL_PORT_IN_USE: Port ${PORT} is already in use.`);
                process.exit(1);
                break;
            // default: // No default throw here, as it might be an operational error passed to server.on('error')
        }
    }
    // For critical startup errors, ensure the process exits if it can't recover.
    // However, be cautious with process.exit in a web server unless it's truly a fatal startup condition.
});

module.exports = app; // Ensure app is exported if needed for tests or other modules