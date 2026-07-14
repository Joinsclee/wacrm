import { describe, expect, it } from 'vitest';
import { internalMocksEnabled, resolveInternalMockUrl } from './config';

describe('internal provider mock guard', () => {
  it('requires both a non-production runtime and the explicit flag', () => {
    expect(
      internalMocksEnabled({
        NODE_ENV: 'development',
        INTERNAL_MOCKS_ENABLED: 'true',
      })
    ).toBe(true);
    expect(
      internalMocksEnabled({
        NODE_ENV: 'development',
        INTERNAL_MOCKS_ENABLED: 'false',
      })
    ).toBe(false);
    expect(
      internalMocksEnabled({
        NODE_ENV: 'production',
        INTERNAL_MOCKS_ENABLED: 'true',
      })
    ).toBe(false);
    expect(internalMocksEnabled({ INTERNAL_MOCKS_ENABLED: 'true' })).toBe(
      false
    );
  });

  it('honours a valid override only while mocks are enabled', () => {
    const realUrl = 'https://api.openai.com';
    const mockUrl = 'http://127.0.0.1:3100/api/dev-mocks/ai/openai/';

    expect(
      resolveInternalMockUrl(realUrl, 'INTERNAL_OPENAI_BASE_URL', {
        NODE_ENV: 'test',
        INTERNAL_MOCKS_ENABLED: 'true',
        INTERNAL_OPENAI_BASE_URL: mockUrl,
      })
    ).toBe(mockUrl.slice(0, -1));

    expect(
      resolveInternalMockUrl(realUrl, 'INTERNAL_OPENAI_BASE_URL', {
        NODE_ENV: 'production',
        INTERNAL_MOCKS_ENABLED: 'true',
        INTERNAL_OPENAI_BASE_URL: mockUrl,
      })
    ).toBe(realUrl);
  });

  it('rejects malformed and non-http overrides', () => {
    const env = {
      NODE_ENV: 'test',
      INTERNAL_MOCKS_ENABLED: 'true',
      INTERNAL_META_API_BASE_URL: 'file:///tmp/fake-meta',
    };

    expect(
      resolveInternalMockUrl(
        'https://graph.facebook.com/v21.0',
        'INTERNAL_META_API_BASE_URL',
        env
      )
    ).toBe('https://graph.facebook.com/v21.0');
  });
});
