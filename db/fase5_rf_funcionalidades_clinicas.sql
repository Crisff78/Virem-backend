-- Fase 5: RF faltantes (verificacion, aprobacion, historia clinica, pagos simulados, valoraciones, auditoria)

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

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS pacienteid INTEGER;

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS medicoid_text TEXT;

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS moneda CHAR(3) DEFAULT 'DOP';

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS metodo_pago VARCHAR(40);

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS estado VARCHAR(40) DEFAULT 'simulado_aprobado';

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS referencia_externa TEXT;

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS detalle_json JSONB DEFAULT '{}'::jsonb;

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE pago
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

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

ALTER TABLE factura
  ADD COLUMN IF NOT EXISTS pacienteid INTEGER;

ALTER TABLE factura
  ADD COLUMN IF NOT EXISTS moneda CHAR(3) DEFAULT 'DOP';

ALTER TABLE factura
  ADD COLUMN IF NOT EXISTS detalle_json JSONB DEFAULT '{}'::jsonb;

ALTER TABLE factura
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

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

CREATE INDEX IF NOT EXISTS idx_valoracion_medico_estado
  ON valoracion (medicoid_text, estado_moderacion, created_at DESC);
