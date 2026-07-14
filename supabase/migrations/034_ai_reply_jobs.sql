-- ============================================================
-- 034_ai_reply_jobs.sql — durable AI auto-reply coalescing
--
-- Replaces request/process-local debounce state with an account-scoped
-- Supabase queue. One row per conversation is versioned by `generation`:
-- every distinct inbound pushes `due_at` forward and increments the
-- generation, while Meta retries are ignored by the dedup table.
--
-- Workers claim due rows atomically with FOR UPDATE SKIP LOCKED. A stale
-- lock can be reclaimed, and a second atomic send reservation immediately
-- before Meta prevents two instances from sending the same generation.
-- Once that reservation exists, recovery is deliberately at-most-once:
-- the system cannot know whether a process died just before or just after
-- Meta accepted the message, so it refuses to repeat that generation.
--
-- Internal only: dashboard clients get no policies and every RPC is
-- callable exclusively by service_role.
-- ============================================================

-- Explicit handoff audit state. Existing muted conversations remain valid
-- with NULL audit fields; new model/empty/manual handoffs record both.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_handoff_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_ai_handoff_reason_check'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_ai_handoff_reason_check
      CHECK (
        ai_handoff_reason IS NULL
        OR ai_handoff_reason IN ('model', 'empty_response', 'manual')
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_reply_jobs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id            uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id                 uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  config_owner_user_id       uuid NOT NULL,
  inbound_message_id         text NOT NULL,
  generation                 bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'completed')),
  due_at                     timestamptz NOT NULL,
  locked_at                  timestamptz,
  lock_token                 uuid,
  claimed_generation         bigint,
  send_reserved_generation   bigint,
  handoff_committed_generation bigint,
  attempts                   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_outcome               text,
  last_error                 text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, conversation_id)
);

-- Durable Meta retry suppression for the AI path. `messages.message_id`
-- is intentionally not globally unique in the legacy schema, so dedupe is
-- account-scoped here instead of changing that unrelated contract.
CREATE TABLE IF NOT EXISTS public.ai_reply_inbound_dedup (
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  inbound_message_id  text NOT NULL,
  conversation_id     uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  invalidates_queue   boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, inbound_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_due
  ON public.ai_reply_jobs (due_at, id)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_account_due
  ON public.ai_reply_jobs (account_id, due_at, id)
  WHERE status IN ('pending', 'running');

-- Fence an older generation in the same transaction that durably stores a
-- new customer message. This closes the gap between the message INSERT and
-- the later Flow/automation precedence decision: a worker that has not yet
-- obtained its final Meta permit becomes stale immediately. A permit already
-- committed before this row lock is acquired remains intentionally
-- at-most-once and cannot be recalled.
CREATE OR REPLACE FUNCTION public.fence_ai_reply_job_on_customer_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ai_reply_jobs j
  SET
    generation = j.generation + 1,
    status = 'completed',
    due_at = now(),
    locked_at = NULL,
    lock_token = NULL,
    claimed_generation = NULL,
    attempts = 0,
    last_outcome = 'fenced_by_new_customer_message',
    last_error = NULL,
    updated_at = now()
  FROM public.conversations c
  WHERE c.id = NEW.conversation_id
    AND j.account_id = c.account_id
    AND j.conversation_id = c.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fence_ai_reply_job_on_customer_message
  ON public.messages;
CREATE TRIGGER fence_ai_reply_job_on_customer_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.sender_type = 'customer')
  EXECUTE FUNCTION public.fence_ai_reply_job_on_customer_message();

REVOKE ALL ON FUNCTION public.fence_ai_reply_job_on_customer_message()
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.ai_reply_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reply_inbound_dedup ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_reply_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_reply_inbound_dedup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_reply_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_reply_inbound_dedup TO service_role;

-- Account-scoped replacement for migration 029's legacy slot claim. The
-- worker already carries the queue's validated account id; applying it to
-- the cap mutation prevents a service-role caller from crossing tenants by
-- supplying a conversation UUID from another account.
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot_for_account(
  p_account_id uuid,
  p_conversation_id uuid,
  p_max_replies integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    UPDATE public.conversations c
    SET ai_reply_count = c.ai_reply_count + 1
    WHERE c.id = p_conversation_id
      AND c.account_id = p_account_id
      AND c.ai_reply_count < p_max_replies
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

-- ============================================================
-- enqueue_ai_reply_job
--
-- Atomically deduplicates the inbound, validates account ownership and
-- upserts the conversation's single coalescing row. A new generation that
-- arrives while the previous one is running leaves that lock intact; the
-- old worker's final send reservation will fail because generation changed,
-- then completion requeues the newer generation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_ai_reply_job(
  p_account_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_config_owner_user_id uuid,
  p_inbound_message_id text,
  p_delay_seconds integer DEFAULT 6
)
RETURNS TABLE (
  job_id uuid,
  job_generation bigint,
  job_due_at timestamptz,
  was_enqueued boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dedup_inserted integer;
  v_due_at timestamptz := now() + make_interval(secs => GREATEST(0, LEAST(p_delay_seconds, 60)));
BEGIN
  IF NULLIF(BTRIM(p_inbound_message_id), '') IS NULL THEN
    RAISE EXCEPTION 'inbound_message_id is required' USING ERRCODE = '22023';
  END IF;

  -- Service-role callers still prove all three domain ids belong to the
  -- same account. This keeps a future caller from forging a cross-tenant
  -- queue row while bypassing RLS.
  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.contacts ct ON ct.id = c.contact_id
    WHERE c.id = p_conversation_id
      AND c.account_id = p_account_id
      AND ct.id = p_contact_id
      AND ct.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'conversation/contact not found for account'
      USING ERRCODE = '22023';
  END IF;

  -- Do not create durable generations for accounts where auto-reply is not
  -- currently usable. The final send permit revalidates this state to close
  -- the opposite race (config disabled while a job is already running).
  IF NOT EXISTS (
    SELECT 1
    FROM public.ai_configs cfg
    JOIN public.whatsapp_config wc
      ON wc.account_id = cfg.account_id
    WHERE cfg.account_id = p_account_id
      AND cfg.is_active = true
      AND cfg.auto_reply_enabled = true
      AND wc.user_id = p_config_owner_user_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.ai_reply_inbound_dedup (
    account_id,
    inbound_message_id,
    conversation_id
  ) VALUES (
    p_account_id,
    p_inbound_message_id,
    p_conversation_id
  )
  ON CONFLICT (account_id, inbound_message_id) DO NOTHING;
  GET DIAGNOSTICS v_dedup_inserted = ROW_COUNT;

  IF v_dedup_inserted = 0 THEN
    RETURN QUERY
      SELECT j.id, j.generation, j.due_at, false
      FROM public.ai_reply_jobs j
      WHERE j.account_id = p_account_id
        AND j.conversation_id = p_conversation_id
      LIMIT 1;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.ai_reply_jobs AS current_job (
    account_id,
    conversation_id,
    contact_id,
    config_owner_user_id,
    inbound_message_id,
    generation,
    status,
    due_at
  ) VALUES (
    p_account_id,
    p_conversation_id,
    p_contact_id,
    p_config_owner_user_id,
    p_inbound_message_id,
    1,
    'pending',
    v_due_at
  )
  ON CONFLICT (account_id, conversation_id) DO UPDATE
  SET
    contact_id = EXCLUDED.contact_id,
    config_owner_user_id = EXCLUDED.config_owner_user_id,
    inbound_message_id = EXCLUDED.inbound_message_id,
    generation = current_job.generation + 1,
    status = CASE
      WHEN current_job.status = 'running' THEN 'running'
      ELSE 'pending'
    END,
    due_at = GREATEST(current_job.due_at, EXCLUDED.due_at),
    locked_at = CASE
      WHEN current_job.status = 'running' THEN current_job.locked_at
      ELSE NULL
    END,
    lock_token = CASE
      WHEN current_job.status = 'running' THEN current_job.lock_token
      ELSE NULL
    END,
    claimed_generation = CASE
      WHEN current_job.status = 'running' THEN current_job.claimed_generation
      ELSE NULL
    END,
    attempts = 0,
    last_outcome = NULL,
    last_error = NULL,
    updated_at = now()
  RETURNING
    current_job.id,
    current_job.generation,
    current_job.due_at,
    true;
END;
$$;

-- ============================================================
-- claim_ai_reply_jobs
--
-- `p_account_id` is supplied by the webhook fast path so one tenant's
-- request never drains another tenant. The protected cron passes NULL and
-- recovers due work globally. Locks older than the lease are reclaimable.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_jobs(
  p_account_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 5,
  p_stale_after_seconds integer DEFAULT 120
)
RETURNS TABLE (
  job_id uuid,
  account_id uuid,
  conversation_id uuid,
  contact_id uuid,
  config_owner_user_id uuid,
  inbound_message_id text,
  claimed_generation bigint,
  lock_token uuid,
  attempt_count integer,
  send_reserved_generation bigint,
  handoff_committed_generation bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT j.id
    FROM public.ai_reply_jobs j
    WHERE (p_account_id IS NULL OR j.account_id = p_account_id)
      AND j.due_at <= now()
      AND (
        j.status = 'pending'
        OR (
          j.status = 'running'
          AND COALESCE(j.locked_at, '-infinity'::timestamptz) <= now() - make_interval(
            secs => GREATEST(30, LEAST(p_stale_after_seconds, 3600))
          )
        )
      )
    ORDER BY j.due_at ASC, j.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 50))
  ), claimed AS (
    UPDATE public.ai_reply_jobs j
    SET
      status = 'running',
      locked_at = now(),
      lock_token = gen_random_uuid(),
      claimed_generation = j.generation,
      attempts = j.attempts + 1,
      updated_at = now()
    FROM candidates c
    WHERE j.id = c.id
    RETURNING j.*
  )
  SELECT
    c.id,
    c.account_id,
    c.conversation_id,
    c.contact_id,
    c.config_owner_user_id,
    c.inbound_message_id,
    c.claimed_generation,
    c.lock_token,
    c.attempts,
    c.send_reserved_generation,
    c.handoff_committed_generation
  FROM claimed c
  ORDER BY c.due_at ASC, c.id ASC;
$$;

-- Final generation + ownership fence immediately before the external send.
-- Exactly one worker can reserve a generation, even across app instances.
DROP FUNCTION IF EXISTS public.reserve_ai_reply_job_send(uuid, uuid, bigint);

CREATE OR REPLACE FUNCTION public.reserve_ai_reply_job_send(
  p_job_id uuid,
  p_lock_token uuid,
  p_generation bigint,
  p_account_id uuid,
  p_conversation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_replies integer;
BEGIN
  -- Lock both mutable rows while checking the current truth. This is the
  -- final gate immediately before Meta: a human assignment/mute, disabled AI
  -- config, stale generation, or exhausted cap all refuse the permit.
  SELECT cfg.auto_reply_max_per_conversation
  INTO v_max_replies
  FROM public.ai_reply_jobs j
  JOIN public.conversations c
    ON c.id = j.conversation_id
   AND c.account_id = j.account_id
  JOIN public.ai_configs cfg
    ON cfg.account_id = j.account_id
  WHERE j.id = p_job_id
    AND j.account_id = p_account_id
    AND j.conversation_id = p_conversation_id
    AND j.status = 'running'
    AND j.lock_token = p_lock_token
    AND j.claimed_generation = p_generation
    AND j.generation = p_generation
    AND j.send_reserved_generation IS DISTINCT FROM p_generation
    AND c.assigned_agent_id IS NULL
    AND c.ai_autoreply_disabled = false
    AND c.ai_reply_count < cfg.auto_reply_max_per_conversation
    AND cfg.is_active = true
    AND cfg.auto_reply_enabled = true
  -- An inbound message INSERT holds KEY SHARE on its referenced
  -- conversation before the AFTER INSERT fence locks this job. NO KEY UPDATE
  -- is sufficient for the mutable conversation fields and is compatible with
  -- that FK lock, avoiding a conversation→job / job→conversation deadlock.
  FOR UPDATE OF j, cfg
  FOR NO KEY UPDATE OF c;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- The cap claim and send reservation are one RPC transaction. The job and
  -- conversation rows remain locked from the SELECT above, so another worker
  -- cannot consume the same generation or overshoot the current cap.
  UPDATE public.conversations c
  SET ai_reply_count = c.ai_reply_count + 1
  WHERE c.id = p_conversation_id
    AND c.account_id = p_account_id
    AND c.ai_reply_count < v_max_replies;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.ai_reply_jobs j
  SET
    send_reserved_generation = p_generation,
    updated_at = now()
  WHERE j.id = p_job_id
    AND j.account_id = p_account_id
    AND j.conversation_id = p_conversation_id
    AND j.status = 'running'
    AND j.lock_token = p_lock_token
    AND j.claimed_generation = p_generation
    AND j.generation = p_generation
    AND j.send_reserved_generation IS DISTINCT FROM p_generation;

  IF NOT FOUND THEN
    -- This should be impossible while the row lock is held. Raising (rather
    -- than returning false) rolls back the cap increment as a fail-safe.
    RAISE EXCEPTION 'AI reply claim changed while reserving send'
      USING ERRCODE = '40001';
  END IF;

  RETURN true;
END;
$$;

-- Mark an inbound that deterministic handling consumed (Flow, interactive,
-- no replyable text, or matched/failed message automation). The durable
-- marker makes Meta retries no-ops, while the generation bump + terminal
-- status immediately fences any pending/running AI worker for this thread.
CREATE OR REPLACE FUNCTION public.invalidate_ai_reply_job(
  p_account_id uuid,
  p_conversation_id uuid,
  p_inbound_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_invalidation boolean;
BEGIN
  IF NULLIF(BTRIM(p_inbound_message_id), '') IS NULL THEN
    RAISE EXCEPTION 'inbound_message_id is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = p_conversation_id
      AND c.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'conversation not found for account'
      USING ERRCODE = '22023';
  END IF;

  WITH marked AS (
    INSERT INTO public.ai_reply_inbound_dedup AS existing (
      account_id,
      inbound_message_id,
      conversation_id,
      invalidates_queue
    ) VALUES (
      p_account_id,
      p_inbound_message_id,
      p_conversation_id,
      true
    )
    ON CONFLICT (account_id, inbound_message_id) DO UPDATE
    SET invalidates_queue = true
    WHERE existing.invalidates_queue = false
      AND existing.conversation_id = p_conversation_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM marked) INTO v_new_invalidation;

  IF NOT v_new_invalidation THEN
    RETURN false;
  END IF;

  UPDATE public.ai_reply_jobs j
  SET
    generation = j.generation + 1,
    status = 'completed',
    due_at = now(),
    locked_at = NULL,
    lock_token = NULL,
    claimed_generation = NULL,
    attempts = 0,
    last_outcome = 'invalidated_by_deterministic_inbound',
    last_error = NULL,
    updated_at = now()
  WHERE j.account_id = p_account_id
    AND j.conversation_id = p_conversation_id;

  RETURN true;
END;
$$;

-- Handoff has no external-send ambiguity, so it must not consume the Meta
-- permit above. Lock the queue row to serialize against enqueue, validate
-- account + conversation + claim generation, then mute the conversation in
-- the same transaction. Whichever operation obtains the job-row lock first
-- defines the order: a newer inbound either invalidates this handoff, or is
-- enqueued after the handoff and observes the conversation as human-owned.
DROP FUNCTION IF EXISTS public.commit_ai_reply_job_handoff(uuid, uuid, bigint, uuid, uuid);

CREATE OR REPLACE FUNCTION public.commit_ai_reply_job_handoff(
  p_job_id uuid,
  p_lock_token uuid,
  p_generation bigint,
  p_account_id uuid,
  p_conversation_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('model', 'empty_response') THEN
    RAISE EXCEPTION 'invalid queued AI handoff reason'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.ai_reply_jobs j
  WHERE j.id = p_job_id
    AND j.account_id = p_account_id
    AND j.conversation_id = p_conversation_id
    AND j.status = 'running'
    AND j.lock_token = p_lock_token
    AND j.claimed_generation = p_generation
    AND j.generation = p_generation
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.conversations c
  SET
    ai_autoreply_disabled = true,
    ai_handoff_at = now(),
    ai_handoff_reason = p_reason
  WHERE c.id = p_conversation_id
    AND c.account_id = p_account_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Persist the committed generation in the same transaction. If the
  -- process dies before normal completion, stale recovery finalizes this
  -- job without replaying the model or undoing a later human reactivation.
  UPDATE public.ai_reply_jobs
  SET
    handoff_committed_generation = p_generation,
    updated_at = now()
  WHERE id = p_job_id;

  RETURN true;
END;
$$;

-- Finish only if the caller still owns the claim. A newer generation wins
-- and is requeued. Safe pre-send failures may request a bounded retry; once
-- the send reservation exists, retry is refused to avoid duplicate texts.
CREATE OR REPLACE FUNCTION public.complete_ai_reply_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_generation bigint,
  p_outcome text,
  p_error text DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation bigint;
  v_send_reserved_generation bigint;
BEGIN
  SELECT j.generation, j.send_reserved_generation
  INTO v_generation, v_send_reserved_generation
  FROM public.ai_reply_jobs j
  WHERE j.id = p_job_id
    AND j.status = 'running'
    AND j.lock_token = p_lock_token
    AND j.claimed_generation = p_generation
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'lost_claim';
  END IF;

  IF v_generation > p_generation THEN
    UPDATE public.ai_reply_jobs
    SET
      status = 'pending',
      locked_at = NULL,
      lock_token = NULL,
      claimed_generation = NULL,
      attempts = 0,
      last_outcome = p_outcome,
      last_error = LEFT(p_error, 2000),
      updated_at = now()
    WHERE id = p_job_id;
    RETURN 'requeued_newer_generation';
  END IF;

  IF p_retry_after_seconds IS NOT NULL
     AND v_send_reserved_generation IS DISTINCT FROM p_generation THEN
    UPDATE public.ai_reply_jobs
    SET
      status = 'pending',
      due_at = now() + make_interval(
        secs => GREATEST(1, LEAST(p_retry_after_seconds, 3600))
      ),
      locked_at = NULL,
      lock_token = NULL,
      claimed_generation = NULL,
      last_outcome = p_outcome,
      last_error = LEFT(p_error, 2000),
      updated_at = now()
    WHERE id = p_job_id;
    RETURN 'requeued_retry';
  END IF;

  UPDATE public.ai_reply_jobs
  SET
    status = 'completed',
    locked_at = NULL,
    lock_token = NULL,
    claimed_generation = NULL,
    last_outcome = p_outcome,
    last_error = LEFT(p_error, 2000),
    updated_at = now()
  WHERE id = p_job_id;
  RETURN 'completed';
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_reply_job(uuid, uuid, uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot_for_account(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ai_reply_jobs(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_ai_reply_job_send(uuid, uuid, bigint, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_ai_reply_job(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ai_reply_job_handoff(uuid, uuid, bigint, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_ai_reply_job(uuid, uuid, bigint, text, text, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_ai_reply_job(uuid, uuid, uuid, uuid, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot_for_account(uuid, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_jobs(uuid, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ai_reply_job_send(uuid, uuid, bigint, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.invalidate_ai_reply_job(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ai_reply_job_handoff(uuid, uuid, bigint, uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_reply_job(uuid, uuid, bigint, text, text, integer)
  TO service_role;
