import { config } from "../../config/index.js";
import { getStores } from "../persistence/index.js";
let seq = 0;
export function audit(category, event, context = {}) {
    try {
        const entry = {
            seq: ++seq,
            ts: new Date().toISOString(),
            category,
            event,
            ...context,
        };
        const stores = getStores();
        const knownSeq = stores.audit.query({ limit: 1 })[0]?.seq ?? 0;
        if (seq < knownSeq) {
            seq = knownSeq;
            entry.seq = ++seq;
        }
        void stores.audit.append(entry);
        if (config.app.env !== "test") {
            void import("../events/bus.js")
                .then(({ broadcast }) => broadcast(entry))
                .catch(() => { });
            process.stderr.write(`${JSON.stringify(entry)}\n`);
        }
    }
    catch {
        // audit() must never throw
    }
}
export const auditAuth = {
    tokenIssued(orgId, role, serviceId) {
        audit("auth", "token_issued", { orgId, role, serviceId });
    },
    tokenVerified(orgId, role) {
        audit("auth", "token_verified", { orgId, role });
    },
    tokenFailed(reason, ip) {
        audit("auth", "token_failed", { reason, ip });
    },
    keyCreated(orgId, keyId, label) {
        audit("auth", "key_created", { orgId, keyId, label });
    },
    keyVerified(orgId, keyId) {
        audit("auth", "key_verified", { orgId, keyId });
    },
    keyRotated(orgId, oldKeyId, newKeyId) {
        audit("auth", "key_rotated", { orgId, oldKeyId, newKeyId });
    },
    keyRevoked(orgId, keyId, reason) {
        audit("auth", "key_revoked", { orgId, keyId, reason });
    },
    accessDenied(orgId, toolName, reason) {
        audit("auth", "access_denied", { orgId, toolName, reason });
    },
};
export const auditSession = {
    created(sessionId, serviceId, initiatorOrgId, role) {
        audit("session", "created", { sessionId, serviceId, initiatorOrgId, role });
    },
    activated(sessionId, providerOrgId, consumerOrgId) {
        audit("session", "activated", { sessionId, providerOrgId, consumerOrgId });
    },
    completed(sessionId) {
        audit("session", "completed", { sessionId });
    },
    expired(sessionId, reason) {
        audit("session", "expired", { sessionId, reason });
    },
};
export const auditTool = {
    called(orgId, role, toolName, sessionId) {
        audit("tool", "called", { orgId, role, toolName, sessionId });
    },
    succeeded(orgId, toolName, durationMs) {
        audit("tool", "succeeded", { orgId, toolName, durationMs });
    },
    failed(orgId, toolName, errorCode, errorMessage) {
        audit("tool", "failed", { orgId, toolName, errorCode, errorMessage });
    },
};
export const auditSchema = {
    published(sessionId, schemaId, orgId, endpointCount) {
        audit("schema", "published", { sessionId, schemaId, orgId, endpointCount });
    },
    discovered(sessionId, schemaId, orgId) {
        audit("schema", "discovered", { sessionId, schemaId, orgId });
    },
    diffed(sessionId, changeCount) {
        audit("schema", "diffed", { sessionId, changeCount });
    },
};
export const auditCodegen = {
    started(sessionId, orgId, language, framework) {
        audit("codegen", "started", { sessionId, orgId, language, framework });
    },
    completed(sessionId, fileCount, durationMs) {
        audit("codegen", "completed", { sessionId, fileCount, durationMs });
    },
    failed(sessionId, reason) {
        audit("codegen", "failed", { sessionId, reason });
    },
};
export function queryAuditLog({ orgId, category, sessionId, limit = 100 }) {
    return getStores().audit.query({ orgId, category, sessionId, limit });
}
export function auditLogSize() {
    return getStores().audit.count();
}
