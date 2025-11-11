const bcrypt = require('bcryptjs');

const normalizeEmail = (value) => (value || '').toString().trim().toLowerCase();

const getAdminConfig = () => ({
  email: (process.env.ADMIN_EMAIL || '').toString().trim(),
  passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
});

const isAdminConfigured = () => {
  const { email, passwordHash } = getAdminConfig();
  return Boolean(email && passwordHash);
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
  const { email: adminEmail, passwordHash } = getAdminConfig();
  if (!adminEmail || !passwordHash) {
    return { ok: false, reason: 'not_configured' };
  }
  const normalizedInputEmail = normalizeEmail(email);
  if (!normalizedInputEmail || normalizedInputEmail !== normalizeEmail(adminEmail)) {
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
      email: adminEmail,
    },
  };
}

const requireAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  if (req.session) {
    req.session.pendingAdminRedirect = req.originalUrl;
  }
  if (typeof req.flash === 'function') {
    req.flash('error', 'Please log in as admin to continue.');
  }
  const query = new URLSearchParams();
  if (req.originalUrl && req.originalUrl !== '/') {
    query.set('returnTo', req.originalUrl);
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return res.redirect(`/admin/login${suffix}`);
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
