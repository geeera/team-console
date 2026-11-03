-- Web push (#11; ADR 0001 decisions 3 and 5). One row per browser that turned notifications on. The endpoint is
-- checked against the push-service allow-list before it is stored (threat model on #11, row 1), and at most 10 rows
-- are kept: a new device evicts the one that has gone longest without a delivery (row 2). `failures` counts failed
-- deliveries in a row and resets on success; 404/410 or the 5th failure in a row deletes the row. The slot reserved
-- as 0002 was taken by the next free number when this landed.
CREATE TABLE push_subscriptions (
  endpoint         TEXT PRIMARY KEY NOT NULL,  -- https URL on an allowed push-service host
  p256dh           TEXT NOT NULL,              -- base64url, 65-byte uncompressed P-256 point
  auth             TEXT NOT NULL,              -- base64url, 16 bytes
  user_agent       TEXT,                       -- shown in the device list only, cut to 256 characters
  created_at       TEXT NOT NULL,              -- ISO 8601 UTC, like 0001
  last_success_at  TEXT,
  failures         INTEGER NOT NULL DEFAULT 0
);

-- "Send a test" is accepted once per 30 s across isolates (row 7): a single row, claimed in one statement.
CREATE TABLE push_test_sends (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  sent_at  INTEGER NOT NULL                    -- epoch milliseconds
);
