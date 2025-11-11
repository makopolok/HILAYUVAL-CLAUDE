const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  authenticateAdmin,
  isAdminConfigured,
  sanitizeRedirect,
} = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    const fallback = sanitizeRedirect(req.session.pendingAdminRedirect, '/projects');
    const target = sanitizeRedirect(req.query.returnTo, fallback);
    return res.redirect(target || '/projects');
  }
  const requestedReturnTo = sanitizeRedirect(req.query.returnTo, '');
  res.render('admin/login', {
    title: 'Admin Login',
    returnTo: requestedReturnTo,
    adminConfigured: isAdminConfigured(),
  });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (req.body.email || '').toString();
  const password = (req.body.password || '').toString();
  const desiredReturnTo = sanitizeRedirect(req.body.returnTo, '');

  try {
    const result = await authenticateAdmin(email, password);
    if (!result.ok) {
      if (result.reason === 'not_configured') {
        console.error('[ADMIN_LOGIN_ERROR] Admin credentials are not configured via environment variables.');
        req.flash('error', 'Admin login is not configured. Please contact the site administrator.');
      } else {
        req.flash('error', 'Invalid email or password.');
      }
      const query = desiredReturnTo ? `?returnTo=${encodeURIComponent(desiredReturnTo)}` : '';
      return res.redirect(`/admin/login${query}`);
    }

    const fallback = sanitizeRedirect(req.session?.pendingAdminRedirect, '/projects');
    const redirectTarget = sanitizeRedirect(desiredReturnTo, fallback || '/projects');

    return req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error('[ADMIN_LOGIN_SESSION_ERROR]', regenErr);
        req.flash('error', 'Unable to create a session. Please try again.');
        return res.redirect('/admin/login');
      }
      req.session.isAdmin = true;
      req.session.admin = {
        email: result.admin.email,
        loggedInAt: new Date().toISOString(),
      };
      delete req.session.pendingAdminRedirect;
      req.flash('success', 'Welcome back!');
      return res.redirect(redirectTarget || '/projects');
    });
  } catch (error) {
    console.error('[ADMIN_LOGIN_UNEXPECTED_ERROR]', error);
    req.flash('error', 'Unexpected error while signing in. Please try again.');
    const query = desiredReturnTo ? `?returnTo=${encodeURIComponent(desiredReturnTo)}` : '';
    return res.redirect(`/admin/login${query}`);
  }
});

router.post('/logout', (req, res) => {
  const desiredReturnTo = sanitizeRedirect(req.body.returnTo, '/');
  return req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('[ADMIN_LOGOUT_SESSION_ERROR]', regenErr);
      return res.redirect(desiredReturnTo || '/');
    }
    req.flash('info', 'Signed out successfully.');
    return res.redirect(desiredReturnTo || '/');
  });
});

module.exports = router;
