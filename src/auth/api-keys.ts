import { createHash, randomBytes, randomUUID } from "node:crypto";

import { config } from "../../config/index.js";
import { getStores } from "../persistence/index.js";
import type { ApiKeyRecord } from "../types.js";
import { auditAuth } from "./audit.js";

type PublicApiKeyRecord = Omit<ApiKeyRecord, "hash" | "_revokeTimer">;

export class ApiKeyError extends Error {
  code: number;
  machineCode: string;
  statusCode: number;

  constructor(message: string, options: { machineCode?: string; statusCode?: number } = {}) {
    super(message);
    this.name = "ApiKeyError";
    this.code = -32001;
    this.machineCode = options.machineCode ?? "AUTH_ERROR";
    this.statusCode = options.statusCode ?? 401;
  }
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function copyPublicRecord(record: ApiKeyRecord): PublicApiKeyRecord {
  const { hash, _revokeTimer, ...publicRecord } = record;
  return { ...publicRecord };
}

function saveRecord(record: ApiKeyRecord): void {
  void getStores().keys.save(record);
}

function buildRecord(orgId: string, { rawKey, label = null, ttlDays = null, status = "active" }: {
  rawKey: string;
  label?: string | null;
  ttlDays?: number | null;
  status?: "active" | "rotating" | "revoked";
}): ApiKeyRecord {
  const now = Date.now();
  const expiresAt = typeof ttlDays === "number"
    ? new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  return {
    keyId: `key_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    orgId,
    hash: hashKey(rawKey),
    label,
    status,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt,
    lastUsedAt: null,
    rotatedFromKeyId: null,
    replacementKeyId: null,
    _revokeTimer: null,
  };
}

function generateRawKey(orgId: string): string {
  return `bf_${orgId}_${randomBytes(24).toString("hex")}`;
}

export async function createApiKey(orgId: string, { label = null, ttlDays = null }: { label?: string | null; ttlDays?: number | null } = {}): Promise<{
  rawKey: string;
  record: PublicApiKeyRecord;
}> {
  if (!config.orgs[orgId]) {
    throw new ApiKeyError("Organization not found", { statusCode: 404, machineCode: "NOT_FOUND" });
  }
  const rawKey = generateRawKey(orgId);
  const record = buildRecord(orgId, { rawKey, label, ttlDays });
  await getStores().keys.save(record);
  return { rawKey, record: copyPublicRecord(record) };
}

export function verifyApiKey(rawKey: string): ApiKeyRecord {
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw new ApiKeyError("Invalid API key");
  }

  const record = getStores().keys.getByHash(hashKey(rawKey));
  if (!record) {
    throw new ApiKeyError("Invalid API key");
  }
  if (record.status === "revoked") {
    throw new ApiKeyError("API key revoked");
  }
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    throw new ApiKeyError("API key expired");
  }

  record.lastUsedAt = new Date().toISOString();
  record.updatedAt = record.lastUsedAt;
  void getStores().keys.update(record.keyId, {
    lastUsedAt: record.lastUsedAt,
    updatedAt: record.updatedAt,
  });
  auditAuth.keyVerified(record.orgId, record.keyId);
  return record;
}

export async function rotateKey(keyId: string, { gracePeriodMs = 60_000 }: { gracePeriodMs?: number } = {}): Promise<{
  rawKey: string;
  newRecord: PublicApiKeyRecord;
  oldRecord: PublicApiKeyRecord;
}> {
  const oldRecord = getStores().keys.getByKeyId(keyId);
  if (!oldRecord) {
    throw new ApiKeyError("API key not found", { statusCode: 404, machineCode: "NOT_FOUND" });
  }
  if (oldRecord.status === "revoked") {
    throw new ApiKeyError("API key already revoked");
  }

  const rawKey = generateRawKey(oldRecord.orgId);
  const newRecord = buildRecord(oldRecord.orgId, {
    rawKey,
    label: oldRecord.label,
    ttlDays: oldRecord.expiresAt
      ? Math.max(0, Math.ceil((Date.parse(oldRecord.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)))
      : null,
  });

  oldRecord.status = "rotating";
  oldRecord.updatedAt = new Date().toISOString();
  oldRecord.replacementKeyId = newRecord.keyId;
  newRecord.rotatedFromKeyId = oldRecord.keyId;

  if (oldRecord._revokeTimer) {
    clearTimeout(oldRecord._revokeTimer);
  }

  oldRecord._revokeTimer = setTimeout(() => {
    oldRecord.status = "revoked";
    oldRecord.updatedAt = new Date().toISOString();
    oldRecord._revokeTimer = null;
  }, gracePeriodMs);
  if (typeof oldRecord._revokeTimer.unref === "function") {
    oldRecord._revokeTimer.unref();
  }

  await getStores().keys.save(oldRecord);
  await getStores().keys.save(newRecord);

  return {
    rawKey,
    newRecord: copyPublicRecord(newRecord),
    oldRecord: copyPublicRecord(oldRecord),
  };
}

export async function revokeKey(keyId: string): Promise<PublicApiKeyRecord> {
  const record = getStores().keys.getByKeyId(keyId);
  if (!record) {
    throw new ApiKeyError("API key not found", { statusCode: 404, machineCode: "NOT_FOUND" });
  }
  if (record._revokeTimer) {
    clearTimeout(record._revokeTimer);
    record._revokeTimer = null;
  }
  record.status = "revoked";
  record.updatedAt = new Date().toISOString();
  await getStores().keys.save(record);
  return copyPublicRecord(record);
}

export function listOrgKeys(orgId: string): PublicApiKeyRecord[] {
  return getStores().keys.listByOrg(orgId).map(copyPublicRecord);
}

export async function seedDevKey(orgId: string, rawKey: string): Promise<PublicApiKeyRecord> {
  const hash = hashKey(rawKey);
  const existing = getStores().keys.getByHash(hash);
  if (existing) {
    return copyPublicRecord(existing);
  }

  const record = buildRecord(orgId, {
    rawKey,
    label: "seeded-dev-key",
    ttlDays: null,
  });
  record.hash = hash;
  await getStores().keys.save(record);
  return copyPublicRecord(record);
}

export async function ensureSeededKeys(): Promise<void> {
  for (const [orgId, org] of Object.entries(config.orgs)) {
    if (org.secret) {
      await seedDevKey(orgId, org.secret);
    }
  }
}
