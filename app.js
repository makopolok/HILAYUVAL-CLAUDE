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
const bunnyUploadService = require('./services/bunnyUploadService'); // MODIFIED - Correctly import the service
const errorHandler = require('./middleware/errorHandler');
const handlebarsHelpers = require('./helpers/handlebarsHelpers');
const rateLimit = require('express-rate-limit');
const portfolioRoutes = require('./routes/portfolio'); // Define portfolioRoutes
// Import DB health check
const { checkDbConnection } = require('./services/auditionService');
const bunnyService = require('./services/bunnyUploadService');
const session = require('express-session');
const flash = require('connect-flash');

// Add a version log at the top for deployment verification
console.log('INFO: app.js version 2025-06-08_2100_DEBUG running');

const app = express();
const PORT = process.env.PORT || 3000;

// Canonical domain enforcement (optional). Set APP_PRIMARY_DOMAIN=hilayuval.com in env to enable.
if (process.env.APP_PRIMARY_DOMAIN) {
  const primary = process.env.APP_PRIMARY_DOMAIN.toLowerCase();
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    // Allow localhost & primary & www.primary; redirect everything else to primary.
    const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    const isPrimary = host === primary;
    const isWwwPrimary = host === 'www.' + primary;
    if (!isLocal && !isPrimary && !isWwwPrimary) {
      const target = `https://${primary}${req.originalUrl}`;
      return res.redirect(301, target);
    }
    // Optionally collapse www to root
    if (isWwwPrimary) {
      return res.redirect(301, `https://${primary}${req.originalUrl}`);
    }
    return next();
  });
}

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

// Middleware - Configure for large file uploads
app.use(express.json({ 
  limit: '10mb' // Increase JSON payload limit
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' // Increase URL-encoded payload limit
}));
// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Sessions + flash messages
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax' }
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  next();
});

// Proxy-serving uploaded images from Bunny Storage when no CDN is configured
// This allows using relative URLs like /images/<filename> for uploaded profile pictures.
app.get('/images/:file', async (req, res) => {
  try {
    const file = (req.params.file || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!file) return res.status(400).send('Bad file name');
    const zone = process.env.BUNNY_STORAGE_ZONE;
    const key = process.env.BUNNY_API_KEY;
    const cdnBase = process.env.BUNNY_CDN_BASE_URL;
    // If a CDN base is configured, redirect to the CDN URL (faster + cached)
    if (cdnBase) {
      const url = `${cdnBase.replace(/\/$/, '')}/images/${file}`;
      return res.redirect(302, url);
    }
    if (!zone || !key) return res.status(404).send('Not found');
    const axios = require('axios');
    const upstream = `https://storage.bunnycdn.com/${zone}/images/${file}`;
    const upstreamResp = await axios.get(upstream, {
      responseType: 'stream',
      headers: { 'AccessKey': key },
      validateStatus: () => true,
    });
    if (upstreamResp.status !== 200) {
      return res.status(404).send('Not found');
    }
    // Pass through content-type if provided
    const contentType = upstreamResp.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    // Cache for 7 days at edge and browser
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    upstreamResp.data.pipe(res);
  } catch (e) {
    console.error('IMAGE_PROXY_ERROR:', e.message);
    res.status(500).send('Server error');
  }
});

// Configure multer with comprehensive file size and type restrictions
const multerConfig = {
  dest: 'uploads/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
    files: 12, // Max 12 files per request (1 video + 10 profile pics + buffer)
    fieldSize: 10 * 1024 * 1024, // 10MB max field size
    fields: 50 // Max number of non-file fields
  },
  fileFilter: (req, file, cb) => {
    // Accept videos and images only
    if (file.fieldname === 'video') {
      if (file.mimetype.startsWith('video/')) {
        cb(null, true);
      } else {
        cb(new Error('Only video files are allowed for video uploads'), false);
      }
    } else if (file.fieldname === 'profile_pictures') {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed for profile pictures'), false);
      }
    } else {
      cb(new Error('Unexpected file field'), false);
    }
  }
};

// Define multer instance for the general /audition route (YouTube upload)
const generalAuditionUpload = multer(multerConfig);

// Routes
app.use('/', portfolioRoutes);

// Basic DB health route (lightweight) for debugging connectivity
app.get('/health/db', async (req, res) => {
  const status = await checkDbConnection();
  const envHasUrl = !!process.env.DATABASE_URL;
  res.status(status.ok ? 200 : 500).json({
    service: 'database',
    hasConnectionString: envHasUrl,
    status: status.ok ? 'up' : 'down',
    details: status,
    timestamp: new Date().toISOString()
  });
});

// API: Create a Bunny video stub and return upload info for direct browser upload
// This avoids routing the large file through Heroku. The client will PUT the file directly to Bunny.
app.post('/api/videos', async (req, res) => {
  try {
    const title = (req.query.title || req.body?.title || '').toString().slice(0, 200) || `audition_${Date.now()}`;
    const created = await bunnyService.createVideo(title);
    const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
    // Bunny simple direct upload endpoint: PUT the raw file to /videos/{guid}
    const uploadUrl = `https://video.bunnycdn.com/library/${libId}/videos/${created.guid}`;
    // Return minimal info; DO NOT return AccessKey
    res.json({ guid: created.guid, title: created.title, uploadUrl });
  } catch (e) {
    console.error('API /api/videos create error:', e.message);
    res.status(500).json({ error: 'Failed to create Bunny video' });
  }
});

// Route to render audition submission form
app.get('/audition', (req, res) => {
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID || '';
  const expose = process.env.DIRECT_UPLOAD_EXPOSE_KEY === '1';
  res.render('audition', {
    bunny_stream_library_id: libId,
  upload_method: 'bunny',
    bunny_video_access_key: expose ? (process.env.BUNNY_VIDEO_API_KEY || '') : null,
    direct_upload_exposed: expose
  });
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
      submitted_time: new Date().toLocaleString('en-IL', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem'
      }),
      project: { name: 'General Audition', id: 'general' }
    };
    
  // Inline player toggle
  submissionData.disable_inline_player = process.env.DISABLE_INLINE_PLAYER === '1';
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

// Route to display all projects with version information
app.get('/projects', async (req, res) => {
  try {
    const projects = await projectService.getAllProjects();
    
    // Get current Git commit hash and branch dynamically
    let currentCommit = 'unknown';
    let currentBranch = 'development';
    
    console.log('DEBUG: Starting version info collection...');
    
    try {
      const { execSync } = require('child_process');
      currentCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
      console.log('DEBUG: Git commands successful:', { currentCommit, currentBranch });
    } catch (error) {
      console.warn('Could not get Git information:', error.message);
      // Fallback: try reading from environment variable (useful for deployed environments)
      if (process.env.HEROKU_SLUG_COMMIT) {
        currentCommit = process.env.HEROKU_SLUG_COMMIT.substring(0, 7);
        console.log('DEBUG: Using HEROKU_SLUG_COMMIT:', currentCommit);
      } else {
        console.log('DEBUG: No HEROKU_SLUG_COMMIT found');
      }
    }
    
    console.log('DEBUG: Final version info:', { currentCommit, currentBranch });
    
    // Add version and deployment information
    const deploymentInfo = {
      commit: 'test123', // Test hardcoded value
      version: 'development-test', // Test hardcoded value
      branch: 'main (Heroku production)', // Since the app is only run on Heroku
      deployDate: 'test-date-' + new Date().getTime() // Test timestamp
    };
    
    console.log('DEBUG: deploymentInfo object:', deploymentInfo);
    
    res.render('projects', {
      title: 'Projects',
      projects,
      query: req.query,
      deploymentInfo
    });
  } catch (error) {
    console.error('[App.js GET /projects] Error fetching projects:', error);
    res.status(500).render('error/500', { error });
  }
});

// Route to render the create project form
app.get('/projects/create', (req, res) => {
  res.render('createProject');
});

// Route to handle project creation
app.post('/projects/create', async (req, res, next) => { // Added next
  try { // Added try
  const { name, description, uploadMethod: projectUploadMethod } = req.body;
  const effectiveUploadMethod = projectUploadMethod || 'bunny'; // Default to bunny

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
      name,
      description,
      uploadMethod: effectiveUploadMethod,
      roles: finalProjectRoles,
      createdAt: new Date().toISOString(),
      director: req.body.director,
      production_company: req.body.production_company
    };
    const newProjectId = await projectService.addProject(project);
  // Build audition link using canonical domain if configured
  const baseDomain = process.env.APP_PRIMARY_DOMAIN ? `https://${process.env.APP_PRIMARY_DOMAIN}` : `${req.protocol}://${req.get('host')}`;
  const auditionUrl = `${baseDomain}/audition/${newProjectId}`;
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
  const auditionBaseUrl = `${baseDomain}/audition`;
    
    const projectData = {
      project: { id: newProjectId, ...project, roles: finalProjectRoles },
      audition_base_url: auditionBaseUrl,
      used_default_playlist: usedDefault,
      submitted_time: new Date().toLocaleString('en-IL', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem'
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
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID || '';
  const expose = process.env.DIRECT_UPLOAD_EXPOSE_KEY === '1';
  res.render('audition', { 
    project,
    bunny_stream_library_id: libId,
  upload_method: project && project.uploadMethod ? project.uploadMethod : 'bunny',
    bunny_video_access_key: expose ? (process.env.BUNNY_VIDEO_API_KEY || '') : null,
  direct_upload_exposed: expose
  });
});

// Optional guard for /debug routes (active only if DEBUG_SECRET is set)
// Usage: append ?key=YOUR_SECRET or send header x-debug-secret: YOUR_SECRET
const debugGuard = (req, res, next) => {
  const secret = process.env.DEBUG_SECRET;
  if (!secret) return next(); // No guard if not configured
  const provided = req.query.key || req.headers['x-debug-secret'];
  if (provided && provided === secret) return next();
  return res.status(403).json({ error: 'Forbidden: invalid or missing debug key' });
};
app.use(['/debug', '/debug/*'], debugGuard);

// Debug route to inspect Bunny Stream token computation (does NOT reveal signing key)
app.get('/debug/video/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const pathForToken = `/embed/${libId}/${guid}`;
  let token = null;
  if (process.env.BUNNY_STREAM_SIGNING_KEY) {
    const crypto = require('crypto');
    token = crypto.createHash('md5').update(process.env.BUNNY_STREAM_SIGNING_KEY + pathForToken + expires).digest('hex');
  }
  // Get status via service
  let status = null;
  try {
    status = await bunnyUploadService.getVideoStatus(guid);
  } catch (e) {
    status = { error: e.message };
  }
  res.json({
    guid,
    library: libId,
    tokenPresent: !!token,
  suggestedEmbed: token ? `https://iframe.mediadelivery.net/embed/${libId}/${guid}?token=${token}&expires=${expires}&autoplay=false` : `https://iframe.mediadelivery.net/embed/${libId}/${guid}?autoplay=false`,
    tokenMeta: token ? { expires, ttl, path: pathForToken } : null,
    env: {
      hasSigningKey: !!process.env.BUNNY_STREAM_SIGNING_KEY,
      hasVideoApiKey: !!process.env.BUNNY_VIDEO_API_KEY
    },
    status
  });
});

// Debug: probe iframe embed URL directly from server to see raw status/headers
app.get('/debug/embed/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  // Reconstruct signed URL using same logic
  let base = `https://iframe.mediadelivery.net/embed/${libId}/${guid}`;
  let usedPath = `/embed/${libId}/${guid}`;
  let expires = null; let token = null; let ttl = null; let altTried = false;
  if (process.env.BUNNY_STREAM_SIGNING_KEY) {
    const crypto = require('crypto');
    ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
    expires = Math.floor(Date.now()/1000) + ttl;
    token = crypto.createHash('md5').update(process.env.BUNNY_STREAM_SIGNING_KEY + usedPath + expires).digest('hex');
    base += `?token=${token}&expires=${expires}`;
  }
  const axios = require('axios');
  let resultPrimary = null; let resultAlt = null; let errorPrimary = null; let errorAlt = null;
  try {
    resultPrimary = await axios.get(base, { validateStatus: () => true });
  } catch (e) { errorPrimary = e.message; }
  if (process.env.BUNNY_STREAM_ALT_PATH === '1' && process.env.BUNNY_STREAM_SIGNING_KEY) {
    altTried = true;
    const crypto = require('crypto');
    const altPath = `/iframe/${libId}/${guid}`;
    const altToken = crypto.createHash('md5').update(process.env.BUNNY_STREAM_SIGNING_KEY + altPath + expires).digest('hex');
  const altUrl = `https://iframe.mediadelivery.net/embed/${libId}/${guid}?token=${altToken}&expires=${expires}&autoplay=false`;
    try { resultAlt = await axios.get(altUrl, { validateStatus: () => true }); } catch (e) { errorAlt = e.message; }
    return res.json({
      guid,
      primary: {
        url: base,
        status: resultPrimary && resultPrimary.status,
        headers: resultPrimary && resultPrimary.headers,
        error: errorPrimary || null
      },
      alt: {
        tried: true,
        url: altUrl,
        status: resultAlt && resultAlt.status,
        headers: resultAlt && resultAlt.headers,
        error: errorAlt || null
      },
      signing: { ttl, expires, usedPath, altPathTried: true }
    });
  }
  return res.json({
    guid,
    primary: {
      url: base,
      status: resultPrimary && resultPrimary.status,
      headers: resultPrimary && resultPrimary.headers,
      error: errorPrimary || null
    },
    signing: { ttl, expires, usedPath, altPathTried: altTried }
  });
});

// Advanced: test multiple possible token path variants to pinpoint which path Bunny expects
app.get('/debug/embed-matrix/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  if (!process.env.BUNNY_STREAM_SIGNING_KEY) {
    return res.status(400).json({ error: 'BUNNY_STREAM_SIGNING_KEY not set' });
  }
  const crypto = require('crypto');
  const axios = require('axios');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  // Candidate path variants (leading slash required). Order matters.
  const variants = [
    { name: 'embed', path: `/embed/${libId}/${guid}`, url: `https://iframe.mediadelivery.net/embed/${libId}/${guid}` },
    { name: 'no-embed', path: `/${libId}/${guid}`, url: `https://iframe.mediadelivery.net/embed/${libId}/${guid}` },
    { name: 'iframe', path: `/iframe/${libId}/${guid}`, url: `https://iframe.mediadelivery.net/embed/${libId}/${guid}` }
  ];
  const results = [];
  for (const v of variants) {
    const token = crypto.createHash('md5').update(process.env.BUNNY_STREAM_SIGNING_KEY + v.path + expires).digest('hex');
    const testUrl = `${v.url}?token=${token}&expires=${expires}`;
    let status = null; let headers = null; let error = null;
    try {
      const r = await axios.get(testUrl, { validateStatus: () => true });
      status = r.status; headers = r.headers;
    } catch (e) {
      error = e.message;
    }
    results.push({ variant: v.name, tokenPath: v.path, testUrl, status, error });
  }
  res.json({ guid, library: libId, expires, ttl, results });
});

// Probe underlying HLS/DASH playlist & segment URLs to diagnose 403 origins
app.get('/debug/stream/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  // Bunny typical CDN hostname pattern: vz-<libraryId>-<guid>.b-cdn.net
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  // Candidate playlist paths
  const playlistPaths = [
    '/playlist.m3u8',
    '/manifest/video.m3u8',
    '/video.m3u8'
  ];
  const axios = require('axios');
  const results = [];
  // Optional referer injection for hotlink diagnostics (?ref=https://iframe.mediadelivery.net)
  const injectedRef = req.query.ref;
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  for (const p of playlistPaths) {
    const url = `https://${host}${p}`;
    let headStatus = null, getStatus = null, length = null, contentType = null, error = null, headHeaders = null;
    try {
      const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
      headStatus = h.status; headHeaders = h.headers;
      if (headStatus === 200 || req.query.forceGet === '1') {
        const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
        getStatus = g.status;
        length = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
        contentType = g.headers['content-type'];
      }
    } catch (e) {
      error = e.message;
    }
    results.push({ path: p, url, headStatus, headHeaders, getStatus, lines: length, contentType, error });
  }
  // Try a first segment guess if any playlist succeeded (common pattern: chunk_0.ts)
  let segmentProbe = null;
  const success = results.find(r => r.getStatus === 200);
  if (success) {
    const segUrl = success.url.replace(/\/[^/]+$/, '/chunk_0.ts');
    try {
      const segResp = await axios.head(segUrl, { timeout: 8000, validateStatus: () => true, headers: headersBase });
      segmentProbe = { url: segUrl, status: segResp.status, length: segResp.headers['content-length'] };
    } catch (e) {
      segmentProbe = { url: segUrl, error: e.message };
    }
  }
  res.json({ guid, library: libId, host, injectedRef: injectedRef || null, playlists: results, segmentProbe });
});

// Probe HLS playlists with a SIGNED token (uses server-side signing key)
app.get('/debug/stream-signed/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  // Prefer a dedicated CDN signing key if provided, fall back to EMBED key
  const cdnKey = process.env.BUNNY_STREAM_CDN_SIGNING_KEY || process.env.BUNNY_STREAM_SIGNING_KEY;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  if (!cdnKey) return res.status(400).json({ error: 'No signing key set. Provide BUNNY_STREAM_CDN_SIGNING_KEY (preferred) or BUNNY_STREAM_SIGNING_KEY.' });
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  const playlistPaths = [
    '/playlist.m3u8',
    '/manifest/video.m3u8',
    '/video.m3u8'
  ];
  const crypto = require('crypto');
  const axios = require('axios');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref; // optional Referer
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const includeIp = process.env.BUNNY_STREAM_TOKEN_INCLUDE_IP === '1';
  const results = [];
  for (const p of playlistPaths) {
    // NOTE: Basic CDN token format uses Base64 URL-safe of MD5 RAW bytes
    // token = base64url(md5_raw(key + path + expires [+ ip]))
    const tokenBase = includeIp ? `${cdnKey}${p}${expires}${req.ip || ''}` : `${cdnKey}${p}${expires}`;
    const md5Raw = crypto.createHash('md5').update(tokenBase).digest();
    const token = md5Raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
    const url = `https://${host}${p}?token=${token}&expires=${expires}`;
    let headStatus = null, getStatus = null, length = null, contentType = null, error = null, headHeaders = null;
    try {
      const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
      headStatus = h.status; headHeaders = h.headers;
      if (headStatus === 200 || req.query.forceGet === '1') {
        const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
        getStatus = g.status;
        length = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
        contentType = g.headers['content-type'];
      }
    } catch (e) { error = e.message; }
    results.push({ path: p, url, headStatus, headHeaders, getStatus, lines: length, contentType, error });
  }
  res.json({ 
    guid, library: libId, host, ttl, expires, injectedRef: injectedRef || null, 
    keySource: process.env.BUNNY_STREAM_CDN_SIGNING_KEY ? 'CDN_SIGNING_KEY' : 'EMBED_SIGNING_KEY',
    includeIp,
    results 
  });
});

// Simple index to list available debug endpoints (helps avoid copy/paste URL concatenation mistakes)
app.get('/debug', (req, res) => {
  res.json({
    message: 'Debug utilities',
    note: 'Use endpoints below separately. Do NOT concatenate them.',
    endpoints: [
      '/debug/video/:guid',
      '/debug/embed/:guid',
      '/debug/stream/:guid',
      '/debug/stream-signed/:guid',
  '/debug/stream-matrix/:guid',
  '/debug/stream-adv/:guid',
  '/debug/stream-adv-matrix/:guid',
  '/debug/stream-path/:guid',
  '/debug/stream-adv-path/:guid'
    ],
    example: {
      video: `/debug/video/your-video-guid-here`,
      embed: `/debug/embed/your-video-guid-here`,
      stream: `/debug/stream/your-video-guid-here?ref=https://iframe.mediadelivery.net`,
      streamSigned: `/debug/stream-signed/your-video-guid-here?ref=https://iframe.mediadelivery.net`,
  matrix: `/debug/stream-matrix/your-video-guid-here?ref=https://iframe.mediadelivery.net`,
  adv: `/debug/stream-adv/your-video-guid-here?ref=https://iframe.mediadelivery.net`,
  advMatrix: `/debug/stream-adv-matrix/your-video-guid-here?ref=https://iframe.mediadelivery.net`
    }
  });
});

// Matrix tester: try multiple key sources and IP inclusion settings for HLS token
app.get('/debug/stream-matrix/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  const playlistPaths = ['/playlist.m3u8','/manifest/video.m3u8','/video.m3u8'];
  const crypto = require('crypto');
  const axios = require('axios');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref; // optional Referer
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const embedKey = process.env.BUNNY_STREAM_SIGNING_KEY;
  const cdnKey = process.env.BUNNY_STREAM_CDN_SIGNING_KEY;
  const combos = [];
  if (embedKey) combos.push({ name: 'EMBED_KEY_noIP', key: embedKey, includeIp: false });
  if (embedKey) combos.push({ name: 'EMBED_KEY_withIP', key: embedKey, includeIp: true });
  if (cdnKey) combos.push({ name: 'CDN_KEY_noIP', key: cdnKey, includeIp: false });
  if (cdnKey) combos.push({ name: 'CDN_KEY_withIP', key: cdnKey, includeIp: true });
  if (combos.length === 0) return res.status(400).json({ error: 'No signing keys set. Provide BUNNY_STREAM_SIGNING_KEY and/or BUNNY_STREAM_CDN_SIGNING_KEY.' });
  const matrix = [];
  for (const combo of combos) {
    const perCombo = { combo: combo.name, includeIp: combo.includeIp, results: [] };
    for (const p of playlistPaths) {
      const base = combo.includeIp ? `${combo.key}${p}${expires}${req.ip || ''}` : `${combo.key}${p}${expires}`;
      const md5Raw = crypto.createHash('md5').update(base).digest();
      const token = md5Raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
      const url = `https://${host}${p}?token=${token}&expires=${expires}`;
      let headStatus = null, getStatus = null, length = null, contentType = null, error = null;
      try {
        const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
        headStatus = h.status;
        if (headStatus === 200) {
          const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
          getStatus = g.status;
          length = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
          contentType = g.headers['content-type'];
        }
      } catch (e) { error = e.message; }
      perCombo.results.push({ path: p, url, headStatus, getStatus, lines: length, contentType, error });
    }
    matrix.push(perCombo);
  }
  return res.json({ guid, library: libId, host, ttl, expires, injectedRef: injectedRef || null, serverIpSeen: req.ip || null, haveKeys: { embed: !!embedKey, cdn: !!cdnKey }, matrix });
});

// Advanced SHA256 token probes (modern token auth with optional token_path)
function buildAdvancedToken({ key, signedUrlPath, expires, remoteIp, extraParamsObj }) {
  const crypto = require('crypto');
  // Build the base string: key + signed_url + expiration + optional ip + optional encoded_query_params
  let base = `${key}${signedUrlPath}${expires}`;
  if (remoteIp) base += remoteIp;
  // encoded_query_parameters: keys ascending, form-encoded style key=value without URL encoding in the signature
  if (extraParamsObj && Object.keys(extraParamsObj).length > 0) {
    const keys = Object.keys(extraParamsObj).sort();
    const kv = keys.map(k => `${k}=${extraParamsObj[k]}`).join('&');
    if (kv) base += kv;
  }
  const shaRaw = crypto.createHash('sha256').update(base).digest();
  const token = shaRaw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
  return token;
}

// Try advanced tokens for common variants: no token_path, token_path='/', token_path=directory
app.get('/debug/stream-adv/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const key = process.env.BUNNY_STREAM_CDN_SIGNING_KEY || process.env.BUNNY_STREAM_SIGNING_KEY;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  if (!key) return res.status(400).json({ error: 'Signing key not set' });
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  const axios = require('axios');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref;
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const remoteIp = process.env.BUNNY_STREAM_TOKEN_INCLUDE_IP === '1' ? (req.ip || '') : '';
  const playlistPaths = ['/playlist.m3u8','/manifest/video.m3u8','/video.m3u8'];
  const results = [];
  for (const p of playlistPaths) {
    const dir = p.replace(/\/[^/]*$/, '/'); // directory with trailing slash
    const variants = [
      { name: 'no_token_path', extra: null },
      { name: 'token_path_root', extra: { token_path: '/' } },
      { name: 'token_path_dir', extra: { token_path: dir } }
    ];
    for (const v of variants) {
      const extraForSignature = v.extra ? { ...v.extra } : null;
      const token = buildAdvancedToken({ key, signedUrlPath: v.extra ? (v.extra.token_path) : p, expires, remoteIp, extraParamsObj: extraForSignature });
      // Build URL query: token, expires, and include token_path if set (URL-encoded)
      const qp = new URLSearchParams();
      qp.set('token', token);
      qp.set('expires', String(expires));
      if (v.extra && v.extra.token_path) qp.set('token_path', v.extra.token_path);
      const url = `https://${host}${p}?${qp.toString()}`;
      let headStatus = null, getStatus = null, lines = null, contentType = null, error = null, headHeaders = null;
      try {
        const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
        headStatus = h.status; headHeaders = h.headers;
        if (headStatus === 200 || req.query.forceGet === '1') {
          const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
          getStatus = g.status; contentType = g.headers['content-type'];
          lines = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
        }
      } catch (e) { error = e.message; }
      results.push({ path: p, variant: v.name, url, headStatus, headHeaders, getStatus, lines, contentType, error });
    }
  }
  return res.json({ guid, library: libId, host, ttl, expires, injectedRef: injectedRef || null, keySource: process.env.BUNNY_STREAM_CDN_SIGNING_KEY ? 'CDN_SIGNING_KEY' : 'EMBED_SIGNING_KEY', includeIp: !!remoteIp, results });
});

// Matrix: try both keys and IP options across paths and token_path variants
app.get('/debug/stream-adv-matrix/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const keyEmbed = process.env.BUNNY_STREAM_SIGNING_KEY;
  const keyCdn = process.env.BUNNY_STREAM_CDN_SIGNING_KEY;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  if (!keyEmbed && !keyCdn) return res.status(400).json({ error: 'No signing keys set' });
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  const axios = require('axios');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref;
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const playlistPaths = ['/playlist.m3u8','/manifest/video.m3u8','/video.m3u8'];
  const combos = [];
  if (keyEmbed) combos.push({ name: 'EMBED_noIP', key: keyEmbed, includeIp: false });
  if (keyEmbed) combos.push({ name: 'EMBED_withIP', key: keyEmbed, includeIp: true });
  if (keyCdn) combos.push({ name: 'CDN_noIP', key: keyCdn, includeIp: false });
  if (keyCdn) combos.push({ name: 'CDN_withIP', key: keyCdn, includeIp: true });
  const matrix = [];
  for (const combo of combos) {
    const remoteIp = combo.includeIp ? (req.ip || '') : '';
    const perCombo = { combo: combo.name, includeIp: combo.includeIp, results: [] };
    for (const p of playlistPaths) {
      const dir = p.replace(/\/[^/]*$/, '/');
      const variants = [
        { name: 'no_token_path', extra: null },
        { name: 'token_path_root', extra: { token_path: '/' } },
        { name: 'token_path_dir', extra: { token_path: dir } }
      ];
      for (const v of variants) {
        const extraForSignature = v.extra ? { ...v.extra } : null;
        const token = buildAdvancedToken({ key: combo.key, signedUrlPath: v.extra ? (v.extra.token_path) : p, expires, remoteIp, extraParamsObj: extraForSignature });
        const qp = new URLSearchParams();
        qp.set('token', token); qp.set('expires', String(expires));
        if (v.extra && v.extra.token_path) qp.set('token_path', v.extra.token_path);
        const url = `https://${host}${p}?${qp.toString()}`;
        let headStatus = null, getStatus = null, lines = null, contentType = null, error = null, headHeaders = null;
        try {
          const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
          headStatus = h.status; headHeaders = h.headers;
          if (headStatus === 200 || req.query.forceGet === '1') {
            const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
            getStatus = g.status; contentType = g.headers['content-type'];
            lines = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
          }
        } catch (e) { error = e.message; }
        perCombo.results.push({ path: p, variant: v.name, url, headStatus, headHeaders, getStatus, lines, contentType, error });
      }
    }
    matrix.push(perCombo);
  }
  return res.json({ guid, library: libId, host, ttl, expires, injectedRef: injectedRef || null, haveKeys: { embed: !!keyEmbed, cdn: !!keyCdn }, matrix });
});

// Basic MD5 path-based tokens: https://host/bcdn_token=...&expires=...&token_path=.../playlist.m3u8
app.get('/debug/stream-path/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const key = process.env.BUNNY_STREAM_CDN_SIGNING_KEY || process.env.BUNNY_STREAM_SIGNING_KEY;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  if (!key) return res.status(400).json({ error: 'Signing key not set' });
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  const axios = require('axios');
  const crypto = require('crypto');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref;
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const includeIp = process.env.BUNNY_STREAM_TOKEN_INCLUDE_IP === '1';
  const remoteIp = includeIp ? (req.ip || '') : '';
  const playlistPaths = ['/playlist.m3u8','/manifest/video.m3u8','/video.m3u8'];
  const results = [];
  for (const p of playlistPaths) {
    const dir = p.replace(/\/[^/]*$/, '/');
    const variants = [
      { name: 'no_token_path', token_path: null },
      { name: 'token_path_root', token_path: '/' },
      { name: 'token_path_dir', token_path: dir }
    ];
    for (const v of variants) {
      const base = includeIp ? `${key}${v.token_path ? v.token_path : p}${expires}${remoteIp}` : `${key}${v.token_path ? v.token_path : p}${expires}`;
      const md5Raw = crypto.createHash('md5').update(base).digest();
      const token = md5Raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
      const prefix = `/bcdn_token=${token}&expires=${expires}` + (v.token_path ? `&token_path=${encodeURIComponent(v.token_path)}` : '');
      const url = `https://${host}${prefix}${p}`;
      let headStatus = null, headHeaders = null, getStatus = null, lines = null, contentType = null, error = null;
      try {
        const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
        headStatus = h.status; headHeaders = h.headers;
        if (headStatus === 200 || req.query.forceGet === '1') {
          const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
          getStatus = g.status; contentType = g.headers['content-type'];
          lines = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
        }
      } catch (e) { error = e.message; }
      results.push({ path: p, variant: v.name, url, headStatus, headHeaders, getStatus, lines, contentType, error });
    }
  }
  return res.json({ guid, library: libId, host, ttl, expires, injectedRef: injectedRef || null, includeIp, results });
});

// Advanced SHA256 path-based tokens
app.get('/debug/stream-adv-path/:guid', async (req, res) => {
  const guid = req.params.guid;
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const key = process.env.BUNNY_STREAM_CDN_SIGNING_KEY || process.env.BUNNY_STREAM_SIGNING_KEY;
  if (!guid || !libId) return res.status(400).json({ error: 'Missing guid or library id' });
  if (!key) return res.status(400).json({ error: 'Signing key not set' });
  const host = `vz-${libId}-${guid}.b-cdn.net`;
  const axios = require('axios');
  const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref;
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const includeIp = process.env.BUNNY_STREAM_TOKEN_INCLUDE_IP === '1';
  const remoteIp = includeIp ? (req.ip || '') : '';
  const playlistPaths = ['/playlist.m3u8','/manifest/video.m3u8','/video.m3u8'];
  const results = [];
  for (const p of playlistPaths) {
    const dir = p.replace(/\/[^/]*$/, '/');
    const variants = [
      { name: 'no_token_path', token_path: null },
      { name: 'token_path_root', token_path: '/' },
      { name: 'token_path_dir', token_path: dir }
    ];
    for (const v of variants) {
      const extra = v.token_path ? { token_path: v.token_path } : null;
      // signed_url for advanced path tokens should match token_path if provided; otherwise the full file path
      const signedUrlPath = v.token_path ? v.token_path : p;
      const token = buildAdvancedToken({ key, signedUrlPath, expires, remoteIp, extraParamsObj: extra });
      const prefix = `/bcdn_token=${token}&expires=${expires}` + (v.token_path ? `&token_path=${encodeURIComponent(v.token_path)}` : '');
      const url = `https://${host}${prefix}${p}`;
      let headStatus = null, headHeaders = null, getStatus = null, lines = null, contentType = null, error = null;
      try {
        const h = await axios.head(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
        headStatus = h.status; headHeaders = h.headers;
        if (headStatus === 200 || req.query.forceGet === '1') {
          const g = await axios.get(url, { timeout: 8000, validateStatus: () => true, headers: headersBase });
          getStatus = g.status; contentType = g.headers['content-type'];
          lines = (g.data && typeof g.data === 'string') ? g.data.split('\n').length : null;
        }
      } catch (e) { error = e.message; }
      results.push({ path: p, variant: v.name, url, headStatus, headHeaders, getStatus, lines, contentType, error });
    }
  }
  return res.json({ guid, library: libId, host, ttl, expires, injectedRef: injectedRef || null, includeIp, results });
});

// Update multer to handle multiple profile pictures and a video with enhanced configuration
const auditionUpload = multer(multerConfig);

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

    // For Bunny.net upload, use uploadImage for profile pictures
    let profilePictureUploadResults = [];
    if (profilePictureFiles && profilePictureFiles.length > 0) {
      profilePictureUploadResults = await Promise.all(profilePictureFiles.map(async (file) => {
        console.log(`POST_AUDITION_UPLOADING_PROFILE_PICTURE: ${file.originalname}`);
        const result = await bunnyUploadService.uploadImage(file);
        // result will be an object like { id: '...', url: '...' }
        console.log(`POST_AUDITION_PROFILE_PICTURE_UPLOADED: ${file.originalname}, ID: ${result.id}, URL: ${result.url}`);
        return result; 
      }));
    } else {
      console.log('POST_AUDITION_NO_PROFILE_PICTURES_UPLOADED');
    }

    let videoUploadResult = null;
    let videoType = null;
    let finalVideoUrl = null; // Using a more descriptive name

  if (videoFile) {
      console.log(`POST_AUDITION_UPLOADING_VIDEO: ${videoFile.originalname} for project ${project.id}. Project's uploadMethod: ${project.upload_method}`);
      
      if (project.upload_method === 'youtube') { // MODIFIED HERE
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
        }      } else { // Default to Bunny.net Stream (if uploadMethod is 'cloudflare' or anything else)
        console.log(`POST_AUDITION_UPLOADING_TO_BUNNY_STREAM: ${videoFile.originalname}`);
        try {
          const bunnyResult = await bunnyUploadService.uploadVideo(videoFile);
          finalVideoUrl = bunnyResult.id; // This is the Bunny.net video GUID
          videoType = 'bunny_stream';
          videoUploadResult = { id: bunnyResult.id };
          console.log(`POST_AUDITION_VIDEO_UPLOADED_BUNNY: ${videoFile.originalname}, GUID: ${bunnyResult.id}`);
        } catch (bunnyError) {
          console.error('POST_AUDITION_BUNNY_UPLOAD_ERROR: Failed to upload video to Bunny.net Stream.', bunnyError);
          throw bunnyError;
        }
      }
    } else {
      // Support direct-to-Bunny uploads: client submits a GUID in body.video_url
      const guidFromForm = (body.video_url || '').toString().trim();
      if (guidFromForm && guidFromForm.length > 10) {
        console.log(`POST_AUDITION_DIRECT_BUNNY_GUID_DETECTED: ${guidFromForm}`);
        finalVideoUrl = guidFromForm;
        videoType = 'bunny_stream';
      } else {
        console.log('POST_AUDITION_NO_VIDEO_UPLOADED: User submitted audition without video');
        finalVideoUrl = null;
        videoType = null;
      }
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
      project: { ...project },
      bunny_stream_library_id: process.env.BUNNY_STREAM_LIBRARY_ID, // Correctly access from process.env
      role: body.role,
      actor_name: actorName,
      email: body.email,
      phone: body.phone,
      video_url: finalVideoUrl,
      video_type: videoType,
      profile_pictures: profilePictureUploadResults || [],
      showreel_url: body.showreel_url,
      submitted_time: new Date().toLocaleString('en-IL', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem'
      })
    };

  // Build optional signed Bunny Stream embed URL if signing key provided
  if (videoType === 'bunny_stream' && finalVideoUrl && process.env.BUNNY_STREAM_LIBRARY_ID) {
      try {
        const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
    let embedBase = `https://iframe.mediadelivery.net/embed/${libId}/${finalVideoUrl}`;
        if (process.env.BUNNY_STREAM_SIGNING_KEY) {
            const crypto = require('crypto');
            const ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400); // clamp 1m - 24h
            const expires = Math.floor(Date.now()/1000) + ttl; // validity
            // Try official path first
            const pathsTried = [];
            const key = process.env.BUNNY_STREAM_SIGNING_KEY;
            const primaryPath = `/embed/${libId}/${finalVideoUrl}`;
            pathsTried.push(primaryPath);
            let token = crypto.createHash('md5').update(key + primaryPath + expires).digest('hex');
            let finalSrc = `${embedBase}?token=${token}&expires=${expires}&autoplay=false`;
            // Some configurations (legacy) may expect /iframe instead of /embed
            if (process.env.BUNNY_STREAM_ALT_PATH === '1') {
              const altPath = `/iframe/${libId}/${finalVideoUrl}`;
              pathsTried.push(altPath);
              token = crypto.createHash('md5').update(key + altPath + expires).digest('hex');
              finalSrc = `https://iframe.mediadelivery.net/embed/${libId}/${finalVideoUrl}?token=${token}&expires=${expires}&autoplay=false`;
            }
            embedBase = finalSrc;
            console.log(`BUNNY_EMBED_SIGNED_URL_GENERATED ttl=${ttl}s guid=${finalVideoUrl} paths=${pathsTried.join('|')}`);
        } else {
            console.log(`BUNNY_EMBED_UNSIGNED_URL: ${embedBase}`);
            // Ensure no autoplay on unsigned embeds
            embedBase = `${embedBase}?autoplay=false`;
        }
        submissionData.embed_url = embedBase;
        submissionData.bunny_embed_signed = !!process.env.BUNNY_STREAM_SIGNING_KEY;
      } catch (e) {
        console.warn('BUNNY_EMBED_URL_BUILD_ERROR:', e.message);
      }
    } else if (videoType === 'bunny_stream') {
      console.log('BUNNY_EMBED_MISSING_ENV: Cannot build embed URL - missing video GUID or library ID');
    }
  // Inline player toggle on success page: rely only on global env flag
  const globalDisable = process.env.DISABLE_INLINE_PLAYER === '1';
  submissionData.disable_inline_player = !!globalDisable;
    
    res.render('audition-success', submissionData);
    
  } catch (error) {
    // Enhanced error logging
    console.error(`[App.js POST /audition/:${req.params.projectId}] Critical error in route: ${error.message}`, error);
    res.status(500).render('error/500', { 
      error: {
        message: `An unexpected error occurred during submission. Please try again. If the problem persists, contact support. Error: ${error.message}`
      }
    });
  }
});


// Route to view all auditions for a specific project
app.get('/projects/:projectId/auditions', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const project = await projectService.getProjectById(projectId);
    if (!project) {
      return res.status(404).render('error/404', { message: 'Project not found.' });
    }

  const auditions = await auditionService.getAuditionsByProjectId(projectId, req.query);
    // If Bunny Stream is used, pre-compute signed embed URLs for each audition video
    const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
    const signingKey = process.env.BUNNY_STREAM_SIGNING_KEY;
    let ttl = null, expires = null;
  if (signingKey && libId) {
      ttl = Math.min(Math.max(parseInt(process.env.BUNNY_STREAM_TOKEN_TTL || '3600', 10) || 3600, 60), 86400);
      expires = Math.floor(Date.now()/1000) + ttl;
      const crypto = require('crypto');
      for (const a of auditions) {
        if (a && a.video_type === 'bunny_stream' && a.video_url && a.video_url.length > 10) {
          const pathForToken = `/embed/${libId}/${a.video_url}`;
          const token = crypto.createHash('md5').update(signingKey + pathForToken + expires).digest('hex');
      a.embed_url = `https://iframe.mediadelivery.net/embed/${libId}/${a.video_url}?token=${token}&expires=${expires}&autoplay=false`;
        }
      }
    } else if (libId) {
      for (const a of auditions) {
        if (a && a.video_type === 'bunny_stream' && a.video_url && a.video_url.length > 10) {
      a.embed_url = `https://iframe.mediadelivery.net/embed/${libId}/${a.video_url}?autoplay=false`;
        }
      }
    }
    
    // Format timestamps to Tel Aviv time and group auditions by role for structured display
    for (const a of auditions) {
      if (a && a.created_at) {
        try {
          a.created_at_formatted = new Date(a.created_at).toLocaleString('en-IL', {
            year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
            timeZone: 'Asia/Jerusalem'
          });
        } catch (_) {
          a.created_at_formatted = a.created_at;
        }
      }
    }
    const rolesWithAuditions = project.roles.map(role => {
      return {
        ...role,
        auditions: auditions.filter(a => a.role === role.name)
      };
    });

  // Casting director page: simplify to global flag only (no per-viewer toggle)
  const disableInlineEffective = process.env.DISABLE_INLINE_PLAYER === '1' ? true : false;

    res.render('auditions', { 
      project: { ...project, roles: rolesWithAuditions },
      query: req.query,
      bunny_stream_library_id: process.env.BUNNY_STREAM_LIBRARY_ID, // Pass library ID to the template
      disable_inline_player: disableInlineEffective
    });
  } catch (error) {
    console.error(`[App.js GET /projects/:projectId/auditions] Error fetching auditions:`, error);
    res.status(500).render('error/500', { message: 'Error fetching auditions.' });
  }
});

// API route to check Bunny.net video status
app.get('/api/video-status/:videoGuid', async (req, res, next) => {
  try {
    const { videoGuid } = req.params;
    if (!videoGuid) {
      return res.status(400).json({ error: 'Video GUID is required.' });
    }
    
    console.log(`API_VIDEO_STATUS_CHECK: Checking status for GUID: ${videoGuid}`);
    
    const status = await bunnyUploadService.getVideoStatus(videoGuid);
    
    console.log(`API_VIDEO_STATUS_SUCCESS: Status for GUID ${videoGuid}:`, status);
    res.json(status);
  } catch (error) {
    console.error(`API_VIDEO_STATUS_ERROR: Error checking status for GUID ${req.params.videoGuid}:`, error);
    // Pass a structured error to the client
    res.status(error.response?.status || 500).json({ 
      error: 'Failed to get video status', 
      message: error.message 
    });
  }
});


// Error handling
app.use((req, res) => {
    res.status(404).render('error/404');
});

// Multer error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        let message = 'File upload error: ';
        
        switch (error.code) {
            case 'LIMIT_FILE_SIZE':
                message += 'File too large. Maximum size allowed is 500MB.';
                break;
            case 'LIMIT_FILE_COUNT':
                message += 'Too many files. Maximum 12 files allowed.';
                break;
            case 'LIMIT_FIELD_VALUE':
                message += 'Field value too large.';
                break;
            case 'LIMIT_UNEXPECTED_FILE':
                message += 'Unexpected file upload.';
                break;
            default:
                message += error.message;
        }
        
        console.error('Multer Error:', error);
        return res.status(400).json({ 
            error: 'Upload Error',
            message: message,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
    
    // Handle file filter errors
    if (error.message && error.message.includes('Only video files are allowed')) {
        return res.status(400).json({
            error: 'Invalid File Type',
            message: 'Please upload only video files (MP4, MOV, AVI, etc.) for video submissions.'
        });
    }
    
    if (error.message && error.message.includes('Only image files are allowed')) {
        return res.status(400).json({
            error: 'Invalid File Type', 
            message: 'Please upload only image files (JPG, PNG, GIF, etc.) for profile pictures.'
        });
    }
    
    // Pass other errors to the general error handler
    next(error);
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