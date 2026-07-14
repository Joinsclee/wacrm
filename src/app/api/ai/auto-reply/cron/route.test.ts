import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  drain: vi.fn(),
}));

vi.mock('@/lib/ai/auto-reply-queue', () => ({
  drainAiReplyJobs: h.drain,
}));

import { GET } from './route';

const URL = 'http://localhost/api/ai/auto-reply/cron';

beforeEach(() => {
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret');
  h.drain.mockReset();
  h.drain.mockResolvedValue({
    claimed: 1,
    sent: 1,
    completed: 1,
    requeued: 0,
    failed: 0,
    ambiguous: 0,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI auto-reply cron', () => {
  it('refuses to run when the shared cron secret is not configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    const response = await GET(new Request(URL));

    expect(response.status).toBe(503);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('rejects an invalid cron secret', async () => {
    const response = await GET(
      new Request(URL, { headers: { 'x-cron-secret': 'wrong' } })
    );

    expect(response.status).toBe(401);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('drains a bounded global batch for an authorized caller', async () => {
    const response = await GET(
      new Request(URL, { headers: { 'x-cron-secret': 'cron-secret' } })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ claimed: 1, sent: 1 })
    );
    expect(h.drain).toHaveBeenCalledWith({ limit: 5 });
  });
});
