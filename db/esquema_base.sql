-- VIREM: esquema base para una base PostgreSQL VACIA (PostgreSQL 15+).
-- Reconstruido desde las consultas de backend-files/routes/auth.routes.js,
-- routes/{auth,medicos,pacientes,agenda}.routes.js y services/agenda-service.js,
-- descontando lo que crean/agregan db/fase2_*.sql ... db/fase8_*.sql,
-- scripts/migrations/20260914_02a_runtime_schema.sql y los migradores de precios/pagos.
-- No se conserva un dump de Fase 1: longitudes, defaults y nulabilidad no
-- recuperables se definen aqui de forma explicita; no es una copia historica exacta.
--
-- Ejecutar antes de las migraciones incrementales, con parada ante errores:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/esquema_base.sql
-- Despues: fase2_normalizar_cita_paciente, fase2_seed_catalogos_cita,
-- fase3, fase4, fase5, fase6, fase7, fase8 (archivos de db/), y finalmente
-- scripts/migrations.js. Los cambios financieros/precios siguen perteneciendo
-- a migrate_medico_price.js, migrate_payments.js, migrate_business_logic.js
-- y scripts/migrate_pricing_v2.js; este archivo no los adelanta.
--
-- No usar IF NOT EXISTS: una instalacion parcialmente creada debe fallar,
-- no ocultar divergencias de esquema. Toda la creacion es atomica.

BEGIN;
SET LOCAL search_path TO public;

CREATE TABLE rol (
    rolid SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE,
    descripcion TEXT
);

CREATE TABLE usuario (
    usuarioid SERIAL PRIMARY KEY,
    rolid INTEGER NOT NULL REFERENCES rol(rolid),
    email TEXT NOT NULL UNIQUE,
    passwordhash TEXT NOT NULL,
    fechacreacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- usuarioid se incorpora a paciente y medico en fase6, no aqui.
CREATE TABLE paciente (
    pacienteid SERIAL PRIMARY KEY,
    nombres TEXT NOT NULL,
    apellidos TEXT NOT NULL,
    fechanacimiento DATE,
    genero TEXT,
    cedula TEXT,
    telefono TEXT,
    fecharegistro TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE especialidad (
    especialidadid SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL
);

CREATE TABLE medico (
    medicoid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    especialidadid INTEGER REFERENCES especialidad(especialidadid),
    nombrecompleto TEXT NOT NULL,
    fechanacimiento DATE,
    genero TEXT,
    cedula TEXT,
    telefono TEXT,
    consultorio TEXT,
    fecharegistro TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Los valores de estos tres catalogos los carga fase2_seed_catalogos_cita.sql.
CREATE TABLE estado_cita (
    estadocitaid SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    descripcion TEXT
);

CREATE TABLE tipos_consulta (
    tipoconsultaid SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    duracionmin INTEGER NOT NULL DEFAULT 30,
    preciobase NUMERIC(12,2) NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE zonas_horarias (
    zonahorariaid SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    offsetutc INTERVAL NOT NULL,
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    descripcion TEXT
);

CREATE TABLE horario_disponible (
    horariodisponibleid SERIAL PRIMARY KEY,
    medicoid UUID NOT NULL REFERENCES medico(medicoid),
    zonahorariaid INTEGER NOT NULL REFERENCES zonas_horarias(zonahorariaid),
    fechainicio TIMESTAMPTZ NOT NULL,
    fechafin TIMESTAMPTZ NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    nota TEXT
);

-- El nombre real utilizado por las rutas y migraciones es cita, en singular.
-- La migracion fase2 normaliza pacienteid y recrea su FK. No documenta el
-- tipo anterior; en una instalacion VACIA se usa INTEGER desde el principio
-- para poder declarar una FK valida hacia paciente.pacienteid (SERIAL).
-- fase2_normalizar_cita_paciente.sql puede ejecutarse igualmente, sin datos.
-- No cargar citas antes: esa migracion rechaza una tabla con filas.
CREATE TABLE cita (
    citaid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pacienteid INTEGER NOT NULL,
    medicoid UUID NOT NULL REFERENCES medico(medicoid),
    tipoconsultaid INTEGER NOT NULL REFERENCES tipos_consulta(tipoconsultaid),
    estadocitaid INTEGER NOT NULL REFERENCES estado_cita(estadocitaid),
    zonahorariaid INTEGER NOT NULL REFERENCES zonas_horarias(zonahorariaid),
    fechahorainicio TIMESTAMPTZ NOT NULL,
    fechahorafin TIMESTAMPTZ NOT NULL,
    duracionmin INTEGER NOT NULL,
    precio NUMERIC(12,2) NOT NULL DEFAULT 0,
    fechacreacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nota TEXT,
    CONSTRAINT cita_pacienteid_fkey FOREIGN KEY (pacienteid)
        REFERENCES paciente(pacienteid) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Unica semilla de Fase 1: IDs de rol usados literalmente por el backend.
-- Sin usuarios, contrasenas, pacientes ni citas de prueba.
INSERT INTO rol (rolid, nombre) VALUES
    (1, 'Paciente'), (2, 'Medico'), (3, 'Administrador');
SELECT setval(pg_get_serial_sequence('rol', 'rolid'), 3, TRUE);

COMMIT;
