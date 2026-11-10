-- Runners and their enrolment (#467, ADR 0008 row 2-A; ADR 0006 "Runner and job queue" as decisions 7, 8 and 12 of
-- ADR 0008 amend it; threat model C4, C9, C11). A runner belongs to one account, holds an Ed25519 public key (the
-- private half never leaves the runner host), and serves only the projects in `allowed_projects`. D1 holds hashes
-- of enrolment codes, never the codes. Timestamps are ISO 8601 UTC text, CHECKed where the Worker compares them.

CREATE TABLE runners (
  id                TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  -- An Ed25519 public JWK and nothing else: no private member, no other curve.
  public_key_jwk    TEXT NOT NULL CHECK (
    json_valid(public_key_jwk) AND json_type(public_key_jwk) = 'object'
    AND json_extract(public_key_jwk, '$.kty') = 'OKP' AND json_extract(public_key_jwk, '$.crv') = 'Ed25519'
    AND json_type(public_key_jwk, '$.x') = 'text' AND json_extract(public_key_jwk, '$.d') IS NULL
  ),
  host              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(host) AND json_type(host) = 'object'),
  capabilities      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities) AND json_type(capabilities) = 'object'),
  hosted            INTEGER NOT NULL DEFAULT 0 CHECK (hosted IN (0, 1)),
  isolation         TEXT NOT NULL CHECK (isolation IN ('container', 'user', 'actions-ephemeral', 'none')),
  allowed_projects  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_projects) AND json_type(allowed_projects) = 'array'),
  version           TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  pinned_version    TEXT CHECK (pinned_version IS NULL OR length(pinned_version) BETWEEN 1 AND 64),
  enrolled_at       TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', enrolled_at) IS substr(enrolled_at, 1, 19) AND substr(enrolled_at, -1) = 'Z'
  ),
  -- Presence (ADR 0006 "Report": `last_seen_at` <= 5 min is online) and the detection rows of threat model C4.
  last_seen_at      TEXT CHECK (
    last_seen_at IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', last_seen_at) IS substr(last_seen_at, 1, 19) AND substr(last_seen_at, -1) = 'Z')
  ),
  last_seen_country TEXT CHECK (
    last_seen_country IS NULL OR (length(last_seen_country) = 2 AND last_seen_country NOT GLOB '*[^A-Z]*')
  ),
  -- SHA-256 of the source address: enough to tell two pollers apart, never the address itself.
  last_seen_ip_hash TEXT CHECK (
    last_seen_ip_hash IS NULL OR (length(last_seen_ip_hash) = 64 AND last_seen_ip_hash NOT GLOB '*[^0-9a-f]*')
  ),
  seen_countries    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(seen_countries) AND json_type(seen_countries) = 'array'),
  suspect_at        TEXT,
  suspect_reason    TEXT CHECK (suspect_reason IS NULL OR suspect_reason IN ('new-country', 'two-pollers')),
  revoked_at        TEXT,
  CHECK ((suspect_at IS NULL) = (suspect_reason IS NULL))
);
CREATE INDEX runners_account ON runners (account_id);

-- A runner never changes account, key or enrolment time: a re-keyed row would hand its jobs to another machine.
CREATE TRIGGER runners_identity_kept
BEFORE UPDATE OF id, account_id, public_key_jwk, enrolled_at, hosted ON runners
BEGIN
  SELECT RAISE(ABORT, 'runners keep their identity');
END;
-- Revocation is final (threat model C4: a revoked key is never trusted again; re-enrol with a new one).
CREATE TRIGGER runners_revoked_once
BEFORE UPDATE OF revoked_at ON runners
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'a revoked runner stays revoked');
END;
CREATE TRIGGER runners_never_replaced
BEFORE INSERT ON runners
WHEN EXISTS (SELECT 1 FROM runners WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'runners are never replaced');
END;

-- One-time enrolment codes (ADR 0006 "Enrolment"): 256 random bits, 10 minutes, single use; the row carries what
-- the owner decided for the runner (name, allowed projects) so the enrol request cannot choose them.
CREATE TABLE runner_enrolments (
  code_hash         TEXT PRIMARY KEY NOT NULL CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  allowed_projects  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_projects) AND json_type(allowed_projects) = 'array'),
  created_by        TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 255),
  created_at        TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', created_at) IS substr(created_at, 1, 19) AND substr(created_at, -1) = 'Z'
  ),
  expires_at        TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', expires_at) IS substr(expires_at, 1, 19) AND substr(expires_at, -1) = 'Z'
  ),
  used_by_runner_id TEXT REFERENCES runners (id),
  used_at           TEXT,
  CHECK (julianday(expires_at) > julianday(created_at)),
  CHECK ((used_by_runner_id IS NULL) = (used_at IS NULL))
);
CREATE INDEX runner_enrolments_account ON runner_enrolments (account_id, created_at);
-- Single use at the row level: two enrol requests racing on one code cannot both win.
CREATE TRIGGER runner_enrolments_used_once
BEFORE UPDATE OF used_by_runner_id ON runner_enrolments
WHEN OLD.used_by_runner_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an enrolment code is used once');
END;
CREATE TRIGGER runner_enrolments_keys_kept
BEFORE UPDATE OF code_hash, account_id, name, allowed_projects, created_by, created_at, expires_at ON runner_enrolments
BEGIN
  SELECT RAISE(ABORT, 'an enrolment code is never rewritten');
END;
CREATE TRIGGER runner_enrolments_never_replaced
BEFORE INSERT ON runner_enrolments
WHEN EXISTS (SELECT 1 FROM runner_enrolments WHERE code_hash = NEW.code_hash)
BEGIN
  SELECT RAISE(ABORT, 'an enrolment code is never rewritten');
END;

-- Runner JWT replay (ADR 0008 "Customer runner authentication without Access"): every `jti` a runner presents is
-- recorded until the token's `exp`; a second presentation is refused. Rows past `expires_at` are swept on use.
CREATE TABLE runner_nonces (
  runner_id  TEXT NOT NULL REFERENCES runners (id),
  jti        TEXT NOT NULL CHECK (length(jti) BETWEEN 1 AND 128),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, jti)
);
CREATE INDEX runner_nonces_expiry ON runner_nonces (expires_at);

-- Role keys (ADR 0006 "Role keys and the gate"): empty until 2-C registers them through `POST /runner/keys`.
CREATE TABLE role_keys (
  id             INTEGER PRIMARY KEY,
  runner_id      TEXT NOT NULL REFERENCES runners (id),
  role           TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 32),
  public_key_jwk TEXT NOT NULL CHECK (
    json_valid(public_key_jwk) AND json_extract(public_key_jwk, '$.kty') = 'OKP'
    AND json_extract(public_key_jwk, '$.crv') = 'Ed25519' AND json_extract(public_key_jwk, '$.d') IS NULL
  ),
  created_at     TEXT NOT NULL,
  revoked_at     TEXT
);
CREATE UNIQUE INDEX role_keys_live ON role_keys (runner_id, role) WHERE revoked_at IS NULL;

-- Fixed-window counters for the Worker's own rate limits (enrol per source address, runner calls per runner id):
-- the WAF rule of ADR 0008 cannot apply on workers.dev (no zone), so the Worker counts in D1. One row per key.
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL CHECK (count >= 0)
);
