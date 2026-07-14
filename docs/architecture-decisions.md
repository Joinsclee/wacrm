# Decisiones e invariantes de arquitectura

Este documento registra el contrato técnico y de producto que ya existe en
JoinsClee WaCrm. No describe una reescritura futura: sirve como línea base para
evaluar propuestas, colaborar sobre el trabajo existente y evitar regresiones
al incorporar mejoras de otros proyectos.

## 1. Identidad del producto e idioma

- La identidad visible del producto es **JoinsClee WaCrm**.
- La experiencia de usuario y la documentación nueva se escriben
  principalmente en español.
- Se conserva la atribución y la licencia MIT del template upstream `wacrm`.
  Esa procedencia no autoriza a revertir el branding, los textos o las
  decisiones de producto ya adaptadas por JoinsClee.

## 2. Next.js 16 se consulta desde la instalación local

El proyecto usa Next.js 16, cuyas APIs y convenciones pueden diferir de
versiones anteriores. Antes de escribir o cambiar código de Next.js se debe:

1. leer `AGENTS.md`;
2. localizar la guía aplicable en `node_modules/next/dist/docs/`;
3. respetar las deprecaciones y convenciones documentadas en esa versión
   instalada, sin asumir comportamientos por memoria o por documentación de
   otra versión.

## 3. Supabase, tenancy y RLS

- Supabase proporciona Postgres, Auth, Storage, Realtime y Row Level Security.
- `account_id` es la frontera de tenancy. Los datos operativos pertenecen a una
  cuenta, no a una persona individual.
- `user_id` se conserva donde existe como autor, propietario histórico,
  asignado o dato de auditoría; no reemplaza a `account_id` como aislamiento.
- Los clientes con sesión deben operar bajo RLS.
- Todo camino que use `SUPABASE_SERVICE_ROLE_KEY` omite RLS y, por tanto, debe
  acotar explícitamente lecturas y escrituras por `account_id`, además de
  validar la pertenencia de identificadores recibidos.
- Las políticas de tablas hijas deben derivar la cuenta desde su entidad padre
  cuando la tabla no tenga `account_id` propio.

## 4. Roles y capacidades

La jerarquía vigente es:

1. `viewer`: lectura;
2. `agent`: operación diaria, como mensajes, contactos, deals, difusiones,
   automatizaciones y flujos;
3. `admin`: configuración compartida y gestión de miembros;
4. `owner`: acciones exclusivas e irreversibles, incluida la transferencia de
   propiedad.

Las comprobaciones de UI, API y RLS deben expresar la misma política. La UI no
es una frontera de seguridad: deshabilitar un control no sustituye la
autorización del servidor ni la política de base de datos.

## 5. Precedencia de respuesta a mensajes entrantes

El procesamiento conserva este orden conceptual:

1. **Flows** intenta continuar o iniciar un recorrido determinista.
2. **Automatizaciones** ejecuta los triggers compatibles. Si un Flow consumió
   el mensaje, se suprimen los triggers de contenido que provocarían una
   respuesta duplicada; los triggers de relación, como primer mensaje o nuevo
   contacto, pueden seguir ejecutándose.
3. **IA** solo intenta responder cuando ningún Flow consumió el mensaje y no
   hay una automatización activa que ya esté encargándose de responder.
4. **Handoff humano** prevalece cuando existe asignación humana, el hilo está
   en modo humano o el modelo solicita transferencia.

Una integración nueva no debe crear un segundo orquestador ni alterar este
orden sin una decisión explícita y pruebas contra respuestas duplicadas.

## 6. Agente IA: setter, closer y control humano

- Existe una configuración de IA compartida por cuenta, con clave propia del
  cliente y soporte para OpenAI o Anthropic.
- Cada conversación comienza en etapa `setter` y puede avanzar a `closer`
  cuando el modelo indica que el lead está calificado.
- El estado de etapa pertenece a la conversación; no debe inferirse solamente
  desde el último mensaje.
- El toggle IA/humano por conversación es persistente.
- La asignación a un agente, una desactivación manual o un handoff del modelo
  detienen el auto-reply. Un agente humano que responde también pausa cualquier
  Flow activo del contacto.
- El límite de respuestas automáticas por conversación se reclama de forma
  atómica y debe seguir evitando carreras y ciclos de gasto.
- Los mensajes entrantes elegibles se agrupan en una cola durable por
  conversación. `due_at`, la generación y el bloqueo viven en Postgres; ningún
  temporizador en memoria es la fuente de verdad.
- La identidad `(conversation_id, message_id)` es única para que un retry del
  mismo webhook de Meta se detenga antes de repetir efectos de Flow,
  automatizaciones o IA.
- Existe una sola conversación por `(account_id, contact_id)`. La restricción
  y la recuperación del conflicto de inserción impiden que dos primeras
  entregas concurrentes abran hilos paralelos y eludan la idempotencia.
- El `INSERT` de un mensaje de cliente cerca atómicamente cualquier generación
  IA anterior mediante un trigger de Postgres. La clasificación posterior
  decide si el nuevo mensaje se encola o se invalida según Flows y
  automatizaciones.
- El webhook realiza un drenaje de baja latencia y el cron protegido recupera
  trabajos pendientes o bloqueos vencidos después de reinicios.
- Antes de llamar a Meta, un worker reserva una sola generación. Si el proceso
  cae después de esa reserva, la recuperación marca el resultado como ambiguo
  y no repite el envío: se prioriza evitar mensajes duplicados, aceptando que
  ese borde excepcional puede dejar una respuesta sin enviar.

### Límite conocido de la fase 1: recepción previa a la cola

Después de validar la firma, la ruta confirma el webhook a Meta y procesa el
contenido dentro de `after()`. Next.js mantiene ese trabajo durante el apagado
graceful, pero todavía no existe una bandeja de eventos crudos que se persista
**antes** del HTTP 200. Una caída abrupta entre el ACK y el primer `INSERT`
podría perder esa entrega completa.

El `INSERT` del mensaje cerca de inmediato cualquier respuesta IA anterior,
pero el trabajo nuevo solo entra en la cola durable después de que Flows y
automatizaciones terminan su clasificación. Una caída en esa ventana conserva
el mensaje en la bandeja, pero puede perder su auto-respuesta; el cron todavía
no puede reconstruir de forma segura una clasificación parcialmente ejecutada.

La siguiente fase de confiabilidad debe agregar un inbox idempotente de eventos
Meta más su worker/cron de recuperación y checkpoints idempotentes para la
clasificación. Hasta entonces no se debe describir el webhook completo ni la
ventana previa al enqueue como entrega garantizada; la garantía de la cola
empieza cuando `enqueue_ai_reply_job` confirma la generación.

## 7. Seguridad de WhatsApp y secretos

- Los webhooks entrantes de Meta se verifican sobre el body crudo con
  `X-Hub-Signature-256` y `META_APP_SECRET`. La ausencia o invalidez de la firma
  falla de forma cerrada.
- Tokens de WhatsApp, claves de IA y secretos recuperables se cifran en reposo
  con AES-256-GCM mediante `ENCRYPTION_KEY`.
- La compatibilidad de lectura con ciphertext CBC legado existe únicamente
  para migrarlo gradualmente; las escrituras nuevas deben usar GCM.
- Las claves API e invitaciones de alta entropía se almacenan como hash y el
  texto secreto se muestra una sola vez.
- La lógica que llama Meta debe reutilizar los adaptadores y núcleos existentes
  para conservar validación, reintentos de variantes telefónicas, persistencia
  y estados de entrega.

## 8. Despliegue en EasyPanel

- El build de producción usa la salida `standalone` de Next.js y el Dockerfile
  multi-stage del repositorio.
- El proceso escucha en `$PORT` y `HOSTNAME=0.0.0.0`; el puerto del dominio en
  EasyPanel debe apuntar al mismo valor.
- El contenedor **no define un `HEALTHCHECK` fijo a propósito**. EasyPanel
  comprueba la disponibilidad mediante su proxy HTTP. Agregar un healthcheck
  clavado a un puerto puede provocar reinicios cuando EasyPanel asigna otro
  `PORT`.
- Las variables `NEXT_PUBLIC_*` se incorporan durante el build y requieren un
  rebuild cuando cambian.

## 9. Google Calendar: trabajo activo a preservar

`supabase/migrations/032_google_calendar.sql` es trabajo activo de la fase de
reservas del agente closer. Define una conexión de Google Calendar por cuenta,
horario comercial, zona horaria, duración de slots y token OAuth cifrado.

Hasta que esa fase se complete:

- no se elimina, renombra, sobrescribe ni reutiliza el número `032`;
- no se crea un esquema de calendario paralelo sin compararlo con esta
  migración;
- cualquier implementación debe ser aditiva y compatible con sus invariantes
  de `account_id`, admin+, cifrado y zona horaria.

## 10. Evolución aditiva y colaboración

- Se preservan los cambios existentes, incluidos los realizados con Claude.
- No se sustituyen módulos completos cuando una extensión localizada resuelve
  el problema.
- Las migraciones aplicadas son historia inmutable. Los cambios de esquema se
  agregan en una migración nueva, idempotente cuando sea razonable y con una
  ruta segura para datos existentes.
- Antes de editar se revisa el estado del árbol de trabajo. Los cambios ajenos
  o no versionados no se limpian, formatean ni incluyen accidentalmente.
- Refactors, cambios de stack o nuevos proveedores requieren una motivación
  concreta y un plan aprobado; no se introducen como efecto secundario de una
  funcionalidad.
- Los caminos compartidos —envío de mensajes, resolución de contactos,
  permisos, cifrado y entrega Meta— se reutilizan en lugar de duplicarse.

## 11. Definición de hecho

Un cambio se considera terminado solamente cuando, de forma proporcional a su
riesgo:

- respeta branding, idioma y experiencia existente;
- sigue las guías locales de Next.js 16 aplicables;
- mantiene aislamiento por cuenta, RLS y capacidades por rol;
- preserva la precedencia Flows → automatizaciones → IA y los controles de
  handoff cuando interviene en mensajería;
- no debilita HMAC, cifrado, manejo de secretos ni validación service-role;
- no altera el contrato de EasyPanel ni introduce un `HEALTHCHECK` fijo;
- no pisa la migración 032 ni trabajo ajeno del árbol;
- incluye migración nueva y documentación cuando cambia datos, configuración o
  operación;
- añade o actualiza pruebas para el comportamiento y los casos de fallo;
- pasa, según corresponda, lint, typecheck, pruebas y build;
- se verifica manualmente el flujo visible afectado y se documenta cualquier
  limitación o seguimiento pendiente;
- el diff queda limitado al objetivo acordado y puede explicarse sin depender
  de una reescritura del sistema.
