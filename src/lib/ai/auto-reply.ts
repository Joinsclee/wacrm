import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, type AgentStage } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

const TAG = '[ai auto-reply]'

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
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
 *   - an active message-level automation is handling replies
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
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  // Short id for readable, greppable per-thread logs.
  const cid = conversationId.slice(0, 8)

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config) {
      console.log(`${TAG} ${cid} skip: no AI config or master switch off`)
      return
    }
    if (!config.autoReplyEnabled) {
      console.log(`${TAG} ${cid} skip: auto_reply_enabled is off`)
      return
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) {
      console.log(
        `${TAG} ${cid} skip: an active message automation is handling replies (standing down to avoid double-texting)`,
      )
      return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_stage')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      console.warn(
        `${TAG} ${cid} skip: conversation not found${convErr ? ` (${convErr.message})` : ''}`,
      )
      return
    }
    if (conv.assigned_agent_id) {
      console.log(`${TAG} ${cid} skip: a human agent is assigned to this thread`)
      return
    }
    if (conv.ai_autoreply_disabled) {
      console.log(
        `${TAG} ${cid} skip: auto-reply disabled on this conversation (prior handoff/opt-out)`,
      )
      return
    }
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      console.log(
        `${TAG} ${cid} skip: reply cap reached (${conv.ai_reply_count}/${config.autoReplyMaxPerConversation})`,
      )
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) {
      console.warn(`${TAG} ${cid} skip: no text messages to build context from`)
      return
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
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      console.log(
        `${TAG} ${cid} ${handoff ? 'model requested handoff' : 'model returned empty text'} → disabling auto-reply on this conversation and leaving it for a human`,
      )
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr || claimed !== true) {
      console.log(
        `${TAG} ${cid} skip: could not claim a reply slot${claimErr ? ` (${claimErr.message})` : ' (cap hit by a concurrent inbound)'}`,
      )
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
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
      if (stageErr) {
        console.warn(`${TAG} ${cid} could not promote to closer: ${stageErr.message}`)
      } else {
        console.log(`${TAG} ${cid} lead qualified → promoted to closer mode`)
      }
    }
  } catch (err) {
    console.error(`${TAG} ${cid} dispatch failed:`, err)
  }
}
