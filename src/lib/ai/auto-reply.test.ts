import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    convError: null as { message: string } | null,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    conversationFilters: [] as { column: string; value: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => {
  class AiReplySendNotPermittedError extends Error {
    constructor(public readonly reason: 'durable_guard' | 'reply_cap') {
      super('AI reply send permit was refused')
      this.name = 'AiReplySendNotPermittedError'
    }
  }
  return {
    AiReplySendNotPermittedError,
    engineSendText: h.engineSendText,
  }
})
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      // conversations
      return {
        select: () => ({
          eq: (column: string, value: unknown) => {
            h.state.conversationFilters.push({ column, value })
            return {
              eq: (nextColumn: string, nextValue: unknown) => {
                h.state.conversationFilters.push({
                  column: nextColumn,
                  value: nextValue,
                })
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: h.state.conv,
                      error: h.state.convError,
                    }),
                }
              },
            }
          },
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return {
            eq: (column: string, value: unknown) => {
              h.state.conversationFilters.push({ column, value })
              return {
                eq: (nextColumn: string, nextValue: unknown) => {
                  h.state.conversationFilters.push({
                    column: nextColumn,
                    value: nextValue,
                  })
                  return Promise.resolve({ error: null })
                },
              }
            },
          }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: true, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'
import { AiReplySendNotPermittedError } from '@/lib/flows/meta-send'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.updatePayload = null
  h.state.convError = null
  h.state.rpcCalls = []
  h.state.conversationFilters = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockImplementation(
    async (sendArgs: {
      aiReplyGuard?: {
        beforeFirstMetaRequest?: () => Promise<boolean>
      }
    }) => {
      const guard = sendArgs.aiReplyGuard?.beforeFirstMetaRequest
      if (guard && !(await guard())) {
        throw new AiReplySendNotPermittedError('durable_guard')
      }
      return { whatsapp_message_id: 'm1' }
    },
  )
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('passes the cap to the late send guard and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'Hello!',
        aiReplyGuard: expect.objectContaining({ maxReplies: 3 }),
      }),
    )
    expect(h.state.conversationFilters).toEqual([
      { column: 'id', value: 'conv-1' },
      { column: 'account_id', value: 'acct-1' },
    ])
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('returns a retryable failure when conversation lookup fails', async () => {
    h.state.convError = { message: 'database unavailable' }

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toEqual({
      status: 'failed',
      error: 'conversation lookup failed: database unavailable',
      retryable: true,
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stops a superseded durable generation before claiming or sending', async () => {
    const beforeSend = vi.fn().mockResolvedValue(false)

    await expect(
      dispatchInboundToAiReply({ ...ARGS, beforeSend }),
    ).resolves.toEqual({ status: 'skipped', reason: 'superseded' })

    expect(beforeSend).toHaveBeenCalledOnce()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledOnce()
  })

  it('returns a retryable failure when the late permit RPC errors', async () => {
    const beforeSend = vi.fn().mockRejectedValue(new Error('permit RPC failed'))

    await expect(
      dispatchInboundToAiReply({ ...ARGS, beforeSend }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'permit RPC failed',
      retryable: true,
    })
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('preserves the direct-call handoff fallback', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toEqual({
      status: 'handoff',
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({
      ai_autoreply_disabled: true,
      ai_handoff_at: expect.any(String),
      ai_handoff_reason: 'model',
    })
    expect(h.state.conversationFilters).toEqual([
      { column: 'id', value: 'conv-1' },
      { column: 'account_id', value: 'acct-1' },
      { column: 'id', value: 'conv-1' },
      { column: 'account_id', value: 'acct-1' },
    ])
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('commits a durable handoff without reserving a Meta send', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    const commitHandoff = vi.fn().mockResolvedValue(true)
    const beforeSend = vi.fn().mockResolvedValue(true)

    await expect(
      dispatchInboundToAiReply({ ...ARGS, commitHandoff, beforeSend }),
    ).resolves.toEqual({ status: 'handoff' })

    expect(commitHandoff).toHaveBeenCalledWith('model')
    expect(beforeSend).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not apply a handoff from a superseded generation', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    const commitHandoff = vi.fn().mockResolvedValue(false)
    const beforeSend = vi.fn().mockResolvedValue(true)

    await expect(
      dispatchInboundToAiReply({ ...ARGS, commitHandoff, beforeSend }),
    ).resolves.toEqual({ status: 'skipped', reason: 'superseded' })

    expect(commitHandoff).toHaveBeenCalledWith('model')
    expect(beforeSend).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('records empty model output as an explicit handoff reason', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: false })
    const commitHandoff = vi.fn().mockResolvedValue(true)

    await expect(
      dispatchInboundToAiReply({ ...ARGS, commitHandoff }),
    ).resolves.toEqual({ status: 'handoff' })

    expect(commitHandoff).toHaveBeenCalledWith('empty_response')
  })
})
