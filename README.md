# Virem Backend

Backend en Node.js + Express + PostgreSQL para autenticacion, agenda medica, chat y videollamada por cita.

## Requisitos
- Node.js 18+
- PostgreSQL 13+

## Configuracion
1. Instalar dependencias:
   - `npm install`
2. Configurar variables en `.env` (DB, JWT, CORS, etc).
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
