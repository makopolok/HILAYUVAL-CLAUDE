const https = require('https');

const httpsRequest = (options, body) => new Promise((resolve, reject) => {
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const err = new Error(`Heroku API error: ${res.statusCode} ${res.statusMessage}`);
          err.status = res.statusCode;
          err.response = parsed;
          reject(err);
        }
      } catch (e) {
        reject(e);
      }
    });
  });
  req.on('error', (err) => reject(err));
  if (body) req.write(body);
  req.end();
});

/**
 * Update a Heroku config var for the given app.
 * Requires HEROKU_API_KEY to be present in process.env.
 * appName must be the exact Heroku app name (e.g. 'hilayuval.com').
 */
async function setHerokuConfigVar(appName, key, value) {
  if (!appName) throw new Error('Heroku app name required');
  const apiKey = process.env.HEROKU_API_KEY;
  if (!apiKey) throw new Error('HEROKU_API_KEY not set in environment; cannot update Heroku config vars');

  const payload = {};
  payload[key] = value;

  const body = JSON.stringify(payload);
  const options = {
    hostname: 'api.heroku.com',
    port: 443,
    path: `/apps/${encodeURIComponent(appName)}/config-vars`,
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.heroku+json; version=3',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'hilayuval/refresh-token-updater',
    },
    timeout: 15000,
  };

  return httpsRequest(options, body);
}

async function verifyRefreshToken(clientId, clientSecret, refreshToken) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing client_id, client_secret, or refresh_token for verification');
  }

  const postData = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token`;
  const options = {
    hostname: 'oauth2.googleapis.com',
    port: 443,
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      'User-Agent': 'hilayuval/refresh-token-verifier'
    },
    timeout: 15000,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new Error(`Google token endpoint returned ${res.statusCode}`);
            err.status = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google token request timed out'));
    });
    req.write(postData);
    req.end();
  });
}

module.exports = { setHerokuConfigVar, verifyRefreshToken };
