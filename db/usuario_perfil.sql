CREATE TABLE IF NOT EXISTS usuario_perfil (
  usuarioid TEXT PRIMARY KEY,
  foto_url TEXT,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE usuario_perfil
  ADD COLUMN IF NOT EXISTS foto_url TEXT;

ALTER TABLE usuario_perfil
  ALTER COLUMN foto_url TYPE TEXT;

ALTER TABLE usuario_perfil
  ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_usuario_perfil_updated_at
  ON usuario_perfil (updated_at DESC);
