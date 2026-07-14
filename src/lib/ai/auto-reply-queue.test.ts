import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  dispatch: vi.fn(),
  claimRows: [] as Record<string, unknown>[],
  reserveResult: true,
  handoffCommitResult: true,
  completionResult: 'completed',
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

vi.mock('./auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatch,
}));

import {
  AI_REPLY_COALESCE_SECONDS,
  drainAiReplyJobs,
  enqueueInboundAiReply,
  invalidateAiReplyJob,
} from './auto-reply-queue';

interface MockDispatchArgs {
  beforeSend?: () => Promise<boolean>;
  commitHandoff?: (reason: 'model' | 'empty_response') => Promise<boolean>;
}

function claimedJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-1',
    account_id: 'acct-1',
    conversation_id: 'conv-1',
    contact_id: 'contact-1',
    config_owner_user_id: 'user-1',
    inbound_message_id: 'wamid.latest',
    claimed_generation: 7,
    lock_token: 'lock-1',
    attempt_count: 1,
    send_reserved_generation: null,
    handoff_committed_generation: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.claimRows = [];
  h.reserveResult = true;
  h.handoffCommitResult = true;
  h.completionResult = 'completed';
  h.rpc.mockReset();
  h.dispatch.mockReset();

  h.rpc.mockImplementation((name: string) => {
    if (name === 'claim_ai_reply_jobs') {
      return Promise.resolve({ data: h.claimRows, error: null });
    }
    if (name === 'reserve_ai_reply_job_send') {
      return Promise.resolve({ data: h.reserveResult, error: null });
    }
    if (name === 'commit_ai_reply_job_handoff') {
      return Promise.resolve({ data: h.handoffCommitResult, error: null });
    }
    if (name === 'complete_ai_reply_job') {
      return Promise.resolve({ data: h.completionResult, error: null });
    }
    if (name === 'enqueue_ai_reply_job') {
      return Promise.resolve({
        data: [
          {
            job_id: 'job-1',
            job_generation: '3',
            job_due_at: '2026-07-14T12:00:06.000Z',
            was_enqueued: true,
          },
        ],
        error: null,
      });
    }
    if (name === 'invalidate_ai_reply_job') {
      return Promise.resolve({ data: true, error: null });
    }
    throw new Error(`unexpected RPC: ${name}`);
  });

  h.dispatch.mockImplementation(async (args: MockDispatchArgs) => {
    const ownsSend = (await args.beforeSend?.()) ?? true;
    return ownsSend
      ? { status: 'sent' }
      : { status: 'skipped', reason: 'superseded' };
  });
});

describe('durable AI reply queue', () => {
  it('enqueues an account-scoped generation with the quiet-window delay', async () => {
    await expect(
      enqueueInboundAiReply({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        configOwnerUserId: 'user-1',
        inboundMessageId: 'wamid.1',
      })
    ).resolves.toEqual({
      jobId: 'job-1',
      generation: 3,
      dueAt: '2026-07-14T12:00:06.000Z',
      enqueued: true,
    });

    expect(h.rpc).toHaveBeenCalledWith('enqueue_ai_reply_job', {
      p_account_id: 'acct-1',
      p_conversation_id: 'conv-1',
      p_contact_id: 'contact-1',
      p_config_owner_user_id: 'user-1',
      p_inbound_message_id: 'wamid.1',
      p_delay_seconds: AI_REPLY_COALESCE_SECONDS,
    });
  });

  it('returns no job when the enqueue RPC finds auto-reply disabled', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(
      enqueueInboundAiReply({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        configOwnerUserId: 'historical-config-owner',
        inboundMessageId: 'wamid.disabled',
      })
    ).resolves.toBeNull();
  });

  it('claims by account, reserves the generation, and completes one send', async () => {
    h.claimRows = [claimedJob()];

    await expect(
      drainAiReplyJobs({ accountId: 'acct-1', limit: 1 })
    ).resolves.toEqual({
      claimed: 1,
      sent: 1,
      completed: 1,
      requeued: 0,
      failed: 0,
      ambiguous: 0,
    });

    expect(h.rpc).toHaveBeenCalledWith('claim_ai_reply_jobs', {
      p_account_id: 'acct-1',
      p_limit: 1,
      p_stale_after_seconds: 120,
    });
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        inboundMessageId: 'wamid.latest',
        beforeSend: expect.any(Function),
        commitHandoff: expect.any(Function),
      })
    );
    expect(h.rpc).toHaveBeenCalledWith('reserve_ai_reply_job_send', {
      p_job_id: 'job-1',
      p_lock_token: 'lock-1',
      p_generation: 7,
      p_account_id: 'acct-1',
      p_conversation_id: 'conv-1',
    });
    expect(h.rpc).toHaveBeenCalledWith('complete_ai_reply_job', {
      p_job_id: 'job-1',
      p_lock_token: 'lock-1',
      p_generation: 7,
      p_outcome: 'sent',
      p_error: null,
      p_retry_after_seconds: null,
    });
  });

  it('durably invalidates a deterministic inbound and its Meta retries', async () => {
    await expect(
      invalidateAiReplyJob({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        inboundMessageId: 'wamid.flow-consumed',
      })
    ).resolves.toBe(true);

    expect(h.rpc).toHaveBeenCalledWith('invalidate_ai_reply_job', {
      p_account_id: 'acct-1',
      p_conversation_id: 'conv-1',
      p_inbound_message_id: 'wamid.flow-consumed',
    });
  });

  it('does not repeat a stale generation whose external-send permit was reserved', async () => {
    h.claimRows = [claimedJob({ send_reserved_generation: 7 })];

    await expect(drainAiReplyJobs()).resolves.toEqual({
      claimed: 1,
      sent: 0,
      completed: 1,
      requeued: 0,
      failed: 0,
      ambiguous: 1,
    });

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith(
      'complete_ai_reply_job',
      expect.objectContaining({ p_outcome: 'ambiguous_send_reserved' })
    );
  });

  it('finalizes a committed handoff without replaying after human reactivation', async () => {
    h.claimRows = [claimedJob({ handoff_committed_generation: 7 })];

    await expect(drainAiReplyJobs()).resolves.toEqual({
      claimed: 1,
      sent: 0,
      completed: 1,
      requeued: 0,
      failed: 0,
      ambiguous: 0,
    });

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith(
      'complete_ai_reply_job',
      expect.objectContaining({ p_outcome: 'recovered_handoff_committed' })
    );
    expect(h.rpc).not.toHaveBeenCalledWith(
      'reserve_ai_reply_job_send',
      expect.anything()
    );
  });

  it('requeues a retryable failure only before a send permit exists', async () => {
    h.claimRows = [claimedJob()];
    h.completionResult = 'requeued_retry';
    h.dispatch.mockResolvedValue({
      status: 'failed',
      error: 'provider temporarily unavailable',
      retryable: true,
    });

    await expect(drainAiReplyJobs()).resolves.toEqual({
      claimed: 1,
      sent: 0,
      completed: 0,
      requeued: 1,
      failed: 1,
      ambiguous: 0,
    });

    expect(h.rpc).not.toHaveBeenCalledWith(
      'reserve_ai_reply_job_send',
      expect.anything()
    );
    expect(h.rpc).toHaveBeenCalledWith(
      'complete_ai_reply_job',
      expect.objectContaining({ p_retry_after_seconds: 15 })
    );
  });

  it('commits handoff atomically without reserving an external send', async () => {
    h.claimRows = [claimedJob()];
    h.dispatch.mockImplementation(async (args: MockDispatchArgs) => {
      const committed = (await args.commitHandoff?.('model')) ?? false;
      return committed
        ? { status: 'handoff' }
        : { status: 'skipped', reason: 'superseded' };
    });

    await expect(drainAiReplyJobs()).resolves.toEqual({
      claimed: 1,
      sent: 0,
      completed: 1,
      requeued: 0,
      failed: 0,
      ambiguous: 0,
    });

    expect(h.rpc).toHaveBeenCalledWith('commit_ai_reply_job_handoff', {
      p_job_id: 'job-1',
      p_lock_token: 'lock-1',
      p_generation: 7,
      p_account_id: 'acct-1',
      p_conversation_id: 'conv-1',
      p_reason: 'model',
    });
    expect(h.rpc).not.toHaveBeenCalledWith(
      'reserve_ai_reply_job_send',
      expect.anything()
    );
    expect(h.rpc).toHaveBeenCalledWith(
      'complete_ai_reply_job',
      expect.objectContaining({ p_outcome: 'handoff' })
    );
  });

  it('requeues when the atomic handoff loses to a newer generation', async () => {
    h.claimRows = [claimedJob()];
    h.handoffCommitResult = false;
    h.completionResult = 'requeued_newer_generation';
    h.dispatch.mockImplementation(async (args: MockDispatchArgs) => {
      const committed = (await args.commitHandoff?.('empty_response')) ?? false;
      return committed
        ? { status: 'handoff' }
        : { status: 'skipped', reason: 'superseded' };
    });

    await expect(drainAiReplyJobs()).resolves.toEqual({
      claimed: 1,
      sent: 0,
      completed: 0,
      requeued: 1,
      failed: 0,
      ambiguous: 0,
    });

    expect(h.rpc).not.toHaveBeenCalledWith(
      'reserve_ai_reply_job_send',
      expect.anything()
    );
    expect(h.rpc).toHaveBeenCalledWith(
      'commit_ai_reply_job_handoff',
      expect.objectContaining({ p_reason: 'empty_response' })
    );
    expect(h.rpc).toHaveBeenCalledWith(
      'complete_ai_reply_job',
      expect.objectContaining({ p_outcome: 'skipped_superseded' })
    );
  });
});
