-- Follow-ups to 0026 (#554, from the review of #551).
--
-- 1. 0026 backfilled title_key with lower(title) but `sprintTitleKeyOf` also trims, so an old title with spaces around
--    it carried a key the Worker's lookup never computes. Re-key those rows to the trimmed key. The trim set is
--    JavaScript's String.prototype.trim (white space and line terminators), spelled out because SQLite's trim() only
--    strips spaces by default.
--
--    A trimmed key can equal a key another sprint of the project already holds (`Checkout` next to ` checkout `), and
--    the unique index would then abort the migration. Such a row is not re-keyed: it keeps its untrimmed key, which is
--    still unique, and the lookup finds the sprint holding the trimmed one, so the name stays taken either way. When
--    several rows would take the same trimmed key, the lowest-numbered one gets it. Nothing is renamed or deleted.
UPDATE sprints
SET title_key = trim(title_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
                                     8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
WHERE title_key IS NOT NULL
  AND title_key <> trim(title_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
                                        8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
  AND NOT EXISTS (
    SELECT 1 FROM sprints AS other
    WHERE other.project_slug = sprints.project_slug
      AND other.id <> sprints.id
      AND (
        other.title_key = trim(sprints.title_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196,
                                                      8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287,
                                                      12288, 65279))
        OR (
          other.title_key IS NOT NULL
          AND other.number < sprints.number
          AND trim(other.title_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
                                         8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
              = trim(sprints.title_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
                                             8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))
        )
      )
  );

-- 2. 0026's trigger guards INSERT only. An UPDATE must not clear a key, nor rename a sprint without rewriting its key
--    (a stale key would let the old name be taken again and hide the new one). A row 0026 left unkeyed because it
--    repeated an older title may still be updated (closed, reopened) as long as its title does not change.
CREATE TRIGGER sprints_title_key_kept
BEFORE UPDATE ON sprints
WHEN (OLD.title_key IS NOT NULL AND NEW.title_key IS NULL)
  OR (NEW.title IS NOT OLD.title AND NEW.title_key IS OLD.title_key)
BEGIN
  SELECT RAISE(ABORT, 'sprints.title_key must follow sprints.title');
END;
