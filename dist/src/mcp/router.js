import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { TOOL_HANDLERS } from "../tools/handlers.js";
function createJsonRpcError(code, message, id = null, data) {
    return {
        jsonrpc: "2.0",
        id,
        error: {
            code,
            message,
            ...(data !== undefined ? { data } : {}),
        },
    };
}
function createJsonRpcResult(result, id) {
    return {
        jsonrpc: "2.0",
        id,
        result,
    };
}
function formatToolResult(payload, isError = false) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload),
            },
        ],
        isError,
    };
}
function normalizeError(error) {
    const err = error;
    if (typeof err?.code === "number") {
        return {
            code: err.code,
            message: err.message ?? "Internal error",
        };
    }
    if (error instanceof SyntaxError) {
        return { code: -32700, message: error.message };
    }
    return {
        code: -32000,
        message: err?.message ?? "Internal error",
    };
}
async function dispatchMethod(method, params = {}, meta = {}) {
    switch (method) {
        case "initialize":
            return {
                protocolVersion: meta.protocolVersion ?? "2024-11-05",
                serverInfo: {
                    name: meta.serverName ?? "bridgefill",
                    version: meta.serverVersion ?? "0.1.0",
                },
                capabilities: {
                    tools: { listChanged: false },
                    resources: { subscribe: false, listChanged: false },
                    prompts: { listChanged: false },
                },
            };
        case "initialized":
            return null;
        case "ping":
            return {};
        case "tools/list":
            return { tools: TOOL_DEFINITIONS };
        case "tools/call": {
            const toolName = typeof params?.name === "string" ? params.name : undefined;
            const handlers = TOOL_HANDLERS;
            const handler = toolName ? handlers[toolName] : undefined;
            if (!handler) {
                throw Object.assign(new Error(`Unknown tool: ${toolName}`), { code: -32601 });
            }
            const toolResult = await handler(params?.arguments ?? {});
            return formatToolResult(toolResult, false);
        }
        case "resources/list":
            return { resources: [] };
        case "prompts/list":
            return { prompts: [] };
        default:
            throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
}
function validateRequestShape(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw Object.assign(new Error("Invalid request"), { code: -32600 });
    }
    const cast = request;
    if (cast.jsonrpc !== "2.0" || typeof cast.method !== "string") {
        throw Object.assign(new Error("Invalid request"), { code: -32600 });
    }
}
export async function handleMcpRequest(request, meta = {}) {
    try {
        validateRequestShape(request);
        const isNotification = request.id === undefined;
        const result = await dispatchMethod(request.method, request.params ?? {}, meta);
        if (isNotification) {
            return null;
        }
        return createJsonRpcResult(result, request.id ?? null);
    }
    catch (error) {
        const normalized = normalizeError(error);
        const maybeRequest = request;
        if (maybeRequest?.id === undefined) {
            return null;
        }
        return createJsonRpcError(normalized.code, normalized.message, maybeRequest?.id ?? null);
    }
}
export async function handleMcpBatch(requests, meta = {}) {
    if (!Array.isArray(requests) || requests.length === 0) {
        return [createJsonRpcError(-32600, "Invalid request", null)];
    }
    const responses = await Promise.all(requests.map((request) => handleMcpRequest(request, meta)));
    return responses.filter((response) => response !== null);
}
