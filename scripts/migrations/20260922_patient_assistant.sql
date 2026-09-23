-- Patient-owned assistant data. No connection to professional clinical records.
CREATE TABLE assistant_conversation (
  id UUID PRIMARY KEY,
  usuarioid INTEGER NOT NULL UNIQUE REFERENCES usuario(usuarioid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);
CREATE TABLE assistant_document (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES assistant_conversation(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BYTEA,
  status TEXT NOT NULL CHECK (status IN ('reading','ready','error')),
  extraction JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX assistant_document_conversation ON assistant_document(conversation_id);
CREATE TABLE assistant_message (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES assistant_conversation(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  document_ids JSONB NOT NULL DEFAULT '[]',
  answer JSONB,
  partial TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('running','completed','stopped','error')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, request_id)
);
CREATE INDEX assistant_message_thread ON assistant_message(conversation_id, created_at);
CREATE UNIQUE INDEX assistant_one_generation ON assistant_message(conversation_id) WHERE status = 'running';
CREATE TABLE assistant_usage (
  usuarioid INTEGER NOT NULL REFERENCES usuario(usuarioid) ON DELETE CASCADE,
  day DATE NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  documents INTEGER NOT NULL DEFAULT 0,
  transcriptions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (usuarioid, day)
);

-- These tables are accessed only by the Express database role. Supabase's
-- default grants must not expose clinical content through its public REST API.
ALTER TABLE public.assistant_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.assistant_conversation, public.assistant_document,
  public.assistant_message, public.assistant_usage FROM PUBLIC;
DO $$
DECLARE access_grant RECORD;
BEGIN
  FOR access_grant IN
    SELECT DISTINCT table_schema, table_name, grantee
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('assistant_conversation', 'assistant_document', 'assistant_message', 'assistant_usage')
      AND grantee NOT IN ('PUBLIC', current_user)
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',
      access_grant.table_schema, access_grant.table_name, access_grant.grantee);
  END LOOP;
END $$;
