import type { ApiKeyRecord, GenerateJobRecord, RegistrySchemaRecord, ServiceEntry, SessionRecord } from "../types.js";

export interface SessionStore {
  get(id: string): SessionRecord | null;
  set(id: string, data: SessionRecord): Promise<void>;
  del(id: string): Promise<void>;
  getByServiceId(serviceId: string): SessionRecord | null;
  indexByServiceId(serviceId: string, sessionId: string | null): Promise<void>;
  list(): SessionRecord[];
}

export interface ServiceStore {
  get(id: string): ServiceEntry | null;
  set(id: string, data: ServiceEntry): Promise<void>;
  list(): ServiceEntry[];
  has(id: string): boolean;
}

export interface KeyStore {
  getByHash(hash: string): ApiKeyRecord | null;
  getByKeyId(keyId: string): ApiKeyRecord | null;
  listByOrg(orgId: string): ApiKeyRecord[];
  save(record: ApiKeyRecord): Promise<void>;
  update(keyId: string, updates: Partial<ApiKeyRecord>): Promise<ApiKeyRecord | null>;
}

export interface AuditStoreEntry {
  seq: number;
  ts: string;
  category: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditStore {
  append(entry: AuditStoreEntry): Promise<void>;
  query(input: { orgId?: string; category?: string; sessionId?: string; limit?: number }): AuditStoreEntry[];
  count(): number;
}

export interface RegistryStore {
  save(record: RegistrySchemaRecord): Promise<void>;
  getById(registryId: string): RegistrySchemaRecord | null;
  getLatest(serviceId: string): RegistrySchemaRecord | null;
  getHistory(serviceId: string): RegistrySchemaRecord[];
  list(input: { orgId?: string; tags?: string[]; q?: string; limit?: number }): RegistrySchemaRecord[];
  markNotLatest(serviceId: string): Promise<void>;
}

export interface JobStore {
  get(jobId: string): GenerateJobRecord | null;
  set(jobId: string, data: GenerateJobRecord): Promise<void>;
  listByOrg(orgId: string): GenerateJobRecord[];
}

export interface StoreBackendMeta {
  backend: "memory" | "postgres";
  dbConnected: boolean | null;
  dbLatencyMs: number | null;
}

export interface StoreCollection {
  sessions: SessionStore;
  services: ServiceStore;
  keys: KeyStore;
  audit: AuditStore;
  registry: RegistryStore;
  jobs: JobStore;
}

export interface InitializedStores extends StoreCollection {
  meta: StoreBackendMeta;
  ping(): Promise<StoreBackendMeta>;
  close(): Promise<void>;
}
