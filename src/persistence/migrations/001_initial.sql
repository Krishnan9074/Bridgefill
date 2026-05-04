CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_service_id ON sessions(service_id);
CREATE INDEX IF NOT EXISTS sessions_status     ON sessions(status);

CREATE TABLE IF NOT EXISTS services (
  id              TEXT PRIMARY KEY,
  provider_org_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',
  label        TEXT,
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  data         JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS api_keys_org_id ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS api_keys_hash   ON api_keys(hash);

CREATE TABLE IF NOT EXISTS audit_log (
  seq        BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category   TEXT NOT NULL,
  event      TEXT NOT NULL,
  org_id     TEXT,
  session_id TEXT,
  data       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_ts         ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_org_id     ON audit_log(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_session_id ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS audit_category   ON audit_log(category, ts DESC);

CREATE TABLE IF NOT EXISTS registry_schemas (
  registry_id  TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  version      TEXT NOT NULL,
  schema_data  JSONB NOT NULL,
  code_samples JSONB NOT NULL DEFAULT '[]',
  changelog    TEXT,
  tags         TEXT[] DEFAULT '{}',
  is_latest    BOOLEAN NOT NULL DEFAULT TRUE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_id, version)
);
CREATE INDEX IF NOT EXISTS registry_service_id ON registry_schemas(service_id, published_at DESC);
CREATE INDEX IF NOT EXISTS registry_org_id     ON registry_schemas(org_id);
CREATE INDEX IF NOT EXISTS registry_is_latest  ON registry_schemas(service_id) WHERE is_latest = TRUE;

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id       TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending',
  org_id       TEXT NOT NULL,
  request_data JSONB NOT NULL,
  result_data  JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_org_id ON generation_jobs(org_id, created_at DESC);
