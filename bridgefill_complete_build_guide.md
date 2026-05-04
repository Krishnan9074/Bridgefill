# BridgeFill — Complete Build Guide
## All phases, from empty directory to production deployment
### Use each phase section as a self-contained Claude Code prompt

---

## READ THIS FIRST

**What BridgeFill is:**
A schema registry and code generator for API integrations. API providers publish
their schema and a working code sample once. Developers (or AI coding agents) request
production-ready integration code for their specific stack. BridgeFill diffs schema
versions, detects breaking changes, auto-bumps semver, and uses an LLM to generate
files grounded in the provider's own code — not synthesized from a description alone.

**What it is NOT:**
- Not an API gateway or proxy (nothing runs at request time in production)
- Not a documentation tool (Readme.io, Swagger UI)
- Not an iPaaS (Zapier, Make)
- Not A2A (which handles runtime agent-to-agent communication)
BridgeFill runs at **developer time**, produces code files, and gets out of the way.

**Tech stack (do not deviate):**
- Node.js 22, ESM modules — `"type": "module"` in package.json
- Fastify 4 for HTTP server
- `jsonwebtoken` for JWTs
- `zod` for validation
- `uuid` for ID generation
- `pino-pretty` for dev logging
- `pg` (node-postgres) for database (Phase 8+)
- TypeScript
- No Express. No NestJS. No Prisma. No ORM.

**Coding rules (enforce in every phase):**
1. ESM only — always `import/export`, never `require()`
2. All imports use `.js` extensions: `import { foo } from './foo.js'`
3. All env vars read in `config/index.js` only — no `process.env` elsewhere
4. All errors returned as `{ "error": "message", "code": "MACHINE_CODE" }`
5. HTTP status: 400 bad input, 401 no auth, 403 wrong scope, 404 not found,
   429 rate limit, 500 server error
6. Fastify routes return plain objects — never call `reply.send()` or `res.json()`
   for normal responses (only for raw streams)
7. Every significant action calls an audit helper from `src/auth/audit.js`
8. In-memory stores use Maps/arrays — no globals except the stores themselves
9. No `console.log` in library code — use `process.stderr.write()` for debug output

**Run the test suite after every phase:**
```bash
node test/e2e.js    # grows with each phase
npm test            # unit tests (jest)
```

---

## PHASE 1 — Project skeleton + MCP server + 10 tool stubs

### Goal
Bootstrap the project from an empty directory. Create the Fastify server,
implement the MCP JSON-RPC 2.0 protocol, and define all 10 tools with working
stubs that return mock data. By the end of Phase 1, any MCP client (including
Claude Code) can connect, call `tools/list`, and invoke every tool.

---

### Step 1 — `package.json`

```json
{
  "name": "bridgefill",
  "version": "0.1.0",
  "description": "Schema registry and code generator for API integrations",
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --experimental-vm-modules node_modules/.bin/jest"
  },
  "dependencies": {
    "fastify": "^4.26.2",
    "@fastify/cors": "^9.0.1",
    "@fastify/websocket": "^8.3.1",
    "uuid": "^9.0.1",
    "jsonwebtoken": "^9.0.2",
    "zod": "^3.22.4",
    "pino-pretty": "^11.0.0"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

Run `npm install` after creating this file.

---

### Step 2 — `config/index.js`

```js
// config/index.js
export const config = {
  server: {
    host: process.env.HOST ?? "0.0.0.0",
    port: parseInt(process.env.PORT ?? "3000"),
  },
  mcp: {
    protocolVersion: "2024-11-05",
    serverName: "bridgefill",
    serverVersion: "0.1.0",
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? "dev-secret-change-in-production",
    orgTokenTtl: "24h",
  },
  session: {
    handshakeTimeoutMs: parseInt(process.env.HANDSHAKE_TIMEOUT_MS ?? "120000"),
    maxMessagesPerSession: 1000,
  },
  orgs: {
    "org_demo_provider": {
      name: "Demo Provider",
      secret: process.env.ORG_PROVIDER_SECRET ?? "dev-provider-secret",
      allowedRoles: ["provider"],
    },
    "org_demo_consumer": {
      name: "Demo Consumer",
      secret: process.env.ORG_CONSUMER_SECRET ?? "dev-consumer-secret",
      allowedRoles: ["consumer"],
    },
    "org_demo": {
      name: "Demo Org",
      secret: process.env.ORG_DEMO_SECRET ?? "dev-demo-secret",
      allowedRoles: ["provider", "consumer"],
    },
  },
};
```

---

### Step 3 — `src/tools/definitions.js`

Define all 10 MCP tool JSON schemas. These are what agents see when they call
`tools/list`. Each tool has a `name`, `description`, and `inputSchema` (JSON Schema).

The 10 tools are:

| Tool | Role | Purpose |
|------|------|---------|
| `ping` | both | Health check — returns server time + protocol version |
| `register_service` | provider | Declare an API service on the platform |
| `join_session` | both | Create or join an integration session |
| `get_session_status` | both | Poll session state, participants, messages |
| `publish_schema` | provider | Publish OpenAPI fragment — triggers diff + semver |
| `provide_code_sample` | provider | Inject authoritative code as few-shot input |
| `discover_schema` | consumer | Get normalised API contract + version history |
| `generate_integration` | consumer | Generate integration files via LLM |
| `validate_integration` | consumer | Check generated code against schema |
| `emit_message` | both | Freeform negotiation channel within a session |

For each tool, write the full `inputSchema` with all parameters documented.
Key schemas:

**`publish_schema` — schema object:**
```json
{
  "base_url": "string (required)",
  "auth": {
    "type": "api_key | oauth2 | bearer | basic | none",
    "location": "header | query | body",
    "key_name": "string"
  },
  "endpoints": [{
    "path": "string",
    "method": "GET | POST | PUT | PATCH | DELETE",
    "summary": "string",
    "parameters": [{
      "name": "string",
      "in": "query | path | header | body",
      "required": "boolean",
      "description": "string",
      "schema": "object"
    }],
    "response_schema": "object"
  }],
  "rate_limits": {
    "requests_per_second": "number",
    "requests_per_day": "number"
  },
  "sdk_languages": ["string"]
}
```

**`generate_integration` — consumer_context object:**
```json
{
  "language": "string (required) — e.g. typescript, python, go",
  "framework": "string — e.g. nextjs, fastapi, gin",
  "use_case": "string (required) — describe what you want to build",
  "existing_patterns": "string — how your codebase handles HTTP, auth, errors",
  "endpoints_needed": ["string"] — subset of endpoint paths; empty = all
}
```

---

### Step 4 — `src/session/store.js`

In-memory session store. A session is the unit of work for one integration
handshake between a provider and consumer.

**Session lifecycle:**
- `pending` → one agent joined, waiting for the other
- `active` → both joined, negotiation can proceed
- `complete` → code has been generated
- `expired` → handshake timeout (default: 120s)

**Functions to export:**
```js
joinSession(serviceId, joinerClaims)     // creates or activates session
getSession(sessionId, callerOrgId)       // auth-checked lookup
getSessionInternal(sessionId)            // internal lookup, no auth check
attachSchema(sessionId, schemaId, schema)
attachGeneratedCode(sessionId, code)
appendMessage(sessionId, message)
closeSession(sessionId)
class SessionError extends Error         // code = -32002
```

**Session object shape:**
```js
{
  id: string,
  serviceId: string,
  status: "pending" | "active" | "complete" | "expired",
  createdAt: ISO string,
  activatedAt: ISO string | null,
  participants: {
    provider?: { orgId, orgName, joinedAt },
    consumer?: { orgId, orgName, joinedAt }
  },
  schema: null | { id, raw, normalised, codeSamples, version },
  schemaHistory: [],
  generatedCode: null | { files, summary, ... },
  messages: [],
  _expiryTimer: null  // NodeJS timer, cleared on activation
}
```

Use two Maps: `sessions` keyed by serviceId (one active per service),
`sessionById` keyed by sessionId. Schedule a `setTimeout` to expire pending
sessions using `config.session.handshakeTimeoutMs`. Call `.unref()` on the timer
so it doesn't block Node process exit.

---

### Step 5 — `src/tools/service-registry.js`

Simple in-memory store for registered services:
```js
export function registerInRegistry(serviceId, entry)
export function getPublicServiceList()
export function getService(serviceId)
export function hasService(serviceId)
```

---

### Step 6 — `src/tools/handlers.js`

Implement stub versions of all 10 tool handlers. Each handler:
1. Accepts the tool's input object (matching the `inputSchema` from definitions.js)
2. Returns a plain object (will be JSON-serialised as the tool result)
3. Is exported as a named async function

For Phase 1, stubs can return placeholder data. The important thing is that
the function signatures are correct and the file is wired up. Full logic comes
in later phases.

Example stubs:
```js
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
  return { service_id: "stub_" + Date.now(), message: "stub — auth coming in Phase 2" };
}
// ... and so on for all 10
```

Export a `TOOL_HANDLERS` map:
```js
export const TOOL_HANDLERS = {
  ping: handlers.ping,
  register_service: handlers.registerService,
  // ...all 10
};
```

---

### Step 7 — `src/mcp/router.js`

Implements MCP JSON-RPC 2.0. All MCP messages arrive as `POST /mcp`.

**Methods to handle:**
- `initialize` → return server capabilities + `protocolVersion`
- `initialized` → notification, no response (return null)
- `ping` → return `{}` (MCP spec liveness ping)
- `tools/list` → return `{ tools: TOOL_DEFINITIONS }`
- `tools/call` → dispatch to `TOOL_HANDLERS[params.name](params.arguments)`
- `resources/list` → return `{ resources: [] }` (not implemented)
- `prompts/list` → return `{ prompts: [] }` (not implemented)
- anything else → JSON-RPC error -32601 Method not found

**Error codes:**
- `-32700` Parse error
- `-32600` Invalid request
- `-32601` Method not found
- `-32602` Invalid params
- `-32000` Internal error
- `-32001` Auth error (custom)
- `-32002` Session error (custom)
- `-32003` Validation error (custom)

**Tool call result format (MCP spec):**
```json
{
  "content": [{ "type": "text", "text": "<JSON string of result>" }],
  "isError": false
}
```

Export:
```js
export async function handleMcpRequest(request, meta = {})
export async function handleMcpBatch(requests, meta = {})
```

---

### Step 8 — `src/server.js`

Fastify server with:
- CORS via `@fastify/cors`
- WebSocket via `@fastify/websocket`
- Pretty logging in dev (`pino-pretty`)

**Routes:**

```
GET  /health          → { status, server, version, protocol, time }
POST /mcp             → MCP HTTP transport (JSON-RPC 2.0, single + batch)
GET  /mcp/ws          → MCP WebSocket transport (newline-delimited JSON-RPC)
GET  /services        → { services: getPublicServiceList() }
```

For `POST /mcp`: accept both single request objects and arrays (batches).
For notifications (no `id`), return HTTP 202 with empty body.

For `GET /mcp/ws`: each WebSocket connection handles messages independently.
Send keep-alive pings every 30s using `setInterval`. Call `.unref()` on the interval.

Start listening at `config.server.host:config.server.port`.

---

### Step 9 — `test/e2e.js`

Write a test script (not jest — just `node test/e2e.js`) that verifies:
1. `GET /health` returns `{ status: "ok" }`
2. `POST /mcp` with `initialize` returns capabilities with `tools` key
3. `tools/list` returns all 10 tools
4. `tools/call` with `ping` returns `{ status: "ok" }`
5. `tools/call` with unknown tool returns JSON-RPC error -32601
6. `GET /services` returns `{ services: [] }`

Print `✓ PASS` or `✗ FAIL` for each assertion.

---

### Phase 1 definition of done
- `npm run dev` starts without errors on port 3000
- `GET /health` returns 200
- `POST /mcp` with `initialize` returns server capabilities
- `tools/list` returns all 10 tool definitions
- `ping` tool returns correct response
- `node test/e2e.js` passes all 6 assertions

---

## PHASE 2 — Auth: API keys, scoped JWTs, audit log

### Goal
Add real authentication. Orgs authenticate with hashed API keys to get scoped JWTs.
JWTs encode which MCP tools the caller may invoke. Every auth and tool event is
recorded to a structured audit log. Tool handlers start enforcing auth.

---

### `src/auth/api-keys.js`

Manages long-lived API keys for orgs. Keys look like `bf_{orgId}_{48 hex chars}`.

**Storage:** two Maps — `byHash` (SHA-256 hash → record) and `byOrg` (orgId → record[]).
Never store the raw key.

**Key lifecycle:** `active` → `rotating` (grace period after rotation) → `revoked`

**Functions to export:**
```js
createApiKey(orgId, { label, ttlDays })
  // Returns { rawKey: string, record: KeyRecord }
  // rawKey is shown ONCE — never stored

verifyApiKey(rawKey)
  // Returns KeyRecord | throws ApiKeyError
  // Updates lastUsedAt on success
  // Rejects revoked keys immediately
  // Rejects expired keys (checks expiresAt)

rotateKey(keyId, { gracePeriodMs })
  // Creates replacement key, marks old as "rotating"
  // Schedules setTimeout to auto-revoke old key after gracePeriodMs
  // Returns { rawKey, newRecord, oldRecord }

revokeKey(keyId)
  // Sets status = "revoked" immediately

listOrgKeys(orgId)
  // Returns records WITHOUT the hash field (never expose hashes)

seedDevKey(orgId, rawKey)
  // Idempotent — creates key from a known raw value for dev/testing
  // Only creates if that hash doesn't already exist

class ApiKeyError extends Error  // code = -32001
```

**Key hashing:** use `createHash('sha256')` from Node's built-in `crypto` module.
SHA-256 is sufficient for API keys (they're already high-entropy random strings).

Seed dev keys from `config.orgs` at module init:
```js
for (const [orgId, org] of Object.entries(config.orgs)) {
  if (org.secret) seedDevKey(orgId, org.secret);
}
```

---

### `src/auth/audit.js`

Structured append-only audit log. Non-blocking — `audit()` never throws.

**Storage:** in-memory circular buffer, max 10,000 entries (evict oldest).

**`audit(category, event, context = {})` — core function:**
```js
const entry = { seq: ++seq, ts: new Date().toISOString(), category, event, ...context };
log.push(entry); // evict if full
// Also broadcast to SSE bus (lazy import — src/events/bus.js — to avoid circular dep)
// Write to stderr in dev
```

**Five category helpers to export:**
```js
export const auditAuth = {
  tokenIssued(orgId, role, serviceId),
  tokenVerified(orgId, role),
  tokenFailed(reason, ip),
  keyCreated(orgId, keyId, label),
  keyVerified(orgId, keyId),
  keyRotated(orgId, oldKeyId, newKeyId),
  keyRevoked(orgId, keyId, reason),
  accessDenied(orgId, toolName, reason),
}

export const auditSession = {
  created(sessionId, serviceId, initiatorOrgId, role),
  activated(sessionId, providerOrgId, consumerOrgId),
  completed(sessionId),
  expired(sessionId, reason),
}

export const auditTool = {
  called(orgId, role, toolName, sessionId),
  succeeded(orgId, toolName, durationMs),
  failed(orgId, toolName, errorCode, errorMessage),
}

export const auditSchema = {
  published(sessionId, schemaId, orgId, endpointCount),
  discovered(sessionId, schemaId, orgId),
  diffed(sessionId, changeCount),
}

export const auditCodegen = {
  started(sessionId, orgId, language, framework),
  completed(sessionId, fileCount, durationMs),
  failed(sessionId, reason),
}

export function queryAuditLog({ orgId, category, sessionId, limit = 100 })
export function auditLogSize()
```

---

### `src/auth/index.js`

JWT issuance and verification layer.

**`issueOrgToken(orgId, rawApiKey, role, serviceId)` — full flow:**
1. Look up org in `config.orgs` — throw `AuthError` if not found
2. Call `verifyApiKey(rawApiKey)` — throws `ApiKeyError` on failure
3. Check `keyRecord.orgId === orgId` — throw if mismatch
4. Check `org.allowedRoles.includes(role)` — throw if not allowed
5. Call `toolsForRole(role)` to get allowed tool list
6. Generate `jti` with `randomBytes(16).toString('hex')`
7. Sign JWT with payload:
   ```js
   { sub: orgId, orgName, role, serviceId, allowedTools, jti, keyId: keyRecord.keyId }
   ```
8. Call `auditAuth.tokenIssued(orgId, role, serviceId)`
9. Return signed JWT string

**`verifyOrgToken(token)` — full flow:**
1. If token is null/undefined → throw `AuthError("Missing org token")`
2. `jwt.verify(token, config.jwt.secret)` — throw wrapped `AuthError` on failure
3. Check `revokedJtis.has(claims.jti)` — throw `AuthError("Token revoked")`
4. Call `auditAuth.tokenVerified(claims.sub, claims.role)`
5. Return `{ orgId, orgName, role, serviceId, allowedTools, jti, keyId }`

**`assertToolAllowed(claims, toolName)`:**
- If `!claims.allowedTools.includes(toolName)`:
  Call `auditAuth.accessDenied(...)` then throw `AuthError`

**`toolsForRole(role)` — returns tool allowlist:**
```js
const shared = ["ping", "get_session_status", "emit_message"];
const byRole = {
  provider: [...shared, "register_service", "join_session", "publish_schema", "provide_code_sample"],
  consumer: [...shared, "join_session", "discover_schema", "generate_integration", "validate_integration"],
};
```

**Token revocation list:** `const revokedJtis = new Set()` module-level.
Export `revokeToken(jti)` that adds to the set.

---

### Update `src/tools/handlers.js` — add real auth

Every handler except `ping` must now:
1. Call `verifyOrgToken(args.org_token)` at the top
2. Call `assertToolAllowed(claims, "tool_name")`
3. Call `auditTool.called(claims.orgId, claims.role, "tool_name", sessionId)`
4. At the end on success: call `auditTool.succeeded(...)`
5. In catch: call `auditTool.failed(...)`

Implement `registerService` fully:
```js
// in-memory serviceRegistry Map (module-level in handlers.js)
export async function registerService({ org_token, service_name, service_description, service_version = "1.0.0", tags = [] }) {
  const claims = verifyOrgToken(org_token);
  assertToolAllowed(claims, "register_service");
  const serviceId = `svc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const entry = { id: serviceId, name: service_name, description: service_description,
    version: service_version, tags, providerOrgId: claims.orgId,
    providerOrgName: claims.orgName, registeredAt: new Date().toISOString() };
  serviceRegistry.set(serviceId, entry);
  registerInRegistry(serviceId, entry); // also update service-registry.js
  return { service_id: serviceId, message: `Service "${service_name}" registered.`, service: entry };
}
```

Implement `joinSession` fully — calls `storeJoinSession(serviceId, claims)` from
session/store.js. Returns `{ session_id, status, role, allowed_tools, participants, message }`.

Implement `getSessionStatus` fully — returns full session state including last 5 messages.

---

### Update `src/server.js` — add auth REST routes

```
POST /auth/token
  Body: { org_id, api_key, role, service_id }
  Calls issueToken(org_id, api_key, role, service_id)
  Returns: { token, org_id, role, service_id, expires_in }

POST /auth/keys
  Body: { org_id, label?, ttl_days? }
  Calls createApiKey(org_id, ...)
  Returns: { raw_key (ONCE), key_id, label, expires_at }
  Audit: auditAuth.keyCreated(...)

GET  /auth/keys/:org_id
  Returns: { org_id, keys: listOrgKeys(org_id) }

POST /auth/keys/:key_id/rotate
  Body: { grace_period_ms? }
  Calls rotateKey(key_id, ...)
  Audit: auditAuth.keyRotated(...)

DELETE /auth/keys/:key_id
  Calls revokeKey(key_id)
  Audit: auditAuth.keyRevoked(...)

GET  /audit
  Query: ?org_id=&category=&session_id=&limit=
  Returns: { entries: queryAuditLog(...) }
```

---

### `src/events/bus.js`

Simple SSE broadcast bus (needed by audit.js):
```js
const clients = new Set();

export function addClient(reply)   // returns cleanup function
export function broadcast(entry)   // sends data: JSON\n\n to all clients
export function clientCount()
```

---

### Phase 2 definition of done
- `POST /auth/token` with valid API key returns a signed JWT
- JWT contains `jti`, `keyId`, `allowedTools`, `role`
- Provider token cannot call `discover_schema` (403)
- Consumer token cannot call `publish_schema` (403)
- Key rotation: old key still works during grace period, rejected after
- Revoked key is rejected immediately
- `GET /audit` returns events for all auth operations
- All Phase 1 tests still pass
- Add 12 new assertions to `test/e2e.js` covering the above

---

## PHASE 3 — Schema negotiation: diff, versioning, conflict detection

### Goal
Implement the semantic diff engine. When a provider publishes a new schema version,
BridgeFill diffs it against the previous version, classifies every change, bumps semver
automatically, and can cross-reference breaking changes against a specific consumer's
needs to surface only the conflicts that actually affect them.

---

### `src/schema/negotiation.js`

**`diff(prev, next)` — compares two normalised schema contracts:**

Returns `SchemaDiff`:
```js
{
  hasDiff: boolean,
  isBreaking: boolean,
  breakingCount: number,
  warningCount: number,
  additiveCount: number,
  infoCount: number,
  suggestedVersionBump: "major" | "minor" | "patch",
  changes: Change[]
}
```

Each `Change`:
```js
{
  severity: "breaking" | "warning" | "additive" | "info",
  path: string,      // e.g. "endpoints.GET:/v1/search.params.query"
  change: string,    // e.g. "removed" | "added_required" | "modified" | "added_optional"
  from: any,
  to: any,
  message: string    // human-readable explanation
}
```

**Change classification rules (implement all):**

| Change | Severity | Reason |
|--------|----------|--------|
| Endpoint removed | breaking | Consumers calling it get 404 |
| New required param added | breaking | Old consumers missing it get 400 |
| Required param removed | breaking | May be relied on |
| Auth type changed | breaking | Consumers must update credential handling |
| Auth key_name changed | breaking | Header/param name consumers use |
| Base URL changed | breaking | All consumers must update HTTP client |
| Rate limit tightened | warning | Consumers may start hitting 429 |
| New endpoint added | additive | Backward compatible |
| Required param made optional | additive | Backward compatible |
| New optional param added | additive | Backward compatible |
| Rate limit loosened | info | Positive change |
| Description/summary changed | info | No code impact |

**`detectConflicts(schemaDiff, consumerContext)` — cross-references breaking changes:**

`consumerContext` has `{ endpoints_needed?: string[], language?: string }`.

A change only becomes a conflict if it affects an endpoint the consumer declared
they need. If `endpoints_needed` is empty, all breaking changes are conflicts.

Returns `ConflictReport`:
```js
{
  hasConflicts: boolean,
  conflictCount: number,
  warningCount: number,
  conflicts: EnrichedChange[],  // breaking changes that affect this consumer
  warnings: EnrichedChange[],
  recommendation: string
}
```

Each `EnrichedChange` adds:
```js
{
  consumer_impact: string,  // e.g. "TypeScript code missing param X will get 400"
  remediation: string       // e.g. "Add the 'maxResultCount' parameter"
}
```

**`negotiate({ publishedSchema, previousSchema, consumerContext })` — full round:**

Combines diff + conflict detection. Returns `NegotiationResult`:
```js
{
  canProceed: boolean,
  blockedEndpoints: string[],
  usableEndpoints: string[],
  diff: SchemaDiff,
  conflicts: ConflictReport,
  negotiationMessages: [{ to: "provider"|"consumer"|"both", type: string, content: string }]
}
```

**`bumpVersion(history, newSchema, schemaDiff)` — semver management:**

Rules:
- No previous version → start at `"1.0.0"`
- `schemaDiff.breakingCount > 0` → major bump (`1.0.0` → `2.0.0`)
- `schemaDiff.warningCount > 0 || schemaDiff.additiveCount > 0` → minor bump
- Info-only changes → patch bump

Returns `{ version: string, history: VersionRecord[] }`.

---

### Update `src/tools/handlers.js` — implement `publishSchema` fully

```js
export async function publishSchema({ org_token, session_id, schema }) {
  const claims = verifyOrgToken(org_token);
  assertToolAllowed(claims, "publish_schema");
  auditTool.called(claims.orgId, claims.role, "publish_schema", session_id);

  const session = getSession(session_id, claims.orgId);
  assertSessionActive(session); // throw SessionError if not active

  // Validate schema structure
  if (!schema.base_url) throw new ValidationError("schema.base_url is required");
  if (!schema.auth?.type) throw new ValidationError("schema.auth.type is required");
  if (!Array.isArray(schema.endpoints) || !schema.endpoints.length)
    throw new ValidationError("schema.endpoints must be a non-empty array");

  const schemaId = `schema_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const normalised = normaliseSchema(schema); // internal helper

  // Diff against previous version
  const previousNormalised = session.schema?.normalised ?? null;
  const schemaDiff = previousNormalised ? diff(previousNormalised, normalised) : null;

  // Version bump
  const history = session.schemaHistory ?? [];
  const { version, history: newHistory } = bumpVersion(history, normalised, schemaDiff);
  normalised.version = version;

  attachSchema(session_id, schemaId, { raw: schema, normalised, codeSamples: [], version });
  const s = getSessionInternal(session_id);
  s.schemaHistory = newHistory;

  auditSchema.published(session_id, schemaId, claims.orgId, schema.endpoints.length);

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
}
```

Also implement `discoverSchema` — returns the normalised contract + version history
+ code samples count. Calls `auditSchema.discovered`.

`normaliseSchema(raw)` internal helper — converts raw schema to normalised shape:
```js
{
  base_url, auth: { type, location, key_name },
  endpoints: [{ path, method, summary, required_params, optional_params, all_params, response_schema }],
  rate_limits, sdk_languages, normalised_at
}
```

---

### Phase 3 definition of done
- Publish schema v1 → gets version `"1.0.0"`
- Publish schema v2 with a removed endpoint + new required param → gets `"2.0.0"`,
  `diff_summary.breaking = 2`, `diff_summary.warnings = 0`
- Publish schema v2 with only new optional param → gets `"1.1.0"` (minor bump)
- `detectConflicts` only flags changes relevant to consumer's `endpoints_needed`
- `discover_schema` returns version history with 2 entries
- Add 8 new assertions to `test/e2e.js` covering all of the above

---

## PHASE 4 — LLM code generation orchestrator

### Goal
Implement the code generation engine. When a consumer calls `generate_integration`,
BridgeFill runs schema negotiation, calls an LLM (OpenAI-compatible — see Phase 5
for provider flexibility), injects the provider's code samples as few-shot examples,
and returns named files. Falls back to a deterministic stub generator if no API key
is set — so the tool never hard-errors.

---

### `src/codegen/orchestrator.js`

**Main export:**
```js
export async function generateIntegrationCode({ sessionId, orgId, contract, codeSamples, consumerContext, negotiation })
  // Returns GeneratedOutput
```

**`GeneratedOutput` shape:**
```js
{
  files: [{ filename, description, content, source }],
  // source = "llm_generated" | "provider_sample" | "fallback_generated"
  summary: string,
  nextSteps: string[],
  warnings: string[],
  source: "llm" | "fallback",
  model: string | null,
}
```

**LLM call strategy:**

Build two prompt sections:

*System prompt* — positions the model as a senior integration engineer with access
to both sides' context:
```
You are a senior integration engineer at BridgeFill, a B2B middleware platform.
Your job is to generate production-quality integration code that lets a consumer
application call a provider's API correctly and safely.

CRITICAL OUTPUT FORMAT:
Respond with ONLY a valid JSON object — no markdown, no explanation, no preamble.
The JSON must have this exact structure:
{
  "files": [{ "filename": "...", "description": "...", "content": "..." }],
  "summary": "2-3 sentence summary",
  "nextSteps": ["step 1", ...],
  "warnings": ["any caveats"]
}
```

*User message* — four structured sections:
1. Consumer stack context (language, framework, use_case, existing_patterns)
2. Provider API contract (base_url, auth, all endpoints + params)
3. Provider-supplied code samples labelled "AUTHORITATIVE — treat as ground truth"
4. Conflict/negotiation result (which endpoints are usable vs blocked)

**Prompt construction rules:**
- If `negotiation.blockedEndpoints.length > 0`, explicitly list them under
  "DO NOT generate code for these endpoints:" in the user message
- Provider samples section header: "## Provider-supplied authoritative code samples\n
  The following samples come directly from the provider's engineering team.
  Treat them as ground truth — adapt for the consumer's stack but stay consistent
  with the patterns shown."
- Filter target endpoints: if `consumer_context.endpoints_needed` is non-empty,
  only include those endpoints in the prompt

**Response parsing:**
Strip markdown fences if present, then `JSON.parse()`. If parse fails, try extracting
a JSON object with regex `\{[\s\S]*\}`. If that also fails, throw and fall back.

**Fallback stub generator** (used when no API key or LLM call fails):

Produces for each endpoint:
- `auth_setup.{ext}` — HTTP client config with the correct auth type
- `{endpoint_path_as_filename}.{ext}` — typed stub using the provider sample if
  available, otherwise generates from schema
- `integration.test.{ext}` — basic test file

Language extensions: `typescript`→`.ts`, `python`→`.py`, `go`→`.go`, else `.js`

For `auth_setup.ts` with API key auth:
```typescript
import axios from 'axios';

const API_KEY = process.env.{KEY_NAME_FROM_SCHEMA} ?? '';
if (!API_KEY) console.warn('[bridgefill] Missing API key — requests will fail');

export const apiClient = axios.create({
  baseURL: '{base_url}',
  {auth_location === 'query' ? `params: { {key_name}: API_KEY },` : `headers: { '{key_name}': API_KEY },`}
  timeout: 10_000,
});
```

Tag every file with its source:
- `"provider_sample"` if content comes from a `provideCodeSample` call
- `"llm_generated"` if content comes from the LLM
- `"fallback_generated"` if content is deterministic stub

---

### Update `src/tools/handlers.js` — implement `generateIntegration` and `validateIntegration`

**`generateIntegration`:**
```js
export async function generateIntegration({ org_token, session_id, consumer_context }) {
  const claims = verifyOrgToken(org_token);
  assertToolAllowed(claims, "generate_integration");
  auditTool.called(claims.orgId, claims.role, "generate_integration", session_id);

  const session = getSession(session_id, claims.orgId);
  assertSessionActive(session);
  if (!session.schema) throw new ValidationError("No schema. Provider must call publish_schema first.");

  const contract = session.schema.normalised;
  const codeSamples = session.schema.codeSamples ?? [];

  // Run negotiation
  const negotiationResult = negotiate({
    publishedSchema: contract,
    previousSchema: null,
    consumerContext: consumer_context,
  });

  const t0 = Date.now();
  const generated = await generateIntegrationCode({
    sessionId: session_id, orgId: claims.orgId,
    contract, codeSamples, consumerContext: consumer_context,
    negotiation: negotiationResult,
  });

  attachGeneratedCode(session_id, generated);
  auditTool.succeeded(claims.orgId, "generate_integration", Date.now() - t0);

  return {
    status: "generated",
    language: consumer_context.language ?? "typescript",
    source: generated.source,
    model: generated.model ?? null,
    files: generated.files,
    summary: generated.summary,
    next_steps: generated.nextSteps,
    warnings: generated.warnings ?? [],
    blocked_endpoints: negotiationResult.blockedEndpoints,
    message: "Integration code generated. Call validate_integration to check for issues.",
  };
}
```

**`validateIntegration`** — checks generated code against the session schema:
- Required params: for each endpoint in the schema, check that all `required_params`
  appear as strings somewhere in the code
- Base URL: check that `contract.base_url` appears in the code
- Auth: check that `contract.auth.key_name` appears in the code

Return `{ passed: boolean, issue_count: number, issues: [{ severity, endpoint, message }] }`.

Also implement `provideCodeSample` — appends to `session.schema.codeSamples`.
Returns `{ message, total_samples }`.

Also implement `emitMessage` — appends to `session.messages`.
Returns `{ message_id, session_message_count, message }`.

---

### Phase 4 definition of done
- `generate_integration` called with no API key → returns fallback files tagged
  `fallback_generated` or `provider_sample`
- `generate_integration` called with `LLM_API_KEY` set → calls OpenAI-compatible
  API and returns files tagged `llm_generated`
- Provider sample, when provided, appears in generated output (verify the key param
  from the sample is in the generated code)
- `validate_integration` returns `passed: true` for correct code, detects missing
  required params
- `emit_message` stores messages visible in `get_session_status`
- Add 6 new assertions to `test/e2e.js`

---

## PHASE 5 — LLM provider: OpenAI-compatible + model routing

### Goal
Replace the hardcoded Anthropic client in the codegen orchestrator with a flexible
LLM client that works with OpenAI, OpenRouter, local Ollama, or any
OpenAI-compatible endpoint. Provider, model, base URL, and API key are all
runtime-configurable via environment variables.

---

### `src/codegen/llm-client.js`

```js
// src/codegen/llm-client.js
import { config } from "../../config/index.js";

let _logged = false;

export async function callLLM({ systemPrompt, userMessage, maxTokens }) {
  const { provider, model, baseUrl, apiKey, maxTokens: defaultMax } = config.llm;

  if (!apiKey) throw new LLMError("LLM_API_KEY is not set");

  if (!_logged) {
    process.stderr.write(`[llm] provider=${provider} model=${model} baseUrl=${baseUrl}\n`);
    _logged = true;
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  // OpenRouter requires these extra headers
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://bridgefill.io";
    headers["X-Title"] = "BridgeFill";
  }

  const body = {
    model,
    max_tokens: maxTokens ?? defaultMax,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage  },
    ],
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    throw new LLMError(`LLM API returned ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LLMError("LLM response missing choices[0].message.content");

  return content;
}

export class LLMError extends Error {
  constructor(message) {
    super(message);
    this.name = "LLMError";
  }
}
```

---

### Update `config/index.js` — add `llm` section

```js
llm: {
  provider:  process.env.LLM_PROVIDER  ?? "openai",
  model:     process.env.LLM_MODEL     ?? "gpt-4o",
  baseUrl:   process.env.LLM_BASE_URL  ?? "https://api.openai.com/v1",
  apiKey:    process.env.LLM_API_KEY   ?? null,
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "4096"),
},
```

**Default base URLs per provider (override in llm-client.js):**
```js
const PROVIDER_DEFAULTS = {
  openai:      "https://api.openai.com/v1",
  openrouter:  "https://openrouter.ai/api/v1",
  custom:      null,  // must be set via LLM_BASE_URL
};
// Apply default if LLM_BASE_URL not set:
const resolvedBaseUrl = config.llm.baseUrl
  ?? PROVIDER_DEFAULTS[config.llm.provider]
  ?? "https://api.openai.com/v1";
```

---

### Update `src/codegen/orchestrator.js`

- Remove all Anthropic-specific imports and constants (`ANTHROPIC_API`, `MODEL`)
- Replace the `fetch` call to Anthropic with `callLLM({ systemPrompt, userMessage, maxTokens: 4096 })`
- The prompt construction logic stays identical
- The fallback stub generator stays — activates when `LLM_API_KEY` is null or
  `callLLM` throws

---

### Add `GET /llm/status` to `src/server.js`

```js
fastify.get("/llm/status", async () => ({
  provider: config.llm.provider,
  model: config.llm.model,
  base_url: config.llm.baseUrl,
  api_key_set: !!config.llm.apiKey,
  max_tokens: config.llm.maxTokens,
}));
```

---

### Configuration examples to document in README

```bash
# OpenAI GPT-4o (default)
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
LLM_API_KEY=sk-...

# OpenAI GPT-4o-mini (cheaper, good for testing)
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...

# OpenRouter — access 100+ models with one key
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_API_KEY=sk-or-...

# OpenRouter + Llama 3.3 (free tier available)
LLM_PROVIDER=openrouter
LLM_MODEL=meta-llama/llama-3.3-70b-instruct
LLM_API_KEY=sk-or-...

# Local Ollama (no API key required)
LLM_PROVIDER=custom
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.2
LLM_API_KEY=ollama
```

---

### Phase 5 definition of done
- `GET /llm/status` returns current LLM config with `api_key_set: true/false`
- `LLM_PROVIDER=openai LLM_API_KEY=sk-... npm run dev` works end-to-end
- `generate_integration` MCP tool works with real OpenAI key
- OpenRouter config also works (verify correct headers sent)
- Fallback generator still activates when `LLM_API_KEY` is null
- All prior e2e assertions still pass

---

## PHASE 6 — Schema Registry (persistent, session-independent)

### Goal
Make schemas a first-class persistent resource. Providers publish once; consumers
discover without needing an active session. This is the product shift from "demo tool"
to "developer tool" — a schema registry that any developer can query.

---

### `src/registry/schema-store.js`

In-memory registry (same pattern as `service-registry.js`):

```js
// Schema record shape
{
  registryId:  "reg_{16 hex chars}",
  serviceId:   string,
  serviceName: string,
  orgId:       string,
  orgName:     string,
  version:     string,     // semver e.g. "2.1.0"
  schema:      object,     // normalised contract from normaliseSchema()
  codeSamples: [],
  changelog:   string,
  tags:        string[],
  isLatest:    boolean,
  publishedAt: ISO string,
}
```

**Functions to export:**
```js
publishToRegistry(orgId, orgName, serviceId, serviceName, normalisedSchema, codeSamples, changelog, tags)
  // 1. If prior versions exist, mark all as isLatest=false
  // 2. Compute version: diff against latest, bumpVersion
  // 3. Create new record with isLatest=true
  // 4. Returns { registryId, version, diffFromPrevious }

getRegistryEntry(registryId)          // by ID
getLatestSchema(serviceId)            // isLatest=true for that serviceId
getSchemaHistory(serviceId)           // all versions, newest first
listRegistry({ orgId, tags, q, limit }) // filter + search
diffRegistryVersions(serviceId, fromVersion, toVersion)  // reuse diff()
```

---

### New MCP tools (add to `definitions.js` and `handlers.js`)

**`publish_to_registry`** (provider role):
```
Input: { org_token, service_id, schema, code_samples?, changelog? }
Output: { registry_id, version, diff_from_previous, message }
```

Implementation: call `publishToRegistry(...)` then `auditSchema.published(...)`.
If a session is active for this service, also call `attachSchema` to keep them in sync.

**`discover_from_registry`** (consumer role, no session needed):
```
Input: { org_token, service_id, version? }
  // version = "latest" (default) or semver string
Output: {
  registry_id, version, schema, code_samples_count,
  changelog, schema_history: [{ version, published_at, is_breaking }],
  message
}
```

**`list_registry`** (both roles):
```
Input: { org_token, tags?, q?, limit? }
Output: {
  services: [{ registry_id, service_id, service_name, org_name,
               latest_version, endpoint_count, tags, published_at }]
}
```

---

### New REST endpoints in `src/server.js`

```
POST  /registry/schemas
  Auth: Bearer org_token
  Body: { service_id, service_name, schema, code_samples?, changelog?, tags? }
  → { registry_id, version, diff_from_previous }

GET   /registry/schemas
  Query: ?org_id=&tags=maps,places&q=google&limit=20
  → { schemas: RegistryEntry[] }

GET   /registry/schemas/:registry_id
  → RegistryEntry | 404

GET   /registry/services/:service_id/schemas
  → { history: RegistryEntry[] }

GET   /registry/services/:service_id/latest
  → RegistryEntry | 404

GET   /registry/services/:service_id/diff
  Query: ?from=1.0.0&to=2.0.0
  → SchemaDiff | 400 if versions not found
```

---

### Phase 6 definition of done
- Provider can publish without a session via `POST /registry/schemas`
- `GET /registry/schemas` lists published schemas, filterable by tags
- Two versions of the same service: diff returned at `/diff?from=1.0.0&to=2.0.0`
- `discover_from_registry` MCP tool works without an active session
- `list_registry` MCP tool returns all published services
- All prior e2e assertions still pass
- Add 5 new assertions to `test/e2e.js`

---

## PHASE 7 — Standalone generate endpoint + CLI

### Goal
Make code generation callable with no session, no MCP, just a service ID and consumer
context. Add a CLI script developers can run from their terminal or CI pipeline.

---

### `POST /generate` endpoint

```
Auth: Authorization: Bearer {org_token}   OR   ?api_key={raw_key}

Body:
{
  "service_id": "svc_abc or registry_id",
  "version": "latest",
  "consumer_context": {
    "language": "typescript",
    "framework": "nextjs",
    "use_case": "Create a payment intent on checkout",
    "existing_patterns": "We use axios and dotenv"
  },
  "options": {
    "include_tests": true,
    "endpoints": ["/v1/payment_intents"]   // subset, empty = all
  }
}

Response 200:
{
  "service_id": "svc_abc",
  "schema_version": "2.1.0",
  "model_used": "gpt-4o",
  "generation_time_ms": 3240,
  "files": [{ "filename", "description", "content", "source" }],
  "summary": "...",
  "next_steps": [...],
  "warnings": [...]
}

Response 202 (async — for large schemas > 5 endpoints):
{ "job_id": "job_abc123", "status": "pending", "poll": "/generate/status/job_abc123" }
```

**Auth logic for this endpoint:**
1. Check `Authorization: Bearer` header first
2. If not found, check `?api_key=` query param
3. Verify the token/key against the org store
4. Return 401 if neither present or invalid

**Async job store:** module-level Map `jobs` in `src/routes/generate.js`:
```js
{
  jobId: string,
  status: "pending" | "running" | "complete" | "failed",
  orgId: string,
  request: object,
  result: object | null,
  error: string | null,
  createdAt: ISO string,
  completedAt: ISO string | null,
}
```

For schemas with > 5 endpoints, immediately return 202 with job_id, then run
generation in background using `setImmediate`.

---

### `GET /generate/status/:job_id`

```
Response 200:
{
  "job_id": "job_abc123",
  "status": "complete",
  "created_at": "...",
  "completed_at": "...",
  "result": { /* same as POST /generate 200 response */ }
}

Response 404: job not found
Response 403: job belongs to different org
```

---

### `POST /validate` standalone endpoint

```
Auth: same as /generate

Body:
{
  "service_id": "svc_abc",
  "version": "latest",
  "code": "...",
  "language": "typescript"
}

Response 200:
{
  "passed": true,
  "issue_count": 0,
  "issues": [],
  "schema_version": "2.1.0"
}
```

---

### `cli/generate.js`

Node.js script, no dependencies beyond Node built-ins:

```bash
node cli/generate.js \
  --service svc_abc123 \
  --language typescript \
  --framework nextjs \
  --use-case "Show nearby restaurants" \
  --out ./generated \
  --server http://localhost:3000 \
  --key bf_...
```

**Behaviour:**
1. Parse args with `process.argv`
2. `POST {server}/generate` with the request body
3. If response is 202, poll `GET /generate/status/{job_id}` every 2s until complete
4. Write each file in `result.files` to `{out}/{filename}`
5. Create `--out` directory if it doesn't exist (`mkdir -p` equivalent)
6. Print a summary table to stdout:

```
BridgeFill — Generated 3 files
Schema version : 2.1.0
Model used     : gpt-4o
Duration       : 3,240ms

  auth_setup.ts              AUTHORITATIVE   1.2 KB
  nearbysearch_json.ts       AI GENERATED    0.8 KB
  integration.test.ts        AI GENERATED    0.5 KB

Next steps:
  1. Set GOOGLE_MAPS_API_KEY in your environment
  2. Review provider_sample files — they are authoritative
  3. Run integration tests before deploying
```

---

### Phase 7 definition of done
- `POST /generate` returns files with no session setup
- `POST /generate` with > 5 endpoints returns 202 and job_id
- `GET /generate/status/:job_id` returns complete result after polling
- `POST /validate` runs standalone validation
- `node cli/generate.js --service svc_demo --language typescript --out ./out`
  writes files to disk
- Auth via `?api_key=` query param works
- All prior e2e assertions still pass
- Add 5 new assertions to `test/e2e.js`

---

## PHASE 8 — PostgreSQL persistence

### Goal
Replace all in-memory Maps with PostgreSQL. The app works identically with
`STORE_BACKEND=memory` (default, for tests and local dev) and
`STORE_BACKEND=postgres` (staging and production). No app code changes required
to switch backends.

---

### `src/persistence/index.js` — adapter layer

```js
import { createMemoryStores } from "./backends/memory.js";
import { createRedisStores }   from "./backends/redis.js";    // optional
import { createPostgresStores } from "./backends/postgres.js";

let _stores = null;

export async function initStores(opts = {}) {
  const backend = opts.backend ?? process.env.STORE_BACKEND ?? "memory";
  switch (backend) {
    case "postgres": _stores = await createPostgresStores({ pgUrl: opts.pgUrl ?? process.env.DATABASE_URL }); break;
    default:         _stores = createMemoryStores(); break;
  }
  return _stores;
}

export function getStores() {
  if (!_stores) throw new Error("Stores not initialised — call initStores() at startup");
  return _stores;
}
```

---

### `src/persistence/backends/memory.js`

Wraps existing in-memory Maps in the standard store interface.
Six stores: `sessions`, `services`, `keys`, `audit`, `registry`, `jobs`.

Each store implements a consistent async interface:
```js
// SessionStore
{ get(id), set(id, data), del(id), getByServiceId(serviceId), indexByServiceId(serviceId, sessionId), list() }

// ServiceStore
{ get(id), set(id, data), list(), has(id) }

// KeyStore
{ getByHash(hash), getByKeyId(keyId), listByOrg(orgId), save(record), update(keyId, updates) }

// AuditStore
{ append(entry), query({ orgId, category, sessionId, limit }), count() }

// RegistryStore
{ save(record), getById(registryId), getLatest(serviceId), getHistory(serviceId), list({ orgId, tags, q, limit }), markNotLatest(serviceId) }

// JobStore
{ get(jobId), set(jobId, data), listByOrg(orgId) }
```

---

### `src/persistence/backends/postgres.js`

Implements the same interface using `pg` (node-postgres) connection pool.

**Connection pool setup:**
```js
import pg from "pg";
const { Pool } = pg;

export async function createPostgresStores({ pgUrl }) {
  const pool = new Pool({
    connectionString: pgUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  await pool.query("SELECT 1"); // verify connection
  await runMigrations(pool);
  return { sessions: ..., services: ..., keys: ..., audit: ..., registry: ..., jobs: ... };
}
```

---

### Migration SQL (`src/persistence/migrations/001_initial.sql`)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_service_id ON sessions(service_id);
CREATE INDEX IF NOT EXISTS sessions_status     ON sessions(status);

CREATE TABLE IF NOT EXISTS services (
  id              TEXT PRIMARY KEY,
  provider_org_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active',
  label        TEXT,
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  data         JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS api_keys_org_id ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS api_keys_hash   ON api_keys(hash);

CREATE TABLE IF NOT EXISTS audit_log (
  seq        BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category   TEXT NOT NULL,
  event      TEXT NOT NULL,
  org_id     TEXT,
  session_id TEXT,
  data       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_ts         ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_org_id     ON audit_log(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_session_id ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS audit_category   ON audit_log(category, ts DESC);

CREATE TABLE IF NOT EXISTS registry_schemas (
  registry_id  TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  version      TEXT NOT NULL,
  schema_data  JSONB NOT NULL,
  code_samples JSONB NOT NULL DEFAULT '[]',
  changelog    TEXT,
  tags         TEXT[] DEFAULT '{}',
  is_latest    BOOLEAN NOT NULL DEFAULT TRUE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_id, version)
);
CREATE INDEX IF NOT EXISTS registry_service_id ON registry_schemas(service_id, published_at DESC);
CREATE INDEX IF NOT EXISTS registry_org_id     ON registry_schemas(org_id);
CREATE INDEX IF NOT EXISTS registry_is_latest  ON registry_schemas(service_id) WHERE is_latest = TRUE;

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id       TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending',
  org_id       TEXT NOT NULL,
  request_data JSONB NOT NULL,
  result_data  JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_org_id ON generation_jobs(org_id, created_at DESC);
```

All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
— safe to run on every server start.

---

### Update `src/server.js` — call `initStores()` at startup

```js
import { initStores } from "./persistence/index.js";
// before fastify.listen:
await initStores();
fastify.log.info(`Store backend: ${process.env.STORE_BACKEND ?? "memory"}`);
```

Refactor all handlers that use module-level Maps to call `getStores()` instead.

---

### Update `GET /health`

```json
{
  "status": "ok",
  "store_backend": "postgres",
  "db_connected": true,
  "db_latency_ms": 2,
  "time": "..."
}
```

When `STORE_BACKEND=memory`, `db_connected` is `null` and `db_latency_ms` is `null`.

---

### `docker-compose.yml`

```yaml
version: "3.9"
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: bridgefill
      POSTGRES_USER: bridgefill
      POSTGRES_PASSWORD: bridgefill
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bridgefill"]
      interval: 5s
      timeout: 5s
      retries: 5

  app:
    build: .
    environment:
      STORE_BACKEND: postgres
      DATABASE_URL: postgresql://bridgefill:bridgefill@db:5432/bridgefill
      LLM_PROVIDER: openai
      LLM_API_KEY: ${LLM_API_KEY}
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

### `Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

---

### Phase 8 definition of done
- `docker-compose up` starts server + Postgres, server passes `GET /health` with
  `db_connected: true`
- All 61+ e2e assertions pass with `STORE_BACKEND=postgres`
- All assertions still pass with `STORE_BACKEND=memory` (no regression)
- Data persists across server restarts when using Postgres
- Migration runs automatically on every startup (idempotent)

---

## PHASE 9 — Developer dashboard (full web UI)

### Goal
Build a complete multi-page developer dashboard as a single HTML file. Replaces
the current session monitor demo. Six pages navigable via a left sidebar.

---

### Technical approach

- Single file: `src/public/index.html`
- No build step, no framework, no npm packages
- Client-side routing: hash-based (`#/`, `#/registry`, `#/generate`, `#/sessions`,
  `#/audit`, `#/settings`)
- All CSS variables in `:root` — same palette as current UI
- Fonts: IBM Plex Mono + IBM Plex Sans Condensed + IBM Plex Sans from Google Fonts
- API calls to same-origin routes (`/registry/...`, `/generate`, `/audit`, etc.)
- All pages share a left sidebar nav (64px collapsed, 220px expanded on hover)

---

### Page structure

**Sidebar (persistent):**
- BridgeFill logo + version at top
- Nav links with monospace labels:
  `◆ Dashboard`, `◆ Registry`, `◆ Generate`, `◆ Sessions`, `◆ Audit`, `◆ Settings`
- Active link: mint-green left border + background tint
- Bottom: LLM status indicator (dot + model name from `GET /llm/status`)

---

**`#/` — Dashboard:**
- 4-stat row at top: Total Services, Total Schemas, Generations Today, Active Sessions
  — fetch from `GET /health` + `GET /registry/schemas` + `GET /audit`
- Recent activity feed: last 20 audit events from `GET /audit?limit=20`
- Quick action buttons: "Publish Schema →" (links to `#/registry`) and
  "Generate Code →" (links to `#/generate`)

---

**`#/registry` — Schema Registry:**
- Search bar + tag filter chips at top
- Table: Service | Org | Version | Endpoints | Updated | Actions
  — fetch from `GET /registry/schemas`
- Clicking a row expands an inline detail panel:
  - Full schema display (base_url, auth, endpoint list with params)
  - Version history timeline: each version on a row with breaking/additive badge
    (`GET /registry/services/:service_id/schemas`)
  - "Diff →" link between any two versions
  - Code samples count + "View" button
- "Publish Schema" button opens a right drawer with a form:
  - Fields: Service Name, Description, Tags (comma-separated input), Changelog
  - Schema JSON textarea with live JSON validation (border turns red on parse error)
  - Code Sample textarea + language dropdown
  - Submit → `POST /registry/schemas`

---

**`#/generate` — Generate Integration:**
- Left column (40%): configuration
  - Service picker: search input + dropdown populated from `GET /registry/schemas`
  - Version picker: "latest" default + semver dropdown
  - Language select, Framework select
  - Use case textarea
  - Existing patterns textarea (optional)
  - Endpoint checkboxes (populated after service is selected)
  - Model display (from `GET /llm/status`) + override input
  - Generate button
- Right column (60%): output
  - Empty state until generated: "Select a service and click Generate"
  - After generation: file tabs (one tab per file)
    - Tab header: filename + source badge (AUTHORITATIVE / AI / STUB)
    - Tab body: code block with syntax color (CSS keyword highlighting)
    - Copy button per file (clipboard API)
  - Validation banner (pass/fail) after files shown
  - "Download as ZIP" button (use JSZip from CDN: `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`)
  - Summary + next steps below files

---

**`#/sessions` — Session Monitor:**
- The current session monitor UI (provider panel + center feed + consumer panel)
  but embedded as a page in the dashboard layout
- Table of recent sessions at top: Session ID | Service | Status | Created | Actions
  — fetch from `GET /audit?category=session&limit=50`
- Clicking a session shows the live feed for that session

---

**`#/audit` — Audit Log:**
- Filter bar: Category dropdown | Org input | Date range (from/to) | Search input
- Virtualized table (only render 50 rows, scroll to load more):
  Columns: Time | Category | Event | Org | Session | Details
- Auto-refresh toggle (SSE or 5s polling)
- "Export CSV" button: generates CSV client-side from loaded rows

---

**`#/settings` — Settings:**
- LLM Configuration section:
  - Display current config from `GET /llm/status`
  - "Test Connection" button: calls `POST /generate` with a minimal request,
    shows success/failure in 1-2 seconds
- API Keys section:
  - List: `GET /auth/keys/{org_id}` — but org_id is from a text input
  - "Create Key" form: org_id, label, ttl_days
  - Rotate button per key, Revoke button per key
- Org section: list orgs from `config.orgs` (read-only display)

---

### Animations + interactions

- Page transitions: fade-in on hash change (`opacity: 0 → 1` in 150ms)
- Table rows: fade-in staggered on load (`animation-delay: N * 30ms`)
- Drawer open/close: `transform: translateX(100%) → 0` in 200ms
- Success/error toasts: slide up from bottom-right, auto-dismiss after 3s

---

### Phase 9 definition of done
- All 6 pages render via hash routing
- Registry page: publish a schema via the form, see it appear in the table
- Generate page: select a service, configure context, generate files, download ZIP
- Audit page: shows real events, filterable by category
- Settings: LLM test button returns success/failure message
- Sidebar LLM status indicator shows green when `api_key_set: true`

---

## PHASE 10 — Production hardening

### Goal
Rate limiting, graceful shutdown, structured logs, readiness probes, deployment config.

---

### Rate limiting (`@fastify/rate-limit`)

```bash
npm install @fastify/rate-limit
```

Limits to apply:
```js
// Global: 200 req/min per IP (unauthenticated)
fastify.register(rateLimit, { max: 200, timeWindow: "1 minute" });

// Per-route overrides:
// POST /generate — 10 req/min per org (LLM cost protection)
// POST /auth/token — 20 req/min per IP (brute-force protection)
// POST /registry/schemas — 30 req/min per org
// GET /audit — 60 req/min per org
```

Rate limit response:
```json
{ "error": "Rate limit exceeded", "code": "RATE_LIMIT", "retry_after_seconds": 12 }
```

---

### Startup validation

At the start of `src/server.js`, before anything else:

```js
function validateEnvironment() {
  const isProduction = process.env.BRIDGEFILL_ENV === "production";
  const errors = [];

  if (isProduction) {
    if (config.jwt.secret === "dev-secret-change-in-production")
      errors.push("JWT_SECRET must not be the default dev value");
    if (!config.llm.apiKey)
      errors.push("LLM_API_KEY must be set in production");
    if (process.env.STORE_BACKEND === "postgres" && !process.env.DATABASE_URL)
      errors.push("DATABASE_URL must be set when STORE_BACKEND=postgres");
  }

  if (errors.length) {
    process.stderr.write("BridgeFill startup validation failed:\n");
    errors.forEach(e => process.stderr.write(`  ✗ ${e}\n`));
    process.exit(1);
  }
}
```

---

### Graceful shutdown

```js
async function shutdown(signal) {
  fastify.log.info(`Received ${signal}, shutting down gracefully...`);
  await fastify.close(); // stops accepting new requests, waits for in-flight
  // close DB pool if postgres
  const stores = getStores();
  if (stores._pool) await stores._pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
```

---

### Readiness endpoint

```js
fastify.get("/ready", async (request, reply) => {
  const checks = { store_backend: process.env.STORE_BACKEND ?? "memory", llm_key_set: !!config.llm.apiKey };

  if (process.env.STORE_BACKEND === "postgres") {
    try {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      checks.db_connected = true;
      checks.db_latency_ms = Date.now() - t0;
    } catch (err) {
      checks.db_connected = false;
      checks.db_error = err.message;
      reply.code(503);
      return { ready: false, checks };
    }
  }

  return { ready: true, checks };
});
```

---

### Security headers (`@fastify/helmet`)

```bash
npm install @fastify/helmet
```

```js
await fastify.register(helmet, {
  contentSecurityPolicy: false, // we serve inline HTML
  crossOriginEmbedderPolicy: false,
});
```

---

### `fly.toml` (Fly.io deployment)

```toml
app = "bridgefill"
primary_region = "iad"

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true

[http_service.concurrency]
  type = "requests"
  hard_limit = 200
  soft_limit = 150

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

Deploy with: `fly launch --name bridgefill --no-deploy && fly secrets set LLM_API_KEY=sk-... JWT_SECRET=... && fly deploy`

---

### Phase 10 definition of done
- Rate limit: 11th `POST /generate` call in a minute returns 429
- `BRIDGEFILL_ENV=production npm start` without `JWT_SECRET` set exits with clear error
- `GET /ready` returns 503 when `DATABASE_URL` is invalid (with `STORE_BACKEND=postgres`)
- `GET /ready` returns 200 when all checks pass
- SIGTERM: server stops accepting requests, in-flight finish, exits cleanly
- `fly deploy` succeeds (or equivalent on Railway/Render)
- All prior e2e assertions still pass

---

## FULL RUNNING ORDER

```
Phase 1   MCP skeleton + 10 tool stubs           ~3h   node test/e2e.js  →  6 assertions
Phase 2   Auth: API keys, JWTs, audit log         ~3h   test/e2e.js       → 18 assertions
Phase 3   Schema negotiation + diff engine        ~3h   test/e2e.js       → 26 assertions
Phase 4   LLM codegen (fallback + real LLM)       ~3h   test/e2e.js       → 32 assertions
Phase 5   OpenAI-compatible LLM client            ~2h   test/e2e.js       → 33 assertions
Phase 6   Schema registry (session-independent)   ~3h   test/e2e.js       → 38 assertions
Phase 7   /generate endpoint + CLI                ~3h   test/e2e.js       → 43 assertions
Phase 8   PostgreSQL persistence                  ~4h   test/e2e.js       → 43 (+ pg backend)
Phase 9   Developer dashboard (full UI)           ~5h   manual verify
Phase 10  Production hardening + deployment       ~2h   test/e2e.js       → 48 assertions
```

**Total: ~31 hours of Claude Code sessions.**
Each phase leaves the system in a working, testable state.
Never move to the next phase until the current phase's definition of done is met.

---

## GLOBAL NOTES FOR EVERY PHASE

1. **Run tests after every phase** — `node test/e2e.js` grows throughout the build.
   Do not move on until all prior assertions still pass.

2. **ESM everywhere** — `import/export` only, `.js` extensions on all imports.

3. **Env vars in config only** — every `process.env.*` lives in `config/index.js`.

4. **Audit everything** — every significant action (token issued, schema published,
   code generated, key rotated) must call an `audit*` helper.

5. **Error format** — all errors: `{ "error": "message", "code": "MACHINE_CODE" }`.

6. **In-memory first** — implement memory backend before postgres backend.
   Memory is what tests use. Postgres is a drop-in swap.

7. **Never break the fallback** — the codegen fallback stub generator must always
   work even when `LLM_API_KEY` is not set. The tool never hard-errors for the consumer.

8. **Source tags on every file** — every generated file has a `source` field:
   `"provider_sample"` | `"llm_generated"` | `"fallback_generated"`
   This is how developers know what to trust and what to review.
