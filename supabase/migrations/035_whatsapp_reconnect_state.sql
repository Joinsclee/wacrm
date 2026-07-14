-- ============================================================
-- WhatsApp connection: explicit credential-reconnection state
-- ============================================================
-- `status` continues to describe the broad connection state. These
-- fields add the operational distinction between a temporary outage
-- and credentials that an administrator must replace.

BEGIN;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS reconnect_required_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_connection_error TEXT;

COMMENT ON COLUMN whatsapp_config.reconnect_required_at IS
  'Set when the saved WhatsApp credentials cannot be used and an administrator must reconnect; cleared after successful verification or credential replacement.';

COMMENT ON COLUMN whatsapp_config.last_connection_error IS
  'Last non-transient WhatsApp credential error associated with reconnect_required_at; cleared after successful verification or credential replacement.';

COMMIT;
