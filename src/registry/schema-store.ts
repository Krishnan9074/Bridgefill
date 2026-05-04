import { randomUUID } from "node:crypto";

import { bumpVersion, diff } from "../schema/negotiation.js";
import type { CodeSample, RegistrySchemaRecord, SchemaDiff } from "../types.js";

const registryEntries = new Map<string, RegistrySchemaRecord>();
const entriesByService = new Map<string, RegistrySchemaRecord[]>();

function getServiceEntries(serviceId: string): RegistrySchemaRecord[] {
  return entriesByService.get(serviceId) ?? [];
}

function saveEntry(entry: RegistrySchemaRecord): void {
  registryEntries.set(entry.registryId, entry);
  const existing = getServiceEntries(entry.serviceId).filter((item) => item.registryId !== entry.registryId);
  existing.push(entry);
  existing.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  entriesByService.set(entry.serviceId, existing);
}

function latestEntry(serviceId: string): RegistrySchemaRecord | null {
  return getServiceEntries(serviceId).find((entry) => entry.isLatest) ?? null;
}

export function publishToRegistry(
  orgId: string,
  orgName: string,
  serviceId: string,
  serviceName: string,
  normalisedSchema: RegistrySchemaRecord["schema"],
  codeSamples: CodeSample[],
  changelog: string,
  tags: string[],
): {
  registryId: string;
  version: string;
  diffFromPrevious: SchemaDiff | null;
  record: RegistrySchemaRecord;
} {
  const currentLatest = latestEntry(serviceId);
  const history = getServiceEntries(serviceId).map((entry) => ({
    version: entry.version,
    publishedAt: entry.publishedAt,
    isBreaking: false,
    schema: entry.schema,
  }));
  const diffFromPrevious = currentLatest ? diff(currentLatest.schema, normalisedSchema) : null;
  const { version } = bumpVersion(history, normalisedSchema, diffFromPrevious);

  for (const entry of getServiceEntries(serviceId)) {
    if (entry.isLatest) {
      entry.isLatest = false;
    }
  }

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

  saveEntry(record);

  return {
    registryId,
    version,
    diffFromPrevious,
    record,
  };
}

export function getRegistryEntry(registryId: string): RegistrySchemaRecord | null {
  return registryEntries.get(registryId) ?? null;
}

export function getLatestSchema(serviceId: string): RegistrySchemaRecord | null {
  return latestEntry(serviceId);
}

export function getSchemaHistory(serviceId: string): RegistrySchemaRecord[] {
  return [...getServiceEntries(serviceId)].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
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
  const normalizedTags = (tags ?? []).map((tag) => tag.toLowerCase());
  const query = q?.toLowerCase().trim();

  return Array.from(registryEntries.values())
    .filter((entry) => entry.isLatest)
    .filter((entry) => {
      if (orgId && entry.orgId !== orgId) {
        return false;
      }
      if (normalizedTags.length && !normalizedTags.every((tag) => entry.tags.some((entryTag) => entryTag.toLowerCase() === tag))) {
        return false;
      }
      if (query) {
        const haystack = [entry.serviceName, entry.orgName, entry.serviceId, entry.version, ...entry.tags].join(" ").toLowerCase();
        if (!haystack.includes(query)) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
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
