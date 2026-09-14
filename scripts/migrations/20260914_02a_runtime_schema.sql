-- Extracted runtime schema and legacy data backfills; run once through scripts/migrations.js.
-- Requires the existing VIREM base tables (usuario, paciente, medico, cita, receta_medica, catalogs).

-- Source: services/rf-core.js
ALTER TABLE paciente
       ADD COLUMN IF NOT EXISTS usuarioid INTEGER;

ALTER TABLE paciente
       ALTER COLUMN cedula TYPE VARCHAR(20);

ALTER TABLE medico
       ADD COLUMN IF NOT EXISTS usuarioid INTEGER;

ALTER TABLE medico
       ALTER COLUMN cedula TYPE VARCHAR(20);

ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS account_status VARCHAR(40) NOT NULL DEFAULT 'activa';

ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS email_verificado_at TIMESTAMPTZ;

ALTER TABLE usuario
       ADD COLUMN IF NOT EXISTS aprobado_por_admin BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE usuario
       SET account_status = 'activa'
       WHERE account_status IS NULL
          OR btrim(account_status) = '';

UPDATE usuario
       SET email_verificado = TRUE,
           email_verificado_at = COALESCE(email_verificado_at, NOW())
       WHERE email_verificado IS DISTINCT FROM TRUE
         AND account_status = 'activa';

CREATE INDEX IF NOT EXISTS idx_usuario_account_status
       ON usuario (account_status, rolid, activo);

CREATE TABLE IF NOT EXISTS pending_registration (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        registration_data JSONB NOT NULL,
        role_id INTEGER NOT NULL,
        verification_code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_pending_registration_email_expires
       ON pending_registration (email, expires_at);

CREATE TABLE IF NOT EXISTS email_verificacion_code (
        id BIGSERIAL PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at TIMESTAMPTZ,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_email_verificacion_code_email_created
       ON email_verificacion_code (email, created_at DESC);

CREATE TABLE IF NOT EXISTS medico_documento (
        documentoid UUID PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        medicoid_text TEXT,
        tipo VARCHAR(40) NOT NULL,
        nombre VARCHAR(180),
        archivo_url TEXT NOT NULL,
        estado_revision VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        comentario_admin TEXT,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_medico_documento_usuario_tipo
       ON medico_documento (usuarioid, tipo, estado_revision, creado_en DESC);

CREATE TABLE IF NOT EXISTS user_modificacion_historial (
        id BIGSERIAL PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        actor_usuarioid INTEGER REFERENCES usuario(usuarioid) ON DELETE SET NULL,
        scope VARCHAR(40) NOT NULL,
        cambios_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        motivo TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_user_modificacion_historial_usuario_fecha
       ON user_modificacion_historial (usuarioid, created_at DESC);

CREATE TABLE IF NOT EXISTS historia_clinica (
        historiaid BIGSERIAL PRIMARY KEY,
        citaid UUID NOT NULL UNIQUE,
        pacienteid INTEGER NOT NULL,
        medicoid_text TEXT NOT NULL,
        diagnostico TEXT NOT NULL,
        antecedentes TEXT,
        tratamiento TEXT,
        observaciones TEXT,
        duracion_min INTEGER,
        consentimiento_otorgado BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_usuarioid INTEGER,
        updated_by_usuarioid INTEGER
      );

CREATE INDEX IF NOT EXISTS idx_historia_clinica_paciente_fecha
       ON historia_clinica (pacienteid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_historia_clinica_medico_fecha
       ON historia_clinica (medicoid_text, created_at DESC);

CREATE TABLE IF NOT EXISTS pago (
        pagoid UUID PRIMARY KEY,
        citaid UUID NOT NULL UNIQUE,
        pacienteid INTEGER NOT NULL,
        medicoid_text TEXT,
        monto NUMERIC(12,2) NOT NULL,
        moneda CHAR(3) NOT NULL DEFAULT 'DOP',
        metodo_pago VARCHAR(40) NOT NULL,
        estado VARCHAR(40) NOT NULL DEFAULT 'simulado_aprobado',
        referencia_externa TEXT,
        detalle_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

ALTER TABLE pago ADD COLUMN IF NOT EXISTS pacienteid INTEGER;

ALTER TABLE pago ADD COLUMN IF NOT EXISTS medicoid_text TEXT;

ALTER TABLE pago ADD COLUMN IF NOT EXISTS moneda CHAR(3) DEFAULT 'DOP';

ALTER TABLE pago ADD COLUMN IF NOT EXISTS metodo_pago VARCHAR(40);

ALTER TABLE pago ADD COLUMN IF NOT EXISTS estado VARCHAR(40) DEFAULT 'simulado_aprobado';

ALTER TABLE pago ADD COLUMN IF NOT EXISTS referencia_externa TEXT;

ALTER TABLE pago ADD COLUMN IF NOT EXISTS detalle_json JSONB DEFAULT '{}'::jsonb;

ALTER TABLE pago ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE pago ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'metodopago'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET metodo_pago = COALESCE(NULLIF(metodo_pago, ''''), metodopago)
          WHERE (metodo_pago IS NULL OR btrim(metodo_pago) = '''')
            AND metodopago IS NOT NULL
        ';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'estadopago'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET estado = COALESCE(NULLIF(estado, ''''), estadopago)
          WHERE (estado IS NULL OR btrim(estado) = '''')
            AND estadopago IS NOT NULL
        ';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'transactionref'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET referencia_externa = COALESCE(referencia_externa, transactionref)
          WHERE referencia_externa IS NULL
        ';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'pago'
          AND column_name = 'fechapago'
      ) THEN
        EXECUTE '
          UPDATE pago
          SET created_at = COALESCE(created_at, fechapago, NOW()),
              updated_at = COALESCE(updated_at, fechapago, created_at, NOW())
          WHERE created_at IS NULL
             OR updated_at IS NULL
        ';
      END IF;
    END $$;

UPDATE pago p
       SET pacienteid = c.pacienteid,
           medicoid_text = c.medicoid::text
       FROM cita c
       WHERE p.citaid = c.citaid
         AND (p.pacienteid IS NULL OR p.medicoid_text IS NULL);

UPDATE pago
       SET moneda = 'DOP'
       WHERE moneda IS NULL
          OR btrim(moneda) = '';

UPDATE pago
       SET metodo_pago = 'tarjeta'
       WHERE metodo_pago IS NULL
          OR btrim(metodo_pago) = '';

UPDATE pago
       SET estado = 'simulado_aprobado'
       WHERE estado IS NULL
          OR btrim(estado) = '';

UPDATE pago
       SET detalle_json = '{}'::jsonb
       WHERE detalle_json IS NULL;

UPDATE pago
       SET created_at = COALESCE(created_at, NOW()),
           updated_at = COALESCE(updated_at, created_at, NOW())
       WHERE created_at IS NULL
          OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pago_paciente_fecha
       ON pago (pacienteid, created_at DESC);

CREATE TABLE IF NOT EXISTS factura (
        facturaid UUID PRIMARY KEY,
        pagoid UUID NOT NULL REFERENCES pago(pagoid) ON DELETE CASCADE,
        numero_factura VARCHAR(80) NOT NULL UNIQUE,
        pacienteid INTEGER NOT NULL,
        monto NUMERIC(12,2) NOT NULL,
        moneda CHAR(3) NOT NULL DEFAULT 'DOP',
        detalle_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

ALTER TABLE factura ADD COLUMN IF NOT EXISTS pacienteid INTEGER;

ALTER TABLE factura ADD COLUMN IF NOT EXISTS moneda CHAR(3) DEFAULT 'DOP';

ALTER TABLE factura ADD COLUMN IF NOT EXISTS detalle_json JSONB DEFAULT '{}'::jsonb;

ALTER TABLE factura ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_factura_paciente_fecha
       ON factura (pacienteid, created_at DESC);

CREATE TABLE IF NOT EXISTS valoracion (
        valoracionid BIGSERIAL PRIMARY KEY,
        citaid UUID NOT NULL,
        pacienteid INTEGER NOT NULL,
        medicoid_text TEXT NOT NULL,
        puntaje SMALLINT NOT NULL,
        comentario TEXT,
        estado_moderacion VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        moderada_por INTEGER,
        moderada_en TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_valoracion_cita UNIQUE (citaid),
        CONSTRAINT chk_valoracion_puntaje CHECK (puntaje BETWEEN 1 AND 5)
      );

CREATE TABLE IF NOT EXISTS recovery_tokens (
        email TEXT PRIMARY KEY,
        code VARCHAR(10) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_recovery_tokens_expires
       ON recovery_tokens (expires_at);

-- Source: services/platform-core.js
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text AS $$
       SELECT translate($1, 'áéíóúÁÉÍÓÚäëïöüÄËÏÖÜñÑ', 'aeiouAEIOUaeiouAEIOUnN');
       $$ LANGUAGE sql IMMUTABLE;

ALTER TABLE paciente
       ADD COLUMN IF NOT EXISTS usuarioid INTEGER;

ALTER TABLE medico
       ADD COLUMN IF NOT EXISTS usuarioid INTEGER;

ALTER TABLE especialidad
       ADD COLUMN IF NOT EXISTS permite_presencial BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE especialidad
       ADD COLUMN IF NOT EXISTS permite_virtual BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS especialidadid INTEGER;

ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS modalidad VARCHAR(16) NOT NULL DEFAULT 'ambas';

ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS slot_minutos INTEGER NOT NULL DEFAULT 30;

ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE horario_disponible
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE estado_cita
       ADD COLUMN IF NOT EXISTS codigo VARCHAR(40);

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS modalidad VARCHAR(16) NOT NULL DEFAULT 'presencial';

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS motivo_consulta TEXT;

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS cancelada_por VARCHAR(16);

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS cancelacion_motivo TEXT;

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS reprogramada_desde_citaid UUID;

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS disponibilidadid INTEGER;

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS estado_codigo VARCHAR(40) NOT NULL DEFAULT 'pendiente';

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS reminders_sent JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE cita
       ADD COLUMN IF NOT EXISTS videosalaid UUID;

CREATE TABLE IF NOT EXISTS medico_especialidad (
        id BIGSERIAL PRIMARY KEY,
        medicoid UUID NOT NULL REFERENCES medico(medicoid) ON DELETE CASCADE,
        especialidadid INTEGER NOT NULL REFERENCES especialidad(especialidadid) ON DELETE RESTRICT,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (medicoid, especialidadid)
      );

CREATE TABLE IF NOT EXISTS cita_historial (
        id BIGSERIAL PRIMARY KEY,
        citaid UUID NOT NULL REFERENCES cita(citaid) ON DELETE CASCADE,
        accion VARCHAR(32) NOT NULL,
        usuario_tipo VARCHAR(16) NOT NULL,
        usuario_id TEXT,
        motivo TEXT,
        datos_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        fecha_evento TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS conversaciones (
        conversacionid UUID PRIMARY KEY,
        citaid_origen UUID REFERENCES cita(citaid) ON DELETE SET NULL,
        pacienteid INTEGER NOT NULL REFERENCES paciente(pacienteid) ON DELETE CASCADE,
        medicoid UUID NOT NULL REFERENCES medico(medicoid) ON DELETE CASCADE,
        estado VARCHAR(16) NOT NULL DEFAULT 'activa',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (pacienteid, medicoid)
      );

CREATE TABLE IF NOT EXISTS mensajes (
        mensajeid UUID PRIMARY KEY,
        conversacionid UUID NOT NULL REFERENCES conversaciones(conversacionid) ON DELETE CASCADE,
        emisor_tipo VARCHAR(16) NOT NULL,
        emisor_id TEXT NOT NULL,
        contenido TEXT NOT NULL,
        tipo VARCHAR(16) NOT NULL DEFAULT 'texto',
        leido BOOLEAN NOT NULL DEFAULT FALSE,
        leido_at TIMESTAMPTZ,
        meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS video_salas (
        videosalaid UUID PRIMARY KEY,
        citaid UUID NOT NULL REFERENCES cita(citaid) ON DELETE CASCADE,
        proveedor VARCHAR(20) NOT NULL DEFAULT 'jitsi',
        room_name VARCHAR(120) NOT NULL,
        token_o_url TEXT,
        estado VARCHAR(16) NOT NULL DEFAULT 'pendiente',
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (citaid)
      );

CREATE TABLE IF NOT EXISTS medico_horario_recurrente (
        medicoid UUID PRIMARY KEY REFERENCES medico(medicoid) ON DELETE CASCADE,
        pattern JSONB NOT NULL DEFAULT '[]'::jsonb,
        modalidad VARCHAR(16) NOT NULL DEFAULT 'ambas',
        slot_minutos INTEGER NOT NULL DEFAULT 30,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS notificaciones (
        notificacionid BIGSERIAL PRIMARY KEY,
        usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
        tipo VARCHAR(40) NOT NULL,
        titulo VARCHAR(180) NOT NULL,
        contenido TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        leida BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at TIMESTAMPTZ
      );

CREATE INDEX IF NOT EXISTS idx_horario_disponible_busqueda
       ON horario_disponible (medicoid, especialidadid, fechainicio, fechafin, activo, bloqueado);

CREATE INDEX IF NOT EXISTS idx_horario_disponible_modalidad
       ON horario_disponible (modalidad, activo, bloqueado);

CREATE INDEX IF NOT EXISTS idx_cita_estado_codigo
       ON cita (estado_codigo);

CREATE INDEX IF NOT EXISTS idx_cita_fecha_inicio
       ON cita (fechahorainicio);

CREATE INDEX IF NOT EXISTS idx_cita_medico_estado_fecha
       ON cita (medicoid, estado_codigo, fechahorainicio);

CREATE INDEX IF NOT EXISTS idx_cita_paciente_estado_fecha
       ON cita (pacienteid, estado_codigo, fechahorainicio);

CREATE INDEX IF NOT EXISTS idx_cita_disponibilidadid
       ON cita (disponibilidadid);

CREATE INDEX IF NOT EXISTS idx_cita_historial_cita_fecha
       ON cita_historial (citaid, fecha_evento DESC);

CREATE INDEX IF NOT EXISTS idx_conversaciones_paciente
       ON conversaciones (pacienteid, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversaciones_medico
       ON conversaciones (medicoid, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_fecha
       ON mensajes (conversacionid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_leido
       ON mensajes (conversacionid, leido, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_salas_estado
       ON video_salas (estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_leida_fecha
       ON notificaciones (usuarioid, leida, created_at DESC);

DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = 'uq_cita_medico_inicio_activa'
         ) THEN
           IF NOT EXISTS (
             SELECT 1
             FROM (
               SELECT medicoid, fechahorainicio
               FROM cita
               WHERE lower(coalesce(estado_codigo, 'pendiente')) IN ('pendiente', 'confirmada', 'reprogramada')
               GROUP BY medicoid, fechahorainicio
               HAVING COUNT(*) > 1
             ) d
           ) THEN
             CREATE UNIQUE INDEX uq_cita_medico_inicio_activa
             ON cita (medicoid, fechahorainicio)
             WHERE lower(estado_codigo) IN ('pendiente', 'confirmada', 'reprogramada');
           END IF;
         END IF;
       END $$;

-- Source: services/user-profile.store.js
SELECT to_regclass('public.usuario_perfil') AS table_name;

CREATE TABLE IF NOT EXISTS usuario_perfil (
            usuarioid TEXT PRIMARY KEY,
            foto_url TEXT,
            meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

ALTER TABLE usuario_perfil
         ADD COLUMN IF NOT EXISTS foto_url TEXT;

ALTER TABLE usuario_perfil
         ALTER COLUMN foto_url TYPE TEXT;

ALTER TABLE usuario_perfil
         ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_usuario_perfil_updated_at
         ON usuario_perfil (updated_at DESC);

-- Source: routes/auth.routes.js
CREATE TABLE IF NOT EXISTS password_reset_code (
          id BIGSERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          verified_at TIMESTAMPTZ,
          used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

ALTER TABLE password_reset_code
           ADD COLUMN IF NOT EXISTS recovery_ticket_hash TEXT,
           ADD COLUMN IF NOT EXISTS recovery_ticket_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_password_reset_code_email_created
           ON password_reset_code (email, created_at DESC);

-- Source: routes/auth.routes.js
CREATE TABLE IF NOT EXISTS admin_mfa_challenge (
    usuarioid TEXT PRIMARY KEY,
    challenge_id UUID NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INTEGER NOT NULL DEFAULT 0,
    used_at TIMESTAMPTZ
  );

-- Source: routes/recetas.routes.js
ALTER TABLE receta_medica 
      ADD COLUMN IF NOT EXISTS disponible_paciente BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS signos_vitales_json JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS ordenes_laboratorio TEXT,
      ADD COLUMN IF NOT EXISTS doctor_info_json JSONB DEFAULT '{}'::jsonb;
