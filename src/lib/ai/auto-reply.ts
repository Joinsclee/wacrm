import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, type AgentStage } from './defaults'
import { latestUserMessage } from './query'
import {
  AiReplySendNotPermittedError,
  engineSendText,
  engineSendTypingIndicator,
} from '@/lib/flows/meta-send'

export type AiHandoffReason = 'model' | 'empty_response'

export interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Inbound message wamid — used to show a "typing…" indicator (+ read
   *  receipt) to the customer while the model generates. Optional so
   *  non-webhook callers can omit it. */
  inboundMessageId?: string
  /**
   * Durable queue fence called only for a text response, immediately before
   * the existing atomic reply-cap claim + Meta send. Returning false means
   * a newer generation or another worker owns the send, so this invocation
   * must stop without consuming a reply slot.
   */
  beforeSend?: () => Promise<boolean>
  /**
   * Queue-owned atomic handoff commit. It validates the current lock and
   * generation while setting `ai_autoreply_disabled`; unlike beforeSend it
   * never reserves an external-send permit. Optional for direct/test callers.
   */
  commitHandoff?: (reason: AiHandoffReason) => Promise<boolean>
}

export type AiAutoReplyDispatchResult =
  | { status: 'sent' }
  | {
      status: 'skipped'
      reason:
        | 'not_configured'
        | 'auto_reply_disabled'
        | 'conversation_missing'
        | 'human_assigned'
        | 'conversation_disabled'
        | 'reply_cap'
        | 'no_context'
        | 'superseded'
    }
  | { status: 'handoff' }
  | { status: 'failed'; error: string; retryable: boolean }

const TAG = '[ai auto-reply]'

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked by the durable AI-reply job worker after the WhatsApp webhook
 * has respected deterministic Flow precedence and enqueued the inbound.
 * Mirrors the flow runner's contract: it owns its try/catch and NEVER
 * throws — a failing or slow LLM call must not affect the webhook's 200
 * to Meta.
 *
 * Every early-exit path logs its reason under the `[ai auto-reply]`
 * prefix. These gates used to `return` silently, which made "the bot
 * didn't answer" impossible to diagnose from the logs — the one lever an
 * operator has on a self-hosted box. The logs are cheap (one line per
 * inbound) and scoped to a short conversation id so a support session
 * can grep a single thread.
 *
 * Eligibility gates (any → logged no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<AiAutoReplyDispatchResult> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
    beforeSend,
    commitHandoff,
  } = args
  // Short id for readable, greppable per-thread logs.
  const cid = conversationId.slice(0, 8)
  let sendReserved = false

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config) {
      console.log(`${TAG} ${cid} skip: no AI config or master switch off`)
      return { status: 'skipped', reason: 'not_configured' }
    }
    if (!config.autoReplyEnabled) {
      console.log(`${TAG} ${cid} skip: auto_reply_enabled is off`)
      return { status: 'skipped', reason: 'auto_reply_disabled' }
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_stage')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      throw new Error(`conversation lookup failed: ${convErr.message}`)
    }
    if (!conv) {
      console.warn(`${TAG} ${cid} skip: conversation not found`)
      return { status: 'skipped', reason: 'conversation_missing' }
    }
    if (conv.assigned_agent_id) {
      console.log(`${TAG} ${cid} skip: a human agent is assigned to this thread`)
      return { status: 'skipped', reason: 'human_assigned' }
    }
    if (conv.ai_autoreply_disabled) {
      console.log(
        `${TAG} ${cid} skip: auto-reply disabled on this conversation (prior handoff/opt-out)`,
      )
      return { status: 'skipped', reason: 'conversation_disabled' }
    }
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      console.log(
        `${TAG} ${cid} skip: reply cap reached (${conv.ai_reply_count}/${config.autoReplyMaxPerConversation})`,
      )
      return { status: 'skipped', reason: 'reply_cap' }
    }

    // Show a "typing…" bubble to the customer (and mark their message
    // read) while we build context + call the model — makes the bot feel
    // human. Cosmetic and best-effort: awaited so it fires inside the
    // webhook's after(), but a failure must never block the reply.
    if (inboundMessageId) {
      try {
        await engineSendTypingIndicator({ accountId, messageId: inboundMessageId })
      } catch (err) {
        console.warn(`${TAG} ${cid} typing indicator failed (non-fatal):`, err)
      }
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) {
      console.warn(`${TAG} ${cid} skip: no text messages to build context from`)
      return { status: 'skipped', reason: 'no_context' }
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Phase 1 setter/closer: pick the mode from the conversation's stage
    // (defaults to setter) and feed the persona + per-mode instructions.
    const stage: AgentStage = conv.ai_stage === 'closer' ? 'closer' : 'setter'

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      agentName: config.agentName,
      stage,
      setterPrompt: config.setterPrompt,
      closerPrompt: config.closerPrompt,
    })

    const { text, handoff, qualified } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      const handoffReason: AiHandoffReason = handoff
        ? 'model'
        : 'empty_response'
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      console.log(
        `${TAG} ${cid} ${handoff ? 'model requested handoff' : 'model returned empty text'} → disabling auto-reply on this conversation and leaving it for a human`,
      )
      if (commitHandoff) {
        const committed = await commitHandoff(handoffReason)
        if (!committed) {
          console.log(
            `${TAG} ${cid} skip: durable job claim was superseded before handoff`,
          )
          return { status: 'skipped', reason: 'superseded' }
        }
      } else {
        await db
          .from('conversations')
          .update({
            ai_autoreply_disabled: true,
            ai_handoff_at: new Date().toISOString(),
            ai_handoff_reason: handoffReason,
          })
          .eq('id', conversationId)
          .eq('account_id', accountId)
      }
      return { status: 'handoff' }
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiReplyGuard: {
        maxReplies: config.autoReplyMaxPerConversation,
        beforeFirstMetaRequest: beforeSend
          ? async () => {
              const permitted = await beforeSend()
              sendReserved = permitted
              return permitted
            }
          : undefined,
      },
    })
    console.log(`${TAG} ${cid} sent ✓ (stage: ${stage})`)

    // Phase 1: the setter flagged the lead as qualified — promote this
    // conversation to closer mode so the NEXT reply closes. Best-effort;
    // a failure just means the next turn stays in setter mode.
    if (qualified && stage === 'setter') {
      const { error: stageErr } = await db
        .from('conversations')
        .update({ ai_stage: 'closer' })
        .eq('id', conversationId)
        .eq('account_id', accountId)
      if (stageErr) {
        console.warn(`${TAG} ${cid} could not promote to closer: ${stageErr.message}`)
      } else {
        console.log(`${TAG} ${cid} lead qualified → promoted to closer mode`)
      }
    }
    return { status: 'sent' }
  } catch (err) {
    if (err instanceof AiReplySendNotPermittedError) {
      const reason = err.reason === 'reply_cap' ? 'reply_cap' : 'superseded'
      console.log(`${TAG} ${cid} skip: ${err.message}`)
      return { status: 'skipped', reason }
    }
    console.error(`${TAG} ${cid} dispatch failed:`, err)
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      // Safe to retry only before the durable send reservation. Once the
      // permit exists, Meta may already have accepted the message.
      retryable: !sendReserved,
    }
  }
}
