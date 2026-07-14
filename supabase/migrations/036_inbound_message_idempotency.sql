-- ============================================================
-- 036_inbound_message_idempotency.sql
--
-- Meta retries the same webhook when acknowledgements are delayed or a
-- delivery is replayed. The old non-unique message_id index let the retry
-- insert a second row and re-run Flow/automation side effects before the AI
-- queue's own dedupe was reached. Make the persisted inbound/outbound message
-- identity idempotent inside its conversation.
--
-- Fail with a diagnostic instead of deleting historical data automatically.
-- ============================================================

-- The application contract is one conversation per account/contact. Without
-- this guard, concurrent first messages can both win the lookup-then-insert
-- race, after which the same Meta wamid lands in two different conversations
-- and bypasses the message-level uniqueness below.
DO $$
DECLARE
  dupe_count integer;
  sample text;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT account_id, contact_id
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING count(*) > 1
  ) duplicates;

  IF dupe_count > 0 THEN
    SELECT string_agg(
      account_id::text || ' / ' || contact_id::text || ' (' || count || ' rows)',
      E'\n  '
    )
    INTO sample
    FROM (
      SELECT account_id, contact_id, count(*) AS count
      FROM conversations
      GROUP BY account_id, contact_id
      HAVING count(*) > 1
      ORDER BY account_id, contact_id
      LIMIT 50
    ) duplicate_sample;

    RAISE EXCEPTION
      E'Cannot add UNIQUE(account_id, contact_id) on conversations — % duplicate combination(s). First 50:\n  %\nResolve the duplicate conversations, then re-run migrations.',
      dupe_count, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_contact_key
  ON conversations (account_id, contact_id);

DO $$
DECLARE
  dupe_count integer;
  sample text;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT conversation_id, message_id
    FROM messages
    WHERE message_id IS NOT NULL
    GROUP BY conversation_id, message_id
    HAVING count(*) > 1
  ) duplicates;

  IF dupe_count > 0 THEN
    SELECT string_agg(
      conversation_id::text || ' / ' || message_id || ' (' || count || ' rows)',
      E'\n  '
    )
    INTO sample
    FROM (
      SELECT conversation_id, message_id, count(*) AS count
      FROM messages
      WHERE message_id IS NOT NULL
      GROUP BY conversation_id, message_id
      HAVING count(*) > 1
      ORDER BY conversation_id, message_id
      LIMIT 50
    ) duplicate_sample;

    RAISE EXCEPTION
      E'Cannot add UNIQUE(conversation_id, message_id) on messages — % duplicate combination(s). First 50:\n  %\nResolve the duplicate message rows, then re-run migrations.',
      dupe_count, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_message_id_key
  ON messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;
