import { issueOrgToken, verifyOrgToken } from "../src/auth/index.js";
import { config } from "../config/index.js";
import { ensureSeededKeys } from "../src/auth/api-keys.js";
import { handleMcpRequest } from "../src/mcp/router.js";
import { initStores } from "../src/persistence/index.js";
import { bumpVersion, detectConflicts, diff } from "../src/schema/negotiation.js";
describe("BridgeFill smoke tests", () => {
    beforeAll(async () => {
        await initStores({ backend: "memory", force: true });
        await ensureSeededKeys();
    });
    test("tools/list exposes thirteen MCP tools", async () => {
        const response = await handleMcpRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
        }, {
            protocolVersion: "2024-11-05",
            serverName: "bridgefill",
            serverVersion: "0.1.0",
        });
        expect(response.result.tools).toHaveLength(13);
    });
    test("issued org tokens round-trip through verification", () => {
        const token = issueOrgToken("org_demo_provider", "dev-provider-secret", "provider");
        const claims = verifyOrgToken(token);
        expect(claims.orgId).toBe("org_demo_provider");
        expect(claims.role).toBe("provider");
        expect(claims.allowedTools).toContain("register_service");
    });
    test("schema diff marks endpoint removal as breaking and bumps major version", () => {
        const previous = {
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [{ path: "/v1/search", method: "GET", summary: "", all_params: [] }],
            rate_limits: {},
        };
        const next = {
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [],
            rate_limits: {},
        };
        const schemaDiff = diff(previous, next);
        const bumped = bumpVersion([{ version: "1.0.0", publishedAt: "2026-01-01T00:00:00.000Z", isBreaking: false, schema: previous }], next, schemaDiff);
        expect(schemaDiff.breakingCount).toBe(1);
        expect(bumped.version).toBe("2.0.0");
    });
    test("conflict detection only returns breaking changes for requested endpoints", () => {
        const schemaDiff = diff({
            base_url: "https://api.example.com",
            auth: { type: "api_key", key_name: "X-API-Key" },
            endpoints: [
                { path: "/v1/search", method: "GET", summary: "", all_params: [] },
                { path: "/v1/nearby", method: "GET", summary: "", all_params: [] },
            ],
            rate_limits: {},
        }, {
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
            rate_limits: {},
        });
        const conflicts = detectConflicts(schemaDiff, {
            endpoints_needed: ["/v1/search"],
            language: "typescript",
        });
        expect(conflicts.conflictCount).toBe(1);
        expect(conflicts.conflicts[0].path).toContain("/v1/search");
    });
    test("llm config resolves a usable base URL", () => {
        expect(typeof config.llm.baseUrl).toBe("string");
        expect(config.llm.baseUrl.length).toBeGreaterThan(0);
        expect(typeof config.llm.model).toBe("string");
    });
});
