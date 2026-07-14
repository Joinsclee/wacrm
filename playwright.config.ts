import { defineConfig, devices } from '@playwright/test';

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL:
        process.env.NEXT_PUBLIC_SUPABASE_URL ??
        'https://ci.example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'ci-dummy-anon-key',
      ENCRYPTION_KEY:
        process.env.ENCRYPTION_KEY ??
        '0000000000000000000000000000000000000000000000000000000000000000',
      META_APP_SECRET: process.env.META_APP_SECRET ?? 'ci-dummy-meta-secret',
      INTERNAL_MOCKS_ENABLED: 'true',
      INTERNAL_META_API_BASE_URL: `${baseURL}/api/dev-mocks/meta/v21.0`,
      INTERNAL_OPENAI_BASE_URL: `${baseURL}/api/dev-mocks/ai/openai`,
      INTERNAL_ANTHROPIC_BASE_URL: `${baseURL}/api/dev-mocks/ai/anthropic`,
    },
  },
});
