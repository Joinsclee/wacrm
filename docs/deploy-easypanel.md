# Desplegar wacrm en EasyPanel (Docker)

Esta guía despliega wacrm como un contenedor Docker usando el `Dockerfile`
de la raíz del repo (Next.js 16 con `output: "standalone"`). Supabase sigue
siendo un servicio externo; aquí solo desplegamos la app Next.js.

## Requisitos previos

- Un proyecto de Supabase con las migraciones de `supabase/` ya aplicadas.
- Los valores de entorno a mano (ver la tabla de variables abajo).
- El repo accesible desde EasyPanel (GitHub) **o** una imagen ya construida.

## 1. Crear el servicio

1. En tu proyecto de EasyPanel: **+ Service → App**.
2. En **Source**, elige **GitHub** y apunta al repo/rama, o **Docker Image**
   si vas a construir la imagen aparte.
3. En **Build**, selecciona **Dockerfile** (no Nixpacks). EasyPanel detecta
   el `Dockerfile` de la raíz automáticamente.

## 2. Variables de entorno

En la pestaña **Environment** del servicio, define las variables. EasyPanel
las inyecta **tanto en build como en runtime** (las pasa como build args al
`docker build`), que es exactamente lo que necesitamos: las `NEXT_PUBLIC_*`
se **incrustan en el bundle del navegador durante el build**, así que tienen
que estar presentes al construir, no solo al arrancar.

### Requeridas (la app no arranca sin ellas)

| Variable | Cuándo se usa | Notas |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **build** (se incrusta en el cliente) | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **build** (se incrusta en el cliente) | Anon key de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | runtime | Secreta. Salta RLS; solo server-side |
| `ENCRYPTION_KEY` | runtime | 64 hex (32 bytes). `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `META_APP_SECRET` | runtime | Verifica la firma HMAC del webhook de Meta |

### Recomendadas

| Variable | Cuándo se usa | Notas |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | **build** | URL pública canónica, sin `/` final. Ej.: `https://crm.tudominio.com` |

> **Importante — las `NEXT_PUBLIC_*` son de tiempo de build.** Si cambias
> `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` o
> `NEXT_PUBLIC_SITE_URL`, debes **reconstruir** (redeploy con rebuild), no
> basta reiniciar. Su valor queda congelado en el JavaScript del navegador.

### Opcionales (solo si usas la función)

| Variable | Para qué |
|---|---|
| `AUTOMATION_CRON_SECRET` | Protege `GET /api/automations/cron` (pasos *Wait* en automatizaciones) |
| `META_APP_ID` | Plantillas con header de imagen (Meta) |
| `ALLOWED_INVITE_HOSTS` | Allow-list de hosts para links de invitación |
| `WHATSAPP_TEMPLATES_DRY_RUN` | Dev/CI: no llama a Meta al crear plantillas |
| `AI_REQUEST_TIMEOUT_MS`, `AI_CONTEXT_MESSAGE_LIMIT` | Ajustan el asistente de IA |

> El asistente de IA es *bring-your-own-key*: cada cuenta pega su propia
> clave de OpenAI/Anthropic en **Settings → AI Assistant** (se guarda cifrada
> con `ENCRYPTION_KEY`). No hay variable global de proveedor.

## 3. Puerto y dominio

- El contenedor escucha en `$PORT` (por defecto **3000**; `HOSTNAME=0.0.0.0`
  viene fijado en el `Dockerfile` para que el proxy pueda alcanzarlo). Si
  defines `PORT` en la pestaña *Environment*, el servidor standalone respeta
  ese valor — mira el log de arranque: `- Local: http://localhost:<PORT>`.
- **El `Port` que apuntas en la pestaña Domains DEBE coincidir con ese
  `<PORT>`.** Si no coinciden, EasyPanel muestra "deploy correcto" pero el
  dominio nunca responde (o el contenedor se reinicia en bucle). Lo más simple:
  no definas `PORT` (se queda en 3000) y apunta el dominio a `3000`.
- EasyPanel gestiona el TLS (Let's Encrypt) y actúa como reverse proxy — que es
  justo lo que Next.js recomienda para self-hosting.

> **Sin `HEALTHCHECK` en el `Dockerfile` a propósito.** EasyPanel ya vigila la
> salud vía su proxy HTTP. Un healthcheck de contenedor clavado a un puerto
> fijo provoca un bucle de reinicios (Docker Swarm mata y reprograma la tarea)
> si EasyPanel corre la app en otro `PORT` distinto al hardcodeado.

## 4. Cron de automatizaciones (opcional)

Si usas pasos *Wait* en automatizaciones o flujos, necesitas un pinger que
drene las ejecuciones pendientes. Define `AUTOMATION_CRON_SECRET` y crea un
cron (en EasyPanel: **Scheduled Task**, o cualquier cron externo) que llame:

```
GET https://crm.tudominio.com/api/automations/cron
Authorization: Bearer <AUTOMATION_CRON_SECRET>
```

Ver `docs/automations-and-cron.md` para el detalle.

## 5. Deploy

Pulsa **Deploy**. EasyPanel construye la imagen con el `Dockerfile`
multi-stage y arranca el contenedor. El `HEALTHCHECK` del `Dockerfile`
consulta `/login`; cuando pasa a *healthy*, el dominio ya sirve tráfico.

## Notas de operación

- **Instancia única.** wacrm usa el caché en disco por defecto de Next.js.
  Escálalo horizontalmente solo si añades un cache handler compartido y
  fijas `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (ver
  `node_modules/next/dist/docs/01-app/02-guides/self-hosting.md`).
- **Secretos.** El `.dockerignore` excluye `.env*` del contexto de build, así
  que tu `.env` local **nunca** viaja dentro de la imagen. Todos los secretos
  entran por la pestaña Environment de EasyPanel.
- **Webhook de WhatsApp.** Apunta el webhook de Meta a
  `https://crm.tudominio.com/api/whatsapp/webhook` una vez que el dominio esté
  activo.
