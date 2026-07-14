import { NextResponse } from 'next/server';
import { internalMockNotFound } from '@/lib/dev-mocks/config';

type RouteContext = { params: Promise<{ path: string[] }> };

interface MockMessage {
  role?: unknown;
  content?: unknown;
}

function mockReply(messages: unknown, systemPrompt: unknown): string {
  if (
    typeof systemPrompt === 'string' &&
    systemPrompt.includes('connectivity check')
  ) {
    return 'OK';
  }

  const turns = Array.isArray(messages) ? (messages as MockMessage[]) : [];
  const latestUser = [...turns]
    .reverse()
    .find(
      (message) =>
        message?.role === 'user' && typeof message.content === 'string'
    );
  const text =
    typeof latestUser?.content === 'string' ? latestUser.content : '';

  if (/\b(humano|asesor|agente|persona)\b/i.test(text)) {
    return 'Te conecto con una persona. [[HANDOFF]]';
  }

  return text
    ? `Respuesta simulada para: ${text}`
    : 'Respuesta simulada del asistente.';
}

/**
 * Deterministic OpenAI/Anthropic stand-in for local and CI integration tests.
 * It never reads account data, saves state, or calls an external service.
 */
export async function POST(request: Request, context: RouteContext) {
  const denied = internalMockNotFound();
  if (denied) return denied;

  const { path } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const provider = path[0];

  if (
    provider === 'openai' &&
    path.slice(1).join('/') === 'v1/chat/completions'
  ) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = (messages[0] as MockMessage | undefined)?.content;
    const reply = mockReply(messages, system);
    return NextResponse.json({
      id: 'chatcmpl-internal-mock',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: reply } }],
    });
  }

  if (provider === 'anthropic' && path.slice(1).join('/') === 'v1/messages') {
    const reply = mockReply(body.messages, body.system);
    return NextResponse.json({
      id: 'msg_internal_mock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: reply }],
    });
  }

  return new Response(null, { status: 404 });
}
