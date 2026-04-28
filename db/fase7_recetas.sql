CREATE TABLE IF NOT EXISTS receta_medica (
  recetaid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citaid UUID NOT NULL,
  pacienteid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
  medicoid_text TEXT NOT NULL,
  diagnostico TEXT NOT NULL,
  medicamentos_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  instrucciones TEXT,
  url_pdf TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receta_medica_paciente ON receta_medica (pacienteid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_receta_medica_medico ON receta_medica (medicoid_text, created_at DESC);

