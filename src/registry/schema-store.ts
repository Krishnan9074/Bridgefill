import { randomUUID } from "node:crypto";

import { getStores } from "../persistence/index.js";
import { bumpVersion, diff } from "../schema/negotiation.js";
import type { CodeSample, RegistrySchemaRecord, SchemaDiff } from "../types.js";

function getServiceEntries(serviceId: string): RegistrySchemaRecord[] {
  return getStores().registry.getHistory(serviceId).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}

function latestEntry(serviceId: string): RegistrySchemaRecord | null {
  return getStores().registry.getLatest(serviceId);
}

export async function publishToRegistry(
  orgId: string,
  orgName: string,
  serviceId: string,
  serviceName: string,
  normalisedSchema: RegistrySchemaRecord["schema"],
  codeSamples: CodeSample[],
  changelog: string,
  tags: string[],
): Promise<{
  registryId: string;
  version: string;
  diffFromPrevious: SchemaDiff | null;
  record: RegistrySchemaRecord;
}> {
  const currentLatest = latestEntry(serviceId);
  const history = getServiceEntries(serviceId).map((entry) => ({
    version: entry.version,
    publishedAt: entry.publishedAt,
    isBreaking: false,
    schema: entry.schema,
  }));
  const diffFromPrevious = currentLatest ? diff(currentLatest.schema, normalisedSchema) : null;
  const { version } = bumpVersion(history, normalisedSchema, diffFromPrevious);

  await getStores().registry.markNotLatest(serviceId);

  const registryId = `reg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const record: RegistrySchemaRecord = {
    registryId,
    serviceId,
    serviceName,
    orgId,
    orgName,
    version,
    schema: {
      ...normalisedSchema,
      version,
    },
    codeSamples,
    changelog,
    tags,
    isLatest: true,
    publishedAt: new Date().toISOString(),
  };

  await getStores().registry.save(record);

  return {
    registryId,
    version,
    diffFromPrevious,
    record,
  };
}

export function getRegistryEntry(registryId: string): RegistrySchemaRecord | null {
  return getStores().registry.getById(registryId);
}

export function getLatestSchema(serviceId: string): RegistrySchemaRecord | null {
  return getStores().registry.getLatest(serviceId);
}

export function getSchemaHistory(serviceId: string): RegistrySchemaRecord[] {
  return getStores().registry.getHistory(serviceId);
}

export function listRegistry({
  orgId,
  tags,
  q,
  limit = 20,
}: {
  orgId?: string;
  tags?: string[];
  q?: string;
  limit?: number;
}): RegistrySchemaRecord[] {
  return getStores().registry.list({ orgId, tags, q, limit });
}

export function diffRegistryVersions(serviceId: string, fromVersion: string, toVersion: string): SchemaDiff | null {
  const entries = getServiceEntries(serviceId);
  const from = entries.find((entry) => entry.version === fromVersion);
  const to = entries.find((entry) => entry.version === toVersion);
  if (!from || !to) {
    return null;
  }
  return diff(from.schema, to.schema);
}
