export type Role = "provider" | "consumer";
export type SessionStatus = "pending" | "active" | "complete" | "expired";

export interface OrgClaims {
  orgId: string;
  orgName: string;
  role: Role;
  serviceId: string | null;
  allowedTools: string[];
  jti: string;
  keyId: string;
}

export interface Participant {
  orgId: string;
  orgName: string;
  joinedAt: string;
}

export interface RawSchemaAuth {
  type: "api_key" | "oauth2" | "bearer" | "basic" | "none";
  location?: "header" | "query" | "body";
  key_name?: string;
}

export interface RawSchemaParameter {
  name: string;
  in: "query" | "path" | "header" | "body";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface RawSchemaEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  summary?: string;
  parameters?: RawSchemaParameter[];
  response_schema?: Record<string, unknown>;
}

export interface RawSchemaContract {
  base_url: string;
  auth: RawSchemaAuth;
  endpoints: RawSchemaEndpoint[];
  rate_limits?: {
    requests_per_second?: number;
    requests_per_day?: number;
  };
  sdk_languages?: string[];
}

export interface NormalizedParam {
  name: string;
  in: RawSchemaParameter["in"];
  required: boolean;
  description: string;
  schema: Record<string, unknown>;
}

export interface NormalizedEndpoint {
  path: string;
  method: RawSchemaEndpoint["method"];
  summary: string;
  required_params: NormalizedParam[];
  optional_params: NormalizedParam[];
  all_params: NormalizedParam[];
  response_schema: Record<string, unknown>;
}

export interface NormalizedSchema {
  base_url: string;
  auth: {
    type: RawSchemaAuth["type"];
    location: RawSchemaAuth["location"] | null;
    key_name: string | null;
  };
  endpoints: NormalizedEndpoint[];
  rate_limits: {
    requests_per_second?: number;
    requests_per_day?: number;
  };
  sdk_languages: string[];
  normalised_at: string;
  version?: string;
}

export interface CodeSample {
  language?: string;
  description?: string;
  content?: string;
}

export interface SessionSchema {
  id: string;
  raw: RawSchemaContract;
  normalised: NormalizedSchema;
  codeSamples: CodeSample[];
  version: string;
}

export interface GeneratedFile {
  filename: string;
  description: string;
  content: string;
  source: "provider_sample" | "llm_generated" | "fallback_generated";
}

export interface GeneratedOutput {
  files: GeneratedFile[];
  summary: string;
  nextSteps: string[];
  warnings: string[];
  source: "llm" | "fallback";
  model: string | null;
}

export interface SessionMessage {
  id: string;
  text: string;
  kind: string;
  createdAt: string;
  orgId?: string;
  role?: Role;
}

export interface VersionRecord {
  version: string;
  publishedAt: string;
  isBreaking: boolean;
  schema: NormalizedSchema;
}

export interface SessionRecord {
  id: string;
  serviceId: string;
  status: SessionStatus;
  createdAt: string;
  activatedAt: string | null;
  participants: {
    provider?: Participant;
    consumer?: Participant;
  };
  schema: SessionSchema | null;
  schemaHistory: VersionRecord[];
  generatedCode: GeneratedOutput | null;
  messages: SessionMessage[];
  _expiryTimer: NodeJS.Timeout | null;
}

export interface ServiceEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  providerOrgId: string;
  providerOrgName: string;
  registeredAt: string;
}

export interface ApiKeyRecord {
  keyId: string;
  orgId: string;
  hash: string;
  label: string | null;
  status: "active" | "rotating" | "revoked";
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  rotatedFromKeyId: string | null;
  replacementKeyId: string | null;
  _revokeTimer: NodeJS.Timeout | null;
}

export interface Change {
  severity: "breaking" | "warning" | "additive" | "info";
  path: string;
  change: string;
  from: unknown;
  to: unknown;
  message: string;
}

export interface SchemaDiff {
  hasDiff: boolean;
  isBreaking: boolean;
  breakingCount: number;
  warningCount: number;
  additiveCount: number;
  infoCount: number;
  suggestedVersionBump: "major" | "minor" | "patch";
  changes: Change[];
}

export interface EnrichedChange extends Change {
  consumer_impact: string;
  remediation: string;
}

export interface ConflictReport {
  hasConflicts: boolean;
  conflictCount: number;
  warningCount: number;
  conflicts: EnrichedChange[];
  warnings: EnrichedChange[];
  recommendation: string;
}

export interface NegotiationResult {
  canProceed: boolean;
  blockedEndpoints: string[];
  usableEndpoints: string[];
  diff: SchemaDiff;
  conflicts: ConflictReport;
  negotiationMessages: Array<{
    to: "provider" | "consumer" | "both";
    type: string;
    content: string;
  }>;
}

export interface ConsumerContext {
  language?: string;
  framework?: string;
  use_case?: string;
  existing_patterns?: string;
  endpoints_needed?: string[];
}
