CREATE TABLE IF NOT EXISTS usuario_perfil (
  usuarioid TEXT PRIMARY KEY,
  foto_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuario_perfil_updated_at
  ON usuario_perfil (updated_at DESC);
