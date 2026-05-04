import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { TOOL_HANDLERS } from "../tools/handlers.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  } | Record<string, unknown>;
}

interface JsonRpcErrorShape {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcResultShape {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

function createJsonRpcError(code: number, message: string, id: string | number | null = null, data?: unknown): JsonRpcErrorShape {
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

function createJsonRpcResult(result: unknown, id: string | number | null): JsonRpcResultShape {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function formatToolResult(payload: unknown, isError = false): { content: Array<{ type: string; text: string }>; isError: boolean } {
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

function normalizeError(error: unknown): { code: number; message: string } {
  const err = error as { code?: number; message?: string };
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

async function dispatchMethod(method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Promise<unknown> {
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
      const handlers = TOOL_HANDLERS as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
      const handler = toolName ? handlers[toolName] : undefined;
      if (!handler) {
        throw Object.assign(new Error(`Unknown tool: ${toolName}`), { code: -32601 });
      }
      const toolResult = await handler((params?.arguments as Record<string, unknown> | undefined) ?? {});
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

function validateRequestShape(request: unknown): asserts request is JsonRpcRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw Object.assign(new Error("Invalid request"), { code: -32600 });
  }
  const cast = request as { jsonrpc?: string; method?: unknown };
  if (cast.jsonrpc !== "2.0" || typeof cast.method !== "string") {
    throw Object.assign(new Error("Invalid request"), { code: -32600 });
  }
}

export async function handleMcpRequest(request: unknown, meta: Record<string, unknown> = {}): Promise<JsonRpcErrorShape | JsonRpcResultShape | null> {
  try {
    validateRequestShape(request);
    const isNotification = request.id === undefined;
    const result = await dispatchMethod(request.method, (request.params as Record<string, unknown> | undefined) ?? {}, meta);
    if (isNotification) {
      return null;
    }
    return createJsonRpcResult(result, request.id ?? null);
  } catch (error) {
    const normalized = normalizeError(error);
    const maybeRequest = request as JsonRpcRequest | undefined;
    if (maybeRequest?.id === undefined) {
      return null;
    }
    return createJsonRpcError(normalized.code, normalized.message, maybeRequest?.id ?? null);
  }
}

export async function handleMcpBatch(requests: unknown, meta: Record<string, unknown> = {}): Promise<Array<JsonRpcErrorShape | JsonRpcResultShape>> {
  if (!Array.isArray(requests) || requests.length === 0) {
    return [createJsonRpcError(-32600, "Invalid request", null)];
  }

  const responses = await Promise.all(requests.map((request) => handleMcpRequest(request, meta)));
  return responses.filter((response): response is JsonRpcErrorShape | JsonRpcResultShape => response !== null);
}
