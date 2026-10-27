-- 002_sessions.sql — server-side session tokens.
--
-- A token is only accepted if it exists here and has not expired. The paywall
-- asks the server (`GET /api/me`) with the token, so a hand-written localStorage
-- session with an invented token resolves to nothing and gets the subscribe
-- screen instead of the Pro tools.

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT        PRIMARY KEY,
  email      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_email_idx ON sessions (email);
