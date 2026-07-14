import { dispatchInboundToAiReply, type AiHandoffReason } from './auto-reply';
import { supabaseAdmin } from './admin-client';

const TAG = '[ai reply queue]';

/** The database owns coalescing; this is only the due_at offset. */
export const AI_REPLY_COALESCE_SECONDS = 6;
export const AI_REPLY_STALE_LOCK_SECONDS = 120;
const AI_REPLY_MAX_SAFE_ATTEMPTS = 3;

export interface EnqueueInboundAiReplyArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  inboundMessageId: string;
}

export interface EnqueuedAiReplyJob {
  jobId: string;
  generation: number;
  dueAt: string;
  enqueued: boolean;
}

export interface InvalidateAiReplyJobArgs {
  accountId: string;
  conversationId: string;
  inboundMessageId: string;
}

interface ClaimedAiReplyJob {
  jobId: string;
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  inboundMessageId: string;
  claimedGeneration: number;
  lockToken: string;
  attemptCount: number;
  sendReservedGeneration: number | null;
  handoffCommittedGeneration: number | null;
}

interface EnqueueRpcRow {
  job_id: string;
  job_generation: number | string;
  job_due_at: string;
  was_enqueued: boolean;
}

interface ClaimRpcRow {
  job_id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  config_owner_user_id: string;
  inbound_message_id: string;
  claimed_generation: number | string;
  lock_token: string;
  attempt_count: number;
  send_reserved_generation: number | string | null;
  handoff_committed_generation: number | string | null;
}

export interface AiReplyDrainResult {
  claimed: number;
  sent: number;
  completed: number;
  requeued: number;
  failed: number;
  ambiguous: number;
}

function firstRow<T>(data: T[] | T | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

function asGeneration(value: number | string): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`invalid AI reply job generation: ${String(value)}`);
  }
  return generation;
}

/**
 * Persist one eligible inbound. The RPC performs account ownership checks,
 * durable Meta retry dedupe and generation bump in one database transaction.
 */
export async function enqueueInboundAiReply(
  args: EnqueueInboundAiReplyArgs
): Promise<EnqueuedAiReplyJob | null> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc('enqueue_ai_reply_job', {
    p_account_id: args.accountId,
    p_conversation_id: args.conversationId,
    p_contact_id: args.contactId,
    p_config_owner_user_id: args.configOwnerUserId,
    p_inbound_message_id: args.inboundMessageId,
    p_delay_seconds: AI_REPLY_COALESCE_SECONDS,
  });

  if (error) {
    throw new Error(`enqueue failed: ${error.message}`);
  }

  const row = firstRow(data as EnqueueRpcRow[] | EnqueueRpcRow | null);
  if (!row) return null;
  return {
    jobId: row.job_id,
    generation: asGeneration(row.job_generation),
    dueAt: row.job_due_at,
    enqueued: row.was_enqueued,
  };
}

/**
 * Fence queued AI work when deterministic handling owns this inbound. The
 * RPC also records the wamid so a Meta retry cannot become AI-eligible later.
 */
export async function invalidateAiReplyJob(
  args: InvalidateAiReplyJobArgs
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('invalidate_ai_reply_job', {
    p_account_id: args.accountId,
    p_conversation_id: args.conversationId,
    p_inbound_message_id: args.inboundMessageId,
  });
  if (error) throw new Error(`invalidation failed: ${error.message}`);
  return data === true;
}

function parseClaim(row: ClaimRpcRow): ClaimedAiReplyJob {
  return {
    jobId: row.job_id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    configOwnerUserId: row.config_owner_user_id,
    inboundMessageId: row.inbound_message_id,
    claimedGeneration: asGeneration(row.claimed_generation),
    lockToken: row.lock_token,
    attemptCount: Number(row.attempt_count),
    sendReservedGeneration:
      row.send_reserved_generation === null
        ? null
        : asGeneration(row.send_reserved_generation),
    handoffCommittedGeneration:
      row.handoff_committed_generation === null
        ? null
        : asGeneration(row.handoff_committed_generation),
  };
}

async function claimDueJobs(args: {
  accountId?: string;
  limit: number;
}): Promise<ClaimedAiReplyJob[]> {
  const { data, error } = await supabaseAdmin().rpc('claim_ai_reply_jobs', {
    p_account_id: args.accountId ?? null,
    p_limit: args.limit,
    p_stale_after_seconds: AI_REPLY_STALE_LOCK_SECONDS,
  });
  if (error) throw new Error(`claim failed: ${error.message}`);
  return ((data ?? []) as ClaimRpcRow[]).map(parseClaim);
}

async function reserveSend(job: ClaimedAiReplyJob): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc(
    'reserve_ai_reply_job_send',
    {
      p_job_id: job.jobId,
      p_lock_token: job.lockToken,
      p_generation: job.claimedGeneration,
      p_account_id: job.accountId,
      p_conversation_id: job.conversationId,
    }
  );
  if (error) throw new Error(`send reservation failed: ${error.message}`);
  return data === true;
}

async function commitHandoff(
  job: ClaimedAiReplyJob,
  reason: AiHandoffReason
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc(
    'commit_ai_reply_job_handoff',
    {
      p_job_id: job.jobId,
      p_lock_token: job.lockToken,
      p_generation: job.claimedGeneration,
      p_account_id: job.accountId,
      p_conversation_id: job.conversationId,
      p_reason: reason,
    }
  );
  if (error) throw new Error(`handoff commit failed: ${error.message}`);
  return data === true;
}

async function completeJob(
  job: ClaimedAiReplyJob,
  args: {
    outcome: string;
    error?: string | null;
    retryAfterSeconds?: number | null;
  }
): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc('complete_ai_reply_job', {
    p_job_id: job.jobId,
    p_lock_token: job.lockToken,
    p_generation: job.claimedGeneration,
    p_outcome: args.outcome,
    p_error: args.error?.slice(0, 2000) ?? null,
    p_retry_after_seconds: args.retryAfterSeconds ?? null,
  });
  if (error) throw new Error(`completion failed: ${error.message}`);
  return typeof data === 'string' ? data : String(data);
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempt - 1), 300);
}

function emptyDrainResult(claimed = 0): AiReplyDrainResult {
  return {
    claimed,
    sent: 0,
    completed: 0,
    requeued: 0,
    failed: 0,
    ambiguous: 0,
  };
}

async function runClaimedJob(
  job: ClaimedAiReplyJob
): Promise<AiReplyDrainResult> {
  const result = emptyDrainResult(1);

  // The handoff mutation and this marker are committed atomically. If the
  // worker died before clearing its lease, do not replay the model: a human
  // may already have deliberately re-enabled AI for the conversation.
  if (job.handoffCommittedGeneration === job.claimedGeneration) {
    await completeJob(job, { outcome: 'recovered_handoff_committed' });
    result.completed = 1;
    return result;
  }

  // A stale worker may have died after receiving its one-time external-send
  // permit. We cannot know whether Meta accepted the text, so finalize this
  // generation without dispatching it again. This is the at-most-once edge.
  if (job.sendReservedGeneration === job.claimedGeneration) {
    await completeJob(job, {
      outcome: 'ambiguous_send_reserved',
      error:
        'Recovered a stale job after its send permit was reserved; generation was not repeated.',
    });
    result.completed = 1;
    result.ambiguous = 1;
    return result;
  }

  const dispatch = await dispatchInboundToAiReply({
    accountId: job.accountId,
    conversationId: job.conversationId,
    contactId: job.contactId,
    configOwnerUserId: job.configOwnerUserId,
    inboundMessageId: job.inboundMessageId,
    beforeSend: () => reserveSend(job),
    commitHandoff: (reason) => commitHandoff(job, reason),
  });

  const outcome =
    dispatch.status === 'skipped'
      ? `skipped_${dispatch.reason}`
      : dispatch.status;
  const error = dispatch.status === 'failed' ? dispatch.error : null;
  const canRetry =
    dispatch.status === 'failed' &&
    dispatch.retryable &&
    job.attemptCount < AI_REPLY_MAX_SAFE_ATTEMPTS;

  const completion = await completeJob(job, {
    outcome,
    error,
    retryAfterSeconds: canRetry ? retryDelaySeconds(job.attemptCount) : null,
  });

  if (completion.startsWith('requeued')) result.requeued = 1;
  else result.completed = 1;
  if (dispatch.status === 'sent') result.sent = 1;
  if (dispatch.status === 'failed') result.failed = 1;
  return result;
}

function addDrainResult(
  target: AiReplyDrainResult,
  source: AiReplyDrainResult
): void {
  target.claimed += source.claimed;
  target.sent += source.sent;
  target.completed += source.completed;
  target.requeued += source.requeued;
  target.failed += source.failed;
  target.ambiguous += source.ambiguous;
}

/**
 * Atomically claim and execute due jobs. The webhook passes accountId and a
 * limit of one; the protected cron may drain a small global batch. Claims,
 * not this process, provide concurrency control across app instances.
 */
export async function drainAiReplyJobs(
  args: {
    accountId?: string;
    limit?: number;
  } = {}
): Promise<AiReplyDrainResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 5, 20));
  const jobs = await claimDueJobs({ accountId: args.accountId, limit });
  const total = emptyDrainResult();

  // Provider calls are independent after the atomic DB claims. Run the small
  // claimed batch concurrently so a cron invocation stays within maxDuration.
  const settled = await Promise.allSettled(jobs.map(runClaimedJob));
  for (let i = 0; i < settled.length; i++) {
    const item = settled[i];
    if (item.status === 'fulfilled') {
      addDrainResult(total, item.value);
      continue;
    }
    total.claimed += 1;
    total.failed += 1;
    console.error(
      `${TAG} ${jobs[i]?.jobId.slice(0, 8) ?? 'unknown'} worker failed:`,
      item.reason
    );
    // No completion here: the durable lock expires and cron safely reclaims
    // it. If a send permit was already reserved, the reclaim path above will
    // finalize without repeating the external send.
  }
  return total;
}

/** Best-effort accelerator for after(); due_at remains authoritative. */
export async function waitUntilAiReplyDue(dueAt: string): Promise<void> {
  const dueTime = new Date(dueAt).getTime();
  if (!Number.isFinite(dueTime)) {
    throw new Error(`invalid AI reply due_at: ${dueAt}`);
  }
  // Never pin a route invocation for a retry/backoff due far in the future.
  // The normal coalescing due_at is six seconds; cron owns longer recovery.
  const delayMs = Math.min(
    Math.max(0, dueTime - Date.now()),
    (AI_REPLY_COALESCE_SECONDS + 1) * 1000
  );
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
