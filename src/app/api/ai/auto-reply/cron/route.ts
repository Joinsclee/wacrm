import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { drainAiReplyJobs } from '@/lib/ai/auto-reply-queue';

export const maxDuration = 60;

/**
 * Recover and drain durable AI auto-reply work across all accounts.
 *
 * Hosting should call this endpoint on a short schedule with the same
 * `x-cron-secret` / `AUTOMATION_CRON_SECRET` contract already used by the
 * automation and Flow sweepers. Atomic database claims make overlapping
 * invocations safe across instances.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await drainAiReplyJobs({ limit: 5 });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ai-reply-cron] drain failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
