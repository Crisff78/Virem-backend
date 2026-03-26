# Virem Backend

Backend en Node.js + Express + PostgreSQL para autenticacion, agenda medica, chat y videollamada por cita.

## Requisitos
- Node.js 18+
- PostgreSQL 13+

## Configuracion
1. Instalar dependencias:
   - `npm install`
2. Configurar variables en `.env` (DB, JWT, CORS, etc).
   - Para verificacion por correo real (sin consola), agrega SMTP:
     - `SMTP_HOST=...`
     - `SMTP_PORT=587`
     - `SMTP_SECURE=false`
     - `SMTP_USER=...`
     - `SMTP_PASS=...`
     - `SMTP_FROM=...`
     - `PUBLIC_BACKEND_URL=http://localhost:3000` (o URL publica real)
     - `PUBLIC_WEB_URL=http://localhost:8081` (opcional, para boton de login en pagina de verificacion)
      - `EMAIL_FALLBACK_TO_CONSOLE=false`
   - Variables recomendadas para endurecimiento en produccion:
      - `NODE_ENV=production`
      - `JWT_SECRET=<minimo_32_caracteres>`
      - `CORS_ORIGIN=https://tu-frontend.com,https://admin.tu-frontend.com`
      - `GLOBAL_RATE_LIMIT_WINDOW_MS=60000`
      - `GLOBAL_RATE_LIMIT_MAX=180`
      - `MAX_JSON_BODY=1mb`
3. Ejecutar migraciones:
   - `npm run migrate:agenda`

## Ejecutar
- Desarrollo: `npm run dev`
- Produccion: `npm start`

## Pruebas
- Funcional (smoke): `npm run test:functional:smoke`
- Rendimiento (base): `npm run test:performance`
- Reportes generados en `backend/reports/`

> Nota: para ejecutar pruebas funcionales/rendimiento, el backend debe estar levantado.

## CI/CD (GitHub Actions)
- CI backend: `.github/workflows/ci.yml`
- Deploy parcial/simulado: `.github/workflows/deploy-partial.yml`

Secrets opcionales para deploy real:
- `RENDER_DEPLOY_HOOK_URL_BACKEND`
- `BACKEND_HEALTHCHECK_URL`

## Endpoints principales

### Salud
- `GET /health`

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/verify-email`
- `GET /api/auth/verify-email-link?email=...&codigo=...`
- `POST /api/auth/resend-verification`

### Agenda y tiempo real
- `GET /api/agenda/catalogos/especialidades`
- `GET /api/agenda/disponibilidades`
- `GET /api/agenda/medico/me/disponibilidades`
- `POST /api/agenda/medico/me/disponibilidades`
- `PUT /api/agenda/medico/me/disponibilidades/:id`
- `PATCH /api/agenda/medico/me/disponibilidades/:id/bloquear`
- `GET /api/agenda/me/citas`
- `POST /api/agenda/me/citas`
- `PATCH /api/agenda/me/citas/:citaId/cancelar`
- `PATCH /api/agenda/me/citas/:citaId/reprogramar`
- `PATCH /api/agenda/me/citas/:citaId/estado`

### Chat por cita
- `GET /api/agenda/me/conversaciones`
- `GET /api/agenda/me/conversaciones/:conversacionId/mensajes`
- `POST /api/agenda/me/conversaciones/:conversacionId/mensajes`
- `PATCH /api/agenda/me/conversaciones/:conversacionId/leido`

### Video por cita
- `GET /api/agenda/me/citas/:citaId/video-sala`
- `POST /api/agenda/me/citas/:citaId/video-sala/abrir`
- `POST /api/agenda/me/citas/:citaId/video-sala/finalizar`

### Notificaciones
- `GET /api/agenda/me/notificaciones`
- `PATCH /api/agenda/me/notificaciones/:id/leida`
- `PATCH /api/agenda/me/notificaciones/leer-todas`

### Clinico
- `POST /api/clinical/me/citas/:citaId/historia`
- `GET /api/clinical/me/historia`
- `POST /api/clinical/me/citas/:citaId/valoracion`
- `GET /api/clinical/me/valoraciones`

### Pagos (simulados)
- `POST /api/payments/me/citas/:citaId/procesar`
- `GET /api/payments/me`
- `GET /api/payments/me/:pagoId/comprobante`

### Admin
- `GET /api/admin/panel`
- `GET /api/admin/medicos/pendientes`
- `PATCH /api/admin/medicos/:usuarioId/aprobar`
- `PATCH /api/admin/medicos/:usuarioId/rechazar`
- `PATCH /api/admin/usuarios/:usuarioId/estado`
- `GET /api/admin/usuarios/modificaciones`
- `GET /api/admin/valoraciones/pendientes`
- `PATCH /api/admin/valoraciones/:valoracionId/moderar`

## Socket.IO
Eventos emitidos:
- `cita_creada`
- `cita_actualizada`
- `cita_cancelada`
- `cita_reprogramada`
- `mensaje_nuevo`
- `notificacion_nueva`
- `medico_en_linea`
- `medico_fuera_de_linea`

## Notas
- Se evita doble reserva con validacion de backend y un indice unico parcial (`uq_cita_medico_inicio_activa`) cuando no existen conflictos previos.
- `JITSI_BASE_URL` permite cambiar el proveedor base para salas Jitsi.
- El backend ahora valida configuracion critica al iniciar (`JWT_SECRET` y DB), aplica cabeceras de seguridad, rate limit global, CORS con allowlist y trazabilidad por `x-request-id`.

## Checklist de rollout seguro (produccion)
1. Definir `JWT_SECRET` robusto (>= 32 caracteres).
2. Configurar `CORS_ORIGIN` con dominios reales (sin wildcard).
3. Ajustar `GLOBAL_RATE_LIMIT_MAX` segun capacidad de infraestructura.
4. Mantener `MAX_JSON_BODY` bajo (recomendado `1mb`, subir solo si es estrictamente necesario).
5. Verificar que `/health` responda correctamente despues del deploy.
6. Ejecutar `npm run test:functional:smoke` y `npm run test:performance` en ambiente destino.
