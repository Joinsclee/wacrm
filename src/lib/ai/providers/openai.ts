import { AiError } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'
import { resolveInternalMockUrl } from '@/lib/dev-mocks/config'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'

export function openAiUrl(): string {
  const base = resolveInternalMockUrl(
    DEFAULT_OPENAI_BASE_URL,
    'INTERNAL_OPENAI_BASE_URL',
  )
  return `${base}/v1/chat/completions`
}

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(openAiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}
