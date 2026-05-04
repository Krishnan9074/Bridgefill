import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "../config/index.js";
import { issueOrgToken, verifyOrgToken } from "./auth/index.js";
import { createApiKey, listOrgKeys, revokeKey, rotateKey } from "./auth/api-keys.js";
import { auditAuth, queryAuditLog } from "./auth/audit.js";
import { addClient } from "./events/bus.js";
import { handleMcpBatch, handleMcpRequest } from "./mcp/router.js";
import { diffRegistryVersions, getLatestSchema, getRegistryEntry, getSchemaHistory, listRegistry, publishToRegistry, } from "./registry/schema-store.js";
import { getPublicServiceList } from "./tools/service-registry.js";
import { getService } from "./tools/service-registry.js";
function getBearerToken(request) {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return null;
    }
    return authHeader.slice("Bearer ".length).trim() || null;
}
function requireBearerClaims(request) {
    const token = getBearerToken(request);
    if (!token) {
        throw Object.assign(new Error("Missing org token"), { statusCode: 401, machineCode: "AUTH_ERROR" });
    }
    return verifyOrgToken(token);
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
function buildLoggerOptions() {
    if (config.app.env === "test") {
        return false;
    }
    if (config.app.env === "development") {
        return {
            transport: {
                target: "pino-pretty",
            },
        };
    }
    return true;
}
function buildMeta() {
    return {
        protocolVersion: config.mcp.protocolVersion,
        serverName: config.mcp.serverName,
        serverVersion: config.mcp.serverVersion,
    };
}
async function handleSingleOrBatch(body) {
    const meta = buildMeta();
    if (Array.isArray(body)) {
        return handleMcpBatch(body, meta);
    }
    return handleMcpRequest(body, meta);
}
function toErrorResponse(error) {
    return {
        statusCode: error.statusCode ?? 500,
        body: {
            error: error.message ?? "Server error",
            code: error.machineCode ?? "SERVER_ERROR",
        },
    };
}
export async function buildServer() {
    const fastify = Fastify({
        logger: buildLoggerOptions(),
    });
    await fastify.register(cors, { origin: true });
    await fastify.register(websocket);
    fastify.setErrorHandler((error, request, reply) => {
        const response = toErrorResponse(error);
        reply.code(response.statusCode);
        return response.body;
    });
    fastify.get("/health", async () => ({
        status: "ok",
        server: config.mcp.serverName,
        version: config.mcp.serverVersion,
        protocol: config.mcp.protocolVersion,
        time: new Date().toISOString(),
    }));
    fastify.get("/llm/status", async () => ({
        provider: config.llm.provider,
        model: config.llm.model,
        base_url: config.llm.baseUrl,
        api_key_set: !!config.llm.apiKey,
        max_tokens: config.llm.maxTokens,
    }));
    fastify.post("/auth/token", async (request) => {
        const { org_id: orgId, api_key: apiKey, role, service_id: serviceId } = request.body ?? {};
        const token = issueOrgToken(orgId, apiKey, role, serviceId);
        return {
            token,
            org_id: orgId,
            role,
            service_id: serviceId ?? null,
            expires_in: config.jwt.orgTokenTtl,
        };
    });
    fastify.post("/auth/keys", async (request) => {
        const { org_id: orgId, label = null, ttl_days: ttlDays = null } = request.body ?? {};
        const { rawKey, record } = createApiKey(orgId, { label, ttlDays });
        auditAuth.keyCreated(orgId, record.keyId, record.label);
        return {
            raw_key: rawKey,
            key_id: record.keyId,
            label: record.label,
            expires_at: record.expiresAt,
        };
    });
    fastify.get("/auth/keys/:org_id", async (request) => ({
        org_id: request.params.org_id,
        keys: listOrgKeys(request.params.org_id),
    }));
    fastify.post("/auth/keys/:key_id/rotate", async (request) => {
        const { grace_period_ms: gracePeriodMs = 60_000 } = request.body ?? {};
        const { rawKey, newRecord, oldRecord } = rotateKey(request.params.key_id, { gracePeriodMs });
        auditAuth.keyRotated(oldRecord.orgId, oldRecord.keyId, newRecord.keyId);
        return {
            raw_key: rawKey,
            new_key: newRecord,
            old_key: oldRecord,
        };
    });
    fastify.delete("/auth/keys/:key_id", async (request) => {
        const record = revokeKey(request.params.key_id);
        auditAuth.keyRevoked(record.orgId, record.keyId, "manual_revoke");
        return {
            revoked: true,
            key_id: record.keyId,
        };
    });
    fastify.get("/audit", async (request) => ({
        entries: queryAuditLog({
            orgId: request.query.org_id,
            category: request.query.category,
            sessionId: request.query.session_id,
            limit: request.query.limit ? parseInt(request.query.limit, 10) : 100,
        }),
    }));
    fastify.get("/events/audit", async (request, reply) => {
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.hijack();
        const cleanup = addClient(reply);
        reply.raw.write(": connected\n\n");
        request.raw.on("close", cleanup);
    });
    fastify.post("/registry/schemas", async (request) => {
        const claims = requireBearerClaims(request);
        const service = getService(request.body.service_id);
        if (!service) {
            throw Object.assign(new Error("Service not found"), { statusCode: 404, machineCode: "NOT_FOUND" });
        }
        const normalisedSchema = normaliseSchema(request.body.schema);
        const published = publishToRegistry(claims.orgId, claims.orgName, request.body.service_id, request.body.service_name ?? service.name, normalisedSchema, request.body.code_samples ?? [], request.body.changelog ?? "", request.body.tags ?? service.tags ?? []);
        return {
            registry_id: published.registryId,
            version: published.version,
            diff_from_previous: published.diffFromPrevious,
        };
    });
    fastify.get("/registry/schemas", async (request) => ({
        schemas: listRegistry({
            orgId: request.query.org_id,
            tags: request.query.tags ? request.query.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined,
            q: request.query.q,
            limit: request.query.limit ? parseInt(request.query.limit, 10) : 20,
        }),
    }));
    fastify.get("/registry/schemas/:registry_id", async (request, reply) => {
        const entry = getRegistryEntry(request.params.registry_id);
        if (!entry) {
            reply.code(404);
            return { error: "Registry entry not found", code: "NOT_FOUND" };
        }
        return entry;
    });
    fastify.get("/registry/services/:service_id/schemas", async (request) => ({
        history: getSchemaHistory(request.params.service_id),
    }));
    fastify.get("/registry/services/:service_id/latest", async (request, reply) => {
        const entry = getLatestSchema(request.params.service_id);
        if (!entry) {
            reply.code(404);
            return { error: "Registry entry not found", code: "NOT_FOUND" };
        }
        return entry;
    });
    fastify.get("/registry/services/:service_id/diff", async (request, reply) => {
        const fromVersion = request.query.from;
        const toVersion = request.query.to;
        if (!fromVersion || !toVersion) {
            reply.code(400);
            return { error: "from and to query params are required", code: "VALIDATION_ERROR" };
        }
        const schemaDiff = diffRegistryVersions(request.params.service_id, fromVersion, toVersion);
        if (!schemaDiff) {
            reply.code(400);
            return { error: "Registry versions not found", code: "VALIDATION_ERROR" };
        }
        return schemaDiff;
    });
    fastify.post("/mcp", async (request, reply) => {
        const response = await handleSingleOrBatch(request.body);
        if (response === null || (Array.isArray(response) && response.length === 0)) {
            reply.code(202);
            return;
        }
        return response;
    });
    fastify.get("/mcp/ws", { websocket: true }, (socket) => {
        const meta = buildMeta();
        const ws = socket.socket;
        const keepAlive = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.ping();
            }
        }, 30_000);
        if (typeof keepAlive.unref === "function") {
            keepAlive.unref();
        }
        socket.on("message", async (rawMessage) => {
            try {
                const input = JSON.parse(rawMessage.toString());
                const response = Array.isArray(input)
                    ? await handleMcpBatch(input, meta)
                    : await handleMcpRequest(input, meta);
                if (response === null || (Array.isArray(response) && response.length === 0)) {
                    return;
                }
                const payload = `${JSON.stringify(response)}\n`;
                if (ws.readyState === ws.OPEN) {
                    ws.send(payload);
                }
            }
            catch (error) {
                const payload = JSON.stringify({
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                        code: -32700,
                        message: error?.message ?? "Parse error",
                    },
                });
                if (ws.readyState === ws.OPEN) {
                    ws.send(`${payload}\n`);
                }
            }
        });
        socket.on("close", () => {
            clearInterval(keepAlive);
        });
        socket.on("error", () => {
            clearInterval(keepAlive);
        });
    });
    fastify.get("/services", async () => ({
        services: getPublicServiceList(),
    }));
    return fastify;
}
export async function startServer() {
    const fastify = await buildServer();
    await fastify.listen({
        host: config.server.host,
        port: config.server.port,
    });
    return fastify;
}
const entrypointPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : null;
if (entrypointPath === import.meta.url) {
    void startServer().catch((error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exit(1);
    });
}
