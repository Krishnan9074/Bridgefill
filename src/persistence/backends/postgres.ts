import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { config } from "../../../config/index.js";
import type { ApiKeyRecord, GenerateJobRecord, RegistrySchemaRecord, ServiceEntry, SessionRecord } from "../../types.js";
import type { AuditStoreEntry, InitializedStores } from "../types.js";

const { Pool } = pg;
const currentDir = dirname(fileURLToPath(import.meta.url));

function withoutTimer<T extends { _revokeTimer?: unknown; _expiryTimer?: unknown }>(value: T): Record<string, unknown> {
  const clone = { ...value } as Record<string, unknown>;
  delete clone._revokeTimer;
  delete clone._expiryTimer;
  return clone;
}

async function runMigrations(pool: pg.Pool): Promise<void> {
  const sql = await readFile(join(currentDir, "..", "migrations", "001_initial.sql"), "utf8");
  await pool.query(sql);
}

export async function createPostgresStores({ pgUrl }: { pgUrl?: string | null }): Promise<InitializedStores> {
  if (!pgUrl) {
    throw new Error("DATABASE_URL is required when STORE_BACKEND=postgres");
  }

  const pool = new Pool({
    connectionString: pgUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  await pool.query("SELECT 1");
  await runMigrations(pool);

  const sessionsById = new Map<string, SessionRecord>();
  const sessionIdsByService = new Map<string, string>();
  const servicesById = new Map<string, ServiceEntry>();
  const keysByHash = new Map<string, ApiKeyRecord>();
  const keysById = new Map<string, ApiKeyRecord>();
  const keyIdsByOrg = new Map<string, string[]>();
  const auditLog: AuditStoreEntry[] = [];
  const registryById = new Map<string, RegistrySchemaRecord>();
  const registryIdsByService = new Map<string, string[]>();
  const jobsById = new Map<string, GenerateJobRecord>();
  const jobIdsByOrg = new Map<string, string[]>();

  const [sessionsResult, servicesResult, keysResult, auditResult, registryResult, jobsResult] = await Promise.all([
    pool.query("SELECT id, service_id, data FROM sessions"),
    pool.query("SELECT id, data FROM services"),
    pool.query("SELECT key_id, hash, data FROM api_keys"),
    pool.query("SELECT seq, ts, category, event, data FROM audit_log ORDER BY seq ASC"),
    pool.query("SELECT registry_id, service_id, org_id, version, schema_data, code_samples, changelog, tags, is_latest, published_at FROM registry_schemas ORDER BY published_at ASC"),
    pool.query("SELECT job_id, request_data, result_data, status, org_id, error, created_at, completed_at FROM generation_jobs"),
  ]);

  for (const row of servicesResult.rows) {
    const service = row.data as ServiceEntry;
    servicesById.set(service.id, service);
  }

  for (const row of sessionsResult.rows) {
    const session = { ...(row.data as SessionRecord), _expiryTimer: null } satisfies SessionRecord;
    sessionsById.set(session.id, session);
    sessionIdsByService.set(session.serviceId, session.id);
  }

  for (const row of keysResult.rows) {
    const key = { ...(row.data as ApiKeyRecord), hash: row.hash as string, _revokeTimer: null } satisfies ApiKeyRecord;
    keysByHash.set(key.hash, key);
    keysById.set(key.keyId, key);
    const ids = keyIdsByOrg.get(key.orgId) ?? [];
    ids.push(key.keyId);
    keyIdsByOrg.set(key.orgId, ids);
  }

  for (const row of auditResult.rows) {
    auditLog.push({
      seq: Number(row.seq),
      ts: new Date(row.ts as string | Date).toISOString(),
      category: row.category as string,
      event: row.event as string,
      ...((row.data as Record<string, unknown>) ?? {}),
    });
  }

  for (const row of registryResult.rows) {
    const service = servicesById.get(row.service_id as string);
    const orgName = config.orgs[row.org_id as string]?.name ?? String(row.org_id);
    const record: RegistrySchemaRecord = {
      registryId: row.registry_id as string,
      serviceId: row.service_id as string,
      serviceName: service?.name ?? String(row.service_id),
      orgId: row.org_id as string,
      orgName,
      version: row.version as string,
      schema: row.schema_data as RegistrySchemaRecord["schema"],
      codeSamples: (row.code_samples as RegistrySchemaRecord["codeSamples"]) ?? [],
      changelog: (row.changelog as string | null) ?? "",
      tags: (row.tags as string[] | null) ?? [],
      isLatest: Boolean(row.is_latest),
      publishedAt: new Date(row.published_at as string | Date).toISOString(),
    };
    registryById.set(record.registryId, record);
    const ids = registryIdsByService.get(record.serviceId) ?? [];
    ids.push(record.registryId);
    registryIdsByService.set(record.serviceId, ids);
  }

  for (const row of jobsResult.rows) {
    const job: GenerateJobRecord = {
      jobId: row.job_id as string,
      status: row.status as GenerateJobRecord["status"],
      orgId: row.org_id as string,
      request: row.request_data as GenerateJobRecord["request"],
      result: (row.result_data as GenerateJobRecord["result"]) ?? null,
      error: (row.error as string | null) ?? null,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as string | Date).toISOString() : null,
    };
    jobsById.set(job.jobId, job);
    const ids = jobIdsByOrg.get(job.orgId) ?? [];
    ids.push(job.jobId);
    jobIdsByOrg.set(job.orgId, ids);
  }

  async function pingMeta() {
    const startedAt = Date.now();
    await pool.query("SELECT 1");
    return {
      backend: "postgres" as const,
      dbConnected: true,
      dbLatencyMs: Date.now() - startedAt,
    };
  }

  return {
    sessions: {
      get(id) {
        return sessionsById.get(id) ?? null;
      },
      async set(id, data) {
        sessionsById.set(id, data);
        await pool.query(
          `INSERT INTO sessions (id, service_id, status, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, NOW())
           ON CONFLICT (id) DO UPDATE SET
             service_id = EXCLUDED.service_id,
             status = EXCLUDED.status,
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [id, data.serviceId, data.status, JSON.stringify(withoutTimer(data)), data.createdAt],
        );
      },
      async del(id) {
        const current = sessionsById.get(id);
        if (current && sessionIdsByService.get(current.serviceId) === id) {
          sessionIdsByService.delete(current.serviceId);
        }
        sessionsById.delete(id);
        await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
      },
      getByServiceId(serviceId) {
        const sessionId = sessionIdsByService.get(serviceId);
        return sessionId ? sessionsById.get(sessionId) ?? null : null;
      },
      async indexByServiceId(serviceId, sessionId) {
        if (sessionId) {
          sessionIdsByService.set(serviceId, sessionId);
        } else {
          sessionIdsByService.delete(serviceId);
        }
      },
      list() {
        return Array.from(sessionsById.values());
      },
    },
    services: {
      get(id) {
        return servicesById.get(id) ?? null;
      },
      async set(id, data) {
        servicesById.set(id, data);
        await pool.query(
          `INSERT INTO services (id, provider_org_id, name, data, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
           ON CONFLICT (id) DO UPDATE SET
             provider_org_id = EXCLUDED.provider_org_id,
             name = EXCLUDED.name,
             data = EXCLUDED.data`,
          [id, data.providerOrgId, data.name, JSON.stringify(data), data.registeredAt],
        );
      },
      list() {
        return Array.from(servicesById.values());
      },
      has(id) {
        return servicesById.has(id);
      },
    },
    keys: {
      getByHash(hash) {
        return keysByHash.get(hash) ?? null;
      },
      getByKeyId(keyId) {
        return keysById.get(keyId) ?? null;
      },
      listByOrg(orgId) {
        return (keyIdsByOrg.get(orgId) ?? []).map((keyId) => keysById.get(keyId)).filter((record): record is ApiKeyRecord => !!record);
      },
      async save(record) {
        keysByHash.set(record.hash, record);
        keysById.set(record.keyId, record);
        const ids = keyIdsByOrg.get(record.orgId) ?? [];
        if (!ids.includes(record.keyId)) {
          ids.push(record.keyId);
          keyIdsByOrg.set(record.orgId, ids);
        }
        await pool.query(
          `INSERT INTO api_keys (key_id, org_id, hash, status, label, expires_at, last_used_at, data)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb)
           ON CONFLICT (key_id) DO UPDATE SET
             org_id = EXCLUDED.org_id,
             hash = EXCLUDED.hash,
             status = EXCLUDED.status,
             label = EXCLUDED.label,
             expires_at = EXCLUDED.expires_at,
             last_used_at = EXCLUDED.last_used_at,
             data = EXCLUDED.data`,
          [
            record.keyId,
            record.orgId,
            record.hash,
            record.status,
            record.label,
            record.expiresAt,
            record.lastUsedAt,
            JSON.stringify(withoutTimer(record)),
          ],
        );
      },
      async update(keyId, updates) {
        const current = keysById.get(keyId);
        if (!current) {
          return null;
        }
        if (updates.hash && updates.hash !== current.hash) {
          keysByHash.delete(current.hash);
        }
        const next = { ...current, ...updates };
        keysByHash.set(next.hash, next);
        keysById.set(next.keyId, next);
        await this.save(next);
        return next;
      },
    },
    audit: {
      async append(entry) {
        auditLog.push(entry);
        if (auditLog.length > 10_000) {
          auditLog.shift();
        }
        await pool.query(
          `INSERT INTO audit_log (seq, ts, category, event, org_id, session_id, data)
           VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::jsonb)`,
          [
            entry.seq,
            entry.ts,
            entry.category,
            entry.event,
            (entry.orgId as string | undefined) ?? (entry.initiatorOrgId as string | undefined) ?? null,
            (entry.sessionId as string | undefined) ?? null,
            JSON.stringify({ ...entry, seq: undefined, ts: undefined, category: undefined, event: undefined }),
          ],
        );
      },
      query({ orgId, category, sessionId, limit = 100 }) {
        return auditLog
          .filter((entry) => {
            if (orgId && entry.orgId !== orgId && entry.initiatorOrgId !== orgId) {
              return false;
            }
            if (category && entry.category !== category) {
              return false;
            }
            if (sessionId && entry.sessionId !== sessionId) {
              return false;
            }
            return true;
          })
          .slice(-limit)
          .reverse();
      },
      count() {
        return auditLog.length;
      },
    },
    registry: {
      async save(record) {
        registryById.set(record.registryId, record);
        const ids = registryIdsByService.get(record.serviceId) ?? [];
        if (!ids.includes(record.registryId)) {
          ids.push(record.registryId);
          registryIdsByService.set(record.serviceId, ids);
        }
        await pool.query(
          `INSERT INTO registry_schemas (registry_id, service_id, org_id, version, schema_data, code_samples, changelog, tags, is_latest, published_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::text[], $9, $10::timestamptz)
           ON CONFLICT (registry_id) DO UPDATE SET
             service_id = EXCLUDED.service_id,
             org_id = EXCLUDED.org_id,
             version = EXCLUDED.version,
             schema_data = EXCLUDED.schema_data,
             code_samples = EXCLUDED.code_samples,
             changelog = EXCLUDED.changelog,
             tags = EXCLUDED.tags,
             is_latest = EXCLUDED.is_latest,
             published_at = EXCLUDED.published_at`,
          [
            record.registryId,
            record.serviceId,
            record.orgId,
            record.version,
            JSON.stringify(record.schema),
            JSON.stringify(record.codeSamples),
            record.changelog,
            record.tags,
            record.isLatest,
            record.publishedAt,
          ],
        );
      },
      getById(registryId) {
        return registryById.get(registryId) ?? null;
      },
      getLatest(serviceId) {
        return (registryIdsByService.get(serviceId) ?? [])
          .map((id) => registryById.get(id))
          .filter((record): record is RegistrySchemaRecord => !!record)
          .find((record) => record.isLatest) ?? null;
      },
      getHistory(serviceId) {
        return (registryIdsByService.get(serviceId) ?? [])
          .map((id) => registryById.get(id))
          .filter((record): record is RegistrySchemaRecord => !!record)
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      },
      list({ orgId, tags, q, limit = 20 }) {
        const normalizedTags = (tags ?? []).map((tag) => tag.toLowerCase());
        const query = q?.toLowerCase().trim();
        return Array.from(registryById.values())
          .filter((entry) => entry.isLatest)
          .filter((entry) => {
            if (orgId && entry.orgId !== orgId) {
              return false;
            }
            if (normalizedTags.length && !normalizedTags.every((tag) => entry.tags.some((entryTag) => entryTag.toLowerCase() === tag))) {
              return false;
            }
            if (query) {
              const haystack = [entry.serviceName, entry.orgName, entry.serviceId, entry.version, ...entry.tags].join(" ").toLowerCase();
              if (!haystack.includes(query)) {
                return false;
              }
            }
            return true;
          })
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
          .slice(0, limit);
      },
      async markNotLatest(serviceId) {
        for (const record of this.getHistory(serviceId)) {
          record.isLatest = false;
        }
        await pool.query("UPDATE registry_schemas SET is_latest = FALSE WHERE service_id = $1", [serviceId]);
      },
    },
    jobs: {
      get(jobId) {
        return jobsById.get(jobId) ?? null;
      },
      async set(jobId, data) {
        jobsById.set(jobId, data);
        const ids = jobIdsByOrg.get(data.orgId) ?? [];
        if (!ids.includes(jobId)) {
          ids.push(jobId);
          jobIdsByOrg.set(data.orgId, ids);
        }
        await pool.query(
          `INSERT INTO generation_jobs (job_id, status, org_id, request_data, result_data, error, created_at, completed_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::timestamptz, $8::timestamptz)
           ON CONFLICT (job_id) DO UPDATE SET
             status = EXCLUDED.status,
             org_id = EXCLUDED.org_id,
             request_data = EXCLUDED.request_data,
             result_data = EXCLUDED.result_data,
             error = EXCLUDED.error,
             created_at = EXCLUDED.created_at,
             completed_at = EXCLUDED.completed_at`,
          [
            jobId,
            data.status,
            data.orgId,
            JSON.stringify(data.request),
            data.result ? JSON.stringify(data.result) : null,
            data.error,
            data.createdAt,
            data.completedAt,
          ],
        );
      },
      listByOrg(orgId) {
        return (jobIdsByOrg.get(orgId) ?? []).map((jobId) => jobsById.get(jobId)).filter((record): record is GenerateJobRecord => !!record);
      },
    },
    meta: {
      backend: "postgres",
      dbConnected: true,
      dbLatencyMs: 0,
    },
    async ping() {
      return pingMeta();
    },
    async close() {
      await pool.end();
    },
  };
}
