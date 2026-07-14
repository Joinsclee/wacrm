import { NextResponse } from 'next/server';
import { internalMockNotFound } from '@/lib/dev-mocks/config';

type RouteContext = { params: Promise<{ path: string[] }> };

async function routePath(context: RouteContext): Promise<string[]> {
  const { path } = await context.params;
  return path[0]?.startsWith('v') ? path.slice(1) : path;
}

/**
 * A small, stateless subset of Meta's Graph responses. It is sufficient for
 * local/CI exercises of registration, text sends, templates and uploads.
 */
export async function GET(request: Request, context: RouteContext) {
  const denied = internalMockNotFound();
  if (denied) return denied;

  const path = await routePath(context);
  const resource = path.at(-1);

  if (resource === 'subscribed_apps') {
    return NextResponse.json({
      data: [
        {
          whatsapp_business_api_data: {
            id: 'internal-mock-app',
            name: 'JoinsClee Internal Mock',
          },
        },
      ],
    });
  }

  if (resource === 'message_templates') {
    return NextResponse.json({ data: [], paging: {} });
  }

  const fields = new URL(request.url).searchParams.get('fields') ?? '';
  if (path.length === 1 && fields.includes('display_phone_number')) {
    return NextResponse.json({
      id: resource ?? 'internal-mock-phone',
      display_phone_number: '+57 300 000 0000',
      verified_name: 'JoinsClee Internal Mock',
      quality_rating: 'GREEN',
    });
  }

  return new Response(null, { status: 404 });
}

export async function POST(request: Request, context: RouteContext) {
  const denied = internalMockNotFound();
  if (denied) return denied;

  const path = await routePath(context);
  const resource = path.at(-1);
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (resource === 'messages') {
    return NextResponse.json({
      messaging_product: 'whatsapp',
      contacts: [
        {
          input: body.to ?? 'internal-recipient',
          wa_id: body.to ?? 'internal-recipient',
        },
      ],
      messages: [{ id: 'wamid.internal-mock' }],
    });
  }

  if (resource === 'uploads') {
    return NextResponse.json({ id: 'upload:internal-mock-session' });
  }

  if (resource?.startsWith('upload:')) {
    return NextResponse.json({ h: 'internal-mock-media-handle' });
  }

  if (resource === 'message_templates') {
    return NextResponse.json({
      id: 'internal-mock-template',
      status: 'PENDING',
      category: body.category ?? 'UTILITY',
    });
  }

  if (resource === 'register' || resource === 'subscribed_apps') {
    return NextResponse.json({ success: true });
  }

  // Editing an existing template posts its replacement components to /{id}.
  if (
    path.length === 1 &&
    (Array.isArray(body.components) || typeof body.category === 'string')
  ) {
    return NextResponse.json({ success: true });
  }

  return new Response(null, { status: 404 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const denied = internalMockNotFound();
  if (denied) return denied;
  const path = await routePath(context);
  return path.length === 1
    ? NextResponse.json({ success: true })
    : new Response(null, { status: 404 });
}
