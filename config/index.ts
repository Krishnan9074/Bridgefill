import type { Role } from "../src/types.js";

interface Config {
  app: {
    env: string;
  };
  server: {
    host: string;
    port: number;
  };
  mcp: {
    protocolVersion: string;
    serverName: string;
    serverVersion: string;
  };
  jwt: {
    secret: string;
    orgTokenTtl: string;
  };
  session: {
    handshakeTimeoutMs: number;
    maxMessagesPerSession: number;
  };
  llm: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string | null;
    maxTokens: number;
  };
  orgs: Record<string, {
    name: string;
    secret: string;
    allowedRoles: Role[];
  }>;
}

export const config: Config = {
  app: {
    env: process.env.NODE_ENV ?? "development",
  },
  server: {
    host: process.env.HOST ?? "0.0.0.0",
    port: parseInt(process.env.PORT ?? "3000", 10),
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
    handshakeTimeoutMs: parseInt(process.env.HANDSHAKE_TIMEOUT_MS ?? "120000", 10),
    maxMessagesPerSession: 1000,
  },
  llm: {
    provider: process.env.LLM_PROVIDER ?? "openai",
    model: process.env.LLM_MODEL ?? "gpt-4o",
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "4096", 10),
  },
  orgs: {
    org_demo_provider: {
      name: "Demo Provider",
      secret: process.env.ORG_PROVIDER_SECRET ?? "dev-provider-secret",
      allowedRoles: ["provider"],
    },
    org_demo_consumer: {
      name: "Demo Consumer",
      secret: process.env.ORG_CONSUMER_SECRET ?? "dev-consumer-secret",
      allowedRoles: ["consumer"],
    },
    org_demo: {
      name: "Demo Org",
      secret: process.env.ORG_DEMO_SECRET ?? "dev-demo-secret",
      allowedRoles: ["provider", "consumer"],
    },
  },
};
