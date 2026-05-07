-- =========================================================
-- Fase 8: Chat por pareja (paciente, medico)
--
-- Cambia el modelo de chat: deja de ser "una conversacion por cita"
-- y pasa a ser "una conversacion por pareja paciente/medico".
--
-- Esto permite:
--  * Que el medico inicie un chat sin que exista una cita.
--  * Que el chat persista a lo largo de varias citas.
--  * Mensajes en tiempo real consistentes (la sala socket es estable).
-- =========================================================

-- 1) Si la columna citaid existe (modelo viejo), la renombramos a citaid_origen
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversaciones'
      AND column_name = 'citaid'
  ) THEN
    -- Borrar UNIQUE sobre citaid si existe
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'conversaciones_citaid_key'
        AND connamespace = 'public'::regnamespace
    ) THEN
      ALTER TABLE conversaciones DROP CONSTRAINT conversaciones_citaid_key;
    END IF;

    -- Borrar el FK viejo de citaid (con su nombre por defecto)
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'conversaciones_citaid_fkey'
        AND connamespace = 'public'::regnamespace
    ) THEN
      ALTER TABLE conversaciones DROP CONSTRAINT conversaciones_citaid_fkey;
    END IF;

    -- Permitir NULL antes de renombrar
    ALTER TABLE conversaciones ALTER COLUMN citaid DROP NOT NULL;

    -- Renombrar columna
    ALTER TABLE conversaciones RENAME COLUMN citaid TO citaid_origen;

    -- Recrear FK con ON DELETE SET NULL (no queremos perder el chat si la cita se borra)
    ALTER TABLE conversaciones
      ADD CONSTRAINT conversaciones_citaid_origen_fkey
      FOREIGN KEY (citaid_origen) REFERENCES cita(citaid) ON DELETE SET NULL;
  END IF;
END $$;

-- 2) Si por alguna razon la columna citaid_origen no existe, la creamos
ALTER TABLE conversaciones
  ADD COLUMN IF NOT EXISTS citaid_origen UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversaciones_citaid_origen_fkey'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE conversaciones
      ADD CONSTRAINT conversaciones_citaid_origen_fkey
      FOREIGN KEY (citaid_origen) REFERENCES cita(citaid) ON DELETE SET NULL;
  END IF;
END $$;

-- 3) Colapsar filas duplicadas: para cada par (paciente, medico)
--    elegimos la fila mas recientemente actualizada como canonica
--    y reasignamos los mensajes de las demas a esa fila, antes de borrarlas.
DO $$
DECLARE
  pair RECORD;
  canonical_id UUID;
BEGIN
  FOR pair IN
    SELECT pacienteid, medicoid
    FROM conversaciones
    GROUP BY pacienteid, medicoid
    HAVING COUNT(*) > 1
  LOOP
    SELECT conversacionid
      INTO canonical_id
    FROM conversaciones
    WHERE pacienteid = pair.pacienteid
      AND medicoid = pair.medicoid
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1;

    UPDATE mensajes
       SET conversacionid = canonical_id
     WHERE conversacionid IN (
        SELECT conversacionid
        FROM conversaciones
        WHERE pacienteid = pair.pacienteid
          AND medicoid = pair.medicoid
          AND conversacionid <> canonical_id
     );

    DELETE FROM conversaciones
     WHERE pacienteid = pair.pacienteid
       AND medicoid = pair.medicoid
       AND conversacionid <> canonical_id;
  END LOOP;
END $$;

-- 4) Indice unico por pareja
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_conversaciones_pareja'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE conversaciones
      ADD CONSTRAINT uq_conversaciones_pareja UNIQUE (pacienteid, medicoid);
  END IF;
END $$;

-- 5) Indice util para listados por usuario, ya cubierto por los existentes
--    pero mantenemos uno por citaid_origen para depuracion / auditoria
CREATE INDEX IF NOT EXISTS idx_conversaciones_citaid_origen
  ON conversaciones (citaid_origen);
