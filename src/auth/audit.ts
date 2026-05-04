import { config } from "../../config/index.js";

interface AuditEntry {
  seq: number;
  ts: string;
  category: string;
  event: string;
  [key: string]: unknown;
}

const MAX_ENTRIES = 10_000;
const log: AuditEntry[] = [];
let seq = 0;

function pushEntry(entry: AuditEntry): void {
  log.push(entry);
  if (log.length > MAX_ENTRIES) {
    log.shift();
  }
}

export function audit(category: string, event: string, context: Record<string, unknown> = {}): void {
  try {
    const entry: AuditEntry = {
      seq: ++seq,
      ts: new Date().toISOString(),
      category,
      event,
      ...context,
    };

    pushEntry(entry);

    if (config.app.env !== "test") {
      void import("../events/bus.js")
        .then(({ broadcast }) => broadcast(entry))
        .catch(() => {});
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    }
  } catch {
    // audit() must never throw
  }
}

export const auditAuth = {
  tokenIssued(orgId: string, role: string, serviceId: string | null): void {
    audit("auth", "token_issued", { orgId, role, serviceId });
  },
  tokenVerified(orgId: string, role: string): void {
    audit("auth", "token_verified", { orgId, role });
  },
  tokenFailed(reason: string, ip: string | null): void {
    audit("auth", "token_failed", { reason, ip });
  },
  keyCreated(orgId: string, keyId: string, label: string | null): void {
    audit("auth", "key_created", { orgId, keyId, label });
  },
  keyVerified(orgId: string, keyId: string): void {
    audit("auth", "key_verified", { orgId, keyId });
  },
  keyRotated(orgId: string, oldKeyId: string, newKeyId: string): void {
    audit("auth", "key_rotated", { orgId, oldKeyId, newKeyId });
  },
  keyRevoked(orgId: string, keyId: string, reason: string): void {
    audit("auth", "key_revoked", { orgId, keyId, reason });
  },
  accessDenied(orgId: string, toolName: string, reason: string): void {
    audit("auth", "access_denied", { orgId, toolName, reason });
  },
};

export const auditSession = {
  created(sessionId: string, serviceId: string, initiatorOrgId: string, role: string): void {
    audit("session", "created", { sessionId, serviceId, initiatorOrgId, role });
  },
  activated(sessionId: string, providerOrgId: string | null, consumerOrgId: string | null): void {
    audit("session", "activated", { sessionId, providerOrgId, consumerOrgId });
  },
  completed(sessionId: string): void {
    audit("session", "completed", { sessionId });
  },
  expired(sessionId: string, reason: string): void {
    audit("session", "expired", { sessionId, reason });
  },
};

export const auditTool = {
  called(orgId: string, role: string, toolName: string, sessionId: string | null): void {
    audit("tool", "called", { orgId, role, toolName, sessionId });
  },
  succeeded(orgId: string, toolName: string, durationMs: number): void {
    audit("tool", "succeeded", { orgId, toolName, durationMs });
  },
  failed(orgId: string, toolName: string, errorCode: number, errorMessage: string): void {
    audit("tool", "failed", { orgId, toolName, errorCode, errorMessage });
  },
};

export const auditSchema = {
  published(sessionId: string, schemaId: string, orgId: string, endpointCount: number): void {
    audit("schema", "published", { sessionId, schemaId, orgId, endpointCount });
  },
  discovered(sessionId: string, schemaId: string | null, orgId: string): void {
    audit("schema", "discovered", { sessionId, schemaId, orgId });
  },
  diffed(sessionId: string, changeCount: number): void {
    audit("schema", "diffed", { sessionId, changeCount });
  },
};

export const auditCodegen = {
  started(sessionId: string | null, orgId: string, language: string | null, framework: string | null): void {
    audit("codegen", "started", { sessionId, orgId, language, framework });
  },
  completed(sessionId: string | null, fileCount: number, durationMs: number): void {
    audit("codegen", "completed", { sessionId, fileCount, durationMs });
  },
  failed(sessionId: string | null, reason: string): void {
    audit("codegen", "failed", { sessionId, reason });
  },
};

export function queryAuditLog({ orgId, category, sessionId, limit = 100 }: {
  orgId?: string;
  category?: string;
  sessionId?: string;
  limit?: number;
}): AuditEntry[] {
  return log
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
}

export function auditLogSize(): number {
  return log.length;
}
