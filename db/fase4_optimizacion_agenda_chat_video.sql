BEGIN;

-- =========================================================
-- FASE 4: Optimizacion + consistencia de agenda/chat/video
-- Ejecutar despues de fase3_citas_tiempo_real.sql
-- =========================================================

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

-- Evita doble reserva activa en mismo medico + misma hora de inicio.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
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
    ELSE
      RAISE NOTICE 'uq_cita_medico_inicio_activa no se crea por conflictos existentes.';
    END IF;
  END IF;
END $$;

COMMIT;
