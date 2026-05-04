import { issueOrgToken, verifyOrgToken } from "../src/auth/index.js";
import { handleMcpRequest } from "../src/mcp/router.js";
import { bumpVersion, detectConflicts, diff } from "../src/schema/negotiation.js";

describe("BridgeFill smoke tests", () => {
  test("tools/list exposes ten MCP tools", async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
      {
        protocolVersion: "2024-11-05",
        serverName: "bridgefill",
        serverVersion: "0.1.0",
      },
    );

    expect((response as { result: { tools: unknown[] } }).result.tools).toHaveLength(10);
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
      auth: { type: "api_key" as const, key_name: "X-API-Key" },
      endpoints: [{ path: "/v1/search", method: "GET" as const, summary: "", all_params: [] }],
      rate_limits: {},
    };
    const next = {
      base_url: "https://api.example.com",
      auth: { type: "api_key" as const, key_name: "X-API-Key" },
      endpoints: [],
      rate_limits: {},
    };

    const schemaDiff = diff(previous, next);
    const bumped = bumpVersion([{ version: "1.0.0", publishedAt: "2026-01-01T00:00:00.000Z", isBreaking: false, schema: previous as never }], next as never, schemaDiff);

    expect(schemaDiff.breakingCount).toBe(1);
    expect(bumped.version).toBe("2.0.0");
  });

  test("conflict detection only returns breaking changes for requested endpoints", () => {
    const schemaDiff = diff(
      {
        base_url: "https://api.example.com",
        auth: { type: "api_key" as const, key_name: "X-API-Key" },
        endpoints: [
          { path: "/v1/search", method: "GET" as const, summary: "", all_params: [] },
          { path: "/v1/nearby", method: "GET" as const, summary: "", all_params: [] },
        ],
        rate_limits: {},
      },
      {
        base_url: "https://api.example.com",
        auth: { type: "api_key" as const, key_name: "X-API-Key" },
        endpoints: [
          {
            path: "/v1/search",
            method: "GET" as const,
            summary: "",
            all_params: [{ name: "region", in: "query" as const, required: true, schema: { type: "string" }, description: "" }],
          },
        ],
        rate_limits: {},
      },
    );

    const conflicts = detectConflicts(schemaDiff, {
      endpoints_needed: ["/v1/search"],
      language: "typescript",
    });

    expect(conflicts.conflictCount).toBe(1);
    expect(conflicts.conflicts[0].path).toContain("/v1/search");
  });
});
