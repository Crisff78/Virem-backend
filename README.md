# Virem Backend

Backend en Node.js + Express para autenticación y validación de teléfonos.

## Requisitos
- Node.js 18+
- PostgreSQL 13+

## Configuración
1. Copia el archivo de ejemplo de entorno:
   ```bash
   cp .env.example .env
   ```
2. Completa las variables en `.env`.
3. Crea las tablas con el script SQL:
   ```bash
   psql -U <usuario> -d <basededatos> -f db/schema.sql
   ```

## Ejecutar
```bash
npm install
npm run dev
```

## Endpoints
### Salud
- `GET /health`

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me` (requiere JWT)

### Teléfono
- `POST /api/phone/validar-telefono`

## Notas de seguridad
- Usa `JWT_SECRET` fuerte.
- Ajusta `RATE_LIMIT_WINDOW_MS` y `RATE_LIMIT_MAX` según necesidad.