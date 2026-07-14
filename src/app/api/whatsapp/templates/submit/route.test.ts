import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes: Array<{
  method: 'insert' | 'update';
  row: Record<string, unknown>;
}> = [];

let existingTemplate: Record<string, unknown> | null = null;
let profileRole = 'admin';
const submitMessageTemplateMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: submitMessageTemplateMock,
}));

function makeSupabaseMock() {
  function builder(table: string) {
    let upsertedRow: Record<string, unknown> | null = null;

    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const method of ['select', 'eq']) b[method] = vi.fn(chain);

    b.insert = vi.fn((row: Record<string, unknown>) => {
      upsertedRow = row;
      writes.push({ method: 'insert', row });
      return b;
    });
    b.update = vi.fn((row: Record<string, unknown>) => {
      upsertedRow = row;
      writes.push({ method: 'update', row });
      return b;
    });
    b.is = vi.fn(chain);

    b.maybeSingle = vi.fn(async () => {
      if (table === 'profiles') {
        return {
          data: { account_id: 'account-1', account_role: profileRole },
          error: null,
        };
      }
      if (table === 'message_templates') {
        return { data: existingTemplate, error: null };
      }
      return { data: null, error: null };
    });

    b.single = vi.fn(async () => ({
      data: upsertedRow ? { id: 'template-1', ...upsertedRow } : null,
      error: null,
    }));

    return b;
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  };
}

let supabaseMock = makeSupabaseMock();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}));

import { POST } from './route';

describe('POST /api/whatsapp/templates/submit — account-scoped identity', () => {
  beforeEach(() => {
    writes.length = 0;
    existingTemplate = null;
    profileRole = 'admin';
    supabaseMock = makeSupabaseMock();
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('inserts a new template with account identity and author audit', async () => {
    const response = await POST(
      new Request('http://localhost/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'order_update',
          category: 'Marketing',
          language: 'en_US',
          body_text: 'Your order is ready.',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe('insert');
    expect(writes[0]?.row).toMatchObject({
      account_id: 'account-1',
      user_id: 'user-1',
      name: 'order_update',
      language: 'en_US',
    });
  });

  it('refuses to overwrite an existing Meta-linked template', async () => {
    existingTemplate = {
      id: 'approved-template',
      user_id: 'original-author',
      status: 'APPROVED',
      meta_template_id: 'meta-123',
    };

    const response = await POST(
      new Request('http://localhost/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'order_update',
          category: 'Marketing',
          language: 'en_US',
          body_text: 'A replacement body.',
        }),
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      existing_template_id: 'approved-template',
    });
    expect(writes).toHaveLength(0);
  });

  it('retries only an unlinked DRAFT and preserves its original author', async () => {
    existingTemplate = {
      id: 'draft-template',
      user_id: 'original-author',
      status: 'DRAFT',
      meta_template_id: null,
    };

    const response = await POST(
      new Request('http://localhost/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'order_update',
          category: 'Marketing',
          language: 'en_US',
          body_text: 'Updated draft body.',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe('update');
    expect(writes[0]?.row).toMatchObject({
      account_id: 'account-1',
      user_id: 'original-author',
      status: 'PENDING',
    });
  });

  it('rejects a viewer before any irreversible Meta mutation', async () => {
    profileRole = 'viewer';
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'false');

    const response = await POST(
      new Request('http://localhost/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'viewer_attempt',
          category: 'Marketing',
          language: 'en_US',
          body_text: 'This must never reach Meta.',
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(submitMessageTemplateMock).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});
