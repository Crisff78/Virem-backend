BEGIN;

-- =========================================================
-- FASE 3: Plataforma de citas en tiempo real (incremental)
-- =========================================================

-- Opcional para restricciones avanzadas (si no hay permisos, continua)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Sin permisos para CREATE EXTENSION btree_gist. Se omite.';
END $$;

-- =========================================================
-- Especialidades: modalidad permitida
-- =========================================================
ALTER TABLE especialidad
  ADD COLUMN IF NOT EXISTS permite_presencial BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE especialidad
  ADD COLUMN IF NOT EXISTS permite_virtual BOOLEAN NOT NULL DEFAULT TRUE;

-- Reglas sugeridas por negocio
UPDATE especialidad
SET permite_presencial = TRUE,
    permite_virtual = TRUE
WHERE lower(nombre) LIKE 'psicolog%'
   OR lower(nombre) LIKE 'psiquiatr%'
   OR lower(nombre) LIKE 'medicina general%'
   OR lower(nombre) LIKE 'dermatolog%'
   OR lower(nombre) LIKE 'nutric%'
   OR lower(nombre) LIKE 'pediatr%';

UPDATE especialidad
SET permite_presencial = TRUE,
    permite_virtual = FALSE
WHERE lower(nombre) LIKE 'odontolog%'
   OR lower(nombre) LIKE 'cirugia%'
   OR lower(nombre) LIKE 'traumatolog%';

-- =========================================================
-- Multi-especialidad (compatibilidad: medico.especialidadid se mantiene)
-- =========================================================
CREATE TABLE IF NOT EXISTS medico_especialidad (
  id BIGSERIAL PRIMARY KEY,
  medicoid UUID NOT NULL REFERENCES medico(medicoid) ON DELETE CASCADE,
  especialidadid INTEGER NOT NULL REFERENCES especialidad(especialidadid) ON DELETE RESTRICT,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (medicoid, especialidadid)
);

INSERT INTO medico_especialidad (medicoid, especialidadid, activo)
SELECT m.medicoid, m.especialidadid, TRUE
FROM medico m
WHERE m.especialidadid IS NOT NULL
ON CONFLICT (medicoid, especialidadid) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_medico_especialidad_medico
  ON medico_especialidad (medicoid, activo);

CREATE INDEX IF NOT EXISTS idx_medico_especialidad_especialidad
  ON medico_especialidad (especialidadid, activo);

-- =========================================================
-- Disponibilidad del medico (extiende horario_disponible existente)
-- =========================================================
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'horario_disponible'
      AND constraint_name = 'horario_disponible_especialidadid_fkey'
  ) THEN
    ALTER TABLE horario_disponible
      ADD CONSTRAINT horario_disponible_especialidadid_fkey
      FOREIGN KEY (especialidadid)
      REFERENCES especialidad(especialidadid)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_horario_modalidad'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE horario_disponible
      ADD CONSTRAINT chk_horario_modalidad
      CHECK (lower(modalidad) IN ('presencial', 'virtual', 'ambas'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_horario_slot_minutos'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE horario_disponible
      ADD CONSTRAINT chk_horario_slot_minutos
      CHECK (slot_minutos IN (15, 20, 30, 60));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_horario_disponible_busqueda
  ON horario_disponible (medicoid, especialidadid, fechainicio, fechafin, activo, bloqueado);

CREATE INDEX IF NOT EXISTS idx_horario_disponible_modalidad
  ON horario_disponible (modalidad, activo, bloqueado);

-- =========================================================
-- Estados de cita estandarizados (sin romper estado_cita actual)
-- =========================================================
ALTER TABLE estado_cita
  ADD COLUMN IF NOT EXISTS codigo VARCHAR(40);

UPDATE estado_cita
SET codigo = 'pendiente'
WHERE codigo IS NULL
  AND lower(nombre) LIKE 'pendient%';

UPDATE estado_cita
SET codigo = 'confirmada'
WHERE codigo IS NULL
  AND lower(nombre) LIKE 'confirm%';

UPDATE estado_cita
SET codigo = 'completada'
WHERE codigo IS NULL
  AND (lower(nombre) LIKE 'complet%' OR lower(nombre) LIKE 'finaliz%' OR lower(nombre) LIKE 'realiz%');

UPDATE estado_cita
SET codigo = 'cancelada_por_medico'
WHERE codigo IS NULL
  AND lower(nombre) LIKE 'cancel%';

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'Pendiente', 'Cita creada y pendiente de confirmacion.', 'pendiente'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'pendiente'
     OR lower(nombre) = 'pendiente'
);

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'Confirmada', 'Cita confirmada por el medico.', 'confirmada'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'confirmada'
     OR lower(nombre) = 'confirmada'
);

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'Cancelada por paciente', 'Cita cancelada por el paciente.', 'cancelada_por_paciente'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'cancelada_por_paciente'
);

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'Cancelada por medico', 'Cita cancelada por el medico.', 'cancelada_por_medico'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'cancelada_por_medico'
);

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'Reprogramada', 'Cita reprogramada.', 'reprogramada'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'reprogramada'
);

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'Completada', 'Cita completada satisfactoriamente.', 'completada'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'completada'
     OR lower(nombre) = 'completada'
);

INSERT INTO estado_cita (nombre, descripcion, codigo)
SELECT 'No asistio', 'El paciente no asistio a la cita.', 'no_asistio'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita
  WHERE lower(coalesce(codigo, '')) = 'no_asistio'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_estado_cita_codigo
  ON estado_cita (lower(codigo))
  WHERE codigo IS NOT NULL;

-- =========================================================
-- Citas: nuevos campos de negocio
-- =========================================================
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
  ADD COLUMN IF NOT EXISTS videosalaid UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cita_modalidad'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE cita
      ADD CONSTRAINT chk_cita_modalidad
      CHECK (lower(modalidad) IN ('presencial', 'virtual'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cita_cancelada_por'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE cita
      ADD CONSTRAINT chk_cita_cancelada_por
      CHECK (
        cancelada_por IS NULL
        OR lower(cancelada_por) IN ('paciente', 'medico', 'sistema')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'cita'
      AND constraint_name = 'cita_reprogramada_desde_citaid_fkey'
  ) THEN
    ALTER TABLE cita
      ADD CONSTRAINT cita_reprogramada_desde_citaid_fkey
      FOREIGN KEY (reprogramada_desde_citaid)
      REFERENCES cita(citaid)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'cita'
      AND constraint_name = 'cita_disponibilidadid_fkey'
  ) THEN
    ALTER TABLE cita
      ADD CONSTRAINT cita_disponibilidadid_fkey
      FOREIGN KEY (disponibilidadid)
      REFERENCES horario_disponible(horariodisponibleid)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

UPDATE cita c
SET estado_codigo = COALESCE(
  NULLIF(lower(trim(ec.codigo)), ''),
  CASE
    WHEN lower(ec.nombre) LIKE 'pendient%' THEN 'pendiente'
    WHEN lower(ec.nombre) LIKE 'confirm%' THEN 'confirmada'
    WHEN lower(ec.nombre) LIKE 'reprogram%' THEN 'reprogramada'
    WHEN lower(ec.nombre) LIKE 'complet%' OR lower(ec.nombre) LIKE 'finaliz%' OR lower(ec.nombre) LIKE 'realiz%' THEN 'completada'
    WHEN lower(ec.nombre) LIKE 'cancel%pacient%' THEN 'cancelada_por_paciente'
    WHEN lower(ec.nombre) LIKE 'cancel%medic%' THEN 'cancelada_por_medico'
    WHEN lower(ec.nombre) LIKE 'cancel%' THEN 'cancelada_por_medico'
    WHEN lower(ec.nombre) LIKE 'no asist%' THEN 'no_asistio'
    ELSE 'pendiente'
  END
)
FROM estado_cita ec
WHERE ec.estadocitaid = c.estadocitaid;

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

-- Evita doble reserva activa en mismo medico + misma hora de inicio
DO $$
DECLARE
  duplicated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicated_count
  FROM (
    SELECT medicoid, fechahorainicio
    FROM cita
    WHERE lower(coalesce(estado_codigo, 'pendiente')) IN ('pendiente', 'confirmada', 'reprogramada')
    GROUP BY medicoid, fechahorainicio
    HAVING COUNT(*) > 1
  ) q;

  IF duplicated_count = 0 THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'uq_cita_medico_inicio_activa'
    ) THEN
      EXECUTE 'CREATE UNIQUE INDEX uq_cita_medico_inicio_activa
               ON cita (medicoid, fechahorainicio)
               WHERE lower(estado_codigo) IN (''pendiente'', ''confirmada'', ''reprogramada'')';
    END IF;
  ELSE
    RAISE NOTICE 'No se crea uq_cita_medico_inicio_activa por conflictos previos (%).', duplicated_count;
  END IF;
END $$;

-- =========================================================
-- Historial de citas
-- =========================================================
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cita_historial_accion'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE cita_historial
      ADD CONSTRAINT chk_cita_historial_accion
      CHECK (lower(accion) IN ('creada', 'confirmada', 'cancelada', 'reprogramada', 'completada', 'no_asistio'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_cita_historial_usuario_tipo'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE cita_historial
      ADD CONSTRAINT chk_cita_historial_usuario_tipo
      CHECK (lower(usuario_tipo) IN ('paciente', 'medico', 'sistema'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cita_historial_cita_fecha
  ON cita_historial (citaid, fecha_evento DESC);

-- =========================================================
-- Chat por cita
-- =========================================================
CREATE TABLE IF NOT EXISTS conversaciones (
  conversacionid UUID PRIMARY KEY,
  citaid UUID NOT NULL REFERENCES cita(citaid) ON DELETE CASCADE,
  pacienteid INTEGER NOT NULL REFERENCES paciente(pacienteid) ON DELETE CASCADE,
  medicoid UUID NOT NULL REFERENCES medico(medicoid) ON DELETE CASCADE,
  estado VARCHAR(16) NOT NULL DEFAULT 'activa',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (citaid)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_conversaciones_estado'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE conversaciones
      ADD CONSTRAINT chk_conversaciones_estado
      CHECK (lower(estado) IN ('activa', 'cerrada'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversaciones_paciente
  ON conversaciones (pacienteid, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversaciones_medico
  ON conversaciones (medicoid, updated_at DESC);

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_mensajes_emisor_tipo'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE mensajes
      ADD CONSTRAINT chk_mensajes_emisor_tipo
      CHECK (lower(emisor_tipo) IN ('paciente', 'medico', 'sistema'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_mensajes_tipo'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE mensajes
      ADD CONSTRAINT chk_mensajes_tipo
      CHECK (lower(tipo) IN ('texto', 'imagen', 'archivo', 'sistema'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_fecha
  ON mensajes (conversacionid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion_leido
  ON mensajes (conversacionid, leido, created_at DESC);

-- =========================================================
-- Salas de videollamada por cita
-- =========================================================
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_video_salas_estado'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE video_salas
      ADD CONSTRAINT chk_video_salas_estado
      CHECK (lower(estado) IN ('pendiente', 'abierta', 'finalizada'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_video_salas_estado
  ON video_salas (estado, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'cita'
      AND constraint_name = 'cita_videosalaid_fkey'
  ) THEN
    ALTER TABLE cita
      ADD CONSTRAINT cita_videosalaid_fkey
      FOREIGN KEY (videosalaid)
      REFERENCES video_salas(videosalaid)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

-- =========================================================
-- Notificaciones persistentes
-- =========================================================
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

CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_leida_fecha
  ON notificaciones (usuarioid, leida, created_at DESC);

COMMIT;
