-- Enrolment intents (#634 PR 3, architect note section 2; threat model C4 R-INT-1…7). A second door beside the
-- one-time code of 0021, with no secret on the human side: the owner's wizard creates a request (an id, never a
-- credential), the runner's `setup` binds its public key to it, the owner compares the key's fingerprint and approves,
-- and the runner collects its enrolment with a poll token only it holds. `runner_enrolments` (codes) is untouched.
--
-- The row is the only source of the runner it becomes (R-INT-6): account, name, scope, list and isolation are the
-- owner's, fixed at creation; the key, host, capabilities and version are the binder's, fixed at the first bind.
-- Stored states: pending → bound → approved → used, and pending|bound → withdrawn. `expired` is never stored: every
-- statement judges `expires_at` against its own `now`, as the codes do, so no row says one thing while its clock
-- says another. Timestamps are ISO 8601 UTC text, CHECKed where the Worker compares them.

CREATE TABLE runner_enrolment_requests (
  id                TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  project_scope     TEXT NOT NULL CHECK (project_scope IN ('all', 'selected')),
  allowed_projects  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_projects) AND json_type(allowed_projects) = 'array'),
  -- What a code can grant, and nothing else: `actions-ephemeral` comes from the OIDC exchange alone (#668).
  isolation         TEXT NOT NULL CHECK (isolation IN ('container', 'user', 'none')),
  -- The audit actor of the owner who made the request: the only one who may read, approve or withdraw it (R-INT-2),
  -- and the runner's `enrolled_by` (owner decision D3).
  created_by        TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 255),
  created_at        TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', created_at) IS substr(created_at, 1, 19) AND substr(created_at, -1) = 'Z'
  ),
  expires_at        TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', expires_at) IS substr(expires_at, 1, 19) AND substr(expires_at, -1) = 'Z'
  ),
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'bound', 'approved', 'used', 'withdrawn')),
  -- The bind: the `x` of the runner's Ed25519 public JWK and nothing else (no private member can be stored).
  public_key        TEXT CHECK (public_key IS NULL OR (length(public_key) = 43 AND public_key NOT GLOB '*[^A-Za-z0-9_-]*')),
  host              TEXT CHECK (host IS NULL OR (json_valid(host) AND json_type(host) = 'object')),
  capabilities      TEXT CHECK (capabilities IS NULL OR (json_valid(capabilities) AND json_type(capabilities) = 'object')),
  version           TEXT CHECK (version IS NULL OR length(version) BETWEEN 1 AND 64),
  -- First 40 bits of the key's RFC 7638 thumbprint, Crockford base32, `ABCD-EFGH`: what the owner compares.
  fingerprint       TEXT CHECK (
    fingerprint IS NULL
    OR (length(fingerprint) = 9 AND substr(fingerprint, 5, 1) = '-'
        AND replace(fingerprint, '-', '') NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*' AND length(replace(fingerprint, '-', '')) = 8)
  ),
  -- SHA-256 of the poll token (256 random bits, returned once to the binder); never the token.
  poll_token_hash   TEXT CHECK (
    poll_token_hash IS NULL OR (length(poll_token_hash) = 64 AND poll_token_hash NOT GLOB '*[^0-9a-f]*')
  ),
  bound_at          TEXT CHECK (
    bound_at IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', bound_at) IS substr(bound_at, 1, 19) AND substr(bound_at, -1) = 'Z')
  ),
  -- `CF-IPCountry` of the bind, shown beside the fingerprint (R-INT-1).
  bound_country     TEXT CHECK (bound_country IS NULL OR (length(bound_country) = 2 AND bound_country NOT GLOB '*[^A-Z]*')),
  -- The binder's last admitted poll, for `slow-down` (R-INT-5).
  last_polled_at    TEXT,
  approved_at       TEXT CHECK (
    approved_at IS NULL
    OR (strftime('%Y-%m-%dT%H:%M:%S', approved_at) IS substr(approved_at, 1, 19) AND substr(approved_at, -1) = 'Z')
  ),
  approved_by       TEXT CHECK (approved_by IS NULL OR length(approved_by) BETWEEN 1 AND 255),
  runner_id         TEXT REFERENCES runners (id),
  collected_at      TEXT,
  withdrawn_at      TEXT,
  CHECK (julianday(expires_at) > julianday(created_at)),
  -- The scope is the one truth, never a list beside it (0036).
  CHECK (project_scope = 'selected' OR allowed_projects = '[]'),
  -- The bind is whole or absent.
  CHECK ((public_key IS NULL) = (poll_token_hash IS NULL)),
  CHECK ((public_key IS NULL) = (fingerprint IS NULL)),
  CHECK ((public_key IS NULL) = (bound_at IS NULL)),
  CHECK ((public_key IS NULL) = (host IS NULL)),
  CHECK ((public_key IS NULL) = (capabilities IS NULL)),
  CHECK ((public_key IS NULL) = (version IS NULL)),
  CHECK (bound_country IS NULL OR public_key IS NOT NULL),
  -- A pending request holds no key; a bound, approved or used one always does. A withdrawn one keeps what it had:
  -- the owner's rejection is evidence of which key asked (the note's CHECK would have cleared it, the security
  -- note's "no UPDATE changes public_key once bound" wins).
  CHECK (state <> 'pending' OR public_key IS NULL),
  CHECK (state NOT IN ('bound', 'approved', 'used') OR public_key IS NOT NULL),
  -- A runner exists exactly from approval on, with who approved and when.
  CHECK ((state IN ('approved', 'used')) = (runner_id IS NOT NULL)),
  CHECK ((runner_id IS NULL) = (approved_at IS NULL)),
  CHECK ((runner_id IS NULL) = (approved_by IS NULL)),
  CHECK ((state = 'used') = (collected_at IS NOT NULL)),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
CREATE INDEX runner_enrolment_requests_account ON runner_enrolment_requests (account_id, expires_at);

-- What the owner decided is never rewritten: the bind and the approval cannot choose account, name, scope or backend.
CREATE TRIGGER runner_enrolment_requests_keys_kept
BEFORE UPDATE OF id, account_id, name, project_scope, allowed_projects, isolation, created_by, created_at, expires_at
ON runner_enrolment_requests
BEGIN
  SELECT RAISE(ABORT, 'an enrolment request is never rewritten');
END;
-- First bind wins at the row level (R-INT-1): two `start` requests racing on one request cannot both win, and no
-- later write swaps the key the owner was shown.
CREATE TRIGGER runner_enrolment_requests_bound_once
BEFORE UPDATE OF public_key, host, capabilities, version, fingerprint, poll_token_hash, bound_at, bound_country
ON runner_enrolment_requests
WHEN OLD.public_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an enrolment request is bound once');
END;
-- One approval, one runner.
CREATE TRIGGER runner_enrolment_requests_approved_once
BEFORE UPDATE OF runner_id, approved_at, approved_by ON runner_enrolment_requests
WHEN OLD.runner_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an enrolment request is approved once');
END;
-- The state only moves forward along the flow; `used` and `withdrawn` are final.
CREATE TRIGGER runner_enrolment_requests_state_forward
BEFORE UPDATE OF state ON runner_enrolment_requests
WHEN NEW.state IS NOT OLD.state AND NOT (
  (OLD.state = 'pending' AND NEW.state IN ('bound', 'withdrawn'))
  OR (OLD.state = 'bound' AND NEW.state IN ('approved', 'withdrawn'))
  OR (OLD.state = 'approved' AND NEW.state = 'used')
)
BEGIN
  SELECT RAISE(ABORT, 'an enrolment request only moves forward');
END;
CREATE TRIGGER runner_enrolment_requests_never_replaced
BEFORE INSERT ON runner_enrolment_requests
WHEN EXISTS (SELECT 1 FROM runner_enrolment_requests WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'an enrolment request is never rewritten');
END;
