import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { assertToolAllowed, verifyOrgToken } from "../auth/index.js";
import { auditCodegen, auditSchema, auditSession, auditTool } from "../auth/audit.js";
import { diff, bumpVersion } from "../schema/negotiation.js";
import { appendMessage, attachGeneratedCode, attachSchema, getSession, getSessionInternal, joinSession as storeJoinSession, } from "../session/store.js";
import { getService, registerInRegistry } from "./service-registry.js";
export class ValidationError extends Error {
    code;
    machineCode;
    statusCode;
    constructor(message) {
        super(message);
        this.name = "ValidationError";
        this.code = -32003;
        this.machineCode = "VALIDATION_ERROR";
        this.statusCode = 400;
    }
}
function toolFailure(toolName, orgId, error) {
    const err = error;
    auditTool.failed(orgId, toolName, err.code ?? -32000, err.message ?? "Internal error");
    throw error;
}
async function withAuthedTool(args, toolName, executor) {
    const claims = verifyOrgToken(args.org_token);
    assertToolAllowed(claims, toolName);
    const sessionId = args.session_id ?? null;
    const startedAt = Date.now();
    auditTool.called(claims.orgId, claims.role, toolName, sessionId);
    try {
        const result = await executor(claims);
        auditTool.succeeded(claims.orgId, toolName, Date.now() - startedAt);
        return result;
    }
    catch (error) {
        return toolFailure(toolName, claims.orgId, error);
    }
}
function assertSessionActive(session) {
    if (session.status !== "active") {
        throw new ValidationError("Session must be active");
    }
}
function normaliseSchema(raw) {
    return {
        base_url: raw.base_url,
        auth: {
            type: raw.auth?.type ?? "none",
            location: raw.auth?.location ?? null,
            key_name: raw.auth?.key_name ?? null,
        },
        endpoints: (raw.endpoints ?? []).map((endpoint) => {
            const allParams = (endpoint.parameters ?? []).map((param) => ({
                name: param.name,
                in: param.in,
                required: !!param.required,
                description: param.description ?? "",
                schema: param.schema ?? {},
            }));
            return {
                path: endpoint.path,
                method: endpoint.method,
                summary: endpoint.summary ?? "",
                required_params: allParams.filter((param) => param.required),
                optional_params: allParams.filter((param) => !param.required),
                all_params: allParams,
                response_schema: endpoint.response_schema ?? {},
            };
        }),
        rate_limits: raw.rate_limits ?? {},
        sdk_languages: raw.sdk_languages ?? [],
        normalised_at: new Date().toISOString(),
    };
}
export async function ping({ echo } = {}) {
    return {
        status: "ok",
        serverTime: new Date().toISOString(),
        protocolVersion: config.mcp.protocolVersion,
        serverVersion: config.mcp.serverVersion,
        ...(echo !== undefined ? { echo } : {}),
    };
}
export async function registerService(args) {
    return withAuthedTool(args, "register_service", async (claims) => {
        const serviceId = `svc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const service = {
            id: serviceId,
            name: args.service_name,
            description: args.service_description,
            version: args.service_version ?? "1.0.0",
            tags: args.tags ?? [],
            providerOrgId: claims.orgId,
            providerOrgName: claims.orgName,
            registeredAt: new Date().toISOString(),
        };
        registerInRegistry(serviceId, service);
        return {
            service_id: serviceId,
            message: `Service "${args.service_name}" registered.`,
            service,
        };
    });
}
export async function joinSession(args) {
    return withAuthedTool(args, "join_session", async (claims) => {
        const service = getService(args.service_id);
        if (!service) {
            throw new ValidationError("Service not found");
        }
        const session = storeJoinSession(args.service_id, claims);
        const participantCount = Object.values(session.participants).filter(Boolean).length;
        if (participantCount === 1) {
            auditSession.created(session.id, args.service_id, claims.orgId, claims.role);
        }
        if (session.status === "active") {
            auditSession.activated(session.id, session.participants.provider?.orgId ?? null, session.participants.consumer?.orgId ?? null);
        }
        return {
            session_id: session.id,
            status: session.status,
            role: claims.role,
            allowed_tools: claims.allowedTools,
            participants: session.participants,
            message: session.status === "active" ? "Session active." : "Session pending.",
        };
    });
}
export async function getSessionStatus(args) {
    return withAuthedTool(args, "get_session_status", async (claims) => {
        if (!args.session_id) {
            throw new ValidationError("session_id is required");
        }
        const session = getSession(args.session_id, claims.orgId);
        return {
            session_id: session.id,
            service_id: session.serviceId,
            status: session.status,
            participants: session.participants,
            schema: session.schema,
            generated_code: session.generatedCode,
            messages: session.messages.slice(-5),
        };
    });
}
export async function publishSchema(args) {
    return withAuthedTool(args, "publish_schema", async (claims) => {
        const session = getSession(args.session_id, claims.orgId);
        assertSessionActive(session);
        const schema = args.schema ?? {};
        if (!schema.base_url) {
            throw new ValidationError("schema.base_url is required");
        }
        if (!schema.auth?.type) {
            throw new ValidationError("schema.auth.type is required");
        }
        if (!Array.isArray(schema.endpoints) || schema.endpoints.length === 0) {
            throw new ValidationError("schema.endpoints must be a non-empty array");
        }
        const schemaId = `schema_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const normalised = normaliseSchema(schema);
        const previousNormalised = session.schema?.normalised ?? null;
        const schemaDiff = previousNormalised ? diff(previousNormalised, normalised) : null;
        const history = session.schemaHistory ?? [];
        const { version, history: newHistory } = bumpVersion(history, normalised, schemaDiff);
        normalised.version = version;
        attachSchema(args.session_id, schemaId, {
            raw: schema,
            normalised,
            codeSamples: session.schema?.codeSamples ?? [],
            version,
        });
        const internalSession = getSessionInternal(args.session_id);
        if (!internalSession) {
            throw new ValidationError("Session not found");
        }
        internalSession.schemaHistory = newHistory;
        auditSchema.published(args.session_id, schemaId, claims.orgId, schema.endpoints.length);
        if (schemaDiff?.hasDiff) {
            auditSchema.diffed(args.session_id, schemaDiff.changes.length);
        }
        const result = {
            schema_id: schemaId,
            version,
            endpoint_count: schema.endpoints.length,
            normalised_contract: normalised,
            message: "Schema published.",
        };
        if (schemaDiff?.hasDiff) {
            result.diff_summary = {
                breaking: schemaDiff.breakingCount,
                warnings: schemaDiff.warningCount,
                additive: schemaDiff.additiveCount,
                suggested_version_bump: schemaDiff.suggestedVersionBump,
            };
        }
        return result;
    });
}
export async function provideCodeSample(args) {
    return withAuthedTool(args, "provide_code_sample", async () => ({
        sample_id: `sample_${Date.now()}`,
        session_id: args.session_id ?? null,
        sample: args.sample ?? null,
        stored: false,
        message: "stub - code sample persistence coming in Phase 4",
    }));
}
export async function discoverSchema(args) {
    return withAuthedTool(args, "discover_schema", async (claims) => {
        const session = getSession(args.session_id, claims.orgId);
        if (!session.schema) {
            throw new ValidationError("No schema has been published for this session");
        }
        auditSchema.discovered(args.session_id, session.schema.id, claims.orgId);
        return {
            session_id: args.session_id,
            schema_id: session.schema.id,
            contract: session.schema.normalised,
            version_history: session.schemaHistory,
            code_samples_count: session.schema.codeSamples.length,
            message: "Schema discovered.",
        };
    });
}
export async function generateIntegration(args) {
    return withAuthedTool(args, "generate_integration", async (claims) => {
        auditCodegen.started(args.session_id ?? null, claims.orgId, args.consumer_context?.language ?? null, args.consumer_context?.framework ?? null);
        const generated = {
            files: [
                {
                    filename: "integration.js",
                    description: "Phase 1 placeholder integration file",
                    content: "// Stub integration output\nexport const status = 'stub';\n",
                    source: "fallback_generated",
                },
            ],
            summary: "Stub integration output for Phase 1.",
            next_steps: ["Implement real orchestration in Phase 4."],
            warnings: ["This is placeholder data only."],
        };
        if (args.session_id) {
            attachGeneratedCode(args.session_id, generated);
            auditSession.completed(args.session_id);
        }
        auditCodegen.completed(args.session_id ?? null, generated.files.length, 0);
        return {
            status: "generated",
            source: "fallback",
            model: null,
            ...generated,
            message: "stub - LLM orchestration coming in Phase 4",
        };
    });
}
export async function validateIntegration(args) {
    return withAuthedTool(args, "validate_integration", async () => ({
        passed: true,
        issue_count: 0,
        issues: [],
        checked_files: Array.isArray(args.files) ? args.files.length : 0,
        message: "stub - validation engine coming in Phase 4",
    }));
}
export async function emitMessage(args) {
    return withAuthedTool(args, "emit_message", async (claims) => {
        const session = getSession(args.session_id, claims.orgId);
        const sessionMessage = {
            id: `msg_${Date.now()}`,
            text: args.message?.text ?? "Stub message",
            kind: args.message?.kind ?? "note",
            createdAt: new Date().toISOString(),
            orgId: claims.orgId,
            role: claims.role,
        };
        appendMessage(args.session_id, sessionMessage);
        return {
            message_id: sessionMessage.id,
            session_message_count: session.messages.length,
            message: "stub - negotiation messaging coming in Phase 4",
            emitted: sessionMessage,
        };
    });
}
export const TOOL_HANDLERS = {
    ping,
    register_service: registerService,
    join_session: joinSession,
    get_session_status: getSessionStatus,
    publish_schema: publishSchema,
    provide_code_sample: provideCodeSample,
    discover_schema: discoverSchema,
    generate_integration: generateIntegration,
    validate_integration: validateIntegration,
    emit_message: emitMessage,
};
