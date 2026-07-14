import { expect, test } from '@playwright/test';

test('muestra el acceso existente de JoinsClee en español', async ({
  page,
}) => {
  await page.goto('/login');

  await expect(
    page.getByText('Bienvenido de nuevo', { exact: true })
  ).toBeVisible();
  await expect(page.getByLabel('Correo')).toBeVisible();
  await expect(page.getByLabel('Contraseña')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Iniciar sesión' })
  ).toBeVisible();
});

test('el laboratorio de IA responde con formatos OpenAI y Anthropic', async ({
  request,
}) => {
  const openAi = await request.post(
    '/api/dev-mocks/ai/openai/v1/chat/completions',
    {
      data: {
        messages: [
          { role: 'system', content: 'Agente de ventas' },
          { role: 'user', content: 'Quiero hablar con un asesor' },
        ],
      },
    }
  );
  expect(openAi.ok()).toBeTruthy();
  expect(await openAi.json()).toMatchObject({
    choices: [
      {
        message: {
          content: expect.stringContaining('[[HANDOFF]]'),
        },
      },
    ],
  });

  const anthropic = await request.post(
    '/api/dev-mocks/ai/anthropic/v1/messages',
    {
      data: {
        system: 'Agente de ventas',
        messages: [{ role: 'user', content: '¿Qué planes tienen?' }],
      },
    }
  );
  expect(anthropic.ok()).toBeTruthy();
  expect(await anthropic.json()).toMatchObject({
    content: [
      {
        type: 'text',
        text: 'Respuesta simulada para: ¿Qué planes tienen?',
      },
    ],
  });
});

test('el laboratorio de Meta cubre verificación y envío sin credenciales reales', async ({
  request,
}) => {
  const phone = await request.get('/api/dev-mocks/meta/v21.0/mock-phone', {
    params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
  });
  expect(phone.ok()).toBeTruthy();
  expect(await phone.json()).toMatchObject({
    id: 'mock-phone',
    verified_name: 'JoinsClee Internal Mock',
    quality_rating: 'GREEN',
  });

  const send = await request.post(
    '/api/dev-mocks/meta/v21.0/mock-phone/messages',
    {
      data: {
        messaging_product: 'whatsapp',
        to: '573000000000',
        type: 'text',
        text: { body: 'Hola' },
      },
    }
  );
  expect(send.ok()).toBeTruthy();
  expect(await send.json()).toMatchObject({
    messages: [{ id: 'wamid.internal-mock' }],
  });

  const unknown = await request.post(
    '/api/dev-mocks/meta/v21.0/not/supported',
    {
      data: {},
    }
  );
  expect(unknown.status()).toBe(404);
});
