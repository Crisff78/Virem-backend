-- ============================================================
-- MIGRACION: relacion explicita usuario -> paciente / medico
-- ============================================================
--
-- Notas:
-- 1. Se mantiene usuarioid nullable porque este repo aun permite
--    crear pacientes/medicos manuales sin cuenta asociada.
-- 2. Si en el futuro se quiere NOT NULL, primero hay que cerrar o
--    adaptar esos flujos y revisar la politica de borrado del usuario.

BEGIN;

ALTER TABLE paciente
  ADD COLUMN IF NOT EXISTS usuarioid INTEGER;

ALTER TABLE medico
  ADD COLUMN IF NOT EXISTS usuarioid INTEGER;

-- Backfill de paciente para registros historicos donde se forzo
-- pacienteid = usuarioid durante el registro.
UPDATE paciente p
SET usuarioid = p.pacienteid
WHERE p.usuarioid IS NULL
  AND EXISTS (
    SELECT 1
    FROM usuario u
    WHERE u.usuarioid = p.pacienteid
  );

-- Backfill de medico usando la relacion historica guardada en usuario_perfil.meta.
DO $$
BEGIN
  IF to_regclass('public.usuario_perfil') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE medico m
      SET usuarioid = src.usuarioid
      FROM (
        SELECT DISTINCT ON (m2.medicoid)
          m2.medicoid,
          u.usuarioid
        FROM medico m2
        JOIN usuario_perfil up
          ON COALESCE(up.meta_json->>'medicoid', up.meta_json->>'medicoId', '') = m2.medicoid::text
        JOIN usuario u
          ON u.usuarioid::text = up.usuarioid::text
        ORDER BY m2.medicoid, up.updated_at DESC NULLS LAST, u.usuarioid DESC
      ) AS src
      WHERE m.medicoid = src.medicoid
        AND m.usuarioid IS NULL
    $sql$;
  END IF;
END $$;

-- Fallback para esquemas legacy donde medicoid pudo coincidir con usuarioid.
UPDATE medico m
SET usuarioid = u.usuarioid
FROM usuario u
WHERE m.usuarioid IS NULL
  AND m.medicoid::text = u.usuarioid::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_paciente_usuarioid'
  ) THEN
    ALTER TABLE paciente
      ADD CONSTRAINT fk_paciente_usuarioid
      FOREIGN KEY (usuarioid) REFERENCES usuario(usuarioid)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_medico_usuarioid'
  ) THEN
    ALTER TABLE medico
      ADD CONSTRAINT fk_medico_usuarioid
      FOREIGN KEY (usuarioid) REFERENCES usuario(usuarioid)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_paciente_usuarioid
  ON paciente (usuarioid)
  WHERE usuarioid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_medico_usuarioid
  ON medico (usuarioid)
  WHERE usuarioid IS NOT NULL;

COMMIT;

-- Auditoria recomendada despues de ejecutar la migracion:
-- SELECT 'paciente sin usuario' AS tipo, pacienteid::text AS perfilid
-- FROM paciente
-- WHERE usuarioid IS NULL
-- UNION ALL
-- SELECT 'medico sin usuario' AS tipo, medicoid::text AS perfilid
-- FROM medico
-- WHERE usuarioid IS NULL;
