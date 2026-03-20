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

## Endpoints principales

### Salud
- `GET /health`

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

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
