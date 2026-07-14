const INTERNAL_MOCK_FLAG = 'INTERNAL_MOCKS_ENABLED';

export type InternalMockEnvironment = Record<string, string | undefined>;

/**
 * Internal provider mocks are deliberately impossible to enable in production.
 * The explicit flag prevents a developer build from exposing them by accident.
 */
export function internalMocksEnabled(
  env: InternalMockEnvironment = process.env
): boolean {
  const safeRuntime = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  return safeRuntime && env[INTERNAL_MOCK_FLAG] === 'true';
}

/**
 * Resolve a provider URL override only while the internal mock harness is on.
 * Invalid URLs and every production build fall back to the real provider.
 */
export function resolveInternalMockUrl(
  defaultUrl: string,
  envName:
    | 'INTERNAL_META_API_BASE_URL'
    | 'INTERNAL_OPENAI_BASE_URL'
    | 'INTERNAL_ANTHROPIC_BASE_URL',
  env: InternalMockEnvironment = process.env
): string {
  if (!internalMocksEnabled(env)) return defaultUrl;

  const candidate = env[envName]?.trim();
  if (!candidate) return defaultUrl;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return defaultUrl;
    }
    return candidate.replace(/\/+$/, '');
  } catch {
    return defaultUrl;
  }
}

export function internalMockNotFound(): Response | null {
  if (internalMocksEnabled()) return null;
  return new Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}
