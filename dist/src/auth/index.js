import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../../config/index.js";
import { verifyApiKey } from "./api-keys.js";
import { auditAuth } from "./audit.js";
const revokedJtis = new Set();
export class AuthError extends Error {
    code;
    machineCode;
    statusCode;
    constructor(message, options = {}) {
        super(message);
        this.name = "AuthError";
        this.code = -32001;
        this.machineCode = options.machineCode ?? "AUTH_ERROR";
        this.statusCode = options.statusCode ?? 401;
    }
}
export function toolsForRole(role) {
    const shared = ["ping", "get_session_status", "emit_message", "list_registry"];
    const byRole = {
        provider: [...shared, "register_service", "join_session", "publish_schema", "provide_code_sample", "publish_to_registry"],
        consumer: [...shared, "join_session", "discover_schema", "generate_integration", "validate_integration", "discover_from_registry"],
    };
    const tools = byRole[role];
    if (!tools) {
        throw new AuthError("Unknown role", { statusCode: 403, machineCode: "FORBIDDEN" });
    }
    return tools;
}
export function issueOrgToken(orgId, rawApiKey, role, serviceId) {
    const org = config.orgs[orgId];
    if (!org) {
        auditAuth.tokenFailed("unknown_org", null);
        throw new AuthError("Organization not found");
    }
    let keyRecord;
    try {
        keyRecord = verifyApiKey(rawApiKey);
    }
    catch (error) {
        auditAuth.tokenFailed(error.message, null);
        throw error;
    }
    if (keyRecord.orgId !== orgId) {
        auditAuth.tokenFailed("org_key_mismatch", null);
        throw new AuthError("API key does not belong to org");
    }
    if (!org.allowedRoles.includes(role)) {
        auditAuth.tokenFailed("role_not_allowed", null);
        throw new AuthError("Role not allowed for org", { statusCode: 403, machineCode: "FORBIDDEN" });
    }
    const allowedTools = toolsForRole(role);
    const jti = randomBytes(16).toString("hex");
    const token = jwt.sign({
        sub: orgId,
        orgName: org.name,
        role,
        serviceId: serviceId ?? null,
        allowedTools,
        jti,
        keyId: keyRecord.keyId,
    }, config.jwt.secret, {
        expiresIn: config.jwt.orgTokenTtl,
    });
    auditAuth.tokenIssued(orgId, role, serviceId ?? null);
    return token;
}
export function verifyOrgToken(token) {
    if (token == null) {
        auditAuth.tokenFailed("missing_token", null);
        throw new AuthError("Missing org token");
    }
    let claims;
    try {
        claims = jwt.verify(token, config.jwt.secret);
    }
    catch (error) {
        auditAuth.tokenFailed(error.message, null);
        throw new AuthError("Invalid org token");
    }
    if (typeof claims.jti !== "string" || revokedJtis.has(claims.jti)) {
        auditAuth.tokenFailed("revoked_token", null);
        throw new AuthError("Token revoked");
    }
    if (typeof claims.sub !== "string" ||
        typeof claims.orgName !== "string" ||
        (claims.role !== "provider" && claims.role !== "consumer") ||
        !Array.isArray(claims.allowedTools) ||
        typeof claims.keyId !== "string") {
        auditAuth.tokenFailed("malformed_token", null);
        throw new AuthError("Invalid org token");
    }
    auditAuth.tokenVerified(claims.sub, claims.role);
    return {
        orgId: claims.sub,
        orgName: claims.orgName,
        role: claims.role,
        serviceId: typeof claims.serviceId === "string" ? claims.serviceId : null,
        allowedTools: claims.allowedTools.filter((value) => typeof value === "string"),
        jti: claims.jti,
        keyId: claims.keyId,
    };
}
export function assertToolAllowed(claims, toolName) {
    if (!claims.allowedTools.includes(toolName)) {
        auditAuth.accessDenied(claims.orgId, toolName, "tool_not_allowed");
        throw new AuthError(`Tool not allowed: ${toolName}`, {
            statusCode: 403,
            machineCode: "FORBIDDEN",
        });
    }
}
export function revokeToken(jti) {
    revokedJtis.add(jti);
}
