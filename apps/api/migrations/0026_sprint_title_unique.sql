-- One sprint title per project, compared ignoring case (#545, from the review of #542). `POST …/sprints` checks the
-- title before it writes, but two creates of one name could both pass that check and both write. A UNIQUE index makes
-- the second batch fail; the route answers it like the check does (422 `sprint-invalid`, field `title`).
--
-- The index is over a stored key, not over lower(title): D1's SQLite has no ICU, so lower() folds ASCII only and would
-- let `Спринт` and `спринт` both in, while the route and the console's dialog compare with JavaScript's lowercasing.
-- The Worker writes the key (`sprintTitleKeyOf`, @shared/contracts); this migration backfills it for the rows already
-- there with lower() plus the uppercase Cyrillic letters (ru/uk/be, the owner's languages) spelled out below. A title
-- written before this migration with uppercase letters of any other script keeps them in its key, so only such an old
-- title can still be repeated in another case; every title written after it is folded by the Worker.
ALTER TABLE sprints ADD COLUMN title_key TEXT;

UPDATE sprints SET title_key = lower(title);
UPDATE sprints SET title_key = replace(title_key, 'А', 'а');
UPDATE sprints SET title_key = replace(title_key, 'Б', 'б');
UPDATE sprints SET title_key = replace(title_key, 'В', 'в');
UPDATE sprints SET title_key = replace(title_key, 'Г', 'г');
UPDATE sprints SET title_key = replace(title_key, 'Д', 'д');
UPDATE sprints SET title_key = replace(title_key, 'Е', 'е');
UPDATE sprints SET title_key = replace(title_key, 'Ж', 'ж');
UPDATE sprints SET title_key = replace(title_key, 'З', 'з');
UPDATE sprints SET title_key = replace(title_key, 'И', 'и');
UPDATE sprints SET title_key = replace(title_key, 'Й', 'й');
UPDATE sprints SET title_key = replace(title_key, 'К', 'к');
UPDATE sprints SET title_key = replace(title_key, 'Л', 'л');
UPDATE sprints SET title_key = replace(title_key, 'М', 'м');
UPDATE sprints SET title_key = replace(title_key, 'Н', 'н');
UPDATE sprints SET title_key = replace(title_key, 'О', 'о');
UPDATE sprints SET title_key = replace(title_key, 'П', 'п');
UPDATE sprints SET title_key = replace(title_key, 'Р', 'р');
UPDATE sprints SET title_key = replace(title_key, 'С', 'с');
UPDATE sprints SET title_key = replace(title_key, 'Т', 'т');
UPDATE sprints SET title_key = replace(title_key, 'У', 'у');
UPDATE sprints SET title_key = replace(title_key, 'Ф', 'ф');
UPDATE sprints SET title_key = replace(title_key, 'Х', 'х');
UPDATE sprints SET title_key = replace(title_key, 'Ц', 'ц');
UPDATE sprints SET title_key = replace(title_key, 'Ч', 'ч');
UPDATE sprints SET title_key = replace(title_key, 'Ш', 'ш');
UPDATE sprints SET title_key = replace(title_key, 'Щ', 'щ');
UPDATE sprints SET title_key = replace(title_key, 'Ъ', 'ъ');
UPDATE sprints SET title_key = replace(title_key, 'Ы', 'ы');
UPDATE sprints SET title_key = replace(title_key, 'Ь', 'ь');
UPDATE sprints SET title_key = replace(title_key, 'Э', 'э');
UPDATE sprints SET title_key = replace(title_key, 'Ю', 'ю');
UPDATE sprints SET title_key = replace(title_key, 'Я', 'я');
UPDATE sprints SET title_key = replace(title_key, 'Ё', 'ё');
UPDATE sprints SET title_key = replace(title_key, 'Є', 'є');
UPDATE sprints SET title_key = replace(title_key, 'І', 'і');
UPDATE sprints SET title_key = replace(title_key, 'Ї', 'ї');
UPDATE sprints SET title_key = replace(title_key, 'Ґ', 'ґ');
UPDATE sprints SET title_key = replace(title_key, 'Ў', 'ў');

-- Existing duplicates (two sprints titled alike before this check existed) cannot be renamed away: titles are not
-- editable and the numbers are referenced. Every one but the lowest-numbered of its project keeps a NULL key instead,
-- which the index skips; the lookup still finds the lowest one, so the name stays taken and no answer changes.
UPDATE sprints SET title_key = NULL
WHERE EXISTS (
  SELECT 1 FROM sprints AS earlier
  WHERE earlier.project_slug = sprints.project_slug
    AND earlier.title_key = sprints.title_key
    AND earlier.number < sprints.number
);

-- A new row always carries its key, so it can never step around the index.
CREATE TRIGGER sprints_title_key_required
BEFORE INSERT ON sprints
WHEN NEW.title_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'sprints.title_key is required');
END;

CREATE UNIQUE INDEX sprints_title_key ON sprints (project_slug, title_key) WHERE title_key IS NOT NULL;
