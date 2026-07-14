import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicUrl } from '@/lib/ai/providers/anthropic'
import { openAiUrl } from '@/lib/ai/providers/openai'
import { metaApiBase } from '@/lib/whatsapp/meta-api'

afterEach(() => vi.unstubAllEnvs())

describe('internal provider URL wiring', () => {
  it('routes every provider through the local harness in test mode', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('INTERNAL_MOCKS_ENABLED', 'true')
    vi.stubEnv('INTERNAL_META_API_BASE_URL', 'http://localhost:3100/meta/v21.0')
    vi.stubEnv('INTERNAL_OPENAI_BASE_URL', 'http://localhost:3100/ai/openai')
    vi.stubEnv('INTERNAL_ANTHROPIC_BASE_URL', 'http://localhost:3100/ai/anthropic')

    expect(metaApiBase()).toBe('http://localhost:3100/meta/v21.0')
    expect(openAiUrl()).toBe('http://localhost:3100/ai/openai/v1/chat/completions')
    expect(anthropicUrl()).toBe(
      'http://localhost:3100/ai/anthropic/v1/messages',
    )
  })

  it('always uses real provider URLs in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('INTERNAL_MOCKS_ENABLED', 'true')
    vi.stubEnv('INTERNAL_META_API_BASE_URL', 'http://localhost:3100/meta')
    vi.stubEnv('INTERNAL_OPENAI_BASE_URL', 'http://localhost:3100/ai/openai')
    vi.stubEnv('INTERNAL_ANTHROPIC_BASE_URL', 'http://localhost:3100/ai/anthropic')

    expect(metaApiBase()).toBe('https://graph.facebook.com/v21.0')
    expect(openAiUrl()).toBe('https://api.openai.com/v1/chat/completions')
    expect(anthropicUrl()).toBe('https://api.anthropic.com/v1/messages')
  })
})
