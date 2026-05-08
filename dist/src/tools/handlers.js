import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { assertToolAllowed, verifyOrgToken } from "../auth/index.js";
import { auditCodegen, auditSchema, auditSession, auditTool } from "../auth/audit.js";
import { generateIntegrationCode } from "../codegen/orchestrator.js";
import { getStores } from "../persistence/index.js";
import { diffRegistryVersions, getLatestSchema, getSchemaHistory, listRegistry as listRegistryEntries, publishToRegistry, } from "../registry/schema-store.js";
import { diff, bumpVersion, negotiate } from "../schema/negotiation.js";
import { appendMessage, attachGeneratedCode, attachSchema, getSession, getSessionByServiceId, getSessionInternal, joinSession as storeJoinSession, } from "../session/store.js";
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
function registrySummary(entry) {
    return {
        registry_id: entry.registryId,
        service_id: entry.serviceId,
        service_name: entry.serviceName,
        org_name: entry.orgName,
        latest_version: entry.version,
        endpoint_count: entry.schema.endpoints.length,
        tags: entry.tags,
        published_at: entry.publishedAt,
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
        await registerInRegistry(serviceId, service);
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
        const session = await storeJoinSession(args.service_id, claims);
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
        await attachSchema(args.session_id, schemaId, {
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
        await getStores().sessions.set(internalSession.id, internalSession);
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
    return withAuthedTool(args, "provide_code_sample", async (claims) => {
        if (!args.session_id) {
            throw new ValidationError("session_id is required");
        }
        if (!args.sample) {
            throw new ValidationError("sample is required");
        }
        const session = getSession(args.session_id, claims.orgId);
        assertSessionActive(session);
        if (!session.schema) {
            throw new ValidationError("No schema. Provider must call publish_schema first.");
        }
        session.schema.codeSamples.push(args.sample);
        await getStores().sessions.set(session.id, session);
        return {
            message: "Code sample stored.",
            total_samples: session.schema.codeSamples.length,
        };
    });
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
        if (!args.session_id) {
            throw new ValidationError("session_id is required");
        }
        const session = getSession(args.session_id, claims.orgId);
        assertSessionActive(session);
        if (!session.schema) {
            throw new ValidationError("No schema. Provider must call publish_schema first.");
        }
        const consumerContext = args.consumer_context ?? {};
        const contract = session.schema.normalised;
        const codeSamples = session.schema.codeSamples ?? [];
        const negotiationResult = negotiate({
            publishedSchema: contract,
            previousSchema: null,
            consumerContext,
        });
        auditCodegen.started(args.session_id, claims.orgId, consumerContext.language ?? null, consumerContext.framework ?? null);
        const t0 = Date.now();
        const generated = await generateIntegrationCode({
            sessionId: args.session_id,
            orgId: claims.orgId,
            contract,
            codeSamples,
            consumerContext,
            negotiation: negotiationResult,
        });
        await attachGeneratedCode(args.session_id, generated);
        auditSession.completed(args.session_id);
        auditCodegen.completed(args.session_id, generated.files.length, Date.now() - t0);
        return {
            status: "generated",
            language: consumerContext.language ?? "typescript",
            source: generated.source,
            model: generated.model ?? null,
            files: generated.files,
            summary: generated.summary,
            next_steps: generated.nextSteps,
            warnings: generated.warnings ?? [],
            blocked_endpoints: negotiationResult.blockedEndpoints,
            message: "Integration code generated. Call validate_integration to check for issues.",
        };
    });
}
export async function validateIntegration(args) {
    return withAuthedTool(args, "validate_integration", async (claims) => {
        if (!args.session_id) {
            throw new ValidationError("session_id is required");
        }
        const session = getSession(args.session_id, claims.orgId);
        if (!session.schema) {
            throw new ValidationError("No schema. Provider must call publish_schema first.");
        }
        const files = Array.isArray(args.files) && args.files.length > 0
            ? args.files
            : session.generatedCode?.files.map((file) => ({ filename: file.filename, content: file.content })) ?? [];
        const codeBlob = files.map((file) => file.content).join("\n");
        const issues = [];
        const contract = session.schema.normalised;
        if (!codeBlob.includes(contract.base_url)) {
            issues.push({
                severity: "error",
                endpoint: null,
                message: `Generated code does not reference base URL ${contract.base_url}.`,
            });
        }
        if (contract.auth.key_name && !codeBlob.includes(contract.auth.key_name)) {
            issues.push({
                severity: "error",
                endpoint: null,
                message: `Generated code does not reference auth key ${contract.auth.key_name}.`,
            });
        }
        for (const endpoint of contract.endpoints) {
            for (const param of endpoint.required_params) {
                if (!codeBlob.includes(param.name)) {
                    issues.push({
                        severity: "error",
                        endpoint: endpoint.path,
                        message: `Missing required param ${param.name} for ${endpoint.path}.`,
                    });
                }
            }
        }
        return {
            passed: issues.length === 0,
            issue_count: issues.length,
            issues,
        };
    });
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
        await appendMessage(args.session_id, sessionMessage);
        return {
            message_id: sessionMessage.id,
            session_message_count: session.messages.length,
            message: "Message emitted.",
        };
    });
}
export async function publishToRegistryTool(args) {
    return withAuthedTool(args, "publish_to_registry", async (claims) => {
        const service = getService(args.service_id);
        if (!service) {
            throw new ValidationError("Service not found");
        }
        if (!args.schema?.base_url) {
            throw new ValidationError("schema.base_url is required");
        }
        if (!args.schema.auth?.type) {
            throw new ValidationError("schema.auth.type is required");
        }
        if (!Array.isArray(args.schema.endpoints) || args.schema.endpoints.length === 0) {
            throw new ValidationError("schema.endpoints must be a non-empty array");
        }
        const normalised = normaliseSchema(args.schema);
        const { registryId, version, diffFromPrevious, record } = await publishToRegistry(claims.orgId, claims.orgName, args.service_id, service.name, normalised, args.code_samples ?? [], args.changelog ?? "", args.tags ?? service.tags ?? []);
        auditSchema.published(registryId, registryId, claims.orgId, normalised.endpoints.length);
        if (diffFromPrevious?.hasDiff) {
            auditSchema.diffed(registryId, diffFromPrevious.changes.length);
        }
        const session = getSessionByServiceId(args.service_id);
        if (session && session.status === "active") {
            const schemaId = `schema_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
            await attachSchema(session.id, schemaId, {
                raw: args.schema,
                normalised: record.schema,
                codeSamples: record.codeSamples,
                version: record.version,
            });
            session.schemaHistory = getSchemaHistory(args.service_id).map((entry) => ({
                version: entry.version,
                publishedAt: entry.publishedAt,
                isBreaking: entry.isLatest ? !!diffFromPrevious?.breakingCount : false,
                schema: entry.schema,
            }));
            await getStores().sessions.set(session.id, session);
        }
        return {
            registry_id: registryId,
            version,
            diff_from_previous: diffFromPrevious,
            message: "Schema published to registry.",
        };
    });
}
export async function discoverFromRegistry(args) {
    return withAuthedTool(args, "discover_from_registry", async (claims) => {
        const targetVersion = args.version ?? "latest";
        const history = getSchemaHistory(args.service_id);
        const entry = targetVersion === "latest"
            ? getLatestSchema(args.service_id)
            : history.find((item) => item.version === targetVersion) ?? null;
        if (!entry) {
            throw new ValidationError("Registry schema not found");
        }
        auditSchema.discovered(entry.registryId, entry.registryId, claims.orgId);
        return {
            registry_id: entry.registryId,
            version: entry.version,
            schema: entry.schema,
            code_samples_count: entry.codeSamples.length,
            changelog: entry.changelog,
            schema_history: history.map((item) => ({
                version: item.version,
                published_at: item.publishedAt,
                is_breaking: item.version === entry.version ? false : (diffRegistryVersions(args.service_id, item.version, entry.version)?.breakingCount ?? 0) > 0,
            })),
            message: "Registry schema discovered.",
        };
    });
}
export async function listRegistryTool(args) {
    return withAuthedTool(args, "list_registry", async () => ({
        services: listRegistryEntries({
            tags: args.tags,
            q: args.q,
            limit: args.limit,
        }).map(registrySummary),
    }));
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
    publish_to_registry: publishToRegistryTool,
    discover_from_registry: discoverFromRegistry,
    list_registry: listRegistryTool,
};
