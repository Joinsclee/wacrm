-- ============================================================
-- 031_ai_agent_modes.sql — Phase 1: setter / closer agent
--
-- Turns the single-prompt auto-reply bot into a two-mode agent that
-- runs as a "setter" (engage + qualify + book) until the model decides
-- the lead is qualified, then switches to "closer" for that
-- conversation. One agent, two modes — no new agent rows; the account
-- still has a single `ai_configs` row.
--
-- All columns are nullable / defaulted so existing installs keep working
-- with zero config: a null setter/closer prompt falls back to the
-- generic `system_prompt` behaviour in `buildSystemPrompt`.
-- ============================================================

-- Persona + per-mode instructions on the account's single agent config.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS agent_name    TEXT,
  ADD COLUMN IF NOT EXISTS setter_prompt TEXT,
  ADD COLUMN IF NOT EXISTS closer_prompt TEXT;

-- Per-conversation lead stage. Starts at 'setter'; the auto-reply engine
-- flips it to 'closer' when the model emits the [[QUALIFIED]] sentinel.
-- NOT NULL + default so both existing and future rows have a stage.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_stage TEXT NOT NULL DEFAULT 'setter';

-- Guard the allowed values without failing if the migration re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_stage_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_stage_check
      CHECK (ai_stage IN ('setter', 'closer'));
  END IF;
END $$;
