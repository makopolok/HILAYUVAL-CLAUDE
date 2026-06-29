CREATE TABLE IF NOT EXISTS admin_session_state (
  admin_email TEXT PRIMARY KEY,
  last_login_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
