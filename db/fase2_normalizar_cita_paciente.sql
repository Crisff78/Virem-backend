BEGIN;

-- Seguridad: este script asume que la tabla cita esta vacia o que
-- haras migracion manual de datos antes de cambiar tipos.
DO $$
DECLARE
  total_citas INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_citas FROM cita;
  IF total_citas > 0 THEN
    RAISE EXCEPTION 'La tabla cita tiene % registros. Migra pacienteid manualmente antes de ejecutar este script.', total_citas;
  END IF;
END $$;

ALTER TABLE cita
  DROP CONSTRAINT IF EXISTS cita_pacienteid_fkey;

-- Unifica tipo con paciente.pacienteid (integer)
ALTER TABLE cita
  ALTER COLUMN pacienteid TYPE INTEGER
  USING NULL::INTEGER;

ALTER TABLE cita
  ADD CONSTRAINT cita_pacienteid_fkey
  FOREIGN KEY (pacienteid) REFERENCES paciente(pacienteid)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_cita_medico_fecha_inicio
  ON cita (medicoid, fechahorainicio);

CREATE INDEX IF NOT EXISTS idx_cita_paciente_fecha_inicio
  ON cita (pacienteid, fechahorainicio);

COMMIT;
