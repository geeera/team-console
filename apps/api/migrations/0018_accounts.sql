-- Accounts are the tenant (#465, ADR 0008 decisions 1, 3-6 and "Data model"; threat model C9). Nothing reads these
-- tables yet: routes keep their behaviour until T-2 (#466) scopes them. Ids are ULIDs (`OWNER_ACCOUNT_ID` and
-- `OWNER_USER_ID` of @shared/contracts are the two this migration writes, since SQL cannot generate one); timestamps
-- are ISO 8601 UTC text; secrets are stored only as hashes or sealed ciphertext.

CREATE TABLE accounts (
  id           TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  -- Shape of `isValidSlug`; reserved slugs are refused by the code that creates accounts (`owner` is one, on purpose).
  slug         TEXT NOT NULL UNIQUE CHECK (
    length(slug) BETWEEN 2 AND 39 AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT GLOB '-*' AND slug NOT GLOB '*-'
  ),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  plan         TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team')),
  -- The operator's override of the plan defaults, read only through `entitlementsOf` (decision 6).
  entitlements TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(entitlements) AND json_type(entitlements) = 'object'),
  created_at   TEXT NOT NULL,
  suspended_at TEXT
);

-- `login` is display, the provider's id is the identity (ADR 0003 decision 2).
CREATE TABLE users (
  id               TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  provider_user_id TEXT NOT NULL CHECK (
    length(provider_user_id) BETWEEN 1 AND 20 AND provider_user_id NOT GLOB '*[^0-9]*'
  ),
  login            TEXT NOT NULL CHECK (length(login) BETWEEN 1 AND 255),
  email            TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320),
  avatar_url       TEXT CHECK (avatar_url IS NULL OR (length(avatar_url) <= 2048 AND avatar_url GLOB 'https://*')),
  -- The linked Cloudflare Access identity: set only by the explicit link of decision 3, never by email equality.
  access_subject   TEXT UNIQUE CHECK (access_subject IS NULL OR length(access_subject) BETWEEN 1 AND 255),
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  UNIQUE (provider, provider_user_id)
);
-- Written once (threat model C9): a link is never moved to another identity or quietly cleared.
CREATE TRIGGER users_access_subject_once
BEFORE UPDATE OF access_subject ON users
WHEN OLD.access_subject IS NOT NULL AND NEW.access_subject IS NOT OLD.access_subject
BEGIN
  SELECT RAISE(ABORT, 'users.access_subject is written once');
END;
-- The identity is the provider's id; re-keying a user row would hand its memberships to someone else.
CREATE TRIGGER users_identity_kept
BEFORE UPDATE OF id, provider, provider_user_id ON users
WHEN NEW.id IS NOT OLD.id OR NEW.provider IS NOT OLD.provider OR NEW.provider_user_id IS NOT OLD.provider_user_id
BEGIN
  SELECT RAISE(ABORT, 'users keep their identity');
END;

-- The console's own sessions (decision 3; used from T-3). The cookie holds a 256-bit random id, D1 its SHA-256.
CREATE TABLE sessions (
  id_hash         TEXT PRIMARY KEY NOT NULL CHECK (length(id_hash) = 64 AND id_hash NOT GLOB '*[^0-9a-f]*'),
  user_id         TEXT NOT NULL REFERENCES users (id),
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  ip_country      TEXT CHECK (ip_country IS NULL OR (length(ip_country) = 2 AND ip_country NOT GLOB '*[^A-Z]*')),
  user_agent_hash TEXT CHECK (
    user_agent_hash IS NULL OR (length(user_agent_hash) = 64 AND user_agent_hash NOT GLOB '*[^0-9a-f]*')
  ),
  revoked_at      TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE account_members (
  account_id TEXT NOT NULL REFERENCES accounts (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  invited_by TEXT REFERENCES users (id),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_members_user ON account_members (user_id);
-- The last owner can neither leave nor be demoted (ADR 0008 "Data model"), whichever code path tries.
CREATE TRIGGER account_members_last_owner_kept_delete
BEFORE DELETE ON account_members
WHEN OLD.role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM account_members
    WHERE account_id = OLD.account_id AND role = 'owner' AND user_id <> OLD.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'an account keeps its last owner');
END;
CREATE TRIGGER account_members_last_owner_kept_update
BEFORE UPDATE OF role ON account_members
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM account_members
    WHERE account_id = OLD.account_id AND role = 'owner' AND user_id <> OLD.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'an account keeps its last owner');
END;
-- A membership changes its role, nothing else.
CREATE TRIGGER account_members_keys_kept
BEFORE UPDATE OF account_id, user_id, invited_by, joined_at ON account_members
BEGIN
  SELECT RAISE(ABORT, 'a membership changes only its role');
END;
-- `INSERT OR REPLACE` deletes the conflicting row without firing DELETE triggers (recursive triggers are off), so a
-- replace could swap or demote the last owner; an insert over an existing membership is refused here instead.
CREATE TRIGGER account_members_never_replaced
BEFORE INSERT ON account_members
WHEN EXISTS (SELECT 1 FROM account_members WHERE account_id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'a membership is never replaced');
END;

-- Invite links (decision 3; used from T-3). The token travels in the URL fragment; D1 holds its SHA-256.
CREATE TABLE invites (
  token_hash  TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  login       TEXT CHECK (login IS NULL OR length(login) BETWEEN 1 AND 39),
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_by TEXT REFERENCES users (id),
  accepted_at TEXT,
  revoked_at  TEXT,
  -- An owner invite is always bound to a login; an open invite is a member invite of at most 72 hours.
  CHECK (role = 'member' OR login IS NOT NULL),
  CHECK (login IS NOT NULL OR (julianday(expires_at) - julianday(created_at)) * 24 <= 72),
  CHECK (julianday(expires_at) > julianday(created_at)),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX invites_account ON invites (account_id, created_at);

-- Per-account installations (decision 4). `projects.installation_id` (0006) keeps the provider's installation id,
-- so a project reaches its row through (`provider`, `installation_id`), unique while linked; T-4 retires the old
-- column. `linked_by_user_id` is NULL only on rows this migration backfills without an owner user.
CREATE TABLE installations (
  id                INTEGER PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  provider          TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  installation_id   TEXT NOT NULL CHECK (
    length(installation_id) BETWEEN 1 AND 20 AND installation_id NOT GLOB '*[^0-9]*'
  ),
  account_login     TEXT NOT NULL CHECK (length(account_login) BETWEEN 1 AND 255),
  linked_by_user_id TEXT REFERENCES users (id),
  linked_at         TEXT NOT NULL,
  suspended_at      TEXT,
  unlinked_at       TEXT
);
CREATE UNIQUE INDEX installations_linked ON installations (provider, installation_id) WHERE unlinked_at IS NULL;
CREATE INDEX installations_account ON installations (account_id);
-- An installation row is never re-pointed at another account or installation; relinking is a new row.
CREATE TRIGGER installations_keys_kept
BEFORE UPDATE OF id, account_id, provider, installation_id, linked_by_user_id, linked_at ON installations
BEGIN
  SELECT RAISE(ABORT, 'an installation link is never re-pointed');
END;

-- The ADR 0003 token pair per user (decision 4), sealed as `owner_connections` is. Filled by T-4, which moves the
-- owner's pair here and drops `owner_connections` in the same step; copying it now would leave a second refresh
-- token that goes stale on the first refresh (GitHub's refresh tokens are single-use).
CREATE TABLE user_connections (
  user_id            TEXT PRIMARY KEY NOT NULL REFERENCES users (id),
  login              TEXT NOT NULL,
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  key_id             TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  refreshing_until   INTEGER,
  connected_at       TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- The account audit (decision 5): append-only, written in the same batch as its action, `details` redacted by
-- `AuditRepo` before it gets here. `kind` is checked for shape only; the vocabulary is `AUDIT_EVENT_KINDS`.
CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY,
  account_id TEXT REFERENCES accounts (id),
  at         TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'job', 'runner', 'system', 'operator')),
  actor      TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 255),
  kind       TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64 AND kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z.-]*'),
  target     TEXT CHECK (target IS NULL OR length(target) BETWEEN 1 AND 255),
  details    TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(details) AND json_type(details) = 'object' AND length(details) <= 4096
  ),
  ip_country TEXT CHECK (ip_country IS NULL OR (length(ip_country) = 2 AND ip_country NOT GLOB '*[^A-Z]*')),
  -- Only the operator and the system act outside an account.
  CHECK (account_id IS NOT NULL OR actor_kind IN ('operator', 'system'))
);
CREATE INDEX audit_events_account ON audit_events (account_id, id);
CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
CREATE TRIGGER audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;
-- `INSERT OR REPLACE` with an existing id would delete that row without a DELETE trigger; refused before it does.
CREATE TRIGGER audit_events_never_replaced
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

-- Backfill. The owner's account always exists: every existing project is attached to it.
INSERT INTO accounts (id, slug, name, plan, entitlements, created_at)
VALUES ('01M6YSNJ000000000000000001', 'owner', 'Owner', 'team', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The owner's user only from an unambiguous owner connection: exactly one GitHub user id across the rows. No row, or
-- rows of different users, create no user and no membership (fail closed: no one becomes an owner by a guess).
-- OWNER_EMAIL is a Worker variable SQL cannot read; `email` is display only and never links an identity, so it
-- stays NULL, as `access_subject` does until the explicit link (decision 3).
INSERT INTO users (id, provider, provider_user_id, login, created_at, last_seen_at)
SELECT '01M6YSNJ000000000000000002', 'github', CAST(user_id AS TEXT), login, connected_at, updated_at
FROM owner_connections
WHERE (SELECT COUNT(DISTINCT user_id) FROM owner_connections) = 1 AND user_id > 0
ORDER BY updated_at DESC
LIMIT 1;

INSERT INTO account_members (account_id, user_id, role, invited_by, joined_at)
SELECT '01M6YSNJ000000000000000001', id, 'owner', NULL, created_at FROM users WHERE id = '01M6YSNJ000000000000000002';

-- Every installation the registry recorded on a project becomes a link of the owner's account. One GitHub
-- installation belongs to one GitHub account, so its repositories share an owner login.
INSERT INTO installations (account_id, provider, installation_id, account_login, linked_by_user_id, linked_at)
SELECT '01M6YSNJ000000000000000001', provider, CAST(installation_id AS TEXT),
       MIN(substr(repo, 1, instr(repo, '/') - 1)),
       (SELECT id FROM users WHERE id = '01M6YSNJ000000000000000002'),
       MIN(added_at)
FROM projects
WHERE installation_id IS NOT NULL AND installation_id > 0 AND instr(repo, '/') > 1
GROUP BY provider, installation_id;

-- Projects belong to an account. SQLite adds a NOT NULL column only with a constant default and no REFERENCES
-- under foreign keys, so the default is the owner's account (what every create means until T-2 passes the account
-- explicitly) and the reference is enforced by the triggers below.
ALTER TABLE projects ADD COLUMN account_id TEXT NOT NULL DEFAULT '01M6YSNJ000000000000000001';
-- The provider's repository id (decision 2: webhooks match by id, never by `full_name`); T-2 backfills it.
ALTER TABLE projects ADD COLUMN repo_id INTEGER CHECK (repo_id IS NULL OR repo_id > 0);
CREATE INDEX projects_account ON projects (account_id);
CREATE UNIQUE INDEX projects_repo_id ON projects (provider, repo_id) WHERE repo_id IS NOT NULL;

CREATE TRIGGER projects_account_exists
BEFORE INSERT ON projects
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'projects.account_id must be an account');
END;
-- A project never moves between accounts: that would hand one tenant's tracker to another.
CREATE TRIGGER projects_account_kept
BEFORE UPDATE OF account_id ON projects
WHEN NEW.account_id IS NOT OLD.account_id
BEGIN
  SELECT RAISE(ABORT, 'projects never change account');
END;
-- The repository id is recorded once from the provider's API, then kept.
CREATE TRIGGER projects_repo_id_kept
BEFORE UPDATE OF repo_id ON projects
WHEN OLD.repo_id IS NOT NULL AND NEW.repo_id IS NOT OLD.repo_id
BEGIN
  SELECT RAISE(ABORT, 'projects.repo_id is never changed');
END;
-- An account with projects is never deleted out from under them (T-6 deletes the projects first).
CREATE TRIGGER accounts_kept_with_projects
BEFORE DELETE ON accounts
WHEN EXISTS (SELECT 1 FROM projects WHERE account_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'an account with projects is not deleted');
END;
CREATE TRIGGER accounts_id_kept
BEFORE UPDATE OF id ON accounts
BEGIN
  SELECT RAISE(ABORT, 'accounts keep their id');
END;

-- The backfill's own audit rows, so the account's history starts with how it came to be.
INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
SELECT id, created_at, 'system', 'migration', 'account.created', slug, '{"via":"0018_accounts"}'
FROM accounts WHERE id = '01M6YSNJ000000000000000001';

INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
SELECT account_id, joined_at, 'system', 'migration', 'member.joined', user_id,
       json_object('via', '0018_accounts', 'role', role)
FROM account_members WHERE account_id = '01M6YSNJ000000000000000001';

INSERT INTO audit_events (account_id, at, actor_kind, actor, kind, target, details)
SELECT account_id, linked_at, 'system', 'migration', 'installation.linked', provider || ':' || installation_id,
       json_object('via', '0018_accounts', 'accountLogin', account_login)
FROM installations WHERE account_id = '01M6YSNJ000000000000000001'
ORDER BY id;
