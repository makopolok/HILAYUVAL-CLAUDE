const { google } = require('googleapis');
const { setHerokuConfigVar, verifyRefreshToken } = require('../lib/herokuConfigUpdater');

let oauth2Client = null;
let authenticatedClient = null;
let REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || null;

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube'
];

function initOauthClient() {
  oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  }
}

function mountRoutes(app, options = {}) {
  if (!oauth2Client) initOauthClient();

  app.get('/auth/google', (req, res) => {
    if (!REFRESH_TOKEN) {
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: YOUTUBE_SCOPES,
        prompt: 'consent'
      });
      res.redirect(authUrl);
    } else {
      res.render('oauth_result', { title: 'Already authorized', success: true, message: 'Application is already authorized. Refresh token is present.' });
    }
  });

  app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    if (code) {
      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        authenticatedClient = oauth2Client;

        console.log('Access Token:', tokens.access_token);
        if (tokens.refresh_token) {
          try {
            await setHerokuConfigVar(process.env.HEROKU_APP_NAME || 'hilayuval.com', 'GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
            console.info('GOOGLE_REFRESH_TOKEN updated on Heroku config vars');
            REFRESH_TOKEN = tokens.refresh_token;

            try {
              const verifyResp = await verifyRefreshToken(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, tokens.refresh_token);
              if (verifyResp && verifyResp.access_token) {
                console.info('Refresh token verified: access token obtained');
                res.render('oauth_result', { title: 'Authentication successful', success: true, message: 'Refresh token saved to Heroku config vars and verified (access token obtained). Dynos will restart to pick up the new value.' });
              } else {
                console.warn('Refresh token persisted but verification response missing access_token');
                res.render('oauth_result', { title: 'Verification incomplete', success: false, message: 'Refresh token saved to Heroku config vars but verification did not return an access token. Check client credentials.' });
              }
            } catch (verifyErr) {
              console.warn('Saved refresh token but verification failed:', verifyErr && verifyErr.message);
              res.render('oauth_result', { title: 'Verification failed', success: false, message: 'Refresh token saved to Heroku config vars but verification against Google failed. Check client_id/client_secret and try again.', details: (verifyErr && verifyErr.message) ? verifyErr.message : undefined });
            }
          } catch (herokuErr) {
            REFRESH_TOKEN = tokens.refresh_token;
            console.warn('Failed to update Heroku config var for GOOGLE_REFRESH_TOKEN:', herokuErr && herokuErr.message);
            res.render('oauth_result', { title: 'Saved locally only', success: false, message: 'Authentication succeeded but automatic update to Heroku failed. The refresh token was stored in-memory for this dyno. Set GOOGLE_REFRESH_TOKEN manually in Heroku config vars or check logs.' });
          }
        } else {
          res.render('oauth_result', { title: 'Authenticated', success: true, message: 'Authentication successful, but no new refresh token was provided (this is normal if you have authorized before). Ensure GOOGLE_REFRESH_TOKEN is set in your environment.' });
        }
      } catch (error) {
        console.error('Error authenticating with Google:', error);
        res.status(500).render('oauth_result', { title: 'Authentication error', success: false, message: 'Error during authentication. Check server logs for details.' });
      }
    } else {
      res.status(400).render('oauth_result', { title: 'Authentication failed', success: false, message: 'No authorization code was provided by Google. The OAuth flow did not complete.' });
    }
  });
}

function startTokenMonitor({ getPool } = {}) {
  // replicate the minimal token monitor behavior from app.js if needed
  // For now, do nothing; the app's existing token monitor can continue to use process.env.GOOGLE_REFRESH_TOKEN
}

function getOAuthClient() { 
  if (!oauth2Client) initOauthClient();
  return oauth2Client;
}
function getRefreshToken() { return REFRESH_TOKEN; }
function setRefreshToken(val) { REFRESH_TOKEN = val; if (oauth2Client) oauth2Client.setCredentials({ refresh_token: val }); }

module.exports = {
  mountRoutes,
  initOauthClient,
  getOAuthClient,
  getRefreshToken,
  setRefreshToken
};
