-- GitHub App webhook deliveries (#12; ADR 0001 decisions 4, 5, 8; ADR 0003 decision 5). The public hooks Worker
-- writes one row per accepted delivery, only after its HMAC verified. A replay is refused by the delivery id and,
-- because `X-GitHub-Delivery` is not covered by the signature, also by the SHA-256 of the exact body (threat model
-- row 3). Payloads are never stored. Rows older than 7 days are pruned by the Worker.
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,   -- X-GitHub-Delivery
  event       TEXT NOT NULL,               -- X-GitHub-Event
  repo        TEXT NOT NULL,               -- repository.full_name as sent; '' for installation-level events
  body_sha256 TEXT NOT NULL UNIQUE,        -- hex SHA-256 of the raw body
  received_at TEXT NOT NULL                -- ISO 8601 UTC, like 0001
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);
-- Settings reads the latest delivery per repository case-insensitively (#83, ProjectSignalsRepo.eventsFor).
CREATE INDEX webhook_deliveries_repo ON webhook_deliveries (lower(repo), received_at);

-- When the console app lost access to the project's repository (`installation_repositories.removed`,
-- `installation.deleted`); cleared by `installation_repositories.added`. Settings (#15) shows it.
ALTER TABLE projects ADD COLUMN access_lost_at TEXT;
