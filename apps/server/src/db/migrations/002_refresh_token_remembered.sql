-- Carries "remember me" through a token rotation.
--
-- The refresh cookie's lifetime was always set from JWT_REFRESH_TTL_REMEMBERED
-- regardless of what the user chose, so an ordinary session kept a cookie for
-- thirty days holding a token that stopped working after seven: the browser
-- presented it, the server rejected it, and the person was signed out with an
-- error rather than simply asked to sign in again.
--
-- Fixing the cookie needs the flag to survive rotation, because `refresh`
-- issues a new token every time and had nothing to read the original choice
-- from. It belongs on the row rather than in the JWT: the refresh token is the
-- thing whose lifetime it governs.
--
-- Not destructive: one nullable-with-default column. §B19.5.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS remembered BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN refresh_tokens.remembered IS
  'Whether the sign-in that created this family opted into the longer refresh lifetime.';
