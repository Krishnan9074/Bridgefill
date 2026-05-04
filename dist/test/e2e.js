import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
function pass(message) {
    process.stdout.write(`\u2713 PASS ${message}\n`);
}
function fail(message, error) {
    process.stdout.write(`\u2717 FAIL ${message}\n`);
    if (error) {
        process.stderr.write(`${error.message}\n`);
    }
}
async function runCheck(message, fn) {
    try {
        await fn();
        pass(message);
        return 1;
    }
    catch (error) {
        fail(message, error);
        return 0;
    }
}
async function issueToken(server, payload) {
    const response = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload,
    });
    return response.json();
}
async function callTool(server, id, name, args) {
    const response = await server.inject({
        method: "POST",
        url: "/mcp",
        payload: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
                name,
                arguments: args,
            },
        },
    });
    return response.json();
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
async function main() {
    process.env.NODE_ENV = "test";
    const { buildServer } = await import("../src/server.js");
    const server = await buildServer();
    let passed = 0;
    passed += await runCheck('GET /health returns { status: "ok" }', async () => {
        const response = await server.inject({
            method: "GET",
            url: "/health",
        });
        const body = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(body.status === "ok", `Expected status=ok, received ${body.status}`);
    });
    passed += await runCheck("GET /llm/status returns current LLM config", async () => {
        const response = await server.inject({
            method: "GET",
            url: "/llm/status",
        });
        const body = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(typeof body.provider === "string" && body.provider.length > 0, "Expected provider");
        assert(typeof body.model === "string" && body.model.length > 0, "Expected model");
        assert(typeof body.base_url === "string" && body.base_url.length > 0, "Expected base_url");
        assert(typeof body.api_key_set === "boolean", "Expected api_key_set boolean");
        assert(typeof body.max_tokens === "number", "Expected max_tokens number");
    });
    passed += await runCheck("POST /mcp initialize returns capabilities with tools key", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/mcp",
            payload: {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {},
            },
        });
        const body = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(body.result?.capabilities?.tools, "Expected capabilities.tools to be defined");
    });
    passed += await runCheck("tools/list returns all 13 tools", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/mcp",
            payload: {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
            },
        });
        const body = response.json();
        assert(Array.isArray(body.result?.tools), "Expected result.tools to be an array");
        assert(body.result.tools.length === 13, `Expected 13 tools, received ${body.result.tools.length}`);
    });
    passed += await runCheck('tools/call ping returns { status: "ok" }', async () => {
        const response = await server.inject({
            method: "POST",
            url: "/mcp",
            payload: {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                    name: "ping",
                    arguments: {},
                },
            },
        });
        const body = response.json();
        const toolPayload = JSON.parse(body.result.content[0].text);
        assert(toolPayload.status === "ok", `Expected status=ok, received ${toolPayload.status}`);
    });
    passed += await runCheck("tools/call with unknown tool returns JSON-RPC error -32601", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/mcp",
            payload: {
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: {
                    name: "missing_tool",
                    arguments: {},
                },
            },
        });
        const body = response.json();
        assert(body.error?.code === -32601, `Expected error code -32601, received ${body.error?.code}`);
    });
    passed += await runCheck("GET /services returns { services: [] }", async () => {
        const response = await server.inject({
            method: "GET",
            url: "/services",
        });
        const body = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(Array.isArray(body.services), "Expected services to be an array");
        assert(body.services.length === 0, `Expected 0 services, received ${body.services.length}`);
    });
    let providerToken = "";
    let consumerToken = "";
    let serviceId = "";
    let sessionId = "";
    let rotatedKeyId = "";
    let oldRotatedRawKey = "";
    let schemaSessionId = "";
    let schemaSessionId2 = "";
    let phase4SessionId = "";
    let llmSessionId = "";
    let registryServiceId = "";
    let registryEntryId = "";
    let largeRegistryServiceId = "";
    let asyncJobId = "";
    let standaloneGeneratedFiles = [];
    passed += await runCheck("POST /auth/token with valid provider API key returns signed JWT", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/auth/token",
            payload: {
                org_id: "org_demo_provider",
                api_key: "dev-provider-secret",
                role: "provider",
            },
        });
        const body = response.json();
        providerToken = body.token;
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(typeof body.token === "string" && body.token.length > 20, "Expected a signed JWT");
    });
    passed += await runCheck("Provider JWT contains jti, keyId, allowedTools, and role", async () => {
        const [, payload] = providerToken.split(".");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        assert(typeof claims.jti === "string", "Expected jti");
        assert(typeof claims.keyId === "string", "Expected keyId");
        assert(Array.isArray(claims.allowedTools), "Expected allowedTools");
        assert(claims.role === "provider", `Expected role=provider, received ${claims.role}`);
    });
    passed += await runCheck("Consumer API key can also mint a scoped consumer token", async () => {
        const body = await issueToken(server, {
            org_id: "org_demo_consumer",
            api_key: "dev-consumer-secret",
            role: "consumer",
        });
        consumerToken = body.token;
        assert(typeof consumerToken === "string", "Expected consumer token");
    });
    passed += await runCheck("Provider can register a service with the scoped token", async () => {
        const response = await callTool(server, 5, "register_service", {
            org_token: providerToken,
            service_name: "Maps API",
            service_description: "Provider test service",
        });
        const toolPayload = JSON.parse(response.result.content[0].text);
        serviceId = toolPayload.service_id;
        assert(typeof serviceId === "string" && serviceId.startsWith("svc_"), "Expected service id");
    });
    passed += await runCheck("Provider can join a session for the new service", async () => {
        const response = await callTool(server, 6, "join_session", {
            org_token: providerToken,
            service_id: serviceId,
        });
        const toolPayload = JSON.parse(response.result.content[0].text);
        sessionId = toolPayload.session_id;
        assert(toolPayload.status === "pending", `Expected pending, received ${toolPayload.status}`);
    });
    passed += await runCheck("Consumer can join the same session and activate it", async () => {
        const response = await callTool(server, 7, "join_session", {
            org_token: consumerToken,
            service_id: serviceId,
        });
        const toolPayload = JSON.parse(response.result.content[0].text);
        assert(toolPayload.status === "active", `Expected active, received ${toolPayload.status}`);
    });
    passed += await runCheck("Provider token cannot call discover_schema", async () => {
        const response = await callTool(server, 8, "discover_schema", {
            org_token: providerToken,
            session_id: sessionId,
        });
        assert(response.error.code === -32001, `Expected -32001, received ${response.error.code}`);
    });
    passed += await runCheck("Consumer token cannot call publish_schema", async () => {
        const response = await callTool(server, 9, "publish_schema", {
            org_token: consumerToken,
            session_id: sessionId,
            schema: { base_url: "https://api.example.com", auth: { type: "none" }, endpoints: [] },
        });
        assert(response.error.code === -32001, `Expected -32001, received ${response.error.code}`);
    });
    passed += await runCheck("POST /auth/keys creates a new API key and exposes it once", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/auth/keys",
            payload: {
                org_id: "org_demo_provider",
                label: "phase2-test-key",
            },
        });
        const body = response.json();
        rotatedKeyId = body.key_id;
        oldRotatedRawKey = body.raw_key;
        assert(typeof body.raw_key === "string" && body.raw_key.startsWith("bf_org_demo_provider_"), "Expected raw key");
        assert(typeof body.key_id === "string", "Expected key id");
    });
    passed += await runCheck("Key rotation leaves old key usable during grace period", async () => {
        const rotateResponse = await server.inject({
            method: "POST",
            url: `/auth/keys/${rotatedKeyId}/rotate`,
            payload: { grace_period_ms: 50 },
        });
        assert(rotateResponse.statusCode === 200, `Expected 200, received ${rotateResponse.statusCode}`);
        const tokenResponse = await server.inject({
            method: "POST",
            url: "/auth/token",
            payload: {
                org_id: "org_demo_provider",
                api_key: oldRotatedRawKey,
                role: "provider",
            },
        });
        const tokenBody = tokenResponse.json();
        assert(tokenResponse.statusCode === 200, `Expected 200, received ${tokenResponse.statusCode}`);
        assert(typeof tokenBody.token === "string", "Expected old rotating key to still mint tokens");
    });
    passed += await runCheck("Old rotated key is rejected after the grace period", async () => {
        const createdKeyResponse = await server.inject({
            method: "POST",
            url: "/auth/keys",
            payload: {
                org_id: "org_demo_consumer",
                label: "grace-window-key",
            },
        });
        const createdKeyBody = createdKeyResponse.json();
        const oldRawKey = createdKeyBody.raw_key;
        const keyId = createdKeyBody.key_id;
        await server.inject({
            method: "POST",
            url: `/auth/keys/${keyId}/rotate`,
            payload: { grace_period_ms: 30 },
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const response = await server.inject({
            method: "POST",
            url: "/auth/token",
            payload: {
                org_id: "org_demo_consumer",
                api_key: oldRawKey,
                role: "consumer",
            },
        });
        const body = response.json();
        assert(response.statusCode === 401, `Expected 401, received ${response.statusCode}`);
        assert(body.code === "AUTH_ERROR", `Expected AUTH_ERROR, received ${body.code}`);
    });
    passed += await runCheck("Revoked key is rejected immediately", async () => {
        const createdKeyResponse = await server.inject({
            method: "POST",
            url: "/auth/keys",
            payload: {
                org_id: "org_demo",
                label: "revoke-me",
            },
        });
        const createdKeyBody = createdKeyResponse.json();
        await server.inject({
            method: "DELETE",
            url: `/auth/keys/${createdKeyBody.key_id}`,
        });
        const response = await server.inject({
            method: "POST",
            url: "/auth/token",
            payload: {
                org_id: "org_demo",
                api_key: createdKeyBody.raw_key,
                role: "consumer",
            },
        });
        assert(response.statusCode === 401, `Expected 401, received ${response.statusCode}`);
    });
    passed += await runCheck("GET /audit returns events for auth operations", async () => {
        const response = await server.inject({
            method: "GET",
            url: "/audit?category=auth&limit=20",
        });
        const body = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(Array.isArray(body.entries) && body.entries.length > 0, "Expected auth audit entries");
    });
    passed += await runCheck('Publish schema v1 gets version "1.0.0"', async () => {
        const registerResponse = await callTool(server, 20, "register_service", {
            org_token: providerToken,
            service_name: "Search API",
            service_description: "Schema phase service",
        });
        const newServiceId = JSON.parse(registerResponse.result.content[0].text).service_id;
        const providerJoin = await callTool(server, 21, "join_session", {
            org_token: providerToken,
            service_id: newServiceId,
        });
        schemaSessionId = JSON.parse(providerJoin.result.content[0].text).session_id;
        await callTool(server, 22, "join_session", {
            org_token: consumerToken,
            service_id: newServiceId,
        });
        const publishResponse = await callTool(server, 23, "publish_schema", {
            org_token: providerToken,
            session_id: schemaSessionId,
            schema: {
                base_url: "https://api.search.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-API-Key" },
                endpoints: [
                    {
                        path: "/v1/search",
                        method: "GET",
                        summary: "Search for places",
                        parameters: [
                            { name: "query", in: "query", required: true, schema: { type: "string" } },
                            { name: "page", in: "query", required: false, schema: { type: "number" } },
                        ],
                        response_schema: { type: "object" },
                    },
                    {
                        path: "/v1/suggest",
                        method: "GET",
                        summary: "Suggest places",
                        parameters: [
                            { name: "query", in: "query", required: true, schema: { type: "string" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
                rate_limits: { requests_per_second: 5, requests_per_day: 1000 },
                sdk_languages: ["javascript"],
            },
        });
        const payload = JSON.parse(publishResponse.result.content[0].text);
        assert(payload.version === "1.0.0", `Expected 1.0.0, received ${payload.version}`);
    });
    passed += await runCheck('Publish schema v2 with removed endpoint and new required param gets "2.0.0" with 2 breaking changes', async () => {
        const publishResponse = await callTool(server, 24, "publish_schema", {
            org_token: providerToken,
            session_id: schemaSessionId,
            schema: {
                base_url: "https://api.search.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-API-Key" },
                endpoints: [
                    {
                        path: "/v1/search",
                        method: "GET",
                        summary: "Search for places",
                        parameters: [
                            { name: "query", in: "query", required: true, schema: { type: "string" } },
                            { name: "region", in: "query", required: true, schema: { type: "string" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
                rate_limits: { requests_per_second: 5, requests_per_day: 1000 },
                sdk_languages: ["javascript"],
            },
        });
        const payload = JSON.parse(publishResponse.result.content[0].text);
        assert(payload.version === "2.0.0", `Expected 2.0.0, received ${payload.version}`);
        assert(payload.diff_summary.breaking === 2, `Expected 2 breaking changes, received ${payload.diff_summary.breaking}`);
        assert(payload.diff_summary.warnings === 0, `Expected 0 warnings, received ${payload.diff_summary.warnings}`);
    });
    passed += await runCheck('discover_schema returns version history with 2 entries', async () => {
        const response = await callTool(server, 25, "discover_schema", {
            org_token: consumerToken,
            session_id: schemaSessionId,
        });
        const payload = JSON.parse(response.result.content[0].text);
        assert(Array.isArray(payload.version_history), "Expected version history array");
        assert(payload.version_history.length === 2, `Expected 2 history entries, received ${payload.version_history.length}`);
    });
    passed += await runCheck('Publish schema with only a new optional param gets "1.1.0"', async () => {
        const registerResponse = await callTool(server, 26, "register_service", {
            org_token: providerToken,
            service_name: "Maps Nearby API",
            service_description: "Optional param scenario",
        });
        const serviceId2 = JSON.parse(registerResponse.result.content[0].text).service_id;
        const providerJoin = await callTool(server, 27, "join_session", {
            org_token: providerToken,
            service_id: serviceId2,
        });
        schemaSessionId2 = JSON.parse(providerJoin.result.content[0].text).session_id;
        await callTool(server, 28, "join_session", {
            org_token: consumerToken,
            service_id: serviceId2,
        });
        await callTool(server, 29, "publish_schema", {
            org_token: providerToken,
            session_id: schemaSessionId2,
            schema: {
                base_url: "https://maps.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-Maps-Key" },
                endpoints: [
                    {
                        path: "/v1/nearby",
                        method: "GET",
                        summary: "Nearby places",
                        parameters: [
                            { name: "lat", in: "query", required: true, schema: { type: "number" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
            },
        });
        const publishResponse = await callTool(server, 30, "publish_schema", {
            org_token: providerToken,
            session_id: schemaSessionId2,
            schema: {
                base_url: "https://maps.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-Maps-Key" },
                endpoints: [
                    {
                        path: "/v1/nearby",
                        method: "GET",
                        summary: "Nearby places",
                        parameters: [
                            { name: "lat", in: "query", required: true, schema: { type: "number" } },
                            { name: "radius", in: "query", required: false, schema: { type: "number" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
            },
        });
        const payload = JSON.parse(publishResponse.result.content[0].text);
        assert(payload.version === "1.1.0", `Expected 1.1.0, received ${payload.version}`);
    });
    passed += await runCheck("Phase 3 diff engine can scope conflicts to requested endpoints", async () => {
        const { diff, detectConflicts } = await import("../src/schema/negotiation.js");
        const previousSchema = {
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [
                { path: "/v1/search", method: "GET", summary: "", all_params: [] },
                { path: "/v1/nearby", method: "GET", summary: "", all_params: [] },
            ],
        };
        const nextSchema = {
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [
                {
                    path: "/v1/search",
                    method: "GET",
                    summary: "",
                    all_params: [{ name: "region", in: "query", required: true, schema: { type: "string" }, description: "" }],
                },
            ],
        };
        const schemaDiff = diff(previousSchema, nextSchema);
        const conflicts = detectConflicts(schemaDiff, {
            endpoints_needed: ["/v1/nearby"],
            language: "typescript",
        });
        assert(conflicts.conflictCount === 1, `Expected 1 relevant conflict, received ${conflicts.conflictCount}`);
        assert(conflicts.conflicts[0].path.includes("/v1/nearby"), `Expected nearby conflict, received ${conflicts.conflicts[0].path}`);
    });
    passed += await runCheck("Phase 3 diff engine includes both breaking changes when all endpoints are in scope", async () => {
        const { diff, detectConflicts } = await import("../src/schema/negotiation.js");
        const previousSchema = {
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [
                {
                    path: "/v1/search",
                    method: "GET",
                    summary: "",
                    all_params: [{ name: "query", in: "query", required: true, schema: { type: "string" }, description: "" }],
                },
                { path: "/v1/nearby", method: "GET", summary: "", all_params: [] },
            ],
        };
        const nextSchema = {
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [
                {
                    path: "/v1/search",
                    method: "GET",
                    summary: "",
                    all_params: [
                        { name: "query", in: "query", required: true, schema: { type: "string" }, description: "" },
                        { name: "region", in: "query", required: true, schema: { type: "string" }, description: "" },
                    ],
                },
            ],
        };
        const schemaDiff = diff(previousSchema, nextSchema);
        const conflicts = detectConflicts(schemaDiff, {
            endpoints_needed: [],
            language: "typescript",
        });
        assert(schemaDiff.breakingCount === 2, `Expected 2 breaking changes, received ${schemaDiff.breakingCount}`);
        assert(conflicts.conflictCount === 2, `Expected 2 conflicts, received ${conflicts.conflictCount}`);
    });
    passed += await runCheck("discover_schema returns the normalized contract shape", async () => {
        const response = await callTool(server, 31, "discover_schema", {
            org_token: consumerToken,
            session_id: schemaSessionId2,
        });
        const payload = JSON.parse(response.result.content[0].text);
        assert(Array.isArray(payload.contract.endpoints), "Expected normalized endpoints array");
        assert(Array.isArray(payload.contract.endpoints[0].required_params), "Expected required_params array");
        assert(Array.isArray(payload.contract.endpoints[0].optional_params), "Expected optional_params array");
    });
    passed += await runCheck("provide_code_sample stores provider code for later generation", async () => {
        const registerResponse = await callTool(server, 32, "register_service", {
            org_token: providerToken,
            service_name: "Payments API",
            service_description: "Phase 4 fallback scenario",
        });
        const phase4ServiceId = JSON.parse(registerResponse.result.content[0].text).service_id;
        const providerJoin = await callTool(server, 33, "join_session", {
            org_token: providerToken,
            service_id: phase4ServiceId,
        });
        phase4SessionId = JSON.parse(providerJoin.result.content[0].text).session_id;
        await callTool(server, 34, "join_session", {
            org_token: consumerToken,
            service_id: phase4ServiceId,
        });
        await callTool(server, 35, "publish_schema", {
            org_token: providerToken,
            session_id: phase4SessionId,
            schema: {
                base_url: "https://payments.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-PAYMENTS-KEY" },
                endpoints: [
                    {
                        path: "/v1/payment_intents",
                        method: "POST",
                        summary: "Create payment intent",
                        parameters: [
                            { name: "amount", in: "body", required: true, schema: { type: "number" } },
                            { name: "currency", in: "body", required: true, schema: { type: "string" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
            },
        });
        const sampleResponse = await callTool(server, 36, "provide_code_sample", {
            org_token: providerToken,
            session_id: phase4SessionId,
            sample: {
                language: "typescript",
                description: "Authoritative payment intent example",
                content: [
                    "export async function createPaymentIntent() {",
                    '  const endpoint = "/v1/payment_intents";',
                    '  const required = ["amount", "currency"];',
                    '  const authHeader = "X-PAYMENTS-KEY";',
                    '  const baseUrl = "https://payments.example.com";',
                    "  return { endpoint, required, authHeader, baseUrl };",
                    "}",
                ].join("\n"),
            },
        });
        const payload = JSON.parse(sampleResponse.result.content[0].text);
        assert(payload.total_samples === 1, `Expected 1 code sample, received ${payload.total_samples}`);
    });
    passed += await runCheck("generate_integration without an API key returns fallback/provider_sample files", async () => {
        const { config } = await import("../config/index.js");
        config.llm.apiKey = null;
        const response = await callTool(server, 37, "generate_integration", {
            org_token: consumerToken,
            session_id: phase4SessionId,
            consumer_context: {
                language: "typescript",
                framework: "nextjs",
                use_case: "Create a payment intent on checkout",
            },
        });
        const payload = JSON.parse(response.result.content[0].text);
        assert(payload.source === "fallback", `Expected fallback source, received ${payload.source}`);
        assert(payload.files.some((file) => file.source === "provider_sample"), "Expected a provider_sample file");
        assert(payload.files.some((file) => file.source === "fallback_generated"), "Expected a fallback_generated file");
        assert(payload.files.some((file) => file.content.includes("X-PAYMENTS-KEY")), "Expected provider sample content to appear in output");
    });
    passed += await runCheck("validate_integration passes for generated fallback/provider output", async () => {
        const generatedResponse = await callTool(server, 38, "get_session_status", {
            org_token: consumerToken,
            session_id: phase4SessionId,
        });
        const sessionPayload = JSON.parse(generatedResponse.result.content[0].text);
        const validResponse = await callTool(server, 39, "validate_integration", {
            org_token: consumerToken,
            session_id: phase4SessionId,
            files: sessionPayload.generated_code.files,
        });
        const validPayload = JSON.parse(validResponse.result.content[0].text);
        assert(validPayload.passed === true, "Expected generated integration to validate successfully");
    });
    passed += await runCheck("validate_integration detects missing required params", async () => {
        const invalidResponse = await callTool(server, 40, "validate_integration", {
            org_token: consumerToken,
            session_id: phase4SessionId,
            files: [
                {
                    filename: "broken.ts",
                    content: "export const nothingUsefulHere = true;",
                },
            ],
        });
        const invalidPayload = JSON.parse(invalidResponse.result.content[0].text);
        assert(invalidPayload.passed === false, "Expected broken integration to fail validation");
        assert(invalidPayload.issue_count > 0, "Expected one or more validation issues");
    });
    passed += await runCheck("emit_message stores messages visible in get_session_status", async () => {
        const messageResponse = await callTool(server, 41, "emit_message", {
            org_token: consumerToken,
            session_id: schemaSessionId2,
            message: {
                text: "Can you confirm the nearby endpoint rate limit?",
                kind: "question",
            },
        });
        const messagePayload = JSON.parse(messageResponse.result.content[0].text);
        assert(messagePayload.session_message_count > 0, "Expected session message count to increase");
        const statusResponse = await callTool(server, 42, "get_session_status", {
            org_token: consumerToken,
            session_id: schemaSessionId2,
        });
        const statusPayload = JSON.parse(statusResponse.result.content[0].text);
        assert(statusPayload.messages.some((message) => message.text.includes("nearby endpoint rate limit")), "Expected emitted message in session status");
    });
    passed += await runCheck("generate_integration with an LLM API key uses the real configured LLM when available", async () => {
        const { config } = await import("../config/index.js");
        if (!config.llm.apiKey) {
            return;
        }
        const registerResponse = await callTool(server, 43, "register_service", {
            org_token: providerToken,
            service_name: "LLM Service",
            service_description: "Phase 4 llm path",
        });
        const llmServiceId = JSON.parse(registerResponse.result.content[0].text).service_id;
        const providerJoin = await callTool(server, 44, "join_session", {
            org_token: providerToken,
            service_id: llmServiceId,
        });
        llmSessionId = JSON.parse(providerJoin.result.content[0].text).session_id;
        await callTool(server, 45, "join_session", {
            org_token: consumerToken,
            service_id: llmServiceId,
        });
        await callTool(server, 46, "publish_schema", {
            org_token: providerToken,
            session_id: llmSessionId,
            schema: {
                base_url: "https://llm.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-LLM-Key" },
                endpoints: [
                    {
                        path: "/v1/tasks",
                        method: "GET",
                        summary: "List tasks",
                        parameters: [
                            { name: "workspace_id", in: "query", required: true, schema: { type: "string" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
            },
        });
        const generateResponse = await callTool(server, 47, "generate_integration", {
            org_token: consumerToken,
            session_id: llmSessionId,
            consumer_context: {
                language: "typescript",
                framework: "nextjs",
                use_case: "List tasks for a workspace",
            },
        });
        const payload = JSON.parse(generateResponse.result.content[0].text);
        assert(payload.source === "llm", `Expected llm source, received ${payload.source}`);
        assert(payload.model === config.llm.model, `Expected configured model ${config.llm.model}, received ${payload.model}`);
        assert(payload.files.every((file) => file.source === "llm_generated"), "Expected llm_generated files");
        assert(payload.files.every((file) => file.content.length > 0), "Expected non-empty LLM-generated file content");
    });
    passed += await runCheck("publish_to_registry publishes a schema without a session", async () => {
        const registerResponse = await callTool(server, 48, "register_service", {
            org_token: providerToken,
            service_name: "Registry Places API",
            service_description: "Standalone registry service",
            tags: ["maps", "places"],
        });
        registryServiceId = JSON.parse(registerResponse.result.content[0].text).service_id;
        const response = await callTool(server, 49, "publish_to_registry", {
            org_token: providerToken,
            service_id: registryServiceId,
            schema: {
                base_url: "https://registry.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-REGISTRY-KEY" },
                endpoints: [
                    {
                        path: "/v1/places/search",
                        method: "GET",
                        summary: "Search places",
                        parameters: [
                            { name: "query", in: "query", required: true, schema: { type: "string" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
            },
            changelog: "Initial registry release",
            tags: ["maps", "places"],
        });
        const payload = JSON.parse(response.result.content[0].text);
        registryEntryId = payload.registry_id;
        assert(payload.registry_id.startsWith("reg_"), `Expected registry id, received ${payload.registry_id}`);
        assert(payload.version === "1.0.0", `Expected 1.0.0, received ${payload.version}`);
    });
    passed += await runCheck("GET /registry/schemas lists published schemas and supports tag filtering", async () => {
        const response = await server.inject({
            method: "GET",
            url: "/registry/schemas?tags=maps,places",
        });
        const payload = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(payload.schemas.some((entry) => entry.serviceId === registryServiceId), "Expected published registry service in listing");
    });
    passed += await runCheck("discover_from_registry works without an active session", async () => {
        const response = await callTool(server, 50, "discover_from_registry", {
            org_token: consumerToken,
            service_id: registryServiceId,
            version: "latest",
        });
        const payload = JSON.parse(response.result.content[0].text);
        assert(payload.registry_id === registryEntryId, `Expected ${registryEntryId}, received ${payload.registry_id}`);
        assert(payload.version === "1.0.0", `Expected 1.0.0, received ${payload.version}`);
        assert(Array.isArray(payload.schema_history), "Expected schema_history array");
    });
    passed += await runCheck("list_registry MCP tool returns published services", async () => {
        const response = await callTool(server, 51, "list_registry", {
            org_token: consumerToken,
            tags: ["maps"],
        });
        const payload = JSON.parse(response.result.content[0].text);
        assert(payload.services.some((service) => service.service_id === registryServiceId), "Expected list_registry to include published service");
    });
    passed += await runCheck("registry diff endpoint returns differences between two published versions", async () => {
        await callTool(server, 52, "publish_to_registry", {
            org_token: providerToken,
            service_id: registryServiceId,
            schema: {
                base_url: "https://registry.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-REGISTRY-KEY" },
                endpoints: [
                    {
                        path: "/v1/places/search",
                        method: "GET",
                        summary: "Search places",
                        parameters: [
                            { name: "query", in: "query", required: true, schema: { type: "string" } },
                            { name: "region", in: "query", required: false, schema: { type: "string" } },
                        ],
                        response_schema: { type: "object" },
                    },
                ],
            },
            changelog: "Added optional region filter",
            tags: ["maps", "places"],
        });
        const response = await server.inject({
            method: "GET",
            url: `/registry/services/${registryServiceId}/diff?from=1.0.0&to=1.1.0`,
        });
        const payload = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(payload.hasDiff === true, "Expected diff to exist");
        assert(payload.additiveCount > 0, "Expected additive diff count");
    });
    passed += await runCheck("POST /generate returns files with no session setup and accepts ?api_key auth", async () => {
        const response = await server.inject({
            method: "POST",
            url: `/generate?api_key=${encodeURIComponent("dev-provider-secret")}`,
            payload: {
                service_id: registryServiceId,
                version: "latest",
                consumer_context: {
                    language: "typescript",
                    framework: "nextjs",
                    use_case: "Search places in a storefront flow",
                    existing_patterns: "We use axios and dotenv",
                },
                options: {
                    include_tests: true,
                    endpoints: ["/v1/places/search"],
                },
            },
        });
        const payload = response.json();
        standaloneGeneratedFiles = payload.files;
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(payload.service_id === registryServiceId, `Expected ${registryServiceId}, received ${payload.service_id}`);
        assert(payload.schema_version === "1.1.0", `Expected 1.1.0, received ${payload.schema_version}`);
        assert(Array.isArray(payload.files) && payload.files.length >= 2, "Expected generated files");
        assert(payload.generation_time_ms >= 0, "Expected non-negative generation time");
    });
    passed += await runCheck("POST /generate with more than 5 endpoints returns 202 and a job id", async () => {
        const registerResponse = await callTool(server, 53, "register_service", {
            org_token: providerToken,
            service_name: "Large Registry API",
            service_description: "Async generation coverage",
            tags: ["async"],
        });
        largeRegistryServiceId = JSON.parse(registerResponse.result.content[0].text).service_id;
        await callTool(server, 54, "publish_to_registry", {
            org_token: providerToken,
            service_id: largeRegistryServiceId,
            schema: {
                base_url: "https://large.example.com",
                auth: { type: "api_key", location: "header", key_name: "X-LARGE-KEY" },
                endpoints: [
                    { path: "/v1/a", method: "GET", summary: "A", parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], response_schema: { type: "object" } },
                    { path: "/v1/b", method: "GET", summary: "B", parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], response_schema: { type: "object" } },
                    { path: "/v1/c", method: "GET", summary: "C", parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], response_schema: { type: "object" } },
                    { path: "/v1/d", method: "GET", summary: "D", parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], response_schema: { type: "object" } },
                    { path: "/v1/e", method: "GET", summary: "E", parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], response_schema: { type: "object" } },
                    { path: "/v1/f", method: "GET", summary: "F", parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }], response_schema: { type: "object" } },
                ],
            },
            changelog: "Initial async release",
            tags: ["async"],
        });
        const response = await server.inject({
            method: "POST",
            url: "/generate",
            headers: {
                authorization: `Bearer ${consumerToken}`,
            },
            payload: {
                service_id: largeRegistryServiceId,
                version: "latest",
                consumer_context: {
                    language: "typescript",
                    framework: "nextjs",
                    use_case: "Load six resources",
                },
                options: {
                    include_tests: true,
                },
            },
        });
        const payload = response.json();
        asyncJobId = payload.job_id;
        assert(response.statusCode === 202, `Expected 202, received ${response.statusCode}`);
        assert(payload.job_id.startsWith("job_"), `Expected job id, received ${payload.job_id}`);
        assert(payload.status === "pending", `Expected pending, received ${payload.status}`);
    });
    passed += await runCheck("GET /generate/status/:job_id returns the completed async result after polling", async () => {
        let status = "";
        let lastPayload = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const response = await server.inject({
                method: "GET",
                url: `/generate/status/${asyncJobId}`,
                headers: {
                    authorization: `Bearer ${consumerToken}`,
                },
            });
            lastPayload = response.json();
            status = lastPayload?.status ?? "";
            if (status === "complete") {
                break;
            }
            if (status === "failed") {
                throw new Error("Expected async generate job to complete successfully");
            }
            await sleep(20);
        }
        assert(status === "complete", `Expected complete, received ${status}`);
        assert(lastPayload?.result?.service_id === largeRegistryServiceId, "Expected async result service id");
        assert((lastPayload?.result?.files.length ?? 0) >= 2, "Expected async generated files");
    });
    passed += await runCheck("POST /validate runs standalone validation against a published schema", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/validate",
            headers: {
                authorization: `Bearer ${consumerToken}`,
            },
            payload: {
                service_id: registryServiceId,
                version: "latest",
                language: "typescript",
                code: standaloneGeneratedFiles.map((file) => file.content).join("\n"),
            },
        });
        const payload = response.json();
        assert(response.statusCode === 200, `Expected 200, received ${response.statusCode}`);
        assert(payload.passed === true, "Expected standalone validation to pass");
        assert(payload.issue_count === 0, `Expected 0 issues, received ${payload.issue_count}`);
        assert(payload.schema_version === "1.1.0", `Expected 1.1.0, received ${payload.schema_version}`);
    });
    passed += await runCheck("CLI generate command writes generated files to disk", async () => {
        const serverAddress = await server.listen({ host: "127.0.0.1", port: 0 });
        const outputDir = await mkdtemp(join(tmpdir(), "bridgefill-cli-"));
        const { stdout } = await execFileAsync(process.execPath, [
            "node_modules/tsx/dist/cli.mjs",
            "cli/generate.ts",
            "--service", registryServiceId,
            "--language", "typescript",
            "--framework", "nextjs",
            "--use-case", "Search nearby places",
            "--out", outputDir,
            "--server", serverAddress,
            "--key", "dev-provider-secret",
        ], {
            cwd: process.cwd(),
        });
        const files = await readdir(outputDir);
        assert(files.length >= 2, `Expected generated files on disk, received ${files.length}`);
        const firstFile = await readFile(join(outputDir, files[0]), "utf8");
        assert(firstFile.length > 0, "Expected generated file content");
        assert(stdout.includes("BridgeFill - Generated") || stdout.includes("BridgeFill — Generated"), "Expected CLI summary output");
    });
    await server.close();
    if (passed !== 43) {
        process.exit(1);
    }
}
void main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
});
