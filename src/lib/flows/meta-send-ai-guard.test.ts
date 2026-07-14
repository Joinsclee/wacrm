import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  events: [] as string[],
  sendTextMessage: vi.fn(),
  decrypt: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendTextMessage: h.sendTextMessage,
  sendTypingIndicator: vi.fn(),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: h.decrypt,
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  h.events.push('contact');
                  return {
                    data: { id: 'contact-1', phone: '+15551234567' },
                    error: null,
                  };
                },
              }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => {
                h.events.push('config');
                return {
                  data: {
                    phone_number_id: 'phone-number-1',
                    access_token: 'encrypted-token',
                  },
                  error: null,
                };
              },
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          insert: () => Promise.resolve({ error: null }),
        };
      }
      if (table === 'conversations') {
        return {
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: h.rpc,
  }),
}));

import { AiReplySendNotPermittedError, engineSendText } from './meta-send';

const BASE_ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Hello!',
};

beforeEach(() => {
  h.events = [];
  h.decrypt.mockImplementation(() => {
    h.events.push('decrypt');
    return 'plain-token';
  });
  h.sendTextMessage.mockImplementation(async () => {
    h.events.push('meta');
    return { messageId: 'wamid.outbound' };
  });
  h.rpc.mockImplementation(async () => {
    h.events.push('cap');
    return { data: true, error: null };
  });
});

describe('engineSendText AI reply guard', () => {
  it('leaves ordinary Flow sends unchanged', async () => {
    await engineSendText(BASE_ARGS);

    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.sendTextMessage).toHaveBeenCalledOnce();
  });

  it('runs queued permit after local preflight and immediately before Meta', async () => {
    const beforeFirstMetaRequest = vi.fn(async () => {
      h.events.push('permit');
      return true;
    });

    await expect(
      engineSendText({
        ...BASE_ARGS,
        aiReplyGuard: { maxReplies: 3, beforeFirstMetaRequest },
      })
    ).resolves.toEqual({ whatsapp_message_id: 'wamid.outbound' });

    expect(h.events.slice(0, 5)).toEqual([
      'contact',
      'config',
      'decrypt',
      'permit',
      'meta',
    ]);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('does not reserve when credential preflight fails', async () => {
    h.decrypt.mockImplementation(() => {
      h.events.push('decrypt');
      throw new Error('decrypt failed');
    });
    const beforeFirstMetaRequest = vi.fn().mockResolvedValue(true);

    await expect(
      engineSendText({
        ...BASE_ARGS,
        aiReplyGuard: { maxReplies: 3, beforeFirstMetaRequest },
      })
    ).rejects.toThrow('decrypt failed');

    expect(beforeFirstMetaRequest).not.toHaveBeenCalled();
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('does not call Meta when the durable permit is refused', async () => {
    const error = await engineSendText({
      ...BASE_ARGS,
      aiReplyGuard: {
        maxReplies: 3,
        beforeFirstMetaRequest: async () => false,
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiReplySendNotPermittedError);
    expect(error).toMatchObject({
      name: 'AiReplySendNotPermittedError',
      reason: 'durable_guard',
    });

    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('claims the account-scoped cap late for a direct AI caller', async () => {
    await engineSendText({
      ...BASE_ARGS,
      aiReplyGuard: { maxReplies: 3 },
    });

    expect(h.events.slice(0, 5)).toEqual([
      'contact',
      'config',
      'decrypt',
      'cap',
      'meta',
    ]);
    expect(h.rpc).toHaveBeenCalledWith('claim_ai_reply_slot_for_account', {
      p_account_id: 'acct-1',
      p_conversation_id: 'conv-1',
      p_max_replies: 3,
    });
  });

  it('does not call Meta when the direct cap claim loses', async () => {
    h.rpc.mockResolvedValue({ data: false, error: null });

    const error = await engineSendText({
      ...BASE_ARGS,
      aiReplyGuard: { maxReplies: 3 },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiReplySendNotPermittedError);
    expect(error).toMatchObject({ reason: 'reply_cap' });

    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('propagates a direct cap RPC error before contacting Meta', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });

    await expect(
      engineSendText({
        ...BASE_ARGS,
        aiReplyGuard: { maxReplies: 3 },
      })
    ).rejects.toThrow('AI reply slot claim failed: database unavailable');

    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });
});
