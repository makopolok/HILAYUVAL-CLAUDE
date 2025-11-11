const crypto = require('crypto');

const clampTtl = (rawTtl) => {
  const parsed = parseInt(rawTtl, 10);
  if (!Number.isFinite(parsed)) {
    return 3600;
  }
  return Math.min(Math.max(parsed, 60), 86400);
};

function buildTokenMeta({ signingKey, path, ttlSeconds, includeIp, ipAddress, expiresOverride, digest = 'hex' }) {
  if (!signingKey || !path) {
    return { token: null, expires: null, ttl: null };
  }

  const ttl = clampTtl(ttlSeconds);
  let expires = typeof expiresOverride === 'number' ? expiresOverride : Math.floor(Date.now() / 1000) + ttl;
  const now = Math.floor(Date.now() / 1000);
  const effectiveTtl = typeof expiresOverride === 'number' ? Math.max(expires - now, 0) : ttl;

  let payload = signingKey + path + expires;
  if (includeIp && ipAddress) {
    payload += `IP${ipAddress}`;
  }

  const hash = crypto.createHash('md5').update(payload).digest();
  let token = hash.toString('hex');
  if (digest === 'base64url') {
    token = hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
  }

  return {
    token,
    expires,
    ttl: effectiveTtl,
  };
}

module.exports = {
  clampTtl,
  buildTokenMeta,
};
