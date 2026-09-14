# Migración 2A

Esta migración traslada el esquema y las correcciones de datos que antes ejecutaban
los servicios durante el arranque y las peticiones. Incluye perfiles, recetas,
agenda, registro, recuperación de contraseña y MFA. Presupone las tablas base de
la instalación actual de VIREM; no sustituye el aprovisionamiento inicial de una BD vacía.

Desde `backend`, antes de iniciar la nueva versión:

```powershell
node scripts/migrations.js
node --test verify-performance-2a.js
node index.js
```

El migrador carga `backend/.env`. Usa `MIGRATION_DATABASE_URL` si está configurada;
en caso contrario usa `DATABASE_URL` o las variables `DB_*`, incluido `DB_SSL`.
La cuenta de migración necesita permisos DDL. La cuenta de la aplicación puede
limitarse a las operaciones de datos y lectura de `schema_migrations`.

La ejecución se serializa mediante un bloqueo asesor de PostgreSQL y registra
versión y checksum dentro de la misma transacción que el esquema. Un error revierte
la transacción. Esperar bloqueos más de cinco segundos o ejecutar una sentencia más
de dos minutos produce un error; planifica una ventana de despliegue si hay tráfico.
Los ALTER e índices conservados pueden bloquear tablas durante esa ventana.

Una versión aplicada no se repite. Para cambios posteriores, añade otra migración;
no edites el SQL ya aplicado. El backend comprueba la versión antes de escuchar HTTP
y no intenta crear tablas si falta. Los scripts históricos de `db/` siguen siendo
herramientas explícitas de administración, no se invocan desde el servidor.

La prueba rápida usa HTTP real contra un servidor aislado y las rutas actuales,
con autenticación sintética y acceso a BD prohibido. Verifica HTTP 400 y cero consultas
para `daysCount: 99999`, además de otros valores inválidos; no mide carga de producción.
