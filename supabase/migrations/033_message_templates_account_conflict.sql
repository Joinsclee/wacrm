-- ============================================================
-- 033_message_templates_account_conflict.sql
--
-- Template identity became account-scoped in migration 017, but the legacy
-- uniqueness key from migration 014 still used the original author:
--   (user_id, name, language)
--
-- That lets two teammates create separate local rows for the same Meta
-- template variant. Replace it with the account-level key used by the submit
-- route. Fail loudly if existing cross-teammate duplicates need a human
-- decision; never delete or merge template records automatically.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE
  dupe_count INT;
  sample TEXT;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT account_id, name, COALESCE(language, 'en_US') AS language
    FROM message_templates
    GROUP BY account_id, name, COALESCE(language, 'en_US')
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    SELECT string_agg(
      account_id::text || ' / ' || name || ' / ' ||
        COALESCE(language, '(null)') || ' (' || count || ' rows)',
      E'\n  '
    )
    INTO sample
    FROM (
      SELECT
        account_id,
        name,
        COALESCE(language, 'en_US') AS language,
        count(*) AS count
      FROM message_templates
      GROUP BY account_id, name, COALESCE(language, 'en_US')
      HAVING count(*) > 1
    ) dupe_detail;

    RAISE EXCEPTION
      E'Cannot add UNIQUE(account_id, name, language) on message_templates — % duplicate combination(s):\n  %\nResolve the duplicate rows for each account, then re-run migrations.',
      dupe_count, sample;
  END IF;
END $$;

-- The original column was nullable even though the application contract and
-- default both require a language. Canonicalise legacy NULLs before adding
-- uniqueness; the duplicate check above treats NULL as en_US first so this
-- update can never merge two rows silently.
UPDATE message_templates
SET language = 'en_US'
WHERE language IS NULL;

ALTER TABLE message_templates
  ALTER COLUMN language SET DEFAULT 'en_US',
  ALTER COLUMN language SET NOT NULL;

-- Create the replacement before dropping the legacy index so a failed build
-- never leaves the table without either uniqueness guard.
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_name_language_key
  ON message_templates (account_id, name, language);

DROP INDEX IF EXISTS message_templates_user_name_language_key;
