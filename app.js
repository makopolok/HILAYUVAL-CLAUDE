require('dotenv').config(); // Load environment variables
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
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
const { buildTokenMeta, clampTtl } = require('./helpers/bunnyToken');
const handlebarsHelpers = require('./helpers/handlebarsHelpers');
const rateLimit = require('express-rate-limit');
const portfolioRoutes = require('./routes/portfolio'); // Define portfolioRoutes
// Import DB health check
const { checkDbConnection } = require('./services/auditionService');
const bunnyService = require('./services/bunnyUploadService');
const session = require('express-session');
const flash = require('connect-flash');
const adminRoutes = require('./routes/adminRoutes');
const agentsRoutes = require('./routes/agentsRoutes');
const uploadIntentService = require('./services/uploadIntentService');
const reconciliationWorker = require('./services/reconciliationWorker');
const { attachAdminToLocals, requireAdmin } = require('./middleware/auth');
const { closePool, getPool } = require('./utils/database');
// Add a version log at the top for deployment verification
console.log('INFO: app.js version 2025-06-08_2200_MANUAL_CHUNKS running');

// In-memory job store for background YouTube uploads
// Keys are jobId strings, values: { status, videoId, videoUrl, error, auditionData }
const uploadJobs = new Map();

// Pending form submissions waiting for video upload (chunk protocol)
// Keys are submissionId, values: { projectId, body, profilePictures, expiry }
const pendingSubmissions = new Map();
const projectSnapshotCache = new Map();
const agencySuggestionsCache = {
  loadedAt: 0,
  value: null,
};
const activeAgentsCatalogCache = {
  loadedAt: 0,
  value: null,
};

const BUILD_INFO_PATH = path.join(__dirname, 'build-info.json');
const TAG_COLOR_STYLES = {
  gray: { bg: '#f1f3f5', hover: '#e9ecef' },
  red: { bg: '#fff5f5', hover: '#ffe3e3' },
  orange: { bg: '#fff4e6', hover: '#ffe8cc' },
  yellow: { bg: '#fff9db', hover: '#fff3bf' },
  green: { bg: '#ebfbee', hover: '#d3f9d8' },
  blue: { bg: '#e7f5ff', hover: '#d0ebff' },
  purple: { bg: '#f8f0fc', hover: '#f3d9fa' }
};
const getBuildInfo = () => {
  try {
    if (fs.existsSync(BUILD_INFO_PATH)) {
      const raw = fs.readFileSync(BUILD_INFO_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed;
    }

  } catch (error) {
    console.warn('[VERSION_DEBUG] Failed to read build-info.json:', error.message);
  }
  return null;
};

function loadAgencySuggestions() {
  const cacheTtlMs = 10 * 60 * 1000;
  if (agencySuggestionsCache.value && (Date.now() - agencySuggestionsCache.loadedAt) < cacheTtlMs) {
    return agencySuggestionsCache.value;
  }

  const suggestions = [];
  const filePath = path.join(__dirname, 'data', 'agency-suggestions.json');

  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        suggestions.push(...parsed);
      }
    }
  } catch (error) {
    console.warn(`[AGENCY_SUGGESTIONS] Failed to load ${filePath}: ${error.message}`);
  }

  const envJson = (process.env.AGENCY_SUGGESTIONS_JSON || '').trim();
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (Array.isArray(parsed)) {
        suggestions.push(...parsed);
      }
    } catch (error) {
      console.warn(`[AGENCY_SUGGESTIONS] Failed to parse AGENCY_SUGGESTIONS_JSON: ${error.message}`);
    }
  }

  const seen = new Set();
  const normalized = suggestions.map((entry) => {
    if (typeof entry === 'string') {
      return { label: entry.trim(), value: entry.trim(), search: entry.trim() };
    }
    if (!entry || typeof entry !== 'object') return null;
    const label = (entry.label || entry.name || entry.hebrew || entry.english || '').toString().trim();
    const value = (entry.value || entry.label || entry.name || entry.english || entry.hebrew || '').toString().trim();
    const search = (entry.search || entry.keywords || '').toString().trim();
    if (!label && !value) return null;
    return { label: label || value, value, search };
  }).filter(Boolean).filter((entry) => {
    const key = `${entry.label}::${entry.value}::${entry.search}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  agencySuggestionsCache.value = normalized;
  agencySuggestionsCache.loadedAt = Date.now();
  return normalized;
}

function loadAgentsCatalog() {
  const cacheTtlMs = 10 * 60 * 1000;
  if (activeAgentsCatalogCache.value && (Date.now() - activeAgentsCatalogCache.loadedAt) < cacheTtlMs) {
    return activeAgentsCatalogCache.value;
  }

  const filePath = path.join(__dirname, 'data', 'agents.seed.json');
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const catalog = Array.isArray(parsed) ? parsed : [];
    activeAgentsCatalogCache.value = catalog;
    activeAgentsCatalogCache.loadedAt = Date.now();
    return catalog;
  } catch (error) {
    console.warn(`[AGENTS] Failed to load catalog: ${error.message}`);
    return [];
  }
}

async function loadActiveAgentsCatalog() {
  const cacheTtlMs = 5 * 60 * 1000;
  if (activeAgentsCatalogCache.value && (Date.now() - activeAgentsCatalogCache.loadedAt) < cacheTtlMs) {
    return activeAgentsCatalogCache.value;
  }

  const result = await dbPool.query(`
    SELECT id, hebrew_name, english_name, phone, email, search_aliases
    FROM agents
    WHERE active = TRUE
    ORDER BY hebrew_name ASC
  `);
  const catalog = result.rows.length ? result.rows : loadAgentsCatalog();
  activeAgentsCatalogCache.value = catalog;
  activeAgentsCatalogCache.loadedAt = Date.now();
  return catalog;
}

function createSignedSubmissionToken(payload) {
  const secret = process.env.SESSION_SECRET || process.env.COOKIE_SECRET || 'default_submission_secret_change_me';
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function parseSignedSubmissionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const secret = process.env.SESSION_SECRET || process.env.COOKIE_SECRET || 'default_submission_secret_change_me';
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expected !== signature) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.expiresAt || parsed.expiresAt <= Date.now()) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

const app = express();
const dbPool = getPool();

// Diagnostic middleware: log non-numeric or prefixed projectId values for investigation
app.use((req, res, next) => {
  try {
    const extractRawProjectId = () => {
      // prefer route params, then query, then body
      if (req.params && req.params.projectId) return req.params.projectId;
      if (req.query && req.query.projectId) return req.query.projectId;
      if (req.body && req.body.projectId) return req.body.projectId;
      return null;
    };
    const raw = extractRawProjectId();
    if (raw && typeof raw === 'string') {
      if (!/^\d+$/.test(raw) || /^proj_\d+$/.test(raw)) {
        const numeric = raw.match(/^proj_(\d+)$/);
        const normalized = numeric ? numeric[1] : null;
        console.info(`DIAG_PROJECTID: raw=${raw} normalized=${normalized} method=${req.method} path=${req.path} referrer=${req.get('referer') || req.get('referrer') || ''} ua=${req.get('user-agent') || ''} ip=${req.ip}`);
      }
    }
  } catch (e) {
    // never block requests for diagnostics
    console.warn('DIAG_PROJECTID_MIDDLEWARE_ERROR', e && e.message);
  }
  return next();
});
const PORT = process.env.PORT || 3000;
const BUNNY_DIRECT_UPLOAD_TTL_SECONDS = Math.max(3600, clampTtl(process.env.BUNNY_DIRECT_UPLOAD_TTL_SECONDS || process.env.BUNNY_STREAM_TOKEN_TTL || '7200'));
const BUNNY_TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || process.env.BUNNY_TURNSTILE_SECRET_KEY || '';
const BUNNY_TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || process.env.BUNNY_TURNSTILE_SITE_KEY || '';
const GA_MEASUREMENT_ID = (process.env.GA_MEASUREMENT_ID || process.env.GOOGLE_ANALYTICS_ID || '').trim();
const BUNNY_DIRECT_UPLOAD_REQUIRE_CAPTCHA = process.env.BUNNY_DIRECT_REQUIRE_CAPTCHA === '1' || Boolean(BUNNY_TURNSTILE_SECRET_KEY);
const BUNNY_DIRECT_UPLOAD_MAX_PER_IP = Number.parseInt(process.env.BUNNY_DIRECT_UPLOAD_MAX_PER_IP || '12', 10);
const BUNNY_DIRECT_UPLOAD_MAX_PER_PROJECT_WINDOW = Number.parseInt(process.env.BUNNY_DIRECT_UPLOAD_MAX_PER_PROJECT_WINDOW || '80', 10);
const BUNNY_DIRECT_UPLOAD_PROJECT_WINDOW_MS = Number.parseInt(process.env.BUNNY_DIRECT_UPLOAD_PROJECT_WINDOW_MS || String(60 * 60 * 1000), 10);
const PROJECT_SNAPSHOT_CACHE_TTL_MS = Number.parseInt(process.env.PROJECT_SNAPSHOT_CACHE_TTL_MS || String(30 * 60 * 1000), 10);
const BUNNY_AUTO_YOUTUBE_ENABLED = process.env.BUNNY_AUTO_YOUTUBE_ENABLED !== '0';
const BUNNY_AUTO_YOUTUBE_DELETE_SOURCE = process.env.BUNNY_AUTO_YOUTUBE_DELETE_SOURCE !== '0';
const BUNNY_AUTO_YOUTUBE_PROJECT_IDS = new Set(
  trimToString(process.env.BUNNY_AUTO_YOUTUBE_PROJECT_IDS)
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
);
const directUploadIntentStore = new Map();
const directUploadProjectQuotaStore = new Map();
const bunnyYoutubeMirrorInFlight = new Set();
const STRICT_AUDITION_PROJECT_IDS = new Set([265, 299]);
const DEFAULT_AUDITION_FORM_RULES = Object.freeze({
  requireHebrewName: true,
  requireProfilePicture: false,
  maxProfilePictures: 10,
  maxProfilePictureBytes: 400 * 1024 * 1024,
  maxProfilePictureSizeMb: 400,
  maxVideoBytes: 400 * 1024 * 1024,
  maxVideoSizeMb: 400,
  maxVideoDurationSeconds: 0,
});
const formatTelAvivDateTime = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString('en-IL', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jerusalem',
    timeZoneName: 'short'
  });
};

function getAuditionFormRules(projectOrId) {
  const projectUploadMethod = projectOrId && typeof projectOrId === 'object'
    ? (projectOrId.upload_method || projectOrId.uploadMethod || '').toString().trim().toLowerCase()
    : '';
  const rawProjectId = projectOrId && typeof projectOrId === 'object'
    ? (projectOrId.id ?? projectOrId.project_id)
    : projectOrId;
  const projectId = Number(rawProjectId);

  if (STRICT_AUDITION_PROJECT_IDS.has(projectId)) {
    const isBunnyIntakeProject = projectId === 299;
    return {
      ...DEFAULT_AUDITION_FORM_RULES,
      requireHebrewName: false,
      requireProfilePicture: true,
      maxProfilePictures: 1,
      profilePictureSingle: true,
      maxProfilePictureBytes: 20 * 1024 * 1024,
      maxProfilePictureSizeMb: 20,
      maxVideoBytes: (isBunnyIntakeProject ? 300 : 150) * 1024 * 1024,
      maxVideoSizeMb: isBunnyIntakeProject ? 300 : 150,
      maxVideoDurationSeconds: 180,
      maxVideoDurationMinutes: 3,
    };
  }

  if (projectUploadMethod === 'bunny_stream') {
    return {
      ...DEFAULT_AUDITION_FORM_RULES,
      maxVideoBytes: 300 * 1024 * 1024,
      maxVideoSizeMb: 300,
      profilePictureSingle: false,
      maxVideoDurationMinutes: 0,
    };
  }

  return {
    ...DEFAULT_AUDITION_FORM_RULES,
    profilePictureSingle: false,
    maxVideoDurationMinutes: 0,
  };
}

function trimToString(value) {
  return (value || '').toString().trim();
}

function normalizeAuditionBody(body = {}) {
  return {
    first_name_he: trimToString(body.first_name_he),
    last_name_he: trimToString(body.last_name_he),
    first_name_en: trimToString(body.first_name_en),
    last_name_en: trimToString(body.last_name_en),
    phone: trimToString(body.phone),
    email: trimToString(body.email).toLowerCase(),
    agency: trimToString(body.agency),
    age: trimToString(body.age),
    height: trimToString(body.height),
    current_location: trimToString(body.current_location),
    about_me: trimToString(body.about_me),
    role: trimToString(body.role),
    showreel_url: trimToString(body.showreel_url),
    video_url: trimToString(body.video_url),
    video_upload_intent: trimToString(body.video_upload_intent),
  };
}

function buildSubmissionProjectSnapshot(project) {
  return {
    id: project.id,
    name: project.name,
    upload_method: project.upload_method || project.uploadMethod || '',
    roles: Array.isArray(project.roles)
      ? project.roles.map((role) => ({
        id: role.id,
        name: role.name,
        playlist_id: role.playlist_id || null,
        youtube_playlist_id: role.youtube_playlist_id || null,
        bunny_collection_id: role.bunny_collection_id || null,
      }))
      : [],
  };
}

function cloneProject(project) {
  return JSON.parse(JSON.stringify(project));
}

function cacheProjectSnapshot(project) {
  const projectId = project && project.id ? String(project.id) : null;
  if (!projectId) return;
  projectSnapshotCache.set(projectId, {
    project: cloneProject(project),
    expiresAt: Date.now() + PROJECT_SNAPSHOT_CACHE_TTL_MS,
  });
}

function getCachedProjectSnapshot(projectId) {
  const key = String(projectId || '').trim();
  if (!key) return null;
  const record = projectSnapshotCache.get(key);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    projectSnapshotCache.delete(key);
    return null;
  }
  return cloneProject(record.project);
}

function findProjectRoleByName(project, roleName) {
  if (!project || !Array.isArray(project.roles)) {
    return null;
  }
  const target = trimToString(roleName);
  if (!target) {
    return null;
  }
  return project.roles.find((role) => trimToString(role.name) === target) || null;
}

function normalizeSiblingProjectName(projectName) {
  return trimToString(projectName)
    .replace(/\s*-\s*bunny\s*$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

async function findSiblingProjectByUploadMethod(sourceProject, targetUploadMethod) {
  if (!sourceProject) {
    return null;
  }

  const siblingKey = normalizeSiblingProjectName(sourceProject.name);
  const normalizedTargetUploadMethod = trimToString(targetUploadMethod).toLowerCase();
  if (!siblingKey || !normalizedTargetUploadMethod) {
    return null;
  }

  const projects = await projectService.getAllProjects();
  return projects.find((project) => (
    Number(project.id) !== Number(sourceProject.id)
    && normalizeSiblingProjectName(project.name) === siblingKey
    && trimToString(project.upload_method || project.uploadMethod).toLowerCase() === normalizedTargetUploadMethod
  )) || null;
}

function isTransientDbTimeoutError(error) {
  if (!error) return false;
  const message = (error.message || '').toLowerCase();
  return (
    message.includes('connection terminated') ||
    message.includes('connection timeout') ||
    message.includes('terminating connection') ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    error.code === '57P01'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertAuditionWithRetry(auditionPayload, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await auditionService.insertAudition(auditionPayload);
    } catch (error) {
      lastError = error;
      if (!isTransientDbTimeoutError(error) || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = 250 * Math.pow(2, attempt);
      console.warn(`AUDITION_INSERT_RETRY: retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function parseYouTubeVideoId(value) {
  const raw = trimToString(value);
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.includes('youtube.com')) {
      const id = parsed.searchParams.get('v');
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
    if (parsed.hostname.includes('youtu.be')) {
      const id = parsed.pathname.replace('/', '');
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function shouldAutoMirrorBunnyProject(project) {
  if (!BUNNY_AUTO_YOUTUBE_ENABLED || !project) return false;
  const uploadMethod = trimToString(project.upload_method || project.uploadMethod).toLowerCase();
  if (uploadMethod !== 'bunny_stream') return false;
  if (BUNNY_AUTO_YOUTUBE_PROJECT_IDS.size === 0) return true;
  return BUNNY_AUTO_YOUTUBE_PROJECT_IDS.has(Number(project.id));
}

async function mirrorAuditionFromBunnyToYoutube({ project, audition }) {
  if (!project || !audition) {
    throw new Error('Missing project or audition for Bunny->YouTube mirror.');
  }

  const auditionKey = `${project.id}:${audition.id}`;
  if (bunnyYoutubeMirrorInFlight.has(auditionKey)) {
    console.log(`AUTO_MIRROR_SKIP_IN_FLIGHT: key=${auditionKey}`);
    return { skipped: true, reason: 'already_in_flight' };
  }
  bunnyYoutubeMirrorInFlight.add(auditionKey);

  let tempDownloadPath = null;
  try {
    if (!process.env.GOOGLE_REFRESH_TOKEN) {
      throw new Error('GOOGLE_REFRESH_TOKEN is not configured.');
    }
    if (trimToString(audition.video_type).toLowerCase() !== 'bunny_stream' || !trimToString(audition.video_url)) {
      return { skipped: true, reason: 'not_bunny_source' };
    }

    const bunnyGuid = trimToString(audition.video_url);
    const youtubeVideoUrl = trimToString(audition.youtube_video_url);
    const existingYoutubeId = parseYouTubeVideoId(audition.youtube_video_id) || parseYouTubeVideoId(youtubeVideoUrl);

    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    let youtubeVideoId = existingYoutubeId;
    let resolvedYoutubeUrl = youtubeVideoUrl;
    if (!youtubeVideoId) {
      const download = await bunnyUploadService.downloadVideoToTemp(bunnyGuid);
      tempDownloadPath = download.path;

      const performerName = [
        audition.first_name_en,
        audition.last_name_en,
        audition.first_name_he,
        audition.last_name_he,
      ].filter(Boolean).join(' ') || 'Audition Performer';
      const title = `${performerName} - ${audition.role_name || audition.role || 'Audition'}`;
      const description = [
        `Audition submitted for project: ${audition.project_name || project.name}`,
        audition.role_name ? `Role: ${audition.role_name}` : null,
        audition.email ? `Email: ${audition.email}` : null,
        audition.phone ? `Phone: ${audition.phone}` : null,
      ].filter(Boolean).join('\n');
      const videoMetadata = {
        snippet: { title, description },
        status: { privacyStatus: 'unlisted' },
      };

      const uploadResponse = await uploadToYouTubeResumable(
        youtube,
        { path: tempDownloadPath, originalname: `${performerName}-audition.mp4` },
        videoMetadata
      );
      youtubeVideoId = trimToString(uploadResponse?.data?.id);
      if (!youtubeVideoId) {
        throw new Error('YouTube did not return a video ID.');
      }
      resolvedYoutubeUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
    }

    const verifyResponse = await youtube.videos.list({ part: ['id'], id: [youtubeVideoId] });
    const existsOnYouTube = Array.isArray(verifyResponse?.data?.items) && verifyResponse.data.items.length > 0;
    if (!existsOnYouTube) {
      throw new Error(`YouTube video verification failed for ID ${youtubeVideoId}.`);
    }
    if (!resolvedYoutubeUrl) {
      resolvedYoutubeUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
    }

    const sourceRole = audition.role_id
      ? (Array.isArray(project.roles)
        ? project.roles.find((role) => Number(role.id) === Number(audition.role_id))
        : null)
      : findProjectRoleByName(project, audition.role_name || audition.role);
    if (sourceRole) {
      const playlistId = await ensureRolePlaylist(youtube, project, sourceRole);
      try {
        await addVideoToYouTubePlaylist(youtube, youtubeVideoId, playlistId);
      } catch (playlistError) {
        // Playlist assignment is best-effort for auto mirror; do not block
        // YouTube verification + Bunny cleanup on transient playlist API issues.
        console.warn(
          `AUTO_MIRROR_PLAYLIST_WARN: project=${project.id} audition=${audition.id} videoId=${youtubeVideoId} err=${playlistError.message}`
        );
      }
    }

    await auditionService.updateAuditionYoutubeData(audition.id, {
      youtubeVideoId,
      youtubeVideoUrl: resolvedYoutubeUrl,
    });

    // Schedule Bunny deletion 4 days in the future (safety window for recovery)
    const deletionScheduledAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    await db.query(
      'UPDATE auditions SET bunny_deletion_scheduled_at = $1 WHERE id = $2',
      [deletionScheduledAt, audition.id]
    );

    await auditionService.markAuditionYoutubePrimary(audition.id, {
      youtubeVideoId,
      youtubeVideoUrl: resolvedYoutubeUrl,
    });
    console.log(`AUTO_MIRROR_DONE_SCHEDULED_BUNNY_DELETE: project=${project.id} audition=${audition.id} videoId=${youtubeVideoId} deleteAt=${deletionScheduledAt.toISOString()}`);

    return {
      skipped: false,
      youtubeVideoId,
      youtubeVideoUrl: resolvedYoutubeUrl,
      deletedBunnySource: false,
      bunnyDeletionScheduledAt: deletionScheduledAt,
    };
  } finally {
    if (tempDownloadPath) {
      fs.promises.unlink(tempDownloadPath).catch(() => undefined);
    }
    bunnyYoutubeMirrorInFlight.delete(auditionKey);
  }
}

async function getProjectByIdWithCache(projectId, contextLabel = 'unknown') {
  try {
    const project = await projectService.getProjectById(projectId);
    if (project) {
      cacheProjectSnapshot(project);
    }
    return project;
  } catch (error) {
    if (isTransientDbTimeoutError(error)) {
      const cached = getCachedProjectSnapshot(projectId);
      if (cached) {
        console.warn(`PROJECT_CACHE_FALLBACK_USED: context=${contextLabel} projectId=${projectId}`);
        return cached;
      }
    }
    throw error;
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  if (!/^[0-9\-+() ]+$/.test(value)) {
    return false;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isValidRomanName(value) {
  return /^[A-Za-z][A-Za-z\s.'-]*$/.test(value);
}

function buildAuditionFullName(firstName, lastName) {
  return [trimToString(firstName), trimToString(lastName)].filter(Boolean).join(' ').trim();
}

function getAuditionPreferredSortName(audition) {
  const hebrewName = buildAuditionFullName(audition.first_name_he, audition.last_name_he);
  if (hebrewName) {
    return { name: hebrewName, locales: ['he', 'en'] };
  }

  const englishName = buildAuditionFullName(audition.first_name_en, audition.last_name_en);
  if (englishName) {
    return { name: englishName, locales: ['en', 'he'] };
  }

  return { name: '', locales: ['en', 'he'] };
}

function compareAuditionsByPreferredName(a, b) {
  const aName = getAuditionPreferredSortName(a);
  const bName = getAuditionPreferredSortName(b);

  if (!aName.name && !bName.name) {
    return (a.id || 0) - (b.id || 0);
  }

  if (!aName.name) return 1;
  if (!bName.name) return -1;

  const locales = aName.locales[0] === 'he' || bName.locales[0] === 'he'
    ? ['he', 'en']
    : ['en', 'he'];
  const nameCompare = aName.name.localeCompare(bName.name, locales, {
    sensitivity: 'base',
    ignorePunctuation: true,
    numeric: true,
  });

  if (nameCompare !== 0) {
    return nameCompare;
  }

  const aEnglishName = buildAuditionFullName(a.first_name_en, a.last_name_en);
  const bEnglishName = buildAuditionFullName(b.first_name_en, b.last_name_en);
  const englishCompare = aEnglishName.localeCompare(bEnglishName, ['en', 'he'], {
    sensitivity: 'base',
    ignorePunctuation: true,
    numeric: true,
  });

  if (englishCompare !== 0) {
    return englishCompare;
  }

  return (a.id || 0) - (b.id || 0);
}

function compareAuditionsByNewest(a, b) {
  const aTime = a && a.created_at ? new Date(a.created_at).getTime() : 0;
  const bTime = b && b.created_at ? new Date(b.created_at).getTime() : 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return (b && b.id ? b.id : 0) - (a && a.id ? a.id : 0);
}

function compareRolesByName(a, b) {
  const aName = trimToString(a && a.name);
  const bName = trimToString(b && b.name);

  if (!aName && !bName) {
    return (a && a.id ? a.id : 0) - (b && b.id ? b.id : 0);
  }
  if (!aName) return 1;
  if (!bName) return -1;

  const nameCompare = aName.localeCompare(bName, ['he', 'en'], {
    sensitivity: 'base',
    ignorePunctuation: true,
    numeric: true,
  });

  if (nameCompare !== 0) {
    return nameCompare;
  }

  return (a && a.id ? a.id : 0) - (b && b.id ? b.id : 0);
}

function validateAuditionBody({ body, project, rules }) {
  const errors = [];

  if (rules.requireHebrewName) {
    if (!body.first_name_he) errors.push('Please enter the first name in Hebrew.');
    if (!body.last_name_he) errors.push('Please enter the last name in Hebrew.');
  }

  if (!body.first_name_en) errors.push('Please enter the first name in English.');
  if (!body.last_name_en) errors.push('Please enter the last name in English.');
  if (body.first_name_en && !isValidRomanName(body.first_name_en)) {
    errors.push('First name in English must use Roman letters only.');
  }
  if (body.last_name_en && !isValidRomanName(body.last_name_en)) {
    errors.push('Last name in English must use Roman letters only.');
  }

  if (!body.phone) {
    errors.push('Please enter a phone number.');
  } else if (!isValidPhone(body.phone)) {
    errors.push('Please enter a valid phone number.');
  }

  if (!body.email) {
    errors.push('Please enter an email address.');
  } else if (!isValidEmail(body.email)) {
    errors.push('Please enter a valid email address.');
  }

  if (body.showreel_url && !isValidHttpUrl(body.showreel_url)) {
    errors.push('Please enter a valid showreel link starting with http:// or https://.');
  }

  if (body.age) {
    const age = Number.parseInt(body.age, 10);
    if (!Number.isInteger(age) || age < 1 || age > 120) {
      errors.push('Please enter a valid age between 1 and 120.');
    }
  }

  if (body.height) {
    const height = Number.parseInt(body.height, 10);
    if (!Number.isInteger(height) || height < 50 || height > 250) {
      errors.push('Please enter a valid height between 50 and 250 cm.');
    }
  }

  if (body.first_name_en.length > 100 || body.last_name_en.length > 100) {
    errors.push('Names must be 100 characters or fewer.');
  }
  if ((body.first_name_he && body.first_name_he.length > 100) || (body.last_name_he && body.last_name_he.length > 100)) {
    errors.push('Hebrew names must be 100 characters or fewer.');
  }
  if (body.agency.length > 120) {
    errors.push('Agency must be 120 characters or fewer.');
  }
  if (body.current_location.length > 160) {
    errors.push('Current location must be 160 characters or fewer.');
  }
  if (body.about_me.length > 1200) {
    errors.push('About me must be 1200 characters or fewer.');
  }

  const roles = project && Array.isArray(project.roles) ? project.roles : [];
  if (roles.length > 0) {
    if (!body.role) {
      errors.push('Please select a role.');
    } else if (!roles.some((role) => role.name === body.role)) {
      errors.push('Please select a valid role for this project.');
    }
  }

  return errors;
}

function validateAuditionFiles({ rules, videoFile, profilePictureFiles, requireVideo, validatePictures = true }) {
  const errors = [];
  const pictures = Array.isArray(profilePictureFiles) ? profilePictureFiles : [];

  if (validatePictures) {
    if (rules.requireProfilePicture && pictures.length !== 1) {
      errors.push('Please upload exactly one profile picture.');
    }
    if (pictures.length > rules.maxProfilePictures) {
      errors.push(`You can upload up to ${rules.maxProfilePictures} profile picture${rules.maxProfilePictures === 1 ? '' : 's'}.`);
    }

    pictures.forEach((file) => {
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        errors.push(`"${file.originalname}" is not a valid image file.`);
      }
      if (typeof file.size === 'number' && file.size > rules.maxProfilePictureBytes) {
        errors.push(`"${file.originalname}" is too large. Profile pictures must be ${rules.maxProfilePictureSizeMb}MB or smaller.`);
      }
    });
  }

  if (requireVideo && !videoFile) {
    errors.push('Please upload a self-tape video.');
  }

  if (videoFile) {
    if (!videoFile.mimetype || !videoFile.mimetype.startsWith('video/')) {
      errors.push('Please upload a valid video file.');
    }
    if (typeof videoFile.size === 'number' && videoFile.size > rules.maxVideoBytes) {
      errors.push(`Video files must be ${rules.maxVideoSizeMb}MB or smaller for this audition.`);
    }
  }

  return errors;
}

async function cleanupUploadedFiles(files = []) {
  await Promise.all(files
    .filter((file) => file && file.path)
    .map((file) => fs.promises.unlink(file.path).catch(() => undefined)));
}

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

const YOUTUBE_TOKEN_MONITOR_ENABLED = process.env.YOUTUBE_TOKEN_MONITOR_ENABLED !== '0';
const YOUTUBE_TOKEN_MONITOR_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.YOUTUBE_TOKEN_MONITOR_INTERVAL_MS) || 24 * 60 * 60 * 1000
);
const YOUTUBE_TOKEN_MONITOR_INITIAL_DELAY_MS = Math.max(
  30 * 1000,
  Number(process.env.YOUTUBE_TOKEN_MONITOR_INITIAL_DELAY_MS) || 5 * 60 * 1000
);
const YOUTUBE_TOKEN_MONITOR_ALERT_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.YOUTUBE_TOKEN_MONITOR_ALERT_COOLDOWN_MS) || 6 * 60 * 60 * 1000
);

let youtubeTokenMonitorInterval = null;
let youtubeTokenMonitorInitialTimeout = null;
let youtubeTokenMonitorInFlight = false;
let youtubeTokenLastAlertAt = 0;

function getYoutubeTokenAlertRecipient() {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (adminEmails.length > 0) return adminEmails[0];
  if (process.env.ADMIN_EMAIL) return process.env.ADMIN_EMAIL.trim();
  if (process.env.SMTP_USER) return process.env.SMTP_USER.trim();
  return null;
}

async function sendYoutubeTokenAlert(subject, text) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('YOUTUBE_TOKEN_MONITOR_ALERT_SKIPPED: SMTP not configured.');
    return;
  }
  const recipient = getYoutubeTokenAlertRecipient();
  if (!recipient) {
    console.warn('YOUTUBE_TOKEN_MONITOR_ALERT_SKIPPED: no recipient configured.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: recipient,
    subject,
    text,
  });
}

async function runYoutubeTokenHealthCheck() {
  const hasRefreshToken = !!process.env.GOOGLE_REFRESH_TOKEN;
  const hasClientId = !!process.env.GOOGLE_CLIENT_ID;
  const hasClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  const hasRedirectUri = !!process.env.GOOGLE_REDIRECT_URI;

  if (!hasRefreshToken || !hasClientId || !hasClientSecret || !hasRedirectUri) {
    return {
      ok: false,
      reason: 'missing_config',
      httpStatus: null,
      config: { hasRefreshToken, hasClientId, hasClientSecret, hasRedirectUri },
    };
  }

  try {
    const healthClient = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    healthClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const { token } = await healthClient.getAccessToken();
    const youtube = google.youtube({ version: 'v3', auth: healthClient });
    const channels = await youtube.channels.list({ part: ['id'], mine: true });
    const channelCount = Array.isArray(channels?.data?.items) ? channels.data.items.length : 0;
    return {
      ok: true,
      accessTokenIssued: !!token,
      channelCount,
      reason: null,
      httpStatus: 200,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || 'youtube_token_check_failed',
      httpStatus: error?.response?.status || null,
      config: { hasRefreshToken, hasClientId, hasClientSecret, hasRedirectUri },
    };
  }
}

function stopYoutubeTokenMonitor() {
  if (youtubeTokenMonitorInitialTimeout) {
    clearTimeout(youtubeTokenMonitorInitialTimeout);
    youtubeTokenMonitorInitialTimeout = null;
  }
  if (youtubeTokenMonitorInterval) {
    clearInterval(youtubeTokenMonitorInterval);
    youtubeTokenMonitorInterval = null;
  }
}

function startYoutubeTokenMonitor() {
  if (!YOUTUBE_TOKEN_MONITOR_ENABLED) {
    console.log('YOUTUBE_TOKEN_MONITOR_DISABLED');
    return;
  }
  const dynoName = (process.env.DYNO || '').trim();
  if (dynoName && dynoName !== 'web.1') {
    console.log(`YOUTUBE_TOKEN_MONITOR_SKIPPED: DYNO=${dynoName}`);
    return;
  }
  stopYoutubeTokenMonitor();

  const runOnce = async () => {
    if (youtubeTokenMonitorInFlight) return;
    youtubeTokenMonitorInFlight = true;
    try {
      const result = await runYoutubeTokenHealthCheck();
      if (result.ok) {
        console.log(`YOUTUBE_TOKEN_MONITOR_OK: channels=${result.channelCount}`);
      } else {
        console.error(`YOUTUBE_TOKEN_MONITOR_FAIL: reason=${result.reason} status=${result.httpStatus || 'n/a'}`);
        const now = Date.now();
        if (now - youtubeTokenLastAlertAt >= YOUTUBE_TOKEN_MONITOR_ALERT_COOLDOWN_MS) {
          youtubeTokenLastAlertAt = now;
          const subject = '[HilaYuval] YouTube token health check failed';
          const text = [
            `Time: ${new Date(now).toISOString()}`,
            `Reason: ${result.reason}`,
            `HTTP status: ${result.httpStatus || 'n/a'}`,
            `Config: ${JSON.stringify(result.config || {})}`,
            '',
            'Uploads to YouTube may fail until GOOGLE_REFRESH_TOKEN is refreshed.',
          ].join('\n');
          await sendYoutubeTokenAlert(subject, text);
        }
      }
    } catch (monitorError) {
      console.error(`YOUTUBE_TOKEN_MONITOR_RUN_ERROR: ${monitorError.message}`);
    } finally {
      youtubeTokenMonitorInFlight = false;
    }
  };

  youtubeTokenMonitorInitialTimeout = setTimeout(() => {
    runOnce().catch(() => {});
    youtubeTokenMonitorInterval = setInterval(() => {
      runOnce().catch(() => {});
    }, YOUTUBE_TOKEN_MONITOR_INTERVAL_MS);
  }, YOUTUBE_TOKEN_MONITOR_INITIAL_DELAY_MS);
  youtubeTokenMonitorInitialTimeout.unref();

  console.log(
    `YOUTUBE_TOKEN_MONITOR_STARTED: initialDelayMs=${YOUTUBE_TOKEN_MONITOR_INITIAL_DELAY_MS} intervalMs=${YOUTUBE_TOKEN_MONITOR_INTERVAL_MS}`
  );
}

// Handlebars setup
app.engine('handlebars', engine({
    // Helpers defined here are globally available in all Handlebars templates.
    helpers: customHelpers // Use the imported helpers
}));
app.set('view engine', 'handlebars');
app.set('views', './views');
// Required on Heroku (and any reverse-proxy setup) so Express sees the real client IP.
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// Set global request timeout to 1 hour (3600000 ms) to accommodate very large YouTube uploads (90MB+)
// Individual routes can override this if needed
app.use((req, res, next) => {
  // Socket timeout: when socket has no data for this long, close it
  req.socket.setTimeout(60 * 60 * 1000); // 1 hour
  // Request timeout: when request processing takes this long, abort
  req.setTimeout(60 * 60 * 1000); // 1 hour
  res.setTimeout(60 * 60 * 1000); // 1 hour
  next();
});

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
  const shouldTrackPage = req.path === '/' || req.path.startsWith('/audition/');
  res.locals.ga_measurement_id = shouldTrackPage ? GA_MEASUREMENT_ID : '';
  next();
});
app.use(attachAdminToLocals);

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
    fileSize: 400 * 1024 * 1024, // 400MB max file size (~7 min 1080p @ 8Mbps)
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

// --- YouTube playlist helpers ---

// Ensure a role has a YouTube playlist. Creates one if missing and persists the ID.
// A valid YouTube playlist ID starts with 'PL' and is at least 18 chars.
function isValidYouTubePlaylistId(id) {
  // YouTube playlist IDs start with 'PL' and can be any length (typically 13-34 chars total)
  return typeof id === 'string' && /^PL[a-zA-Z0-9_-]{5,}$/.test(id);
}

function getRolePlaylistTitle(role) {
  return String(role && role.name ? role.name : '').trim().toUpperCase();
}

async function createAndPersistYouTubePlaylist(youtube, project, role, maxRetries = 3) {
  let lastError;
  let delay = 1000; // Start with 1 second
  
  for (let retries = 0; retries <= maxRetries; retries++) {
    try {
      const res = await youtube.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: getRolePlaylistTitle(role),
            description: `Auditions for role: ${role.name} | Project: ${project.name}`,
          },
          status: { privacyStatus: 'unlisted' },
        },
      });
      const playlistId = res.data.id;
      await projectService.updateRoleYouTubePlaylistId(role.id, playlistId);
      role.youtube_playlist_id = playlistId;
      console.log(`YOUTUBE_PLAYLIST_CREATED: role=${role.name} project=${project.name} playlistId=${playlistId} (attempt ${retries + 1}/${maxRetries + 1})`);
      return playlistId;
    } catch (err) {
      lastError = err;
      const isRateLimitError = err && err.response && err.response.status === 429;
      const isQuotaExceededError = err && err.response && err.response.status === 403 &&
                                 err.response.data && err.response.data.error &&
                                 err.response.data.error.errors && err.response.data.error.errors.length > 0 &&
                                 err.response.data.error.errors[0].reason === 'quotaExceeded';
      
      if (isRateLimitError && retries < maxRetries) {
        console.warn(`YOUTUBE_PLAYLIST_RATE_LIMITED: role=${role.name} project=${project.name}. Retrying in ${delay}ms (attempt ${retries + 1}/${maxRetries + 1})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      if (isQuotaExceededError) {
        console.error(`YOUTUBE_PLAYLIST_QUOTA_EXCEEDED: role=${role.name} project=${project.name}`);
        throw new Error(`YouTube API quota exceeded when creating playlist for ${role.name}. Please contact support.`);
      }
      
      console.error(`YOUTUBE_PLAYLIST_CREATE_ERROR: role=${role.name} project=${project.name} attempt ${retries + 1}/${maxRetries + 1}. Error: ${err.message}`);
      if (retries >= maxRetries) {
        throw err;
      }
      // For other transient errors, retry
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  
  throw lastError || new Error(`Failed to create playlist for ${role.name} after ${maxRetries + 1} attempts`);
}

async function ensureRolePlaylist(youtube, project, role, skipValidation = true) {
  // If we have a valid cached playlist ID and skipValidation is true (default for audition submissions),
  // just use it without making extra API calls. This reduces rate limit pressure.
  if (skipValidation && isValidYouTubePlaylistId(role.youtube_playlist_id)) {
    console.log(`YOUTUBE_PLAYLIST_CACHED: role=${role.name} project=${project.name} playlistId=${role.youtube_playlist_id}`);
    return role.youtube_playlist_id;
  }

  // Full validation: check if the playlist still exists on YouTube
  if (isValidYouTubePlaylistId(role.youtube_playlist_id)) {
    try {
      const check = await youtube.playlists.list({
        part: ['id'],
        id: [role.youtube_playlist_id],
        mine: true,
        maxResults: 1,
      });
      const items = (check && check.data && Array.isArray(check.data.items)) ? check.data.items : [];
      if (items.length > 0) {
        console.log(`YOUTUBE_PLAYLIST_VALIDATED: role=${role.name} project=${project.name} playlistId=${role.youtube_playlist_id}`);
        return role.youtube_playlist_id;
      }

      console.warn(`YOUTUBE_PLAYLIST_NOT_OWNED_OR_INACCESSIBLE: role=${role.name} project=${project.name} playlistId=${role.youtube_playlist_id}. Recreating.`);
      return await createAndPersistYouTubePlaylist(youtube, project, role);
    } catch (err) {
      console.warn(`YOUTUBE_PLAYLIST_VALIDATION_FAILED: role=${role.name} project=${project.name} playlistId=${role.youtube_playlist_id} err=${err.message}. Recreating.`);
      return await createAndPersistYouTubePlaylist(youtube, project, role);
    }
  }

  return await createAndPersistYouTubePlaylist(youtube, project, role);
}

// Add an already-uploaded YouTube video to a playlist.
async function addVideoToYouTubePlaylist(youtube, videoId, playlistId, maxRetries = 3) {
  let lastError;
  let delay = 1000; // Start with 1 second
  
  for (let retries = 0; retries <= maxRetries; retries++) {
    try {
      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: { kind: 'youtube#video', videoId },
          },
        },
      });
      console.log(`YOUTUBE_PLAYLIST_ITEM_ADDED: videoId=${videoId} playlistId=${playlistId} (attempt ${retries + 1}/${maxRetries + 1})`);
      return;
    } catch (err) {
      lastError = err;
      const status = err && err.response ? err.response.status : null;
      const apiErrors = err && err.response && err.response.data && err.response.data.error && Array.isArray(err.response.data.error.errors)
        ? err.response.data.error.errors
        : [];
      const reasons = apiErrors
        .map((entry) => trimToString(entry && entry.reason))
        .filter(Boolean);
      const isRateLimitError = status === 429;
      const isServiceUnavailableConflict = status === 409 && reasons.includes('SERVICE_UNAVAILABLE');
      const isServerError = status >= 500 && status < 600;
      const isNetworkTransient = err && (
        err.code === 'ETIMEDOUT'
        || err.code === 'ECONNRESET'
        || err.code === 'ENOTFOUND'
        || err.code === 'ECONNREFUSED'
      );
      const isRetryable = isRateLimitError || isServiceUnavailableConflict || isServerError || isNetworkTransient;
      const isAlreadyInPlaylist = status === 409 && (
        reasons.includes('videoAlreadyInPlaylist')
        || reasons.includes('playlistItemAlreadyExists')
        || reasons.includes('duplicate')
      );

      if (isAlreadyInPlaylist) {
        console.warn(`YOUTUBE_PLAYLIST_ITEM_ALREADY_EXISTS: videoId=${videoId} playlistId=${playlistId} reasons=${reasons.join(',') || 'unknown'}`);
        return;
      }
      
      if (isRetryable && retries < maxRetries) {
        console.warn(
          `YOUTUBE_PLAYLIST_ITEM_RETRYABLE_ERROR: videoId=${videoId} playlistId=${playlistId} status=${status || 'n/a'} reasons=${reasons.join(',') || 'unknown'}. Retrying in ${delay}ms (attempt ${retries + 1}/${maxRetries + 1})...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      // For non-retryable errors or final retry exhausted, throw
      console.error(`YOUTUBE_PLAYLIST_ITEM_ADD_ERROR: videoId=${videoId} playlistId=${playlistId} attempt ${retries + 1}/${maxRetries + 1}. Error: ${err.message}`);
      throw err;
    }
  }
  
  throw lastError || new Error(`Failed to add video ${videoId} to playlist ${playlistId} after ${maxRetries + 1} attempts`);
}

// Resumable upload helper for large files (>50MB)
async function uploadToYouTubeResumable(youtube, videoFile, videoMetadata, maxRetries = 3) {
  const MAX_RETRIES = maxRetries;
  let lastError;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let fileStream;
    try {
     // Ensure absolute path
     const filePath = path.isAbsolute(videoFile.path) ? videoFile.path : path.resolve(videoFile.path);
     const fileSize = fs.statSync(filePath).size;
     console.log(`[YouTube Upload] Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${videoFile.originalname} (${fileSize} bytes, ~${(fileSize / (1024*1024)).toFixed(1)}MB)`);
      
     // For memory efficiency, stream chunks from disk instead of loading entire file
     // This prevents memory spikes during concurrent uploads
     const CHUNK_SIZE = 256 * 1024; // 256KB chunks
     let sessionUri;
      
     try {
       // Step 1: Initialize resumable upload session with YouTube
       console.log(`[YouTube Upload] Initializing resumable session...`);
       const initResponse = await youtube.videos.insert(
         {
           part: ['snippet', 'status'],
           requestBody: videoMetadata,
           media: {
             mimeType: 'video/mp4',
             body: Buffer.from(''), // Empty body for initialization
           },
         },
         {
           // Request resumable upload initialization only
           headers: {
             'X-Goog-Upload-Protocol': 'resumable',
             'X-Goog-Upload-Command': 'start',
             'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
             'X-Goog-Upload-Header-Content-Type': 'video/mp4',
           },
         }
       ).catch(err => {
         // If YouTube returns a session URI in the Location header
         if (err && err.response && err.response.headers && err.response.headers['x-goog-upload-session-uri']) {
           return { 
             sessionUri: err.response.headers['x-goog-upload-session-uri'],
             initialized: true
           };
         }
         throw err;
       });
        
       if (initResponse.sessionUri) {
         sessionUri = initResponse.sessionUri;
       } else if (initResponse.data && initResponse.data.id) {
         // Upload completed immediately (unlikely for large files)
         console.log(`[YouTube Upload] Success: ${videoFile.originalname} -> ${initResponse.data.id}`);
         return initResponse;
       }
     } catch (initError) {
       console.warn(`[YouTube Upload] Failed to initialize resumable session: ${initError.message}`);
       // Fall back to regular upload
       fileStream = fs.createReadStream(filePath);
     }
      
     // If no session URI, do regular upload
     if (!sessionUri) {
       fileStream = fs.createReadStream(filePath);
       const response = await youtube.videos.insert(
         {
           part: ['snippet', 'status'],
           requestBody: videoMetadata,
           media: {
             mimeType: 'video/mp4',
             body: fileStream,
           },
         }
       );
       console.log(`[YouTube Upload] Success: ${videoFile.originalname} -> ${response.data.id}`);
       return response;
     }
      
     // Step 2: Stream file in chunks via resumable session (memory efficient)
     let uploadedBytes = 0;
     const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
      
     console.log(`[YouTube Upload] Uploading in ${totalChunks} chunks of ${CHUNK_SIZE/1024}KB each...`);
      
     // Open file stream for reading chunks
     const readStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
      
     // Queue to ensure chunks are sent sequentially
     let chunkIndex = 0;
     const chunks = [];
      
     // Read all chunks (but don't load entire file at once into memory due to backpressure)
     await new Promise((resolve, reject) => {
       readStream.on('data', (chunk) => {
         chunks.push(chunk);
       });
       readStream.on('end', resolve);
       readStream.on('error', reject);
     });
      
     // Now upload chunks sequentially
     for (let i = 0; i < chunks.length; i++) {
       const chunk = chunks[i];
       const chunkStart = i * CHUNK_SIZE;
       const chunkEnd = Math.min(chunkStart + chunk.length, fileSize);
        
       try {
         // Upload this chunk
         const uploadResponse = await new Promise((resolve, reject) => {
           const headers = {
             'Content-Type': 'video/mp4',
             'Content-Length': chunk.length.toString(),
             'Content-Range': `bytes ${chunkStart}-${chunkEnd - 1}/${fileSize}`,
           };
            
           const req = https.request(
             sessionUri,
             { method: 'PUT', headers, timeout: 30000 },
             (res) => {
               let body = '';
               res.on('data', (chunk) => { body += chunk; });
               res.on('end', () => {
                 if (res.statusCode >= 200 && res.statusCode < 300) {
                   resolve({ statusCode: res.statusCode, body });
                 } else if (res.statusCode === 308 || (res.statusCode >= 300 && res.statusCode < 400)) {
                   // Resume incomplete - expect more chunks
                   resolve({ statusCode: res.statusCode, body });
                 } else {
                   reject(new Error(`YouTube returned ${res.statusCode}: ${body}`));
                 }
               });
             }
           );
            
           req.on('timeout', () => {
             req.destroy();
             reject(new Error('Chunk upload timeout'));
           });
           req.on('error', reject);
           req.write(chunk);
           req.end();
         });
          
         uploadedBytes = chunkEnd;
         const progress = Math.round((uploadedBytes / fileSize) * 100);
         const chunkNum = i + 1;
         console.log(`[YouTube Upload] Chunk ${chunkNum}/${chunks.length} (${progress}%): ${uploadedBytes}/${fileSize} bytes`);
          
         // Parse response if upload completed
         if (uploadResponse.statusCode < 300 && uploadResponse.body) {
           try {
             const finalResponse = JSON.parse(uploadResponse.body);
             if (finalResponse.id) {
               console.log(`[YouTube Upload] ✅ Success: ${videoFile.originalname} -> ${finalResponse.id}`);
               return { data: finalResponse };
             }
           } catch (e) {
             // JSON parse error, likely not final response yet
           }
         }
       } catch (chunkError) {
         console.error(`[YouTube Upload] ❌ Chunk ${i + 1}/${chunks.length} failed at ${uploadedBytes}/${fileSize}: ${chunkError.message}`);
         throw chunkError;
       }
     }
      
     console.log(`[YouTube Upload] All chunks uploaded, confirming with YouTube...`);
     throw new Error('Upload chunks completed but YouTube did not return video ID');
    } catch (error) {
     if (fileStream && !fileStream.destroyed) {
       fileStream.destroy();
     }
      
     lastError = error;
     const isRateLimitError = error && error.response && error.response.status === 429;
     const isTimeoutError = error.code === 'ETIMEDOUT' || 
                            error.code === 'ECONNRESET' ||
                            error.code === 'ENOTFOUND' ||
                            (error.message && (error.message.includes('timeout') || error.message.includes('Connection terminated') || error.message.includes('Aborted')));
      
     const isRetryable = 
       isRateLimitError ||
       isTimeoutError ||
       error.code === 'ECONNREFUSED' ||
       (error.status && error.status >= 500) ||
       (error.message && (error.message.includes('timeout') || error.message.includes('ECONNRESET')));
      
     if (isRetryable && attempt < MAX_RETRIES) {
       const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
       if (isRateLimitError) {
         console.warn(`[YouTube Upload] Rate limited (429 attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${error.message}. Retrying in ${waitTime}ms...`);
       } else if (isTimeoutError) {
         console.warn(`[YouTube Upload] Connection timeout (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${error.code || error.message}. Retrying in ${waitTime}ms...`);
       } else {
         console.warn(`[YouTube Upload] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${error.code || error.message}. Retrying in ${waitTime}ms...`);
       }
       await new Promise(resolve => setTimeout(resolve, waitTime));
       continue;
     }
      
     console.error(`[YouTube Upload] Non-retryable error or max retries exceeded (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${error.code || error.message}`);
     if (error.response && error.response.status) {
       console.error(`[YouTube Upload] HTTP Status: ${error.response.status}, Message: ${error.response.statusText || 'Unknown'}`);
     }
     throw error;
    }
  }
  
  throw lastError || new Error('Unknown error uploading to YouTube');
}


// --- Bunny collection helpers ---

// A valid Bunny collection GUID is a UUID (8-4-4-4-12 hex)
function isValidBunnyCollectionId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// Ensure a role has a Bunny collection. Creates one if missing and persists the GUID.
async function ensureBunnyCollection(project, role) {
  if (isValidBunnyCollectionId(role.bunny_collection_id)) return role.bunny_collection_id;

  const collectionName = `${project.name} — ${role.name}`;
  const guid = await bunnyUploadService.createCollection(collectionName);
  await projectService.updateRoleBunnyCollectionId(role.id, guid);
  role.bunny_collection_id = guid;
  console.log(`BUNNY_COLLECTION_CREATED: role=${role.name} project=${project.name} guid=${guid}`);
  return guid;
}

function cleanupExpiredDirectUploadIntents() {
  const now = Date.now();
  for (const [intentToken, entry] of directUploadIntentStore.entries()) {
    if (!entry || entry.expiresAtMs <= now || entry.used) {
      directUploadIntentStore.delete(intentToken);
    }
  }
}

async function registerDirectUploadIntent({ guid, projectId, roleName, ipAddress }) {
  cleanupExpiredDirectUploadIntents();
  const intentToken = crypto.randomUUID();
  const expiresAtMs = Date.now() + (BUNNY_DIRECT_UPLOAD_TTL_SECONDS * 1000);
  directUploadIntentStore.set(intentToken, {
    guid,
    projectId: projectId ? String(projectId) : null,
    roleName: roleName ? String(roleName) : null,
    ipAddress: ipAddress || null,
    expiresAtMs,
    used: false,
  });

  // Durable, cross-dyno store (survives restarts/deploys). Best-effort: if the DB
  // write fails we still return the token so upload sessions are not blocked by
  // transient DB slowness — the in-memory copy covers the single-dyno hot path.
  try {
    await uploadIntentService.createIntent({
      intentToken,
      guid,
      projectId: projectId || null,
      roleName: roleName || null,
      ipAddress: ipAddress || null,
      expiresAt: new Date(expiresAtMs),
    });
  } catch (error) {
    console.warn(`UPLOAD_INTENT_DB_WRITE_WARN: guid=${guid} err=${error.message}`);
  }

  return intentToken;
}

async function consumeDirectUploadIntent({ intentToken, guid, projectId, roleName, ipAddress }) {
  cleanupExpiredDirectUploadIntents();
  if (!intentToken) {
    return { ok: false, reason: 'missing_intent' };
  }

  // DB is the source of truth. Fall back to the in-memory Map only when the DB
  // has no record of the token (rollout window / intent created on another dyno
  // before this deploy) or when the DB itself is unreachable.
  try {
    const dbResult = await uploadIntentService.consumeIntent({ intentToken, guid, projectId, roleName, ipAddress });
    if (dbResult.ok) {
      directUploadIntentStore.delete(intentToken);
      return { ok: true };
    }
    if (dbResult.reason !== 'intent_not_found') {
      return dbResult;
    }
    // intent_not_found in DB → try legacy in-memory path below.
  } catch (error) {
    console.warn(`UPLOAD_INTENT_DB_CONSUME_WARN: falling back to memory guid=${guid} err=${error.message}`);
  }

  return consumeDirectUploadIntentFromMemory({ intentToken, guid, projectId, roleName, ipAddress });
}

function consumeDirectUploadIntentFromMemory({ intentToken, guid, projectId, roleName, ipAddress }) {
  const record = directUploadIntentStore.get(intentToken);
  if (!record) {
    return { ok: false, reason: 'intent_not_found' };
  }
  if (record.used) {
    return { ok: false, reason: 'intent_already_used' };
  }
  if (record.guid !== guid) {
    return { ok: false, reason: 'intent_guid_mismatch' };
  }
  if (record.projectId && String(projectId) !== record.projectId) {
    return { ok: false, reason: 'intent_project_mismatch' };
  }
  if (record.roleName && String(roleName) !== record.roleName) {
    return { ok: false, reason: 'intent_role_mismatch' };
  }
  if (record.ipAddress && ipAddress && record.ipAddress !== ipAddress) {
    return { ok: false, reason: 'intent_ip_mismatch' };
  }
  record.used = true;
  directUploadIntentStore.set(intentToken, record);
  return { ok: true };
}

function consumeProjectUploadQuota(projectId) {
  const key = projectId ? String(projectId) : 'global';
  const now = Date.now();
  const existing = directUploadProjectQuotaStore.get(key);
  if (!existing || existing.windowStartMs + BUNNY_DIRECT_UPLOAD_PROJECT_WINDOW_MS <= now) {
    directUploadProjectQuotaStore.set(key, { windowStartMs: now, count: 1 });
    return true;
  }
  if (existing.count >= BUNNY_DIRECT_UPLOAD_MAX_PER_PROJECT_WINDOW) {
    return false;
  }
  existing.count += 1;
  directUploadProjectQuotaStore.set(key, existing);
  return true;
}

async function verifyTurnstileToken(token, ipAddress) {
  if (!BUNNY_DIRECT_UPLOAD_REQUIRE_CAPTCHA) {
    return { ok: true };
  }
  if (!BUNNY_TURNSTILE_SECRET_KEY) {
    return { ok: false, reason: 'captcha_not_configured' };
  }
  if (!token) {
    return { ok: false, reason: 'captcha_missing' };
  }

  try {
    const body = new URLSearchParams();
    body.set('secret', BUNNY_TURNSTILE_SECRET_KEY);
    body.set('response', token);
    if (ipAddress) body.set('remoteip', ipAddress);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const payload = await response.json();
    if (payload && payload.success) {
      return { ok: true };
    }
    return { ok: false, reason: 'captcha_failed' };
  } catch (error) {
    console.error('TURNSTILE_VERIFY_ERROR:', error.message);
    return { ok: false, reason: 'captcha_verify_error' };
  }
}

const directUploadCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number.isFinite(BUNNY_DIRECT_UPLOAD_MAX_PER_IP) ? BUNNY_DIRECT_UPLOAD_MAX_PER_IP : 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload attempts from this network. Please wait and try again.' },
});

// Routes
app.use('/admin', adminRoutes);
app.use('/admin', agentsRoutes);
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

// Basic YouTube token health route for fast diagnostics.
// Requires admin so token validity cannot be probed publicly.
app.get('/health/youtube-token', requireAdmin, async (req, res) => {
  try {
    const result = await runYoutubeTokenHealthCheck();
    if (!result.ok) {
      return res.status(503).json({
        service: 'youtube-token',
        status: 'down',
        reason: result.reason,
        httpStatus: result.httpStatus,
        config: result.config || null,
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(200).json({
      service: 'youtube-token',
      status: 'up',
      accessTokenIssued: result.accessTokenIssued,
      channelCount: result.channelCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({
      service: 'youtube-token',
      status: 'down',
      reason: error?.message || 'youtube_token_check_failed',
      httpStatus: error?.response?.status || null,
      timestamp: new Date().toISOString(),
    });
  }
});

// API: Create Bunny video + signed direct-upload credentials (TUS)
app.post('/api/videos', directUploadCreateLimiter, async (req, res) => {
  try {
    const title = (req.query.title || req.body?.title || '').toString().slice(0, 200) || `audition_${Date.now()}`;
    const projectIdRaw = req.body?.projectId || req.query.projectId;
    const parsedProjectId = projectIdRaw ? Number.parseInt(projectIdRaw, 10) : null;
    const projectId = Number.isFinite(parsedProjectId) ? parsedProjectId : null;
    const captchaToken = (req.body?.captchaToken || req.body?.turnstileToken || req.body?.['cf-turnstile-response'] || '').toString().trim();

    const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
    const accessKey = process.env.BUNNY_VIDEO_API_KEY;
    if (!libId || !accessKey) {
      return res.status(503).json({ error: 'Bunny direct upload is not configured on the server.' });
    }

    const captchaCheck = await verifyTurnstileToken(captchaToken, req.ip);
    if (!captchaCheck.ok) {
      if (captchaCheck.reason === 'captcha_not_configured') {
        return res.status(503).json({ error: 'Upload protection is not configured. Please contact support.' });
      }
      return res.status(400).json({ error: 'Human verification failed. Please try again.' });
    }

    // Keep this route lightweight: do not fetch full project/roles here.
    // We validate project/role and assign collections in POST /audition/:projectId.
    // This avoids creating upload-session failures when DB lookups are transiently slow.
    if (projectIdRaw && !Number.isFinite(parsedProjectId)) {
      return res.status(400).json({ error: 'Invalid project id.' });
    }

    if (!consumeProjectUploadQuota(projectId || 'global')) {
      return res.status(429).json({ error: 'Too many upload attempts for this audition project. Please wait and try again.' });
    }

    const created = await bunnyService.createVideo(title);
    const expires = Math.floor(Date.now() / 1000) + BUNNY_DIRECT_UPLOAD_TTL_SECONDS;
    const signature = crypto
      .createHash('sha256')
      .update(`${libId}${accessKey}${expires}${created.guid}`)
      .digest('hex');
    const uploadIntent = await registerDirectUploadIntent({
      guid: created.guid,
      projectId: projectId || null,
      roleName: (req.body?.role || '').toString().trim() || null,
      ipAddress: req.ip || null,
    });

    return res.json({
      guid: created.guid,
      title: created.title,
      libraryId: String(libId),
      tusEndpoint: 'https://video.bunnycdn.com/tusupload',
      authorizationExpire: expires,
      authorizationSignature: signature,
      uploadIntent,
    });
  } catch (e) {
    console.error('API /api/videos create error:', e.message);
    return res.status(500).json({ error: 'Failed to create Bunny upload session' });
  }
});

// Proxy upload endpoint so the client never sees the Bunny AccessKey
app.put('/api/videos/:guid/upload', (req, res) => {
  const guid = (req.params.guid || '').trim();
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const accessKey = process.env.BUNNY_VIDEO_API_KEY;

  if (!guid || !/^[a-f0-9-]{10,}$/i.test(guid)) {
    return res.status(400).json({ error: 'Invalid or missing video guid' });
  }
  if (!libId || !accessKey) {
    return res.status(503).json({ error: 'Direct upload is not configured on the server' });
  }

  const contentLength = req.headers['content-length'];
  // Bunny API requires Content-Type: application/octet-stream regardless of the video mime type
  console.log(`BUNNY_PROXY_UPLOAD_START: guid=${guid} contentLength=${contentLength || 'unknown'} browserContentType=${req.headers['content-type']}`);

  const proxyHeaders = {
    'AccessKey': accessKey,
    'Content-Type': 'application/octet-stream',
  };
  if (contentLength) proxyHeaders['Content-Length'] = contentLength;

  const proxyReq = https.request({
    hostname: 'video.bunnycdn.com',
    path: `/library/${libId}/videos/${guid}`,
    method: 'PUT',
    headers: proxyHeaders,
  }, (proxyRes) => {
    let body = '';
    proxyRes.setEncoding('utf8');
    proxyRes.on('data', (chunk) => { body += chunk; });
    proxyRes.on('end', () => {
      if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        console.log(`BUNNY_PROXY_UPLOAD_OK: guid=${guid} bunnyStatus=${proxyRes.statusCode}`);
        if (!res.headersSent) res.status(200).json({ ok: true });
      } else {
        console.error(`BUNNY_PROXY_UPLOAD_FAILED: guid=${guid} bunnyStatus=${proxyRes.statusCode} body=${body.slice(0, 200)}`);
        if (!res.headersSent) res.status(502).json({ error: 'Bunny upload failed', bunnyStatus: proxyRes.statusCode });
      }
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`BUNNY_PROXY_UPLOAD_ERROR: guid=${guid} err=${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy connection error', detail: err.message });
  });

  req.on('aborted', () => {
    console.warn(`BUNNY_PROXY_UPLOAD_CLIENT_ABORTED: guid=${guid}`);
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
});

// Route to render audition submission form
app.get('/audition', (req, res) => {
  const libId = process.env.BUNNY_STREAM_LIBRARY_ID || '';
  loadActiveAgentsCatalog()
    .then((agentsCatalog) => {
      res.render('audition', {
        bunny_stream_library_id: libId,
        upload_method: 'bunny_stream',
        show_current_location_field: false,
        agency_suggestions: loadAgencySuggestions(),
        agents_catalog: agentsCatalog,
        auditionRules: getAuditionFormRules(),
        direct_upload_require_captcha: BUNNY_DIRECT_UPLOAD_REQUIRE_CAPTCHA,
        turnstile_site_key: BUNNY_TURNSTILE_SITE_KEY,
        breadcrumbTrail: [
          { label: 'Home', url: '/' },
          { label: 'Audition', url: '/audition' },
        ]
      });
    })
    .catch(() => {
      res.render('audition', {
        bunny_stream_library_id: libId,
        upload_method: 'bunny_stream',
        show_current_location_field: false,
        agency_suggestions: loadAgencySuggestions(),
        agents_catalog: loadAgentsCatalog(),
        auditionRules: getAuditionFormRules(),
        direct_upload_require_captcha: BUNNY_DIRECT_UPLOAD_REQUIRE_CAPTCHA,
        turnstile_site_key: BUNNY_TURNSTILE_SITE_KEY,
        breadcrumbTrail: [
          { label: 'Home', url: '/' },
          { label: 'Audition', url: '/audition' },
        ]
      });
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

    // Upload video to YouTube with resumable upload support
    const videoMetadata = {
      snippet: {
        title: `Audition: ${name}${role ? ' for ' + role : ''}`,
        description: `Audition submitted by ${name} (${email})${role ? ' for role: ' + role : ''}.`,
      },
      status: {
        privacyStatus: 'unlisted', // Not public, but accessible via link
      },
    };
    
    const response = await uploadToYouTubeResumable(youtube, videoFile, videoMetadata);

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
      submitted_time: formatTelAvivDateTime(),
      project: { name: 'General Audition', id: 'general' }
    };
    
  // Inline player toggle
  submissionData.disable_inline_player = process.env.DISABLE_INLINE_PLAYER === '1';
  return res.render('audition-success', submissionData);
  } catch (error) {
    console.error('Error uploading audition:', error);
   console.error('Error stack:', error.stack);
   const errorDetails = error && error.message ? error.message : String(error);
   const timestamp = new Date().toISOString();
   res.status(500).render('audition-upload-error', {
     errorDetails,
     timestamp
   });
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
app.get('/projects', requireAdmin, async (req, res) => {
  try {
    const projects = (await projectService.getAllProjects()).map((project) => {
      const colorStyle = project.tag_color ? TAG_COLOR_STYLES[project.tag_color] : null;
      let created_at_formatted = project.created_at;
      if (project.created_at) {
        try {
          created_at_formatted = new Date(project.created_at).toLocaleString('en-IL', {
            year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
            timeZone: 'Asia/Jerusalem'
          });
        } catch (_) {
          // Keep raw date if formatting fails
        }
      }
      return {
        ...project,
        created_at_formatted,
        tag_color: project.tag_color || null,
        tag_color_bg: colorStyle ? colorStyle.bg : '',
        tag_color_hover: colorStyle ? colorStyle.hover : ''
      };
    });
    
    // Resolve deployment metadata from environment variables (Heroku-safe)
    const shortHash = (value) => (value && typeof value === 'string' ? value.trim().substring(0, 7) : null);

    const buildInfo = getBuildInfo();
    if (buildInfo) {
      console.log('[VERSION_DEBUG] Loaded build info file:', buildInfo);
    } else {
      console.warn('[VERSION_DEBUG] build-info.json not present or unreadable.');
    }

    let currentCommit =
      shortHash(process.env.HEROKU_BUILD_COMMIT) ||
      shortHash(process.env.SOURCE_VERSION) ||
      shortHash(process.env.HEROKU_SLUG_COMMIT) ||
      null;

    if (!currentCommit && buildInfo?.commit) {
      currentCommit = buildInfo.commit;
      console.log('[VERSION_DEBUG] Commit derived from build-info.json:', currentCommit);
    }

    if (!currentCommit) {
      currentCommit = 'unknown';
      console.warn('[VERSION_DEBUG] Commit hash unavailable from env or build-info.');
    } else {
      console.log('[VERSION_DEBUG] Commit resolved:', currentCommit);
    }

    let releaseVersion = process.env.HEROKU_RELEASE_VERSION || buildInfo?.release || null;
    if (!releaseVersion) {
      releaseVersion = process.env.NODE_ENV || 'development';
    }

    const branchLabel = process.env.HEROKU_APP_NAME
      ? `${process.env.HEROKU_APP_NAME} (Heroku app)`
      : buildInfo?.branch
        ? `${buildInfo.branch} (build info)`
        : 'local environment';

    let deploymentTimestamp = buildInfo?.releaseCreatedAt || buildInfo?.generatedAt || null;
    let deployDate;
    try {
      if (deploymentTimestamp) {
        deployDate = new Date(deploymentTimestamp).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
      }
    } catch (error) {
      console.warn('[VERSION_DEBUG] Unable to format deployment timestamp:', error.message);
    }
    if (!deployDate) {
      deployDate = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
    }

    // Add version and deployment information
    const deploymentInfo = {
      commit: currentCommit,
      version: releaseVersion,
      branch: branchLabel,
      deployDate
    };
    
    console.log('[VERSION_DEBUG] Final deploymentInfo:', deploymentInfo);
    
    res.render('projects', {
      title: 'Projects',
      projects,
      query: req.query,
      deploymentInfo,
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Projects', url: '/projects' },
      ]
    });
  } catch (error) {
    console.error('[App.js GET /projects] Error fetching projects:', error);
    if (isTransientDbTimeoutError(error)) {
      return res.status(503).send('Temporary database connectivity issue. Please refresh in a few seconds.');
    }
    res.status(500).render('error/500', { error });
  }
});

app.post('/projects/:projectId/tag-color', requireAdmin, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
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

    return res.json({ ok: true, tagColor: result.row.tag_color });
  } catch (error) {
    console.error('[App.js POST /projects/:projectId/tag-color]', error);
    return res.status(500).json({ ok: false, error: 'Failed to save color.' });
  }
});

// Route to render the create project form
app.get('/projects/create', requireAdmin, (req, res) => {
  res.render('createProject', {
    breadcrumbTrail: [
      { label: 'Home', url: '/' },
      { label: 'Projects', url: '/projects' },
      { label: 'Create Project', url: '/projects/create' },
    ],
  });
});

// Route to handle project creation
app.post('/projects/create', requireAdmin, async (req, res, next) => { // Added next
  try { // Added try
  const { name, description, uploadMethod: projectUploadMethod } = req.body;
  const normalizedMethod = (projectUploadMethod || '').toString().trim().toLowerCase();
  const effectiveUploadMethod = ({
    bunny: 'bunny_stream',
    bunny_stream: 'bunny_stream',
    bunnystream: 'bunny_stream',
    cloudflare: 'cloudflare',
    youtube: 'youtube'
  })[normalizedMethod] || 'bunny_stream';

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
      submitted_time: formatTelAvivDateTime()
    };
    
    res.render('project-success', projectData);
  } catch (error) { // Added catch
    next(error); // Pass error to the error handler
  }
});

// Route to render project-specific audition form
// Emergency redirect: keep legacy intake URL alive while project 265 issues are triaged.
app.get('/audition/265', (req, res) => {
  const queryIndex = req.originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  return res.redirect(302, `/audition/299${query}`);
});
app.get('/audition/265/', (req, res) => {
  const queryIndex = req.originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  return res.redirect(302, `/audition/299${query}`);
});

app.get('/audition/:projectId', async (req, res) => {
  if (String(req.params.projectId) === '265') {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    return res.redirect(302, `/audition/299${query}`);
  }
  try {
    const [project, agentsCatalog] = await Promise.all([
      getProjectByIdWithCache(req.params.projectId, 'audition_form'),
      loadActiveAgentsCatalog(),
    ]);
    if (!project) {
      return res.status(404).send('Project not found.');
    }
    const libId = process.env.BUNNY_STREAM_LIBRARY_ID || '';
    const buildInfo = getBuildInfo();
    const assetVersion = (buildInfo && buildInfo.commit)
      || process.env.SOURCE_VERSION
      || process.env.HEROKU_RELEASE_VERSION
      || 'latest';
    const viewUploadMethod = project ? (project.uploadMethod || project.upload_method || 'bunny_stream') : 'bunny_stream';
    const showCurrentLocationField = String(project.id) === '265' || String(project.id) === '299';
    return res.render('audition', {
      project,
      bunny_stream_library_id: libId,
      asset_version: assetVersion,
      upload_method: viewUploadMethod,
      show_current_location_field: showCurrentLocationField,
      agency_suggestions: loadAgencySuggestions(),
      agents_catalog: agentsCatalog,
      auditionRules: getAuditionFormRules(project),
      direct_upload_require_captcha: BUNNY_DIRECT_UPLOAD_REQUIRE_CAPTCHA,
      turnstile_site_key: BUNNY_TURNSTILE_SITE_KEY,
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Projects', url: '/projects' },
        { label: project.name || `Project ${project.id}`, url: `/audition/${project.id}` },
      ]
    });
  } catch (error) {
    console.error(`AUDITION_FORM_LOAD_ERROR: projectId=${req.params.projectId} err=${error.message}`);
    if (isTransientDbTimeoutError(error)) {
      return res.status(503).send('Temporary database connectivity issue. Please refresh in a few seconds.');
    }
    return res.status(500).send('Could not load audition form right now.');
  }
});

app.get('/audition/:projectId/success', async (req, res) => {
  const successEnvelope = req.session ? req.session.lastAuditionSuccess : null;
  if (!successEnvelope || String(successEnvelope.projectId) !== String(req.params.projectId)) {
    return res.render('audition-success', {
      upload_confirmation_only: true,
      actor_name: 'Your audition',
    });
  }

  const submissionData = successEnvelope.submissionData;
  if (req.session) {
    delete req.session.lastAuditionSuccess;
  }
  return res.render('audition-success', submissionData);
});

// Error page for audition uploads
app.get('/audition/:projectId/error', (req, res) => {
  const errorDetails = 'There was an error uploading your audition. Please try again later.';
  const timestamp = new Date().toISOString();
  res.status(500).render('audition-upload-error', {
    errorDetails,
    timestamp
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
  const pathForToken = `/embed/${libId}/${guid}`;
  const tokenDetails = buildTokenMeta({
    signingKey: process.env.BUNNY_STREAM_SIGNING_KEY,
    path: pathForToken,
    ttlSeconds: process.env.BUNNY_STREAM_TOKEN_TTL
  });
  const token = tokenDetails.token;
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
    suggestedEmbed: token ? `https://iframe.mediadelivery.net/embed/${libId}/${guid}?token=${token}&expires=${tokenDetails.expires}&autoplay=false` : `https://iframe.mediadelivery.net/embed/${libId}/${guid}?autoplay=false`,
    tokenMeta: token ? { expires: tokenDetails.expires, ttl: tokenDetails.ttl, path: pathForToken } : null,
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
  const signingKey = process.env.BUNNY_STREAM_SIGNING_KEY;
  const primaryMeta = signingKey ? buildTokenMeta({
    signingKey,
    path: usedPath,
    ttlSeconds: process.env.BUNNY_STREAM_TOKEN_TTL
  }) : { token: null, expires: null, ttl: null };
  if (primaryMeta.token) {
    base += `?token=${primaryMeta.token}&expires=${primaryMeta.expires}`;
  }
  const axios = require('axios');
  let resultPrimary = null; let resultAlt = null; let errorPrimary = null; let errorAlt = null;
  let altTried = false;
  try {
    resultPrimary = await axios.get(base, { validateStatus: () => true });
  } catch (e) { errorPrimary = e.message; }
  if (process.env.BUNNY_STREAM_ALT_PATH === '1' && primaryMeta.token) {
    altTried = true;
    const altPath = `/iframe/${libId}/${guid}`;
    const altMeta = buildTokenMeta({
      signingKey,
      path: altPath,
      ttlSeconds: process.env.BUNNY_STREAM_TOKEN_TTL,
      expiresOverride: primaryMeta.expires
    });
  const altUrl = altMeta.token ? `https://iframe.mediadelivery.net/embed/${libId}/${guid}?token=${altMeta.token}&expires=${altMeta.expires}&autoplay=false` : `https://iframe.mediadelivery.net/embed/${libId}/${guid}?autoplay=false`;
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
      signing: {
        ttl: primaryMeta.ttl,
        expires: primaryMeta.expires,
        usedPath,
        altPathTried: true
      }
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
    signing: {
      ttl: primaryMeta.ttl,
      expires: primaryMeta.expires,
      usedPath,
      altPathTried: altTried
    }
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
  const axios = require('axios');
  const ttlConfig = process.env.BUNNY_STREAM_TOKEN_TTL;
  const ttl = clampTtl(ttlConfig || '3600');
  const expires = Math.floor(Date.now()/1000) + ttl;
  // Candidate path variants (leading slash required). Order matters.
  const variants = [
    { name: 'embed', path: `/embed/${libId}/${guid}`, url: `https://iframe.mediadelivery.net/embed/${libId}/${guid}` },
    { name: 'no-embed', path: `/${libId}/${guid}`, url: `https://iframe.mediadelivery.net/embed/${libId}/${guid}` },
    { name: 'iframe', path: `/iframe/${libId}/${guid}`, url: `https://iframe.mediadelivery.net/embed/${libId}/${guid}` }
  ];
  const results = [];
  for (const v of variants) {
    const meta = buildTokenMeta({
      signingKey: process.env.BUNNY_STREAM_SIGNING_KEY,
      path: v.path,
      ttlSeconds: ttlConfig,
      expiresOverride: expires
    });
    const testUrl = meta.token ? `${v.url}?token=${meta.token}&expires=${meta.expires}` : v.url;
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
  const axios = require('axios');
  const ttlConfig = process.env.BUNNY_STREAM_TOKEN_TTL;
  const ttl = clampTtl(ttlConfig || '3600');
  const expires = Math.floor(Date.now()/1000) + ttl;
  const injectedRef = req.query.ref; // optional Referer
  const headersBase = injectedRef ? { Referer: injectedRef } : {};
  const includeIp = process.env.BUNNY_STREAM_TOKEN_INCLUDE_IP === '1';
  const results = [];
  for (const p of playlistPaths) {
    const tokenMeta = buildTokenMeta({
      signingKey: cdnKey,
      path: p,
      ttlSeconds: ttlConfig,
      includeIp,
      ipAddress: includeIp ? req.ip : undefined,
      expiresOverride: expires,
      digest: 'base64url'
    });
    const url = `https://${host}${p}?token=${tokenMeta.token}&expires=${tokenMeta.expires}`;
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
  const axios = require('axios');
  const ttlConfig = process.env.BUNNY_STREAM_TOKEN_TTL;
  const ttl = clampTtl(ttlConfig || '3600');
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
      const tokenMeta = buildTokenMeta({
        signingKey: combo.key,
        path: p,
        ttlSeconds: ttlConfig,
        includeIp: combo.includeIp,
        ipAddress: combo.includeIp ? req.ip : undefined,
        expiresOverride: expires,
        digest: 'base64url'
      });
      const url = `https://${host}${p}?token=${tokenMeta.token}&expires=${tokenMeta.expires}`;
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
  const ttl = clampTtl(process.env.BUNNY_STREAM_TOKEN_TTL || '3600');
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
  const ttl = clampTtl(process.env.BUNNY_STREAM_TOKEN_TTL || '3600');
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
  const ttl = clampTtl(process.env.BUNNY_STREAM_TOKEN_TTL || '3600');
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
  const ttl = clampTtl(process.env.BUNNY_STREAM_TOKEN_TTL || '3600');
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

// Polling endpoint for background YouTube upload jobs
// Supports both jobId and submissionId (prefixed with "sub:")
app.get('/upload-status/:jobId', (req, res) => {
  let key = req.params.jobId;
  // If client polls by submissionId, resolve to actual jobId first
  if (uploadJobs.has(`sub:${key}`)) {
    key = uploadJobs.get(`sub:${key}`);
  }
  const job = uploadJobs.get(key);
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

// Step 1: Receive form fields before the video upload
// Returns a submissionId that the browser passes during chunk assembly
app.post('/audition/:projectId/fields', auditionUpload.fields([
  { name: 'profile_pictures', maxCount: 10 }
]), async (req, res) => {
  try {
    if (String(req.params.projectId) === '265') req.params.projectId = '299';
    const project = await getProjectByIdWithCache(req.params.projectId, 'audition_fields');
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const rules = getAuditionFormRules(project);
    const normalizedBody = normalizeAuditionBody(req.body);
    const submissionId = crypto.randomBytes(16).toString('hex');
    const profilePictureFiles = req.files && req.files.profile_pictures ? req.files.profile_pictures : [];
    const validationErrors = [
      ...validateAuditionBody({ body: normalizedBody, project, rules }),
      ...validateAuditionFiles({
        rules,
        videoFile: null,
        profilePictureFiles,
        requireVideo: false,
      }),
    ];

    if (validationErrors.length > 0) {
      await cleanupUploadedFiles(profilePictureFiles);
      return res.status(400).json({ error: validationErrors[0] });
    }

    // Upload profile pictures now (they're small and fast)
    let profilePictureUploadResults = [];
    if (profilePictureFiles.length > 0) {
      profilePictureUploadResults = await Promise.all(profilePictureFiles.map(async (file) => {
        const result = await bunnyUploadService.uploadImage(file);
        return result;
      }));
    }

    pendingSubmissions.set(submissionId, {
      projectId: req.params.projectId,
      projectSnapshot: buildSubmissionProjectSnapshot(project),
      body: normalizedBody,
      profilePictures: profilePictureUploadResults,
      expiry: Date.now() + 3600000, // 1 hour
    });
    // Clean up expired submissions
    setTimeout(() => pendingSubmissions.delete(submissionId), 3600000);

    const submissionToken = createSignedSubmissionToken({
      submissionId,
      uploadId: submissionId,
      expiresAt: Date.now() + 3600000,
      payload: pendingSubmissions.get(submissionId),
    });

    res.json({ submissionId, submissionToken });
  } catch (err) {
    console.error(`[fields] Error: ${err.message}`);
    if (/connection timeout|connection terminated|terminating connection/i.test(err.message || '')) {
      return res.status(503).json({
        error: 'Temporary server connection issue. Please wait a few seconds and try again.',
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Receive video in 5MB binary chunks — each PUT is a short HTTP request
// so Heroku H28 idle timeout (90s) can never trigger regardless of file size.
const CHUNK_UPLOAD_DIR = path.join('/tmp', 'chunk-uploads');
if (!fs.existsSync(CHUNK_UPLOAD_DIR)) fs.mkdirSync(CHUNK_UPLOAD_DIR, { recursive: true });
const CHUNK_MISSING_RETRY_ATTEMPTS = 6; // ~3s total wait (6 * 500ms)
const CHUNK_MISSING_RETRY_MS = 500;

app.put('/upload-chunk/:uploadId/:chunkIndex',
  express.raw({ type: '*/*', limit: '10mb' }),
  (req, res) => {
    const { uploadId, chunkIndex } = req.params;
    if (!/^[a-f0-9]{32}$/.test(uploadId)) return res.status(400).json({ error: 'Invalid uploadId' });
    const idx = parseInt(chunkIndex, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: 'Invalid chunkIndex' });

    const uploadDir = path.join(CHUNK_UPLOAD_DIR, uploadId);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const chunkPath = path.join(uploadDir, `chunk-${String(idx).padStart(5, '0')}`);
    fs.writeFileSync(chunkPath, req.body);
    console.log(`[chunk] PUT uploadId=${uploadId} chunkIndex=${idx} size=${req.body.length}`);
    res.json({ ok: true, chunkIndex: idx });
  }
);

// Step 3: All chunks received — assemble file, start background YouTube job
app.post('/upload-chunk/:uploadId/assemble', async (req, res) => {
  const { uploadId } = req.params;
  const { submissionId, totalChunks, filename, mimetype, submissionToken } = req.body;

  if (!/^[a-f0-9]{32}$/.test(uploadId)) return res.status(400).json({ error: 'Invalid uploadId' });

  let submission = pendingSubmissions.get(submissionId);
  if (!submission && submissionToken) {
    const tokenPayload = parseSignedSubmissionToken(submissionToken);
    if (
      tokenPayload
      && tokenPayload.submissionId === submissionId
      && tokenPayload.uploadId === uploadId
      && tokenPayload.payload
    ) {
      submission = tokenPayload.payload;
      console.warn(`[chunk] assemble: recovered submission from signed token submissionId=${submissionId}`);
    }
  }

  if (!submission) {
    console.error(`[chunk] assemble: no pending submission for submissionId=${submissionId}`);
    return res.status(404).json({ error: 'Submission not found or expired. Please refresh and start the upload again.' });
  }
  pendingSubmissions.delete(submissionId);

  const jobId = crypto.randomBytes(16).toString('hex');
  uploadJobs.set(jobId, { status: 'processing', jobId });
  uploadJobs.set(`sub:${submissionId}`, jobId);

  console.log(`[chunk] assemble START: uploadId=${uploadId} totalChunks=${totalChunks} jobId=${jobId}`);

  // Respond immediately — background job assembles file and uploads to YouTube
  res.json({ jobId });

  (async () => {
    let assembledPath = null;
    try {
      const uploadDir = path.join(CHUNK_UPLOAD_DIR, uploadId);
      assembledPath = path.join(CHUNK_UPLOAD_DIR, `${uploadId}-assembled`);

      const writeStream = fs.createWriteStream(assembledPath);
      for (let i = 0; i < parseInt(totalChunks, 10); i++) {
        const chunkPath = path.join(uploadDir, `chunk-${String(i).padStart(5, '0')}`);
        let found = fs.existsSync(chunkPath);
        let attempt = 0;
        while (!found && attempt < CHUNK_MISSING_RETRY_ATTEMPTS) {
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, CHUNK_MISSING_RETRY_MS));
          found = fs.existsSync(chunkPath);
        }
        if (!found) {
          throw new Error(`Missing chunk ${i}`);
        }
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
        fs.unlinkSync(chunkPath);
      }
      writeStream.end();
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      try { fs.rmdirSync(path.join(CHUNK_UPLOAD_DIR, uploadId)); } catch (e) {}
      console.log(`[chunk] assembled: ${assembledPath}`);

      const videoFile = {
        path: assembledPath,
        originalname: filename || 'video.mp4',
        mimetype: mimetype || 'video/mp4',
        size: fs.statSync(assembledPath).size,
      };

      const project = submission.projectSnapshot
        || await getProjectByIdWithCache(submission.projectId, 'chunk_assemble');
      if (!project) {
        throw new Error(`Project not found for submission ${submissionId}`);
      }
      const rules = getAuditionFormRules(project);
      const videoValidationErrors = validateAuditionFiles({
        rules,
        videoFile,
        profilePictureFiles: [],
        requireVideo: true,
        validatePictures: false,
      });
      if (videoValidationErrors.length > 0) {
        throw new Error(videoValidationErrors[0]);
      }
      const selectedRole = findProjectRoleByName(project, submission.body.role);
      if (!selectedRole) throw new Error(`Role not found: ${submission.body.role}`);

      oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      const playlistId = await ensureRolePlaylist(youtube, project, selectedRole);

      const body = submission.body;
      const videoTitle = `Audition: ${body.first_name_en || body.first_name_he} ${body.last_name_en || body.last_name_he} for ${selectedRole.name} in ${project.name}`;
      const videoDescription = `Audition by ${body.first_name_en || body.first_name_he} ${body.last_name_en || body.last_name_he} for ${selectedRole.name} in ${project.name}. Project ID: ${project.id}. Submitted: ${new Date().toISOString()}`;
      const videoMetadata = {
        snippet: { title: videoTitle, description: videoDescription },
        status: { privacyStatus: 'unlisted' },
      };

      const youtubeResponse = await uploadToYouTubeResumable(youtube, videoFile, videoMetadata);
      if (fs.existsSync(assembledPath)) fs.unlinkSync(assembledPath);

      const youtubeVideoId = youtubeResponse.data.id;
      const ytUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
      console.log(`[chunk] YOUTUBE_SUCCESS: jobId=${jobId} videoId=${youtubeVideoId}`);

      try { await addVideoToYouTubePlaylist(youtube, youtubeVideoId, playlistId); }
      catch (pe) { console.warn(`[chunk] playlist warn: ${pe.message}`); }

      const auditionObj = {
        project_id: project.id,
        role_id: selectedRole.id,
        role: selectedRole.name,
        first_name_he: body.first_name_he, last_name_he: body.last_name_he,
        first_name_en: body.first_name_en, last_name_en: body.last_name_en,
        phone: body.phone, email: body.email, agency: body.agency,
        agent_id: body.agent_id || null,
        agent_text: body.agent_text || body.agency || null,
        age: body.age, height: body.height,
        current_location: body.current_location,
        about_me: body.about_me,
        profile_pictures: submission.profilePictures,
        showreel_url: body.showreel_url,
        video_url: ytUrl, video_type: 'youtube',
      };
      await insertAuditionWithRetry(auditionObj);
      console.log(`[chunk] AUDITION_SAVED: jobId=${jobId}`);

      uploadJobs.set(jobId, { status: 'done', videoId: youtubeVideoId, videoUrl: ytUrl });
      setTimeout(() => uploadJobs.delete(jobId), 3600000);
    } catch (err) {
      console.error(`[chunk] BACKGROUND_ERROR: jobId=${jobId} err=${err.message}`);
      if (assembledPath && fs.existsSync(assembledPath)) try { fs.unlinkSync(assembledPath); } catch (e) {}
      uploadJobs.set(jobId, { status: 'error', error: err.message });
      setTimeout(() => uploadJobs.delete(jobId), 3600000);
    }
  })();
});

// Updated POST route to handle project-specific audition form submission and upload
app.post('/audition/:projectId', auditionUpload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'profile_pictures', maxCount: 10 }
]), async (req, res, next) => { // Added next for error handling
  if (String(req.params.projectId) === '265') req.params.projectId = '299';
  // LOGS AT THE VERY START OF THE HANDLER
  console.log(`POST_AUDITION_HANDLER_ENTRY: projectId = ${req.params.projectId}, timestamp = ${new Date().toISOString()}`);
  console.log(`POST_AUDITION_HANDLER_REQ_BODY_RAW: ${JSON.stringify(req.body)}`);
  console.log(`POST_AUDITION_HANDLER_REQ_FILES_RAW: ${JSON.stringify(req.files)}`);

  try {
    console.log(`POST_AUDITION_TRY_BLOCK_START: projectId = ${req.params.projectId}`);
    const project = await getProjectByIdWithCache(req.params.projectId, 'audition_submit');

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

    const body = normalizeAuditionBody(req.body);
    console.log(`POST_AUDITION_BODY_CONTENT: ${JSON.stringify(body)}`);
    const videoFile = req.files && req.files.video ? req.files.video[0] : null;
    const profilePictureFiles = req.files && req.files.profile_pictures ? req.files.profile_pictures : [];
    const directUploadGuid = trimToString((req.body && req.body.video_url) || body.video_url);
    const hasDirectUploadedVideo = directUploadGuid.length > 10;
    const rules = getAuditionFormRules(project);
    const validationErrors = [
      ...validateAuditionBody({ body, project, rules }),
      ...validateAuditionFiles({
        rules,
        videoFile,
        profilePictureFiles,
        requireVideo: !hasDirectUploadedVideo,
      }),
    ];

    if (hasDirectUploadedVideo) {
      const missingVideoIndex = validationErrors.indexOf('Please upload a self-tape video.');
      if (missingVideoIndex !== -1) {
        validationErrors.splice(missingVideoIndex, 1);
      }
    }

    if (validationErrors.length > 0) {
      console.warn(`POST_AUDITION_VALIDATION_FAILED: projectId=${req.params.projectId} directGuidPresent=${hasDirectUploadedVideo} errors=${JSON.stringify(validationErrors)}`);
      await cleanupUploadedFiles([videoFile, ...profilePictureFiles].filter(Boolean));
      return res.status(400).send(validationErrors[0]);
    }
    
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
    let alreadyFinalized = false; // idempotent-finalize: audition already saved for this Bunny GUID
    let savedAudition = null;

  if (videoFile) {
      console.log(`POST_AUDITION_UPLOADING_VIDEO: ${videoFile.originalname} for project ${project.id}. Project's uploadMethod: ${project.upload_method}`);
      
      if (project.upload_method === 'youtube') {
        console.log(`POST_AUDITION_ATTEMPTING_YOUTUBE_UPLOAD: Role: ${selectedRole.name}, youtube_playlist_id: ${selectedRole.youtube_playlist_id || '(none yet)'}`);
        if (!REFRESH_TOKEN) {
          console.error('POST_AUDITION_YOUTUBE_ERROR: Google Refresh Token not configured.');
          throw new Error('Google Refresh Token not configured. Cannot upload to YouTube.');
        }

        // Generate a unique job ID and respond immediately to the browser.
        // The actual YouTube upload runs in the background so Heroku H28 idle
        // timeout (90s) never kills the browser connection.
        const jobId = crypto.randomBytes(16).toString('hex');
        uploadJobs.set(jobId, { status: 'processing' });

        // Capture everything needed for background processing
        const bgBody = body;
        const bgVideoFile = videoFile;
        const bgProject = project;
        const bgSelectedRole = selectedRole;
        const bgProfilePictures = profilePictureUploadResults;

        // Fire and forget — do NOT await this
        (async () => {
          try {
            oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
            const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

            const playlistId = await ensureRolePlaylist(youtube, bgProject, bgSelectedRole);

            const videoTitle = `Audition: ${bgBody.first_name_en || bgBody.first_name_he} ${bgBody.last_name_en || bgBody.last_name_he} for ${bgSelectedRole.name} in ${bgProject.name}`;
            const videoDescription = `Audition by ${bgBody.first_name_en || bgBody.first_name_he} ${bgBody.last_name_en || bgBody.last_name_he} for ${bgSelectedRole.name} in ${bgProject.name}. Project ID: ${bgProject.id}. Submitted: ${new Date().toISOString()}`;

            const videoMetadata = {
              snippet: { title: videoTitle, description: videoDescription },
              status: { privacyStatus: 'unlisted' },
            };

            const youtubeResponse = await uploadToYouTubeResumable(youtube, bgVideoFile, videoMetadata);

            if (fs.existsSync(bgVideoFile.path)) fs.unlinkSync(bgVideoFile.path);

            const youtubeVideoId = youtubeResponse.data.id;
            const ytUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
            console.log(`BACKGROUND_YOUTUBE_UPLOAD_SUCCESS: jobId=${jobId} videoId=${youtubeVideoId}`);

            try { await addVideoToYouTubePlaylist(youtube, youtubeVideoId, playlistId); }
            catch (pe) { console.warn(`BACKGROUND_PLAYLIST_ADD_WARN: ${pe.message}`); }

            // Save audition to DB
            const auditionObj = {
              project_id: bgProject.id,
              role_id: bgSelectedRole ? bgSelectedRole.id : null,
              role: bgSelectedRole ? bgSelectedRole.name : bgBody.role,
              first_name_he: bgBody.first_name_he, last_name_he: bgBody.last_name_he,
              first_name_en: bgBody.first_name_en, last_name_en: bgBody.last_name_en,
              phone: bgBody.phone, email: bgBody.email, agency: bgBody.agency,
              agent_id: bgBody.agent_id || null,
              agent_text: bgBody.agent_text || bgBody.agency || null,
              age: bgBody.age, height: bgBody.height,
              current_location: bgBody.current_location,
              about_me: bgBody.about_me,
              profile_pictures: bgProfilePictures,
              showreel_url: bgBody.showreel_url,
              video_url: ytUrl,
              video_type: 'youtube',
            };
            await insertAuditionWithRetry(auditionObj);
            console.log(`BACKGROUND_AUDITION_SAVED: jobId=${jobId}`);

            uploadJobs.set(jobId, { status: 'done', videoId: youtubeVideoId, videoUrl: ytUrl });
            // Clean up job after 1 hour
            setTimeout(() => uploadJobs.delete(jobId), 3600000);
          } catch (err) {
            console.error(`BACKGROUND_YOUTUBE_UPLOAD_ERROR: jobId=${jobId} err=${err.message}`);
            if (bgVideoFile && fs.existsSync(bgVideoFile.path)) fs.unlinkSync(bgVideoFile.path);
            uploadJobs.set(jobId, { status: 'error', error: err.message });
            setTimeout(() => uploadJobs.delete(jobId), 3600000);
          }
        })();

        // Respond immediately — browser will poll /upload-status/:jobId
        return res.json({ status: 'processing', jobId });      } else { // Default to Bunny.net Stream (if uploadMethod is 'cloudflare' or anything else)
        console.log(`POST_AUDITION_UPLOADING_TO_BUNNY_STREAM: ${videoFile.originalname}`);
        try {
          // Ensure the role has a Bunny collection, creating one if needed
          const collectionGuid = await ensureBunnyCollection(project, selectedRole);

          const bunnyResult = await bunnyUploadService.uploadVideo(videoFile);
          finalVideoUrl = bunnyResult.id;
          videoType = 'bunny_stream';
          videoUploadResult = { id: bunnyResult.id };
          console.log(`POST_AUDITION_VIDEO_UPLOADED_BUNNY: ${videoFile.originalname}, GUID: ${bunnyResult.id}`);

          // Assign the video to the role's collection
          try {
            await bunnyUploadService.assignVideoToCollection(bunnyResult.id, collectionGuid);
            console.log(`BUNNY_COLLECTION_ITEM_ADDED: videoGuid=${bunnyResult.id} collectionGuid=${collectionGuid}`);
          } catch (colErr) {
            console.warn(`BUNNY_COLLECTION_ASSIGN_WARN: Could not assign video to collection: ${colErr.message}`);
          }
        } catch (bunnyError) {
          console.error('POST_AUDITION_BUNNY_UPLOAD_ERROR: Failed to upload video to Bunny.net Stream.', bunnyError);
          throw bunnyError;
        }
      }
    } else {
      // Support direct-to-Bunny uploads: client submits a GUID in body.video_url
      const guidFromForm = directUploadGuid;
      const uploadIntent = (body.video_upload_intent || '').toString().trim();
      if (guidFromForm && guidFromForm.length > 10) {
        const intentCheck = await consumeDirectUploadIntent({
          intentToken: uploadIntent,
          guid: guidFromForm,
          projectId: project.id,
          roleName: selectedRole ? selectedRole.name : null,
          ipAddress: req.ip || null,
        });
        if (!intentCheck.ok) {
          if (intentCheck.reason === 'intent_already_used') {
            // Idempotent finalize: a retried/duplicate submit (e.g. the first
            // response was lost). If the audition was already saved, return it
            // as success instead of erroring or creating a duplicate.
            const existing = await auditionService.findAuditionByBunnyGuid(guidFromForm);
            if (existing) {
              console.log(`POST_AUDITION_IDEMPOTENT_HIT: guid=${guidFromForm} auditionId=${existing.id}`);
              alreadyFinalized = true;
              savedAudition = existing;
            } else {
              // Intent was consumed but no audition persisted (previous attempt
              // crashed mid-insert). Safe to proceed and create the record now.
              console.warn(`POST_AUDITION_INTENT_USED_NO_RECORD: proceeding to insert guid=${guidFromForm}`);
            }
          } else {
            console.warn(`POST_AUDITION_DIRECT_UPLOAD_INTENT_REJECTED: guid=${guidFromForm} reason=${intentCheck.reason}`);
            return res.status(400).send('Invalid or expired direct upload session. Please upload the video again.');
          }
        }

        console.log(`POST_AUDITION_DIRECT_BUNNY_GUID_DETECTED: ${guidFromForm}`);
        finalVideoUrl = guidFromForm;
        videoType = 'bunny_stream';

        // Assign to the role's Bunny collection in the background so user redirect is immediate.
        if (!alreadyFinalized && project.upload_method !== 'youtube' && selectedRole) {
          (async () => {
            try {
              const collectionGuid = await ensureBunnyCollection(project, selectedRole);
              await bunnyUploadService.assignVideoToCollection(guidFromForm, collectionGuid);
              console.log(`BUNNY_COLLECTION_ITEM_ADDED (direct): videoGuid=${guidFromForm} collectionGuid=${collectionGuid}`);
            } catch (colErr) {
              console.warn(`BUNNY_COLLECTION_ASSIGN_WARN (direct): ${colErr.message}`);
            }
          })();
        }
      } else {
        console.warn(`POST_AUDITION_VIDEO_REQUIRED_MISSING: project=${project.id} upload_method=${project.upload_method}`);
        return res.status(400).send('Please upload a self-tape video.');
      }
    }

    const audition = {
      project_id: project.id,
      role_id: selectedRole ? selectedRole.id : null,
  role: selectedRole ? selectedRole.name : body.role,
      first_name_he: body.first_name_he,
      last_name_he: body.last_name_he,
      first_name_en: body.first_name_en,
      last_name_en: body.last_name_en,
      phone: body.phone,
      email: body.email,
      agency: body.agency,
      age: body.age,
      height: body.height,
      current_location: body.current_location,
      about_me: body.about_me,
      profile_pictures: profilePictureUploadResults, 
      showreel_url: body.showreel_url,
      video_url: finalVideoUrl, 
      video_type: videoType 
    };
    // Corrected logging to use req.params.projectId as projectId is not defined in this scope
    console.log(`[App.js POST /audition/:${req.params.projectId}] Prepared audition object: ${JSON.stringify(audition)}`);
    if (alreadyFinalized) {
      console.log(`[App.js POST /audition/:${req.params.projectId}] Skipping insert; audition already saved for this upload.`);
    } else {
      try {
        savedAudition = await insertAuditionWithRetry(audition);
        console.log(`[App.js POST /audition/:${req.params.projectId}] Audition saved successfully.`);
      } catch (insertErr) {
        // Unique-violation backstop (uq_auditions_bunny_guid): a concurrent
        // duplicate submit slipped past the intent check. Treat as success.
        if (insertErr && insertErr.code === '23505' && videoType === 'bunny_stream' && finalVideoUrl) {
          const existing = await auditionService.findAuditionByBunnyGuid(finalVideoUrl);
          if (existing) {
            console.warn(`POST_AUDITION_DUPLICATE_INSERT_RECOVERED: guid=${finalVideoUrl} auditionId=${existing.id}`);
            savedAudition = existing;
            alreadyFinalized = true;
          } else {
            throw insertErr;
          }
        } else {
          throw insertErr;
        }
      }
    }

    // Mark the durable upload intent completed and link it to the saved audition.
    // Best-effort: never fail the submission because of intent bookkeeping.
    if (videoType === 'bunny_stream' && finalVideoUrl) {
      try {
        await uploadIntentService.markCompleted({
          guid: finalVideoUrl,
          auditionId: savedAudition && savedAudition.id,
          roleName: selectedRole ? selectedRole.name : (body.role || null),
        });
      } catch (intentErr) {
        console.warn(`UPLOAD_INTENT_COMPLETE_WARN: guid=${finalVideoUrl} err=${intentErr.message}`);
      }
    }

    if (videoType === 'bunny_stream' && savedAudition && shouldAutoMirrorBunnyProject(project)) {
      const bgProject = project;
      const bgAuditionId = savedAudition.id;
      setImmediate(async () => {
        try {
          const auditionForMirror = await auditionService.getAuditionById(bgAuditionId);
          if (!auditionForMirror) {
            console.warn(`AUTO_MIRROR_SKIP_NOT_FOUND: project=${bgProject.id} audition=${bgAuditionId}`);
            return;
          }
          await mirrorAuditionFromBunnyToYoutube({ project: bgProject, audition: auditionForMirror });
        } catch (mirrorErr) {
          console.error(
            `AUTO_MIRROR_FAILED: project=${bgProject.id} audition=${bgAuditionId} err=${mirrorErr.message}`,
            mirrorErr
          );
        }
      });
    }
    
    // Render beautiful success page
    const actorName = [body.first_name_he, body.last_name_he, body.first_name_en, body.last_name_en]
      .filter(name => name && name.trim())
      .join(' ') || 'Actor';
    
    const shouldShowVideoPreview = Boolean(videoType) && videoType !== 'bunny_stream';
    const submissionData = {
      project: { ...project },
      bunny_stream_library_id: process.env.BUNNY_STREAM_LIBRARY_ID, // Correctly access from process.env
      role: body.role,
      actor_name: actorName,
      email: body.email,
      phone: body.phone,
      video_url: shouldShowVideoPreview ? finalVideoUrl : null,
      video_type: shouldShowVideoPreview ? videoType : null,
      show_video_preview: shouldShowVideoPreview,
      analytics_video_type: videoType || '',
      analytics_upload_method: (project.upload_method || project.uploadMethod || '').toString(),
      profile_pictures: profilePictureUploadResults || [],
      showreel_url: body.showreel_url,
      submitted_time: formatTelAvivDateTime()
    };

  // Build optional signed Bunny Stream embed URL if signing key provided
  if (shouldShowVideoPreview && videoType === 'bunny_stream' && finalVideoUrl && process.env.BUNNY_STREAM_LIBRARY_ID) {
      try {
        const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
    let embedBase = `https://iframe.mediadelivery.net/embed/${libId}/${finalVideoUrl}`;
    if (process.env.BUNNY_STREAM_SIGNING_KEY) {
      const crypto = require('crypto');
      const ttl = clampTtl(process.env.BUNNY_STREAM_TOKEN_TTL || '3600'); // clamp 1m - 24h
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
    
    if (req.session) {
      req.session.lastAuditionSuccess = {
        projectId: project.id,
        submissionData,
      };
      return req.session.save((sessionErr) => {
        if (sessionErr) {
          console.warn('AUDITION_SUCCESS_SESSION_SAVE_WARN:', sessionErr.message);
          return res.render('audition-success', submissionData);
        }
        return res.redirect(`/audition/${project.id}/success`);
      });
    }

    return res.render('audition-success', submissionData);
    
   } catch (error) {
    // Enhanced error logging
    console.error(`[App.js POST /audition/:${req.params.projectId}] Critical error in route: ${error.message}`, error);
    console.error('Error stack:', error.stack);
    
    // Extract meaningful error details
    let errorDetails = error && error.message ? error.message : String(error);
    
    // Add more context for specific error types
    if (error.code === 'ETIMEDOUT') {
      errorDetails = 'Upload connection timeout - YouTube API did not respond in time';
    } else if (error.code === 'ECONNRESET') {
      errorDetails = 'Connection reset by YouTube API - please try again';
    } else if (error.response && error.response.status) {
      errorDetails = `YouTube API error (${error.response.status}): ${errorDetails}`;
    }
    
    const timestamp = new Date().toISOString();
    res.status(500).render('audition-upload-error', {
      errorDetails,
      timestamp
    });
  }
});


// Promote an existing Bunny audition to YouTube
app.post('/projects/:projectId/auditions/:auditionId/upload-to-youtube', requireAdmin, async (req, res) => {
  const { projectId, auditionId } = req.params;
  const redirectRaw = (req.body.redirect || '').toString();
  const redirectTarget = redirectRaw.startsWith('/') ? redirectRaw : `/projects/${projectId}/auditions`;

  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    req.flash('error', 'YouTube integration is not configured on the server.');
    return res.redirect(redirectTarget);
  }

  let tempDownloadPath = null;
  try {
    const project = await getProjectByIdWithCache(projectId, 'admin_promote_upload_to_youtube');
    if (!project) {
      req.flash('error', 'Project not found.');
      return res.redirect('/projects');
    }

    const audition = await auditionService.getAuditionById(auditionId);
    if (!audition || Number(audition.project_id) !== Number(projectId)) {
      req.flash('error', 'Audition not found for this project.');
      return res.redirect(redirectTarget);
    }

    if (!audition.video_url || audition.video_type !== 'bunny_stream') {
      req.flash('error', 'Only Bunny-hosted auditions can be copied to YouTube.');
      return res.redirect(redirectTarget);
    }

    if (audition.youtube_video_url) {
      req.flash('info', 'This audition is already available on YouTube.');
      return res.redirect(redirectTarget);
    }

    // Download from Bunny to a temporary file
    const download = await bunnyUploadService.downloadVideoToTemp(audition.video_url);
    tempDownloadPath = download.path;

    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const performerName = [audition.first_name_en, audition.last_name_en, audition.first_name_he, audition.last_name_he]
      .filter(Boolean)
      .join(' ') || 'Audition Performer';

    const title = `${performerName} - ${audition.role_name || audition.role || 'Audition'}`;
    const description = [
      `Audition submitted for project: ${audition.project_name || project.name}`,
      audition.role_name ? `Role: ${audition.role_name}` : null,
      audition.email ? `Email: ${audition.email}` : null,
      audition.phone ? `Phone: ${audition.phone}` : null,
    ].filter(Boolean).join('\n');

    const videoMetadata = {
      snippet: {
        title,
        description,
      },
      status: {
        privacyStatus: 'unlisted',
      },
    };
    
    // Create a mock file object for uploadToYouTubeResumable
    const mockFile = {
      path: tempDownloadPath,
      originalname: `${performerName}-audition.mp4`,
    };
    
    const uploadResponse = await uploadToYouTubeResumable(youtube, mockFile, videoMetadata);

    const youtubeVideoId = uploadResponse?.data?.id;
    if (!youtubeVideoId) {
      throw new Error('YouTube did not return a video ID.');
    }
    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;

    let mirroredProject = null;
    let mirroredRole = null;
    const sourceUploadMethod = trimToString(project.upload_method || project.uploadMethod).toLowerCase();
    if (sourceUploadMethod === 'bunny_stream') {
      mirroredProject = await findSiblingProjectByUploadMethod(project, 'youtube');
      mirroredRole = findProjectRoleByName(mirroredProject, audition.role_name || audition.role);
    }

    // Add to the target YouTube role playlist when we know the sibling role;
    // otherwise fall back to the source project role.
    const sourceRole = audition.role_id
      ? project.roles.find((r) => r.id === audition.role_id)
      : findProjectRoleByName(project, audition.role_name || audition.role);
    const playlistProject = mirroredProject && mirroredRole ? mirroredProject : project;
    const playlistRole = mirroredProject && mirroredRole ? mirroredRole : sourceRole;

    if (playlistRole) {
      const playlistId = await ensureRolePlaylist(youtube, playlistProject, playlistRole);
      await addVideoToYouTubePlaylist(youtube, youtubeVideoId, playlistId);
    } else {
      console.warn(`PROMOTE_TO_YOUTUBE_NO_ROLE: audition ${auditionId} has no mappable role — skipping playlist assignment.`);
    }

    await auditionService.updateAuditionYoutubeData(audition.id, {
      youtubeVideoId,
      youtubeVideoUrl: youtubeUrl,
    });

    if (mirroredProject) {
      try {
        const mirroredAuditionPayload = {
          project_id: mirroredProject.id,
          role_id: mirroredRole ? mirroredRole.id : null,
          role: mirroredRole ? mirroredRole.name : (audition.role_name || audition.role),
          first_name_he: audition.first_name_he,
          last_name_he: audition.last_name_he,
          first_name_en: audition.first_name_en,
          last_name_en: audition.last_name_en,
          phone: audition.phone,
          email: audition.email,
          agency: audition.agency,
          age: audition.age,
          height: audition.height,
          current_location: audition.current_location,
          about_me: audition.about_me,
          profile_pictures: Array.isArray(audition.profile_pictures) ? audition.profile_pictures : [],
          showreel_url: audition.showreel_url,
          video_url: youtubeUrl,
          video_type: 'youtube',
        };

        const mirroredAudition = await insertAuditionWithRetry(mirroredAuditionPayload);
        await auditionService.updateAuditionYoutubeData(mirroredAudition.id, {
          youtubeVideoId,
          youtubeVideoUrl: youtubeUrl,
        });

        if (!mirroredRole) {
          req.flash('info', `Uploaded to YouTube and copied to project "${mirroredProject.name}", but no matching role was found there.`);
        }
      } catch (mirrorError) {
        console.error(`PROMOTE_TO_YOUTUBE_MIRROR_INSERT_ERROR: sourceAudition=${audition.id} targetProject=${mirroredProject.id}`, mirrorError);
        req.flash('info', `Uploaded to YouTube, but failed to copy the audition into "${mirroredProject.name}": ${mirrorError.message}`);
      }
    } else if (sourceUploadMethod === 'bunny_stream') {
      console.warn(`PROMOTE_TO_YOUTUBE_NO_SIBLING_PROJECT: sourceProject=${project.id} name="${project.name}"`);
      req.flash('info', 'Uploaded to YouTube, but no matching YouTube sister project was found for copying the audition record.');
    }

    req.flash('success', mirroredProject
      ? 'Audition uploaded to YouTube and copied to the YouTube project successfully.'
      : 'Audition uploaded to YouTube successfully.');
  } catch (error) {
    console.error(`[App.js POST /projects/${projectId}/auditions/${auditionId}/upload-to-youtube]`, error);
    req.flash('error', `Failed to upload to YouTube: ${error.message}`);
  } finally {
    if (tempDownloadPath) {
      fs.promises.unlink(tempDownloadPath).catch(() => undefined);
    }
  }

  return res.redirect(redirectTarget);
});

// Route to delete an audition
app.post('/projects/:projectId/auditions/:auditionId/delete', requireAdmin, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const auditionId = req.params.auditionId;

    // Get the audition first to delete from third-party services
    const audition = await auditionService.getAuditionById(auditionId);
    if (!audition || audition.project_id != projectId) {
      return res.status(404).json({ ok: false, error: 'Audition not found.' });
    }

    // Try to delete from Bunny Stream
    if (audition.video_type === 'bunny_stream' && audition.video_url) {
      try {
        await bunnyUploadService.deleteVideo(audition.video_url);
      } catch (e) {
        console.warn(`Could not delete Bunny video for audition ${auditionId}:`, e.message);
      }
    }

    // Try to delete from YouTube
    const ytVideoId = audition.youtube_video_id || (audition.video_type === 'youtube' ? audition.video_url : null);
    if (ytVideoId && REFRESH_TOKEN) {
      try {
        oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        // The youtube_video_id might just be the ID, but video_url might be "https://www.youtube.com/watch?v=..."
        let videoIdToDelete = ytVideoId;
        if (ytVideoId.includes('v=')) {
          const match = ytVideoId.match(/v=([^&]+)/);
          if (match) videoIdToDelete = match[1];
        } else if (ytVideoId.includes('youtu.be/')) {
          const match = ytVideoId.match(/youtu\.be\/([^?]+)/);
          if (match) videoIdToDelete = match[1];
        }
        
        await youtube.videos.delete({ id: videoIdToDelete });
      } catch (e) {
        console.warn(`Could not delete YouTube video for audition ${auditionId}:`, e.message);
      }
    }

    const deleted = await auditionService.deleteAudition(projectId, auditionId);
    if (deleted) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ ok: false, error: 'Audition not found.' });
    }
  } catch (error) {
    console.error(`[App.js POST /projects/:projectId/auditions/:auditionId/delete] Error:`, error);
    res.status(500).json({ ok: false, error: 'Failed to delete audition.' });
  }
});

app.post('/projects/:projectId/auditions/:auditionId/tag-color', requireAdmin, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const auditionId = Number(req.params.auditionId);
    if (!Number.isInteger(projectId) || !Number.isInteger(auditionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid project or audition id.' });
    }

    const tagColor = req.body ? req.body.tagColor : null;
    const result = await auditionService.updateAuditionTagColor(projectId, auditionId, tagColor);
    if (!result.ok) {
      if (result.reason === 'invalid_color') {
        return res.status(400).json({ ok: false, error: 'Invalid color value.' });
      }
      if (result.reason === 'not_found') {
        return res.status(404).json({ ok: false, error: 'Audition not found.' });
      }
      return res.status(400).json({ ok: false, error: 'Unable to update color.' });
    }

    return res.json({ ok: true, tagColor: result.row.tag_color });
  } catch (error) {
    console.error('[App.js POST /projects/:projectId/auditions/:auditionId/tag-color]', error);
    return res.status(500).json({ ok: false, error: 'Failed to save color.' });
  }
});


// Route to get current audition data for inline editing
app.get('/projects/:projectId/auditions/:auditionId/edit-data', requireAdmin, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const auditionId = Number(req.params.auditionId);
    if (!Number.isInteger(projectId) || !Number.isInteger(auditionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid project or audition id.' });
    }

    const audition = await auditionService.getAuditionById(auditionId);
    if (!audition) {
      return res.status(404).json({ ok: false, error: 'Audition not found.' });
    }

    // Verify the audition belongs to the project
    if (audition.project_id !== projectId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized.' });
    }

    // Return editable fields
    return res.json({
      ok: true,
      first_name_en: audition.first_name_en || '',
      last_name_en: audition.last_name_en || '',
      first_name_he: audition.first_name_he || '',
      last_name_he: audition.last_name_he || '',
      email: audition.email || '',
      phone: audition.phone || '',
      agency: audition.agency || '',
      age: audition.age || '',
      height: audition.height || '',
      current_location: audition.current_location || '',
      about_me: audition.about_me || '',
      video_url: audition.video_url || '',
      video_type: audition.video_type || ''
    });
  } catch (error) {
    console.error('[App.js GET /projects/:projectId/auditions/:auditionId/edit-data]', error);
    return res.status(500).json({ ok: false, error: 'Failed to load audition data.' });
  }
});

// Route to update audition data from inline editing
app.post('/projects/:projectId/auditions/:auditionId/update', requireAdmin, async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const auditionId = Number(req.params.auditionId);
    if (!Number.isInteger(projectId) || !Number.isInteger(auditionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid project or audition id.' });
    }

    const audition = await auditionService.getAuditionById(auditionId);
    if (!audition) {
      return res.status(404).json({ ok: false, error: 'Audition not found.' });
    }

    // Verify the audition belongs to the project
    if (audition.project_id !== projectId) {
      return res.status(403).json({ ok: false, error: 'Unauthorized.' });
    }

    // Extract fields from request body (no strict validation for admin edits)
    const updates = {};
    const editableFields = ['first_name_en', 'last_name_en', 'first_name_he', 'last_name_he', 'email', 'phone', 'agency', 'age', 'height', 'current_location', 'about_me', 'video_url', 'video_type'];
    
    for (const field of editableFields) {
      if (req.body && field in req.body) {
        updates[field] = req.body[field] || null;
      }
    }

    // Convert age and height to numbers if provided
    if (updates.age) {
      updates.age = Number(updates.age);
      if (isNaN(updates.age)) {
        updates.age = null;
      }
    }
    if (updates.height) {
      updates.height = Number(updates.height);
      if (isNaN(updates.height)) {
        updates.height = null;
      }
    }

    // Validate video_url if provided
    if (updates.video_url && typeof updates.video_url === 'string') {
      updates.video_url = updates.video_url.trim();
      if (!isValidHttpUrl(updates.video_url)) {
        return res.status(400).json({ ok: false, error: 'Invalid video URL format.' });
      }
      // Clear youtube_video_url to force recalculation from new video_url
      updates.youtube_video_url = null;
    }

    // Update the audition
    const result = await auditionService.updateAudition(auditionId, updates);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error || 'Failed to update audition.' });
    }

    return res.json({ ok: true, audition: result.row });
  } catch (error) {
    console.error('[App.js POST /projects/:projectId/auditions/:auditionId/update]', error);
    return res.status(500).json({ ok: false, error: 'Failed to update audition.' });
  }
});


app.get('/projects/:projectId/auditions', requireAdmin, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const project = await getProjectByIdWithCache(projectId, 'project_auditions_admin');
    if (!project) {
      return res.status(404).render('error/404', { message: 'Project not found.' });
    }

    const auditions = await auditionService.getAuditionsByProjectId(projectId, req.query);
    const previousAdminLoginTime = req.session && req.session.admin && req.session.admin.previousLoggedInAt
      ? new Date(req.session.admin.previousLoggedInAt)
      : null;
    const roleCountRows = await auditionService.getRoleAuditionCountsByProjectId(projectId, previousAdminLoginTime);
    let projectAuditionsCount = 0;
    let projectNewAuditionsCount = 0;
    const roleCountsById = new Map();
    const roleCountsByName = new Map();
    roleCountRows.forEach((row) => {
      const counts = {
        total: Number(row.total_auditions) || 0,
        newSinceLastSession: Number(row.new_since_last_session) || 0,
      };
      projectAuditionsCount += counts.total;
      projectNewAuditionsCount += counts.newSinceLastSession;
      if (row.role_id) {
        roleCountsById.set(Number(row.role_id), counts);
      }
      if (row.role) {
        roleCountsByName.set(String(row.role), counts);
      }
    });
    // If Bunny Stream is used, pre-compute signed embed URLs for each audition video
    const libId = process.env.BUNNY_STREAM_LIBRARY_ID;
    const signingKey = process.env.BUNNY_STREAM_SIGNING_KEY;
    let ttl = null;
    let expires = null;
    if (signingKey && libId) {
      ttl = clampTtl(process.env.BUNNY_STREAM_TOKEN_TTL || '3600'); // clamp 1m - 24h
      expires = Math.floor(Date.now()/1000) + ttl;
      const crypto = require('crypto');
      for (const a of auditions) {
        if (!a || !a.video_url) continue;
        if (a.video_type === 'bunny_stream' && a.video_url.length > 10) {
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

    // Prepare display metadata for YouTube links (across both Bunny and YouTube primary rows).
    const extractYoutubeId = (value) => {
      const raw = trimToString(value);
      if (!raw) return null;
      try {
        const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
        const fromQuery = parsed.searchParams.get('v');
        if (fromQuery) return fromQuery;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length > 0) return parts[parts.length - 1];
      } catch (_) {
        const match = raw.match(/[?&]v=([^&]+)/);
        if (match && match[1]) return match[1];
      }
      return null;
    };

    for (const a of auditions) {
      if (!a) continue;
      const videoType = trimToString(a.video_type).toLowerCase();
      const fallbackYoutubeUrl = videoType === 'youtube' ? trimToString(a.video_url) : '';
      const youtubeUrl = trimToString(a.youtube_video_url) || fallbackYoutubeUrl;
      const youtubeId = trimToString(a.youtube_video_id) || extractYoutubeId(youtubeUrl) || extractYoutubeId(a.video_url);

      if (youtubeId) {
        a.youtube_embed_url = `https://www.youtube.com/embed/${youtubeId}`;
        a.youtube_watch_url = `https://www.youtube.com/watch?v=${youtubeId}`;
      } else if (youtubeUrl) {
        a.youtube_watch_url = youtubeUrl;
      } else {
        a.youtube_watch_url = '';
      }

      if (!a.video_watch_url && videoType === 'youtube' && a.youtube_watch_url) {
        a.video_watch_url = a.youtube_watch_url;
      }
    }

    // Format timestamps to Tel Aviv time and group auditions by role for structured display
    for (const a of auditions) {
      const pictures = Array.isArray(a.profile_pictures)
        ? a.profile_pictures
        : (a.profile_pictures || []);
      const firstPicture = pictures.find((item) => item && typeof item === 'object' && item.url) || null;
      a.profile_picture_url = firstPicture ? firstPicture.url : null;

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
    const sortedRoles = (Array.isArray(project.roles) ? [...project.roles] : []).sort(compareRolesByName);
    const rolesWithAuditions = sortedRoles.map(role => ({
      ...role,
      totalAuditions: (roleCountsById.get(Number(role.id)) || roleCountsByName.get(String(role.name)) || { total: 0 }).total || 0,
      newAuditionsCount: (roleCountsById.get(Number(role.id)) || roleCountsByName.get(String(role.name)) || { newSinceLastSession: 0 }).newSinceLastSession || 0,
      auditions: auditions.filter(a => {
        if (a.role_id) {
          return a.role_id === role.id;
        }
        return a.role === role.name;
      }).sort(compareAuditionsByNewest)
    }));
    const roleFilter = (req.query.role || '').toString().trim();
    const prioritizeRolesWithNewAuditions = (left, right) => {
      const leftHasNew = (left?.newAuditionsCount || 0) > 0 ? 1 : 0;
      const rightHasNew = (right?.newAuditionsCount || 0) > 0 ? 1 : 0;
      if (leftHasNew !== rightHasNew) {
        return rightHasNew - leftHasNew;
      }
      return compareRolesByName(left, right);
    };
    const visibleRoles = (roleFilter
      ? rolesWithAuditions.filter((role) => role.name === roleFilter)
      : rolesWithAuditions
    ).sort(prioritizeRolesWithNewAuditions);

    // Casting director page: simplify to global flag only (no per-viewer toggle)
    const disableInlineEffective = process.env.DISABLE_INLINE_PLAYER === '1';
    const youtubeReady = !!process.env.GOOGLE_REFRESH_TOKEN;

    // Add browser caching for auditions list (5 min)
    res.set('Cache-Control', 'private, max-age=300');

    res.render('auditions', {
      project: { ...project, roles: rolesWithAuditions },
      role_options: sortedRoles,
      visible_roles: visibleRoles,
      query: req.query,
      bunny_stream_library_id: process.env.BUNNY_STREAM_LIBRARY_ID, // Pass library ID to the template
      disable_inline_player: disableInlineEffective,
      youtube_ready: youtubeReady,
      redirect_to: req.originalUrl,
      project_auditions_count: projectAuditionsCount,
      project_new_auditions_count: projectNewAuditionsCount,
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Projects', url: '/projects' },
        { label: project.name || `Project ${project.id}`, url: `/projects/${project.id}/auditions` },
        { label: 'Auditions', url: `/projects/${project.id}/auditions` },
      ],
    });
  } catch (error) {
    console.error(`[App.js GET /projects/:projectId/auditions] Error fetching auditions:`, error);
    if (isTransientDbTimeoutError(error)) {
      return res.status(503).render('error/500', {
        message: 'Temporary server connection issue. Please wait a few seconds and try again.',
      });
    }
    res.status(500).render('error/500', { message: 'Error fetching auditions.' });
  }
});

// API route: search auditions globally by performer name
app.get('/api/auditions/search', async (req, res, next) => {
  try {
    const term = (req.query.term || '').trim();
    let name = (req.query.name || '').trim();
    let email = (req.query.email || '').trim();

    if (!name && !email && term) {
      if (term.includes('@')) {
        email = term;
      } else {
        name = term;
      }
    }

    if (!name && !email) {
      return res.status(400).json({ error: 'Provide a "term", "name", or "email" query parameter.' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const results = await auditionService.searchAuditions({ name, email, limit, offset });
    res.json({
      query: { term, name, email },
      limit,
      offset,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error('[API] /api/auditions/search failed:', error);
    next(error);
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


// --- Bunny upload-intent reconciliation (Step 3) admin endpoints ---
// Observability + on-demand trigger for the reconciliation worker.
// NOTE: must be registered BEFORE the catch-all 404 handler below.
const INTENT_STATE_BADGE = {
  intent_created: 'bg-secondary',
  token_issued: 'bg-info text-dark',
  upload_started: 'bg-info text-dark',
  uploaded: 'bg-primary',
  processing: 'bg-primary',
  completed: 'bg-success',
  expired: 'bg-secondary',
  failed: 'bg-danger',
  orphaned: 'bg-warning text-dark'
};
const intentBadgeClass = (state) => INTENT_STATE_BADGE[state] || 'bg-secondary';
const formatIntentTime = (value) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IL', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Jerusalem'
  });
};

app.get('/admin/upload-intents', requireAdmin, async (req, res) => {
  try {
    const counts = await uploadIntentService.countByState();
    if (req.query.format === 'json') {
      return res.json({ ok: true, counts });
    }

    // Pagination + filter params
    const PER_PAGE_OPTIONS = [25, 50, 100];
    const perPage = PER_PAGE_OPTIONS.includes(Number(req.query.perPage))
      ? Number(req.query.perPage) : 50;
    const filterProjectId = req.query.projectId || '';
    const mirrorFailuresOnly = req.query.mirrorFailuresOnly === '1';
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * perPage;

    const [recentRaw, total, projectOptions] = await Promise.all([
      uploadIntentService.listRecent(perPage, offset, filterProjectId || null, mirrorFailuresOnly),
      uploadIntentService.countIntents(filterProjectId || null, mirrorFailuresOnly),
      uploadIntentService.listIntentProjects()
    ]);

    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const decorated = counts.map((c) => ({ ...c, badgeClass: intentBadgeClass(c.state) }));
    const recent = recentRaw.map((r) => ({
      ...r,
      badgeClass: intentBadgeClass(r.state),
      created_fmt: formatIntentTime(r.created_at),
      updated_fmt: formatIntentTime(r.updated_at),
      audition_admin_url: (() => {
        const projectId = Number(r.project_id);
        const auditionId = Number(r.audition_id);
        if (!Number.isInteger(projectId) || projectId <= 0) return '';
        if (!Number.isInteger(auditionId) || auditionId <= 0) return '';
        return `/projects/${projectId}/auditions#audition-row-${auditionId}`;
      })(),
      youtube_link: trimToString(r.youtube_video_url)
        || (trimToString(r.youtube_video_id) ? `https://www.youtube.com/watch?v=${trimToString(r.youtube_video_id)}` : ''),
      mirrorStatus: (() => {
        const hasYoutube = Boolean(trimToString(r.youtube_video_id) || trimToString(r.youtube_video_url));
        const isBunnyPrimary = trimToString(r.audition_video_type).toLowerCase() === 'bunny_stream';
        if (!r.audition_id) {
          return { label: 'No Audition Yet', className: 'bg-secondary' };
        }
        if (hasYoutube) {
          return { label: 'Mirrored', className: 'bg-success' };
        }
        if (r.state === 'completed' && isBunnyPrimary) {
          return { label: 'Mirror Failed', className: 'bg-danger' };
        }
        if (r.state === 'failed' || r.state === 'orphaned' || r.state === 'expired') {
          return { label: 'Blocked', className: 'bg-warning text-dark' };
        }
        return { label: 'Pending', className: 'bg-primary' };
      })(),
      needsMirrorRetry: Boolean(
        r.audition_id
        && r.state === 'completed'
        && trimToString(r.audition_video_type).toLowerCase() === 'bunny_stream'
        && !trimToString(r.youtube_video_id)
        && !trimToString(r.youtube_video_url)
      ),
    }));

    const makeUrl = (p, proj, pp, failedOnly) => {
      const params = new URLSearchParams();
      if (p > 1) params.set('page', p);
      if (proj) params.set('projectId', proj);
      if (failedOnly) params.set('mirrorFailuresOnly', '1');
      if (pp !== 50) params.set('perPage', pp);
      const qs = params.toString();
      return '/admin/upload-intents' + (qs ? '?' + qs : '');
    };
    const currentUrl = makeUrl(page, filterProjectId, perPage, mirrorFailuresOnly);

    const lastReconcile = req.session.lastReconcile || null;
    if (req.session.lastReconcile) delete req.session.lastReconcile;

    res.render('admin/upload-intents', {
      title: 'Upload Intents - Hila Yuval Casting',
      counts: decorated,
      recent,
      lastReconcile,
      // Pagination
      page, totalPages, perPage, total,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      prevUrl: makeUrl(page - 1, filterProjectId, perPage, mirrorFailuresOnly),
      nextUrl: makeUrl(page + 1, filterProjectId, perPage, mirrorFailuresOnly),
      perPageOptions: PER_PAGE_OPTIONS.map((n) => ({
        value: n, label: `${n} / page`, selected: n === perPage
      })),
      // Filter
      filterProjectId,
      mirrorFailuresOnly,
      currentUrl,
      projectOptions: projectOptions.map((p) => ({
        ...p, selected: String(p.id) === String(filterProjectId)
      })),
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Projects', url: '/projects' },
        { label: 'Admin', url: '/admin/login' },
        { label: 'Upload Intents', url: '/admin/upload-intents' },
      ]
    });
  } catch (err) {
    console.error('ADMIN_UPLOAD_INTENTS_ERROR:', err.message);
    if (req.query.format === 'json') {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.status(500).render('error/500', { message: 'Failed to load upload intents.' });
  }
});


app.post('/admin/agents/:agentId/contacts', requireAdmin, async (req, res) => {
  const agentId = Number(req.params.agentId);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    req.flash('error', 'Invalid agent id.');
    return res.redirect('/admin/agents');
  }
  const { contact_name, phone, email, is_primary } = req.body;
  try {
    if (is_primary === '1' || is_primary === 'true' || is_primary === 'on') {
      await dbPool.query('UPDATE agent_contacts SET is_primary = FALSE WHERE agent_id = $1', [agentId]);
    }
    await dbPool.query(
      `INSERT INTO agent_contacts (agent_id, contact_name, phone, email, is_primary)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        agentId,
        (contact_name || '').trim() || null,
        (phone || '').trim() || null,
        (email || '').trim() || null,
        is_primary === '1' || is_primary === 'true' || is_primary === 'on'
      ]
    );
    req.flash('success', 'Associate contact added.');
    return res.redirect('/admin/agents');
  } catch (error) {
    console.error('[ADMIN_AGENT_CONTACT_ADD_ERROR]', error);
    req.flash('error', 'Could not add associate contact.');
    return res.redirect('/admin/agents');
  }
});

app.post('/admin/agent-contacts/:contactId', requireAdmin, async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    req.flash('error', 'Invalid contact id.');
    return res.redirect('/admin/agents');
  }
  const { contact_name, phone, email, is_primary } = req.body;
  try {
    const contactResult = await dbPool.query('SELECT agent_id FROM agent_contacts WHERE id = $1', [contactId]);
    if (!contactResult.rows.length) {
      req.flash('error', 'Associate contact not found.');
      return res.redirect('/admin/agents');
    }
    const agentId = contactResult.rows[0].agent_id;
    if (is_primary === '1' || is_primary === 'true' || is_primary === 'on') {
      await dbPool.query('UPDATE agent_contacts SET is_primary = FALSE WHERE agent_id = $1 AND id <> $2', [agentId, contactId]);
    }
    await dbPool.query(
      `UPDATE agent_contacts
       SET contact_name = $2,
           phone = $3,
           email = $4,
           is_primary = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        contactId,
        (contact_name || '').trim() || null,
        (phone || '').trim() || null,
        (email || '').trim() || null,
        is_primary === '1' || is_primary === 'true' || is_primary === 'on'
      ]
    );
    req.flash('success', 'Associate contact updated.');
    return res.redirect('/admin/agents');
  } catch (error) {
    console.error('[ADMIN_AGENT_CONTACT_UPDATE_ERROR]', error);
    req.flash('error', 'Could not update associate contact.');
    return res.redirect('/admin/agents');
  }
});

app.post('/admin/agent-contacts/:contactId/delete', requireAdmin, async (req, res) => {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    req.flash('error', 'Invalid contact id.');
    return res.redirect('/admin/agents');
  }
  try {
    await dbPool.query('DELETE FROM agent_contacts WHERE id = $1', [contactId]);
    req.flash('success', 'Associate contact deleted.');
    return res.redirect('/admin/agents');
  } catch (error) {
    console.error('[ADMIN_AGENT_CONTACT_DELETE_ERROR]', error);
    req.flash('error', 'Could not delete associate contact.');
    return res.redirect('/admin/agents');
  }
});

app.post('/admin/reconcile-intents', requireAdmin, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const summary = await reconciliationWorker.reconcileOnce({ limit });
    if (req.query.format === 'json') {
      return res.json({ ok: true, summary });
    }
    req.session.lastReconcile = summary;
    // Preserve filter/pagination params from the form's hidden inputs
    const qs = new URLSearchParams();
    if (req.body.projectId) qs.set('projectId', req.body.projectId);
    if (req.body.mirrorFailuresOnly === '1') qs.set('mirrorFailuresOnly', '1');
    if (req.body.perPage && req.body.perPage !== '50') qs.set('perPage', req.body.perPage);
    const dest = '/admin/upload-intents' + (qs.toString() ? '?' + qs.toString() : '');
    res.redirect(dest);
  } catch (err) {
    console.error('ADMIN_RECONCILE_ERROR:', err.message);
    if (req.query.format === 'json') {
      return res.status(500).json({ ok: false, error: err.message });
    }
    req.flash('error', `Reconciliation failed: ${err.message}`);
    res.redirect('/admin/upload-intents');
  }
});

app.post('/admin/upload-intents/:intentId/retry-youtube-mirror', requireAdmin, async (req, res) => {
  const rawReturnTo = trimToString(req.body.returnTo);
  const returnTo = rawReturnTo.startsWith('/admin/upload-intents') ? rawReturnTo : '/admin/upload-intents';
  try {
    const intentId = Number(req.params.intentId);
    if (!Number.isInteger(intentId) || intentId <= 0) {
      req.flash('error', 'Invalid upload intent id.');
      return res.redirect(returnTo);
    }

    const intent = await uploadIntentService.findById(intentId);
    if (!intent) {
      req.flash('error', 'Upload intent not found.');
      return res.redirect(returnTo);
    }
    if (!intent.audition_id) {
      req.flash('error', 'Cannot retry mirror before an audition is linked.');
      return res.redirect(returnTo);
    }

    const audition = await auditionService.getAuditionById(intent.audition_id);
    if (!audition) {
      req.flash('error', `Linked audition #${intent.audition_id} was not found.`);
      return res.redirect(returnTo);
    }

    const project = await getProjectByIdWithCache(audition.project_id, 'admin_retry_intent_mirror');
    if (!project) {
      req.flash('error', `Project #${audition.project_id} was not found.`);
      return res.redirect(returnTo);
    }

    const result = await mirrorAuditionFromBunnyToYoutube({ project, audition });
    if (result && result.skipped) {
      req.flash('info', `Mirror retry skipped for intent #${intentId}: ${result.reason}.`);
    } else {
      req.flash('success', `Mirror retry finished for intent #${intentId}.`);
    }
    return res.redirect(returnTo);
  } catch (error) {
    console.error(`ADMIN_RETRY_MIRROR_ERROR: intentId=${req.params.intentId} err=${error.message}`, error);
    req.flash('error', `Mirror retry failed: ${error.message}`);
    return res.redirect(returnTo);
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

// Bunny deletion cleanup job - runs every hour
async function startBunnyCleanupJob() {
  const cleanupInterval = 60 * 60 * 1000; // Every hour
  
  async function cleanupExpiredBunnyFiles() {
    try {
      const { db } = require('./utils/database');
      const now = new Date();
      
      // Find all auditions with scheduled deletion time in the past
      const result = await db.query(
        `SELECT id, first_name_en, last_name_en, video_url 
         FROM auditions 
         WHERE bunny_deletion_scheduled_at IS NOT NULL 
         AND bunny_deletion_scheduled_at <= $1
         AND video_type = 'bunny_stream'
         LIMIT 50`,
        [now]
      );
      
      if (!result.rows || result.rows.length === 0) {
        console.log('[BUNNY_CLEANUP] No expired Bunny files to delete');
        return;
      }
      
      console.log(`[BUNNY_CLEANUP] Found ${result.rows.length} expired Bunny files to delete`);
      
      for (const audition of result.rows) {
        try {
          // Extract Bunny GUID from URL
          const urlMatch = audition.video_url?.match(/\/([a-f0-9-]+)$/);
          if (!urlMatch) {
            console.warn(`[BUNNY_CLEANUP] Could not extract GUID from URL: ${audition.video_url}`);
            continue;
          }
          
          const bunnyGuid = urlMatch[1];
          
          // Delete from Bunny
          await bunnyUploadService.deleteVideo(bunnyGuid);
          
          // Update auditions table to clear the flag
          await db.query(
            'UPDATE auditions SET bunny_deletion_scheduled_at = NULL WHERE id = $1',
            [audition.id]
          );
          
          console.log(`[BUNNY_CLEANUP] Deleted Bunny file for audition ${audition.id} (${audition.first_name_en} ${audition.last_name_en})`);
        } catch (err) {
          console.error(`[BUNNY_CLEANUP_ERROR] Failed to delete audition ${audition.id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error('[BUNNY_CLEANUP_FATAL]', err);
    }
  }
  
  // Run initial cleanup
  await cleanupExpiredBunnyFiles();
  
  // Schedule recurring cleanup
  setInterval(cleanupExpiredBunnyFiles, cleanupInterval);
  console.log('[BUNNY_CLEANUP] Job started - will run every hour');
}

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
    // Start the Bunny upload-intent reconciliation worker (Step 3).
    // Drives stale, non-terminal intents to a terminal state so orphaned
    // uploads and crashed finalizations are recovered or flagged.
    try {
        reconciliationWorker.start();
    } catch (reconErr) {
        console.error('RECONCILE_START_ERROR:', reconErr.message);
    }
    try {
        startYoutubeTokenMonitor();
    } catch (monitorErr) {
        console.error('YOUTUBE_TOKEN_MONITOR_START_ERROR:', monitorErr.message);
    }
    try {
        startBunnyCleanupJob();
    } catch (cleanupErr) {
        console.error('BUNNY_CLEANUP_START_ERROR:', cleanupErr.message);
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

const gracefulSignals = ['SIGINT', 'SIGTERM'];
gracefulSignals.forEach((signal) => {
  process.once(signal, () => {
    console.log(`INFO: Received ${signal}. Initiating graceful shutdown sequence.`);
    const timeout = setTimeout(() => {
      console.error(`FATAL: Graceful shutdown timed out after signal ${signal}. Forcing exit.`);
      process.exit(1);
    }, 10000);
    timeout.unref();

    server.close(async (err) => {
      if (err) {
        console.error(`ERROR: HTTP server close failed during ${signal}.`, err);
      }
      try {
        reconciliationWorker.stop();
      } catch (_) { /* ignore */ }
      try {
        stopYoutubeTokenMonitor();
      } catch (_) { /* ignore */ }
      try {
        await closePool(`app:${signal}`);
      } catch (dbErr) {
        console.error(`ERROR: Failed to close database pool during ${signal}.`, dbErr);
      } finally {
        const exitCode = signal === 'SIGINT' ? 130 : 0;
        process.exit(exitCode);
      }
    });
  });
});

module.exports = app; // Ensure app is exported if needed for tests or other modules
