import { config } from "../../config/index.js";
const MAX_ENTRIES = 10_000;
const log = [];
let seq = 0;
function pushEntry(entry) {
    log.push(entry);
    if (log.length > MAX_ENTRIES) {
        log.shift();
    }
}
export function audit(category, event, context = {}) {
    try {
        const entry = {
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
export function auditLogSize() {
    return log.length;
}
