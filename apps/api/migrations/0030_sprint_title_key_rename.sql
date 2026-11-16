-- 0027's UPDATE guard refuses a rename that keeps title_key (#578, from the review of #574). It refused any title
-- change with an unchanged key, but a rename that only changes case or the white space around the title ("Sprint 1"
-- to "sprint 1") keeps its key by design (`sprintTitleKeyOf` trims and lowercases). The guard now refuses an unchanged
-- key only when the old and the new title fold to different names.
--
-- The fold is the SQL stand-in for `sprintTitleKeyOf` that 0026 and 0027 already use: JavaScript's trim set, lower()
-- for ASCII and the uppercase Cyrillic letters (ru/uk/be) spelled out, as D1's SQLite has no ICU. A case-only rename in
-- any other script folds to a different name here and is still refused unless the key is written with it: the guard
-- errs on the side of refusing. Old title is compared with new title, not with the key, so a row 0026 left unkeyed
-- (NULL) or 0027 left untrimmed can still be renamed within its own name.
DROP TRIGGER sprints_title_key_kept;

CREATE TRIGGER sprints_title_key_kept
BEFORE UPDATE ON sprints
WHEN (OLD.title_key IS NOT NULL AND NEW.title_key IS NULL)
  OR (
    NEW.title IS NOT OLD.title
    AND NEW.title_key IS OLD.title_key
    AND replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(trim(NEW.title, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
      8202, 8232, 8233, 8239, 8287, 12288, 65279))),
      'А', 'а'), 'Б', 'б'), 'В', 'в'), 'Г', 'г'), 'Д', 'д'), 'Е', 'е'), 'Ж', 'ж'), 'З', 'з'),
      'И', 'и'), 'Й', 'й'), 'К', 'к'), 'Л', 'л'), 'М', 'м'), 'Н', 'н'), 'О', 'о'), 'П', 'п'),
      'Р', 'р'), 'С', 'с'), 'Т', 'т'), 'У', 'у'), 'Ф', 'ф'), 'Х', 'х'), 'Ц', 'ц'), 'Ч', 'ч'),
      'Ш', 'ш'), 'Щ', 'щ'), 'Ъ', 'ъ'), 'Ы', 'ы'), 'Ь', 'ь'), 'Э', 'э'), 'Ю', 'ю'), 'Я', 'я'),
      'Ё', 'ё'), 'Є', 'є'), 'І', 'і'), 'Ї', 'ї'), 'Ґ', 'ґ'), 'Ў', 'ў')
    IS NOT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(trim(OLD.title, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
      8202, 8232, 8233, 8239, 8287, 12288, 65279))),
      'А', 'а'), 'Б', 'б'), 'В', 'в'), 'Г', 'г'), 'Д', 'д'), 'Е', 'е'), 'Ж', 'ж'), 'З', 'з'),
      'И', 'и'), 'Й', 'й'), 'К', 'к'), 'Л', 'л'), 'М', 'м'), 'Н', 'н'), 'О', 'о'), 'П', 'п'),
      'Р', 'р'), 'С', 'с'), 'Т', 'т'), 'У', 'у'), 'Ф', 'ф'), 'Х', 'х'), 'Ц', 'ц'), 'Ч', 'ч'),
      'Ш', 'ш'), 'Щ', 'щ'), 'Ъ', 'ъ'), 'Ы', 'ы'), 'Ь', 'ь'), 'Э', 'э'), 'Ю', 'ю'), 'Я', 'я'),
      'Ё', 'ё'), 'Є', 'є'), 'І', 'і'), 'Ї', 'ї'), 'Ґ', 'ґ'), 'Ў', 'ў')
  )
BEGIN
  SELECT RAISE(ABORT, 'sprints.title_key must follow sprints.title');
END;
