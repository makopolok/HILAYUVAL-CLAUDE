const bcrypt = require('bcryptjs');

const normalizeEmail = (value) => (value || '').toString().trim().toLowerCase();
const parseAdminEmails = () => {
  const raw = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '').toString();
  return raw
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
};

const getAdminConfig = () => ({
  emails: parseAdminEmails(),
  passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
});

const isAdminConfigured = () => {
  const { emails, passwordHash } = getAdminConfig();
  return Boolean(emails.length && passwordHash);
};

const sanitizeRedirect = (target, fallback = '/') => {
  if (!target || typeof target !== 'string') {
    return fallback;
  }
  const trimmed = target.trim();
  if (!trimmed.startsWith('/')) {
    return fallback;
  }
  if (trimmed.startsWith('//')) {
    return fallback;
  }
  return trimmed;
};

async function authenticateAdmin(email, password) {
  const { emails: adminEmails, passwordHash } = getAdminConfig();
  if (!adminEmails.length || !passwordHash) {
    return { ok: false, reason: 'not_configured' };
  }
  const normalizedInputEmail = normalizeEmail(email);
  if (!normalizedInputEmail) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  const matchedAdminEmail = adminEmails.find((adminEmail) => normalizeEmail(adminEmail) === normalizedInputEmail);
  if (!matchedAdminEmail) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (!password) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  const match = await bcrypt.compare(password, passwordHash);
  if (!match) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  return {
    ok: true,
    admin: {
      email: matchedAdminEmail,
    },
  };
}

const requireAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  const query = new URLSearchParams();
  if (req.originalUrl && req.originalUrl !== '/') {
    query.set('returnTo', req.originalUrl);
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const loginPath = `/admin/login${suffix}`;
  const requestedWith = (req.get('x-requested-with') || '').toLowerCase();
  const acceptHeader = (req.get('accept') || '').toLowerCase();
  const expectsJson = requestedWith === 'fetch'
    || acceptHeader.includes('application/json')
    || (typeof req.accepts === 'function' && req.accepts(['html', 'json']) === 'json');

  if (req.session) {
    req.session.pendingAdminRedirect = req.originalUrl;
  }
  if (expectsJson) {
    return res.status(401).json({
      ok: false,
      error: 'Admin authentication required.',
      redirectTo: loginPath,
    });
  }
  if (typeof req.flash === 'function') {
    req.flash('error', 'Please log in as admin to continue.');
  }
  return res.redirect(loginPath);
};

const attachAdminToLocals = (req, res, next) => {
  res.locals.isAdmin = Boolean(req.session && req.session.isAdmin);
  res.locals.adminUser = req.session && req.session.admin ? req.session.admin : null;
  res.locals.adminConfigured = isAdminConfigured();
  res.locals.currentPath = req.originalUrl;
  next();
};

module.exports = {
  attachAdminToLocals,
  authenticateAdmin,
  isAdminConfigured,
  requireAdmin,
  sanitizeRedirect,
};
