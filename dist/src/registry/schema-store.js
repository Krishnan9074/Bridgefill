import { randomUUID } from "node:crypto";
import { getStores } from "../persistence/index.js";
import { bumpVersion, diff } from "../schema/negotiation.js";
function getServiceEntries(serviceId) {
    return getStores().registry.getHistory(serviceId).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}
function latestEntry(serviceId) {
    return getStores().registry.getLatest(serviceId);
}
export async function publishToRegistry(orgId, orgName, serviceId, serviceName, normalisedSchema, codeSamples, changelog, tags) {
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
    const record = {
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
export function getRegistryEntry(registryId) {
    return getStores().registry.getById(registryId);
}
export function getLatestSchema(serviceId) {
    return getStores().registry.getLatest(serviceId);
}
export function getSchemaHistory(serviceId) {
    return getStores().registry.getHistory(serviceId);
}
export function listRegistry({ orgId, tags, q, limit = 20, }) {
    return getStores().registry.list({ orgId, tags, q, limit });
}
export function diffRegistryVersions(serviceId, fromVersion, toVersion) {
    const entries = getServiceEntries(serviceId);
    const from = entries.find((entry) => entry.version === fromVersion);
    const to = entries.find((entry) => entry.version === toVersion);
    if (!from || !to) {
        return null;
    }
    return diff(from.schema, to.schema);
}
