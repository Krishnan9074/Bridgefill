import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "../config/index.js";
import { issueOrgToken } from "./auth/index.js";
import { createApiKey, listOrgKeys, revokeKey, rotateKey } from "./auth/api-keys.js";
import { auditAuth, queryAuditLog } from "./auth/audit.js";
import { addClient } from "./events/bus.js";
import { handleMcpBatch, handleMcpRequest } from "./mcp/router.js";
import { getPublicServiceList } from "./tools/service-registry.js";
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
