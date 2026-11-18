-- The person's display name (#775, owner decision 2026-11-18 «option 1»): the GitHub profile `name`, written at sign-in
-- (today the owner's GitHub connect; T-3's sign-in later) and refreshed on each later one. It names the account's owners
-- to a member («Запускать задачи может владелец аккаунта — Анна») and the people D3 talks about to an owner, in place
-- of the login, e-mail or user id, which are never shown there (SECURITY review of #804, condition 2).
--
-- Display only and never an identity: nothing looks a user up by it. The Worker strips control, format (the bidi
-- overrides and isolates among them) and line/paragraph separators before writing (as R-INT-7 does for host fields)
-- and stores NULL for a name that is empty after that; NULL means «no name», and the console words its sentence
-- without one. The CHECK keeps the length bounded; existing rows stay NULL until their next sign-in.

ALTER TABLE users ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 255);
