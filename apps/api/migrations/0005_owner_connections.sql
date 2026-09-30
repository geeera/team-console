-- The owner's GitHub user token pair, one row per environment (#59, ADR 0003 decisions 3 and 4). Tokens are
-- AES-256-GCM ciphertexts (hex) under an HKDF subkey of the Worker secret TOKEN_ENCRYPTION_KEY, AAD
-- `environment:column`; D1 never sees a plaintext token or the key. Expiries and the refresh lease are epoch
-- seconds (the lease is compared in SQL); connected_at/updated_at are ISO 8601 UTC text like 0001.
CREATE TABLE owner_connections (
  environment        TEXT PRIMARY KEY NOT NULL,  -- local | dev | stage | production (SQLite lets a TEXT key be NULL)
  login              TEXT NOT NULL,              -- GitHub login at connect (OWNER_GITHUB_LOGIN, case as GitHub returns it)
  user_id            INTEGER NOT NULL,           -- GitHub's numeric id, pinned at connect (owner check of decision 2)
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  key_id             TEXT NOT NULL,              -- first 8 hex of SHA-256(master key): a rotated key is detected, not tried
  version            INTEGER NOT NULL DEFAULT 1, -- bumped on every write of the pair; guards the lease and deletes
  refreshing_until   INTEGER,                    -- single-flight refresh lease; NULL when nobody refreshes
  connected_at       TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
