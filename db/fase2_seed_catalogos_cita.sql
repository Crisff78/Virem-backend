BEGIN;

-- Estados base de cita
INSERT INTO estado_cita (nombre, descripcion)
SELECT 'Pendiente', 'Cita creada y pendiente de confirmacion.'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita WHERE lower(nombre) = lower('Pendiente')
);

INSERT INTO estado_cita (nombre, descripcion)
SELECT 'Confirmada', 'Cita confirmada por el medico.'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita WHERE lower(nombre) = lower('Confirmada')
);

INSERT INTO estado_cita (nombre, descripcion)
SELECT 'Completada', 'Cita completada satisfactoriamente.'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita WHERE lower(nombre) = lower('Completada')
);

INSERT INTO estado_cita (nombre, descripcion)
SELECT 'Cancelada', 'Cita cancelada por paciente o medico.'
WHERE NOT EXISTS (
  SELECT 1 FROM estado_cita WHERE lower(nombre) = lower('Cancelada')
);

-- Tipos de consulta base
INSERT INTO tipos_consulta (nombre, duracionmin, preciobase, activo)
SELECT 'Videoconsulta', 30, 0.00, true
WHERE NOT EXISTS (
  SELECT 1 FROM tipos_consulta WHERE lower(nombre) = lower('Videoconsulta')
);

INSERT INTO tipos_consulta (nombre, duracionmin, preciobase, activo)
SELECT 'Consulta Presencial', 30, 0.00, true
WHERE NOT EXISTS (
  SELECT 1 FROM tipos_consulta WHERE lower(nombre) = lower('Consulta Presencial')
);

-- Zonas horarias base
INSERT INTO zonas_horarias (nombre, offsetutc, activa, descripcion)
SELECT 'America/Santo_Domingo', '-04:00:00'::interval, true, 'Zona horaria base para Republica Dominicana.'
WHERE NOT EXISTS (
  SELECT 1 FROM zonas_horarias WHERE lower(nombre) = lower('America/Santo_Domingo')
);

INSERT INTO zonas_horarias (nombre, offsetutc, activa, descripcion)
SELECT 'UTC', '00:00:00'::interval, true, 'Tiempo universal coordinado.'
WHERE NOT EXISTS (
  SELECT 1 FROM zonas_horarias WHERE lower(nombre) = lower('UTC')
);

COMMIT;
