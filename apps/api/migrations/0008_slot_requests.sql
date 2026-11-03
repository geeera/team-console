-- "Run now" requests the console fired (#114, architect note §4). The run log is checked first (paused, a run of the
-- slot younger than the 3-hour overlap window); this table is the third layer: a request the run log does not show
-- yet locks its slot for 15 minutes (the clone-and-setup gap before `runlog start` writes its entry), and so does a
-- fire that got no answer. A `started` entry of the slot at or after `requested_at` lifts the lock. Rows are pruned
-- after 24 hours. Pause and resume are recorded in 0007's own_writes with kind 'pause' | 'resume' for their 60 s replay.
CREATE TABLE slot_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  slot         TEXT NOT NULL,              -- 'pm' | 'dev' | 'qa'
  requested_at TEXT NOT NULL,              -- ISO 8601 UTC with milliseconds, like the Worker's clock
  state        TEXT NOT NULL,              -- 'pending' (fire in flight) | 'fired' | 'unknown' (no answer)
  session_id   TEXT                        -- claude_code_session_id of a fired request, when the answer had one
);
CREATE INDEX slot_requests_recent ON slot_requests (slug, slot, requested_at);
