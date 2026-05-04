import { createHash, randomBytes, randomUUID } from "node:crypto";

import { config } from "../../config/index.js";
import type { ApiKeyRecord } from "../types.js";
import { auditAuth } from "./audit.js";

const byHash = new Map<string, ApiKeyRecord>();
const byOrg = new Map<string, ApiKeyRecord[]>();
const byKeyId = new Map<string, ApiKeyRecord>();

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
  byHash.set(record.hash, record);
  byKeyId.set(record.keyId, record);

  const orgRecords = byOrg.get(record.orgId) ?? [];
  const existingIndex = orgRecords.findIndex((item) => item.keyId === record.keyId);
  if (existingIndex >= 0) {
    orgRecords[existingIndex] = record;
  } else {
    orgRecords.push(record);
  }
  byOrg.set(record.orgId, orgRecords);
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

export function createApiKey(orgId: string, { label = null, ttlDays = null }: { label?: string | null; ttlDays?: number | null } = {}): {
  rawKey: string;
  record: PublicApiKeyRecord;
} {
  if (!config.orgs[orgId]) {
    throw new ApiKeyError("Organization not found", { statusCode: 404, machineCode: "NOT_FOUND" });
  }
  const rawKey = generateRawKey(orgId);
  const record = buildRecord(orgId, { rawKey, label, ttlDays });
  saveRecord(record);
  return { rawKey, record: copyPublicRecord(record) };
}

export function verifyApiKey(rawKey: string): ApiKeyRecord {
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw new ApiKeyError("Invalid API key");
  }

  const record = byHash.get(hashKey(rawKey));
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
  auditAuth.keyVerified(record.orgId, record.keyId);
  return record;
}

export function rotateKey(keyId: string, { gracePeriodMs = 60_000 }: { gracePeriodMs?: number } = {}): {
  rawKey: string;
  newRecord: PublicApiKeyRecord;
  oldRecord: PublicApiKeyRecord;
} {
  const oldRecord = byKeyId.get(keyId);
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

  saveRecord(oldRecord);
  saveRecord(newRecord);

  return {
    rawKey,
    newRecord: copyPublicRecord(newRecord),
    oldRecord: copyPublicRecord(oldRecord),
  };
}

export function revokeKey(keyId: string): PublicApiKeyRecord {
  const record = byKeyId.get(keyId);
  if (!record) {
    throw new ApiKeyError("API key not found", { statusCode: 404, machineCode: "NOT_FOUND" });
  }
  if (record._revokeTimer) {
    clearTimeout(record._revokeTimer);
    record._revokeTimer = null;
  }
  record.status = "revoked";
  record.updatedAt = new Date().toISOString();
  return copyPublicRecord(record);
}

export function listOrgKeys(orgId: string): PublicApiKeyRecord[] {
  return (byOrg.get(orgId) ?? []).map(copyPublicRecord);
}

export function seedDevKey(orgId: string, rawKey: string): PublicApiKeyRecord {
  const hash = hashKey(rawKey);
  if (byHash.has(hash)) {
    return copyPublicRecord(byHash.get(hash)!);
  }

  const record = buildRecord(orgId, {
    rawKey,
    label: "seeded-dev-key",
    ttlDays: null,
  });
  record.hash = hash;
  saveRecord(record);
  return copyPublicRecord(record);
}

for (const [orgId, org] of Object.entries(config.orgs)) {
  if (org.secret) {
    seedDevKey(orgId, org.secret);
  }
}
