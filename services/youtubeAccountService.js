'use strict';

/**
 * youtubeAccountService.js
 *
 * Manages persisted Google/YouTube OAuth accounts.
 * Tokens are stored AES-256-GCM encrypted using YOUTUBE_TOKEN_SECRET.
 * Falls back to the legacy GOOGLE_REFRESH_TOKEN env var when a project
 * has no linked account (backward-compatible).
 */

const crypto = require('crypto');
const { google } = require('googleapis');
const pool = require('../db');

const ALGORITHM = 'aes-256-gcm';
const TOKEN_SECRET = process.env.YOUTUBE_TOKEN_SECRET || '';

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

function encryptToken(plaintext) {
  if (!TOKEN_SECRET) throw new Error('YOUTUBE_TOKEN_SECRET env var is not set');
  const key = crypto.scryptSync(TOKEN_SECRET, 'yt-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(stored) {
  if (!TOKEN_SECRET) throw new Error('YOUTUBE_TOKEN_SECRET env var is not set');
  const [ivHex, authTagHex, encHex] = stored.split(':');
  if (!ivHex || !authTagHex || !encHex) throw new Error('Invalid encrypted token format');
  const key = crypto.scryptSync(TOKEN_SECRET, 'yt-salt', 32);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// OAuth2 client factory
// ---------------------------------------------------------------------------

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_BASE_URL || ''}/oauth2callback`
  );
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

async function listAccounts() {
  const { rows } = await pool.query(
    `SELECT id, display_name, email, channel_id, channel_title, created_at
     FROM youtube_accounts ORDER BY display_name`
  );
  return rows;
}

async function getAccountById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM youtube_accounts WHERE id = $1`, [id]
  );
  return rows[0] || null;
}

async function saveAccount({ displayName, email, channelId, channelTitle, refreshToken }) {
  const encrypted = encryptToken(refreshToken);
  // Upsert on channel_id so re-authorizing the same channel updates rather than duplicates.
  const { rows } = await pool.query(
    `INSERT INTO youtube_accounts (display_name, email, channel_id, channel_title, encrypted_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id) DO UPDATE SET
       display_name   = EXCLUDED.display_name,
       email          = EXCLUDED.email,
       channel_title  = EXCLUDED.channel_title,
       encrypted_token = EXCLUDED.encrypted_token,
       updated_at     = NOW()
     RETURNING id, display_name, email, channel_id, channel_title`,
    [displayName, email || null, channelId || null, channelTitle || null, encrypted]
  );
  return rows[0];
}

async function deleteAccount(id) {
  await pool.query(`DELETE FROM youtube_accounts WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Per-project OAuth2 client resolution
// ---------------------------------------------------------------------------

/**
 * Returns an authenticated OAuth2 client for the given project.
 * Priority:
 *   1. Project's linked youtube_accounts row (DB token, decrypted)
 *   2. Legacy GOOGLE_REFRESH_TOKEN env var (backward compat)
 * Throws if neither is available.
 */
async function getClientForProject(projectId) {
  if (projectId) {
    const { rows } = await pool.query(
      `SELECT ya.*
       FROM projects p
       JOIN youtube_accounts ya ON ya.id = p.youtube_account_id
       WHERE p.id = $1`,
      [projectId]
    );
    if (rows.length > 0) {
      const refreshToken = decryptToken(rows[0].encrypted_token);
      const client = makeOAuthClient();
      client.setCredentials({ refresh_token: refreshToken });
      return client;
    }
  }

  // Fall back to legacy global token
  const legacyToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (legacyToken) {
    const client = makeOAuthClient();
    client.setCredentials({ refresh_token: legacyToken });
    return client;
  }

  throw new Error(
    'No YouTube account configured for this project and no GOOGLE_REFRESH_TOKEN env var set.'
  );
}

/**
 * Returns a standalone client for a specific account row (used during OAuth callback).
 */
function getClientForAccount(account) {
  const refreshToken = decryptToken(account.encrypted_token);
  const client = makeOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// ---------------------------------------------------------------------------
// Convenience: fetch channel info using an already-authed client
// ---------------------------------------------------------------------------

async function fetchChannelInfo(oauthClient) {
  const yt = google.youtube({ version: 'v3', auth: oauthClient });
  const { data } = await yt.channels.list({ part: 'snippet', mine: true });
  const ch = data.items && data.items[0];
  if (!ch) return { channelId: null, channelTitle: null };
  return { channelId: ch.id, channelTitle: ch.snippet.title };
}

module.exports = {
  makeOAuthClient,
  encryptToken,
  decryptToken,
  listAccounts,
  getAccountById,
  saveAccount,
  deleteAccount,
  getClientForProject,
  getClientForAccount,
  fetchChannelInfo
};
