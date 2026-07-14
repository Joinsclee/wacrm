import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isMetaCredentialError,
  MetaApiError,
  verifyPhoneNumber,
} from './meta-api';

describe('MetaApiError', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the HTTP status, Graph code and original message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Invalid OAuth access token.',
              type: 'OAuthException',
              code: 190,
              error_subcode: 463,
            },
          }),
          { status: 400 }
        )
      )
    );

    const failure = await verifyPhoneNumber({
      phoneNumberId: 'phone-id',
      accessToken: 'expired-token',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetaApiError);
    expect(failure).toMatchObject({
      message: 'Invalid OAuth access token.',
      status: 400,
      code: 190,
      type: 'OAuthException',
      subcode: 463,
    });
    expect(isMetaCredentialError(failure)).toBe(true);
  });

  it('classifies HTTP 401 as a credential failure even without a Graph code', () => {
    expect(
      isMetaCredentialError(new MetaApiError('Unauthorized', { status: 401 }))
    ).toBe(true);
  });

  it('does not request reconnection for transient Meta or network failures', () => {
    expect(
      isMetaCredentialError(
        new MetaApiError('Meta unavailable', { status: 503, code: 2 })
      )
    ).toBe(false);
    expect(isMetaCredentialError(new TypeError('fetch failed'))).toBe(false);
  });
});
