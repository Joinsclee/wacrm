-- ============================================================
-- 032_google_calendar.sql — Phase 2: appointment booking
--
-- One Google Calendar connection per account (the business calendar).
-- The AI closer books appointments into it. Availability is computed
-- from the configured business hours minus the calendar's busy blocks
-- (Google free/busy), so the bot never offers a slot that clashes.
--
-- The OAuth refresh token is stored AES-256-GCM-encrypted (same
-- discipline as whatsapp_config.access_token and ai_configs.api_key).
-- ============================================================

CREATE TABLE IF NOT EXISTS google_calendar_config (
  account_id            UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by          UUID REFERENCES auth.users(id),
  -- Google OAuth refresh token, AES-256-GCM encrypted at rest.
  refresh_token         TEXT NOT NULL,
  -- The connected Google account email — display only.
  connected_email       TEXT,
  -- Which calendar to book into ('primary' = the account's main one).
  calendar_id           TEXT NOT NULL DEFAULT 'primary',
  -- IANA timezone the business operates in; drives slot generation.
  timezone              TEXT NOT NULL DEFAULT 'America/Bogota',
  -- Business hours per weekday: [start,end] "HH:MM" or null = closed.
  business_hours        JSONB NOT NULL DEFAULT
    '{"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","18:00"],"sat":null,"sun":null}',
  slot_duration_minutes INT NOT NULL DEFAULT 30
    CHECK (slot_duration_minutes BETWEEN 5 AND 480),
  -- Master switch: only when true does the closer offer to book.
  enabled               BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE google_calendar_config ENABLE ROW LEVEL SECURITY;

-- Any account member may read (settings/inbox reflect connection state);
-- only admin+ may connect, edit, or disconnect. Mirrors ai_configs.
DROP POLICY IF EXISTS gcal_select ON google_calendar_config;
CREATE POLICY gcal_select ON google_calendar_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS gcal_insert ON google_calendar_config;
CREATE POLICY gcal_insert ON google_calendar_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS gcal_update ON google_calendar_config;
CREATE POLICY gcal_update ON google_calendar_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS gcal_delete ON google_calendar_config;
CREATE POLICY gcal_delete ON google_calendar_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON google_calendar_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON google_calendar_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
