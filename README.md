<div align="center">

# BridgeFill

**Schema registry and LLM-powered integration code generator for API providers and consumers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Fastify](https://img.shields.io/badge/Fastify-4.x-white)](https://www.fastify.io)
[![MCP](https://img.shields.io/badge/Protocol-MCP%202024--11--05-purple)](https://modelcontextprotocol.io)

[Overview](#overview) · [Quick Start](#quick-start) · [Architecture](#architecture) · [MCP Tools](#mcp-tools) · [REST API](#rest-api) · [Dashboard](#dashboard) · [Configuration](#configuration) · [Deployment](#deployment) · [Contributing](#contributing)

</div>

---

## Overview

BridgeFill solves the integration handshake problem between API **providers** and **consumers** — including AI coding agents.

A provider publishes their OpenAPI schema and a working code sample **once**. Any developer (or AI agent) can then request production-ready integration code tailored to their specific language, framework, and use case. BridgeFill:

- **Diffs schema versions** automatically and detects breaking changes
- **Bumps semver** based on the severity of changes
- **Grounds LLM generation** in the provider's own code — not a hallucinated description
- **Validates** generated code against the published contract before handing it to the developer

```
Provider Agent                   BridgeFill                   Consumer Agent
──────────────                   ──────────                   ──────────────
publish_schema ──────────────►  diff + semver bump
provide_code_sample ─────────►  store as few-shot example
                                                 ◄────────── discover_schema
                                                 ◄────────── generate_integration
                                 LLM call (grounded) ──────► files: auth.ts, client.ts, test.ts
                                                 ◄────────── validate_integration
```

> **BridgeFill runs at developer time.** It produces code files and gets out of the way. It is not an API gateway, a documentation tool, an iPaaS, or a runtime proxy.

---

## Quick Start

### Prerequisites

- Node.js 22+
- npm 9+
- (Optional) Docker + Docker Compose for PostgreSQL persistence

### 1. Clone and install

```bash
git clone https://github.com/Krishnan9074/Bridgefill.git
cd Bridgefill
npm install
```

### 2. Configure environment

```bash
cp .env.example .env   # or set vars directly
```

The minimum required variables for local development:

```bash
# .env (dev defaults work without any changes)
NODE_ENV=development
PORT=3000

# Optional: enable real LLM code generation
LLM_API_KEY=sk-...          # OpenAI, OpenRouter, or custom provider key
LLM_MODEL=gpt-4o            # model to use
LLM_PROVIDER=openai         # openai | openrouter | custom
```

Without `LLM_API_KEY`, BridgeFill uses a deterministic **fallback stub generator** — you still get valid, schema-grounded files.

### 3. Start the server

```bash
npm start                   # production mode
npm run dev                 # watch mode with pino-pretty logging
```

Server is ready at `http://localhost:3000`. Open the **developer dashboard** in your browser.

### 4. Run the test suite

```bash
npm run test:e2e            # 48 end-to-end assertions (memory backend)
npm run test:e2e:postgres   # same suite against real PostgreSQL
npm test                    # jest unit tests
```

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                          BridgeFill Server                         │
│                                                                    │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐ │
│  │  MCP Router  │  │   REST Routes  │  │   Web Dashboard        │ │
│  │  JSON-RPC 2  │  │  /generate     │  │   src/public/index.html│ │
│  │  HTTP + WS   │  │  /validate     │  │   Vanilla JS, no build │ │
│  └──────┬───────┘  │  /registry     │  └────────────────────────┘ │
│         │          │  /auth         │                              │
│         ▼          └───────┬────────┘                              │
│  ┌──────────────┐          │                                       │
│  │  Tool Layer  │          ▼                                       │
│  │  13 handlers │  ┌──────────────────────────────────────────┐   │
│  └──────┬───────┘  │            Core Services                  │   │
│         │          │                                           │   │
│         └──────────►  Auth        Schema       Codegen        │   │
│                    │  (JWT+keys)  (diff+semver) (LLM+fallback)│   │
│                    │                                           │   │
│                    │  Session     Registry     Events (SSE)   │   │
│                    └──────────────────┬────────────────────────┘   │
│                                       │                            │
│                    ┌──────────────────▼────────────────────────┐   │
│                    │           Persistence Layer                │   │
│                    │   memory (default)  │  postgres (prod)    │   │
│                    └───────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

| Decision | Rationale |
|---|---|
| **MCP protocol** | Native tool interface for AI coding agents (Claude Code, Cursor, etc.) |
| **Dual persistence** | Swap memory ↔ postgres via env var — no code changes, tests run in memory |
| **Fallback codegen** | LLM is optional. Deterministic stubs always produce schema-grounded, valid files |
| **No ORM** | Plain `pg` queries with idempotent migrations — zero abstraction overhead |
| **Vanilla dashboard** | No build step. Single HTML file deployed with the server. |
| **Audit log** | Every auth, session, tool, schema, and codegen event is recorded |

---

## Project Structure

```
bridgefill/
├── src/
│   ├── auth/
│   │   ├── index.ts          # JWT issuance + verification, role-based allowlists
│   │   ├── api-keys.ts       # Long-lived key management (SHA-256 hashed)
│   │   └── audit.ts          # Structured audit log (5 categories, 10k cap)
│   ├── codegen/
│   │   ├── orchestrator.ts   # LLM prompt construction + file assembly
│   │   ├── llm-client.ts     # OpenAI-compatible client (OpenAI/OpenRouter/custom)
│   │   └── standalone.ts     # Session-free generation via registry
│   ├── events/
│   │   └── bus.ts            # SSE broadcast bus for real-time dashboard updates
│   ├── mcp/
│   │   └── router.ts         # JSON-RPC 2.0 handler (single + batch)
│   ├── persistence/
│   │   ├── index.ts          # Dual-backend adapter
│   │   └── backends/
│   │       ├── memory.ts     # In-memory stores (Maps)
│   │       └── postgres.ts   # PostgreSQL stores + migrations
│   ├── public/
│   │   └── index.html        # Developer dashboard (single file, no build)
│   ├── registry/
│   │   └── schema-store.ts   # Persistent schema registry
│   ├── routes/
│   │   └── generate.ts       # Async job queue for large-schema generation
│   ├── schema/
│   │   └── negotiation.ts    # Semantic diff engine + conflict detection
│   ├── session/
│   │   └── store.ts          # Session state machine (pending→active→complete)
│   ├── tools/
│   │   ├── definitions.ts    # 13 MCP tool JSON schemas
│   │   ├── handlers.ts       # Tool implementations
│   │   └── service-registry.ts
│   ├── server.ts             # Fastify app factory + route registration
│   └── types.ts              # Shared TypeScript types
├── cli/
│   └── generate.ts           # Standalone CLI (no MCP client needed)
├── config/
│   └── index.ts              # All env var reads live here
├── test/
│   ├── e2e.ts                # 48 end-to-end assertions
│   └── smoke.test.ts         # Jest smoke tests
├── docker-compose.yml
├── Dockerfile
├── fly.toml                  # Fly.io deployment config
└── tsconfig.json
```

---

## MCP Tools

BridgeFill exposes **13 tools** over the MCP protocol. Connect any MCP-compatible client to `http://localhost:3000/mcp` (HTTP) or `ws://localhost:3000/mcp/ws` (WebSocket).

### Authentication

Every tool call requires an `org_token` — a short-lived JWT scoped to a specific org and role.

```bash
# Mint a provider token
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d '{"org_id":"org_demo_provider","api_key":"dev-provider-secret","role":"provider"}'

# Response
{"token":"eyJ...","org_id":"org_demo_provider","role":"provider","expires_in":"24h"}
```

Tokens encode an `allowedTools` claim. Calling a tool outside your role returns JSON-RPC error `-32001`.

### Tool Reference

#### Provider tools

| Tool | Description |
|---|---|
| `register_service` | Declare an API service and receive a `service_id` |
| `join_session` | Create an integration session for a service |
| `publish_schema` | Publish an OpenAPI fragment — triggers diff, semver bump, conflict detection |
| `provide_code_sample` | Upload authoritative code to ground LLM generation |
| `publish_to_registry` | Publish a schema to the persistent registry (no session needed) |
| `emit_message` | Send a freeform negotiation message within a session |

#### Consumer tools

| Tool | Description |
|---|---|
| `join_session` | Join an existing session and activate it |
| `discover_schema` | Retrieve the normalised contract + full version history |
| `generate_integration` | Generate integration files via LLM (or deterministic fallback) |
| `validate_integration` | Check generated files against the published schema |
| `discover_from_registry` | Fetch any schema from the registry without a session |
| `list_registry` | Search and filter published services |
| `emit_message` | Send a freeform negotiation message |

#### Shared tools

| Tool | Description |
|---|---|
| `ping` | Health check — returns server time and protocol version |
| `get_session_status` | Poll session state, participants, messages, and generated code |

### Example: Full provider → consumer flow

```jsonc
// 1. Provider registers their service
{
  "method": "tools/call",
  "params": {
    "name": "register_service",
    "arguments": {
      "org_token": "<provider_jwt>",
      "service_name": "Payments API",
      "service_description": "Stripe-compatible payment intents"
    }
  }
}
// → { "service_id": "svc_abc123" }

// 2. Provider joins a session
{
  "method": "tools/call",
  "params": {
    "name": "join_session",
    "arguments": { "org_token": "<provider_jwt>", "service_id": "svc_abc123" }
  }
}
// → { "session_id": "sess_xyz", "status": "pending" }

// 3. Provider publishes their schema
{
  "method": "tools/call",
  "params": {
    "name": "publish_schema",
    "arguments": {
      "org_token": "<provider_jwt>",
      "session_id": "sess_xyz",
      "schema": {
        "base_url": "https://api.payments.example.com",
        "auth": { "type": "api_key", "location": "header", "key_name": "X-Payments-Key" },
        "endpoints": [
          {
            "path": "/v1/payment_intents",
            "method": "POST",
            "summary": "Create a payment intent",
            "parameters": [
              { "name": "amount",   "in": "body", "required": true,  "schema": { "type": "number" } },
              { "name": "currency", "in": "body", "required": true,  "schema": { "type": "string" } }
            ],
            "response_schema": { "type": "object" }
          }
        ]
      }
    }
  }
}
// → { "version": "1.0.0", "diff_summary": { "breaking": 0, "warnings": 0 } }

// 4. Provider uploads an authoritative code sample
{
  "method": "tools/call",
  "params": {
    "name": "provide_code_sample",
    "arguments": {
      "org_token": "<provider_jwt>",
      "session_id": "sess_xyz",
      "sample": {
        "language": "typescript",
        "description": "Official payment intent creation",
        "content": "export async function createPaymentIntent(amount: number, currency: string) { ... }"
      }
    }
  }
}

// 5. Consumer joins and activates the session
{
  "method": "tools/call",
  "params": {
    "name": "join_session",
    "arguments": { "org_token": "<consumer_jwt>", "service_id": "svc_abc123" }
  }
}
// → { "status": "active" }

// 6. Consumer generates integration code
{
  "method": "tools/call",
  "params": {
    "name": "generate_integration",
    "arguments": {
      "org_token": "<consumer_jwt>",
      "session_id": "sess_xyz",
      "consumer_context": {
        "language": "typescript",
        "framework": "nextjs",
        "use_case": "Create a payment intent on checkout completion"
      }
    }
  }
}
// → { "source": "llm", "files": [{ "filename": "payments-client.ts", ... }, ...] }
```

---

## REST API

### Health and status

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server info, store backend, DB latency |
| `GET` | `/ready` | Readiness probe — 503 if DB not connected |
| `GET` | `/llm/status` | Current LLM provider config |
| `GET` | `/orgs` | Configured organisations |
| `GET` | `/services` | Registered services list |

### Authentication

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/token` | Issue a scoped JWT from an API key |
| `POST` | `/auth/keys` | Create a new long-lived API key |
| `GET` | `/auth/keys/:org_id` | List keys for an org |
| `POST` | `/auth/keys/:key_id/rotate` | Rotate a key with a configurable grace period |
| `DELETE` | `/auth/keys/:key_id` | Revoke a key immediately |
| `GET` | `/audit` | Query the structured audit log |

### Schema Registry

| Method | Path | Description |
|---|---|---|
| `POST` | `/registry/schemas` | Publish a schema (requires Bearer token) |
| `GET` | `/registry/schemas` | List schemas — filter by `org_id`, `tags`, `q` |
| `GET` | `/registry/schemas/:registry_id` | Get a specific registry entry |
| `GET` | `/registry/services/:service_id/schemas` | Full version history for a service |
| `GET` | `/registry/services/:service_id/latest` | Latest published version |
| `GET` | `/registry/services/:service_id/diff?from=X&to=Y` | Semantic diff between two versions |

### Code Generation

| Method | Path | Description |
|---|---|---|
| `POST` | `/generate` | Generate integration files (sync or async) |
| `GET` | `/generate/status/:job_id` | Poll an async generation job |
| `POST` | `/validate` | Validate submitted code against a published schema |

**Sync vs. async:** schemas with ≤5 endpoints respond synchronously (`200`). Larger schemas return a `202` with a `job_id` for polling.

```bash
# Sync generation (auth via query param)
curl -X POST "http://localhost:3000/generate?api_key=dev-provider-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "service_id": "svc_abc123",
    "version": "latest",
    "consumer_context": {
      "language": "typescript",
      "framework": "nextjs",
      "use_case": "Search places in a storefront"
    },
    "options": { "include_tests": true }
  }'
```

### MCP Transport

| Method | Path | Description |
|---|---|---|
| `POST` | `/mcp` | HTTP JSON-RPC 2.0 transport (single or batch) |
| `GET` | `/mcp/ws` | WebSocket MCP transport |

---

## Schema Negotiation

The schema diff engine (`src/schema/negotiation.ts`) classifies every change between two schema versions:

| Severity | Examples | Semver impact |
|---|---|---|
| `breaking` | Removed endpoint, new required param, auth type change | Major bump (`1.x.x → 2.0.0`) |
| `warning` | Changed response shape, deprecation | Minor bump (`1.0.x → 1.1.0`) |
| `additive` | New optional param, new endpoint | Minor bump |
| `info` | Summary text change, new SDK language | Patch bump |

Conflict detection scopes breaking changes to the **endpoints the consumer actually needs** — if you only call `/v1/search` and `/v1/nearby` is removed, you get no conflict.

```bash
# Diff two published versions via REST
curl "http://localhost:3000/registry/services/svc_abc123/diff?from=1.0.0&to=2.0.0"

# Response
{
  "hasDiff": true,
  "breakingCount": 2,
  "warningCount": 0,
  "additiveCount": 1,
  "changes": [
    { "severity": "breaking", "path": "/v1/suggest", "message": "Endpoint removed" },
    { "severity": "breaking", "path": "/v1/search", "message": "New required param: region" },
    { "severity": "additive", "path": "/v1/search", "message": "New optional param: radius" }
  ]
}
```

---

## Code Generation

### LLM-backed generation

When `LLM_API_KEY` is set, `generate_integration` sends a structured prompt to your configured provider:

- **System prompt:** describes the task, output format (JSON with `files` array), and coding conventions
- **User prompt:** includes the normalised schema, rate limits, auth details, and targeted use case
- **Few-shot examples:** the provider's own `provide_code_sample` content is injected verbatim, tagged `AUTHORITATIVE`

The response is parsed and the files are validated against the schema before being returned.

### Fallback generation

Without an LLM, a deterministic stub generator produces:

| File | Content |
|---|---|
| `{service}-auth.ts` | Auth setup using the schema's `key_name` and `location` |
| `{service}-client.ts` | Typed endpoint wrappers for each `endpoints[*]` entry |
| `{service}.test.ts` | Scaffolded test file with required param assertions |

Provider code samples (if any) are included verbatim as additional files.

### Supported LLM providers

| Provider | `LLM_PROVIDER` | Notes |
|---|---|---|
| OpenAI | `openai` | Default. Uses `https://api.openai.com/v1` |
| OpenRouter | `openrouter` | Adds `HTTP-Referer` + `X-Title` headers automatically |
| Custom | `custom` | Set `LLM_BASE_URL` to any OpenAI-compatible endpoint |

---

## CLI

Generate integration code from the command line without an MCP client:

```bash
# Build first
npm run build

node dist/cli/generate.js \
  --service  svc_abc123 \
  --language typescript \
  --framework nextjs \
  --use-case "Search nearby places" \
  --out ./output \
  --server http://localhost:3000 \
  --key dev-provider-secret
```

Output:

```
BridgeFill — Generated 3 files for svc_abc123 (v1.1.0)

  ✓  places-auth.ts          provider_sample    312 bytes
  ✓  places-client.ts        llm_generated      1.4 KB
  ✓  places.test.ts          llm_generated      892 bytes

Written to ./output/
```

---

## Dashboard

The developer dashboard is a single vanilla-JS HTML file (`src/public/index.html`) served at `/`. No build step, no framework.

| Page | URL fragment | Features |
|---|---|---|
| Dashboard | `#/` | Stats, recent activity feed, quick-action buttons |
| Registry | `#/registry` | Service table, schema details, version timeline, publish form |
| Generate | `#/generate` | Service picker, context config, file output tabs, ZIP download |
| Sessions | `#/sessions` | Live session monitor — provider/consumer panels, message feed |
| Audit | `#/audit` | Filterable log table (category, org, date, search), CSV export |
| Settings | `#/settings` | LLM config, API key management (create / rotate / revoke) |

Real-time updates stream via SSE (`GET /events/audit`).

---

## Configuration

All configuration is read from environment variables in `config/index.ts`.

### Server

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |

### Auth

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `dev-secret-change-in-production` | **Must be changed in production** |
| `ORG_PROVIDER_SECRET` | `dev-provider-secret` | API key for `org_demo_provider` |
| `ORG_CONSUMER_SECRET` | `dev-consumer-secret` | API key for `org_demo_consumer` |
| `ORG_DEMO_SECRET` | `dev-demo-secret` | API key for `org_demo` (both roles) |

### LLM

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai` \| `openrouter` \| `custom` |
| `LLM_MODEL` | `gpt-4o` | Model identifier passed to the provider |
| `LLM_BASE_URL` | Provider default | Override API base URL |
| `LLM_API_KEY` | — | API key (`OPENAI_API_KEY` is also accepted as a fallback) |
| `LLM_MAX_TOKENS` | `4096` | Max tokens per generation request |

### Persistence

| Variable | Default | Description |
|---|---|---|
| `STORE_BACKEND` | `memory` | `memory` \| `postgres` |
| `DATABASE_URL` | — | Required when `STORE_BACKEND=postgres` |
| `HANDSHAKE_TIMEOUT_MS` | `120000` | Session expiry if consumer never joins |

### Rate limits (built-in, not configurable per-deploy)

| Route | Limit |
|---|---|
| Global | 200 req/min per IP |
| `POST /auth/token` | 20 req/min |
| `POST /generate` | 10 req/min |
| `POST /registry/schemas` | 30 req/min |
| `GET /audit` | 60 req/min |

---

## Persistence

BridgeFill uses a **dual-backend adapter** — the same interface is implemented by both backends.

### Memory (default)

```bash
STORE_BACKEND=memory npm start
```

All data lives in process memory. Suitable for development, CI, and single-instance staging. Data is lost on restart.

### PostgreSQL

```bash
STORE_BACKEND=postgres DATABASE_URL=postgresql://user:pass@host:5432/bridgefill npm start
```

Migrations run automatically on startup (`CREATE TABLE IF NOT EXISTS`). Six tables:

| Table | Content |
|---|---|
| `sessions` | Session state + participants |
| `services` | Registered services |
| `api_keys` | Hashed long-lived keys |
| `audit_log` | Structured event log |
| `registry_schemas` | Published schema versions |
| `generation_jobs` | Async job queue |

### Local development with Docker

```bash
docker compose up -d db      # starts postgres:16-alpine on :5432
STORE_BACKEND=postgres DATABASE_URL=postgresql://bridgefill:bridgefill@localhost:5432/bridgefill npm start
```

---

## Deployment

### Docker

```bash
docker build -t bridgefill .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET=<strong-secret> \
  -e LLM_API_KEY=sk-... \
  -e STORE_BACKEND=postgres \
  -e DATABASE_URL=postgresql://... \
  bridgefill
```

### Docker Compose (full stack)

```bash
LLM_API_KEY=sk-... docker compose up
```

### Fly.io

```bash
fly launch --no-deploy       # uses fly.toml in repo root
fly secrets set JWT_SECRET=<strong-secret>
fly secrets set LLM_API_KEY=sk-...
fly postgres create          # provision managed postgres
fly postgres attach          # sets DATABASE_URL automatically
fly secrets set STORE_BACKEND=postgres
fly deploy
```

The included `fly.toml` configures:
- 512 MB shared-CPU VM
- Auto-stop/start machines
- `/ready` healthcheck (15s interval, 5s timeout)
- HTTPS enforcement

### Production checklist

- [ ] `JWT_SECRET` set to a randomly generated 32+ byte secret
- [ ] `DATABASE_URL` points to a managed Postgres instance
- [ ] `STORE_BACKEND=postgres`
- [ ] `LLM_API_KEY` set (or accept fallback stub generation)
- [ ] TLS terminated at the load balancer or Fly proxy
- [ ] `NODE_ENV=production`

BridgeFill will **warn on stderr** at startup if `JWT_SECRET` is the dev default or `LLM_API_KEY` is absent. It will **throw** if `STORE_BACKEND=postgres` and `DATABASE_URL` is missing.

---

## Development

### Commands

```bash
npm run dev              # tsx watch mode + pino-pretty
npm run build            # tsc → dist/
npm run test:e2e         # 48 E2E assertions (memory)
npm run test:e2e:memory  # explicit memory backend
npm run test:e2e:postgres # postgres backend (requires running DB)
npm test                 # jest unit tests
```

### Adding a new MCP tool

1. Add the tool schema to `src/tools/definitions.ts`
2. Add the handler to `src/tools/handlers.ts`
3. Update the tools/list assertion count in `test/e2e.ts` if needed
4. Add at least one E2E assertion for the new tool

### Running against a real LLM

```bash
LLM_API_KEY=sk-... npm run dev
```

The Phase 4 E2E assertion (`generate_integration with an LLM API key`) will automatically exercise the real LLM path.

### Database migrations

Migrations are plain SQL strings in `src/persistence/backends/postgres.ts` and run idempotently on every startup (`CREATE TABLE IF NOT EXISTS`). To add a column:

1. Add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statement to the migration function
2. Update the corresponding TypeScript type and query functions

---

## Security

- **API keys** are stored as SHA-256 hashes — the raw key is shown once on creation
- **JWT tokens** include a `jti` (JWT ID) for revocation and a `keyId` binding
- **Revocation** is enforced at token-minting time (key lookup) and via JTI blocklist
- **Key rotation** supports a configurable grace period so old clients aren't broken instantly
- **Tool allowlists** are encoded in the JWT — no server-side role lookup on every call
- **Security headers** via `@fastify/helmet` (CSP, `X-Frame-Options`, `X-Content-Type-Options`, HSTS)
- **Rate limiting** via `@fastify/rate-limit` with per-route overrides

To report a security vulnerability, please open a GitHub issue marked **[security]** or email the maintainer directly.

---

## Contributing

Contributions are welcome. Please open an issue before starting significant work so we can discuss approach.

### Development setup

```bash
git clone https://github.com/Krishnan9074/Bridgefill.git
cd Bridgefill
npm install
npm run dev
```

### Pull request checklist

- [ ] `npm run build` exits zero (no TypeScript errors)
- [ ] `npm run test:e2e` passes all assertions
- [ ] New tools/routes have at least one E2E assertion
- [ ] No `process.env` reads outside `config/index.ts`
- [ ] No `console.log` in library code
- [ ] No mocking of LLM providers (see `AGENTS.md`)

### Repository conventions

- **ESM only** — `import/export`, `.js` extensions on all local imports
- **Error shape** — `{ "error": "...", "code": "MACHINE_CODE" }`
- **Env vars** — read exclusively in `config/index.ts`
- **Audit** — every significant action must call an audit helper
- **No mocks** — tests use the real server via `fastify.inject()`; LLM tests require a real key or skip

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

Built with [Fastify](https://fastify.io) · [Model Context Protocol](https://modelcontextprotocol.io) · [TypeScript](https://typescriptlang.org)

</div>
