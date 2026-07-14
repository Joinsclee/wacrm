# JoinsClee WaCrm — CRM para WhatsApp

> CRM autohospedable para WhatsApp® con bandeja compartida, contactos,
> embudos de ventas, difusiones, automatizaciones y agentes IA.

Esta es la adaptación de JoinsClee basada en el template MIT
[wacrm](https://github.com/ArnasDon/wacrm). Conservamos su atribución e
historia upstream mientras evolucionamos el producto con la identidad y las
decisiones propias de JoinsClee.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/Joinsclee/wacrm/actions/workflows/ci.yml/badge.svg)](https://github.com/Joinsclee/wacrm/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![Stars](https://img.shields.io/github/stars/ArnasDon/wacrm?style=social)](https://github.com/ArnasDon/wacrm/stargazers)

The upstream marketing site and self-host docs live in a separate repo:
[ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)
([wacrm.tech](https://wacrm.tech)). They remain useful as upstream reference;
the decisions specific to this JoinsClee adaptation are recorded in
[docs/architecture-decisions.md](./docs/architecture-decisions.md).

## What you get out of the box

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **AI reply assistant** — bring your own OpenAI or Anthropic key
  (stored encrypted; no per-seat AI fee, your data stays yours).
  One-click AI-drafted replies in the inbox, plus an optional
  auto-reply bot with a per-conversation cap and clean human handoff.
  Add a **knowledge base** (FAQs, policies, product docs) and it
  answers from your own content — hybrid retrieval (Postgres full-text,
  or semantic pgvector when an embeddings key is set).
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer. Every install
  is account-scoped, so one shared inbox can be staffed by a whole
  team. Solo use stays single-user with zero setup.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys —
  build your own automations on top of your CRM. See
  [docs/public-api.md](./docs/public-api.md).

## Why fork this?

This is a **template**, not a product. Forking means you get:

- **Full ownership** — your code, your Supabase project, your domain,
  your data. No SaaS lock-in, no seat pricing, no trust dance.
- **Full customisation** — add the fields your team needs, remove the
  modules you don't, redesign anything. The stack is boring on
  purpose (Next.js + Supabase + Tailwind) so the learning curve is
  short.
- **Despliegue reproducible** — el `Dockerfile` multi-stage y la salida
  standalone de Next.js están preparados para EasyPanel, sin depender de una
  plataforma propietaria ni introducir Kubernetes.
  ([Ver despliegue ↓](#despliegue-en-easypanel))
- **Real security primitives** — token encryption (AES-256-GCM), RLS
  on every table, HMAC-verified webhooks, CSP, rate limiting, CI
  typecheck/build on every PR.

Not a framework. Not an SDK. A concrete, working CRM you can stand up
in an afternoon and make yours.

## Quick start

```bash
git clone https://github.com/Joinsclee/wacrm.git
cd wacrm
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

## Despliegue en EasyPanel

La ruta operativa de JoinsClee usa el `Dockerfile` del repositorio sobre
EasyPanel. El contenedor ejecuta la salida `standalone` de Next.js 16 y recibe
Supabase, Meta, cifrado y cron mediante variables de entorno.

1. Crea un servicio desde este repositorio y selecciona **Dockerfile**.
2. Configura las variables de `.env.local.example` en EasyPanel.
3. Apunta el dominio al mismo `PORT` del contenedor — `3000` por defecto.
4. Si usas esperas, timeouts de Flows o auto-reply IA, configura las tareas
   programadas protegidas por `AUTOMATION_CRON_SECRET`.

La guía completa, incluidos build-time vars, proxy, puerto y cron, está en
[docs/deploy-easypanel.md](./docs/deploy-easypanel.md).

La aplicación sigue siendo MIT y puede ejecutarse en otras plataformas Node o
Docker. Las guías de Hostinger del proyecto upstream se conservan únicamente
como referencia externa, no como el contrato de despliegue de JoinsClee.

## Documentation

Las decisiones propias y el despliegue de esta adaptación viven dentro del
repositorio. La documentación de `wacrm.tech` continúa como referencia del
template upstream, no como fuente de verdad para JoinsClee.

Key pages:

- [Decisiones de arquitectura](./docs/architecture-decisions.md)
- [Despliegue en EasyPanel](./docs/deploy-easypanel.md)
- [API pública](./docs/public-api.md)
- [Getting started](https://wacrm.tech/docs/getting-started)
- [Supabase setup](https://wacrm.tech/docs/supabase-setup)
- [WhatsApp setup](https://wacrm.tech/docs/whatsapp-setup)
- [Environment variables](https://wacrm.tech/docs/environment-variables)
- [Troubleshooting](https://wacrm.tech/docs/troubleshooting)

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Contributing

This is a template, not a collaborative product — the expected flow is
fork → customise → deploy, **not** upstream contribution. Bug reports
and security issues are welcome; feature PRs often belong in your fork
rather than here. Details in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`.github/SECURITY.md`](./.github/SECURITY.md).

## License

[MIT](./LICENSE). Fork it, brand it, host it.
