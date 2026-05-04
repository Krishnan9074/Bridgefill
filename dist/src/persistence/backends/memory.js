export function createMemoryStores() {
    const sessionsById = new Map();
    const sessionIdsByService = new Map();
    const servicesById = new Map();
    const keysByHash = new Map();
    const keysById = new Map();
    const keyIdsByOrg = new Map();
    const auditLog = [];
    const registryById = new Map();
    const registryIdsByService = new Map();
    const jobsById = new Map();
    const jobIdsByOrg = new Map();
    function saveKeyIndex(record) {
        keysByHash.set(record.hash, record);
        keysById.set(record.keyId, record);
        const orgIds = keyIdsByOrg.get(record.orgId) ?? [];
        if (!orgIds.includes(record.keyId)) {
            orgIds.push(record.keyId);
            keyIdsByOrg.set(record.orgId, orgIds);
        }
    }
    function saveRegistryIndex(record) {
        registryById.set(record.registryId, record);
        const ids = registryIdsByService.get(record.serviceId) ?? [];
        if (!ids.includes(record.registryId)) {
            ids.push(record.registryId);
            registryIdsByService.set(record.serviceId, ids);
        }
    }
    function saveJobIndex(record) {
        jobsById.set(record.jobId, record);
        const ids = jobIdsByOrg.get(record.orgId) ?? [];
        if (!ids.includes(record.jobId)) {
            ids.push(record.jobId);
            jobIdsByOrg.set(record.orgId, ids);
        }
    }
    return {
        sessions: {
            get(id) {
                return sessionsById.get(id) ?? null;
            },
            async set(id, data) {
                sessionsById.set(id, data);
            },
            async del(id) {
                const current = sessionsById.get(id);
                if (current && sessionIdsByService.get(current.serviceId) === id) {
                    sessionIdsByService.delete(current.serviceId);
                }
                sessionsById.delete(id);
            },
            getByServiceId(serviceId) {
                const sessionId = sessionIdsByService.get(serviceId);
                return sessionId ? sessionsById.get(sessionId) ?? null : null;
            },
            async indexByServiceId(serviceId, sessionId) {
                if (sessionId) {
                    sessionIdsByService.set(serviceId, sessionId);
                }
                else {
                    sessionIdsByService.delete(serviceId);
                }
            },
            list() {
                return Array.from(sessionsById.values());
            },
        },
        services: {
            get(id) {
                return servicesById.get(id) ?? null;
            },
            async set(id, data) {
                servicesById.set(id, data);
            },
            list() {
                return Array.from(servicesById.values());
            },
            has(id) {
                return servicesById.has(id);
            },
        },
        keys: {
            getByHash(hash) {
                return keysByHash.get(hash) ?? null;
            },
            getByKeyId(keyId) {
                return keysById.get(keyId) ?? null;
            },
            listByOrg(orgId) {
                return (keyIdsByOrg.get(orgId) ?? []).map((keyId) => keysById.get(keyId)).filter((record) => !!record);
            },
            async save(record) {
                saveKeyIndex(record);
            },
            async update(keyId, updates) {
                const current = keysById.get(keyId);
                if (!current) {
                    return null;
                }
                if (updates.hash && updates.hash !== current.hash) {
                    keysByHash.delete(current.hash);
                }
                const next = { ...current, ...updates };
                saveKeyIndex(next);
                return next;
            },
        },
        audit: {
            async append(entry) {
                auditLog.push(entry);
                if (auditLog.length > 10_000) {
                    auditLog.shift();
                }
            },
            query({ orgId, category, sessionId, limit = 100 }) {
                return auditLog
                    .filter((entry) => {
                    if (orgId && entry.orgId !== orgId && entry.initiatorOrgId !== orgId) {
                        return false;
                    }
                    if (category && entry.category !== category) {
                        return false;
                    }
                    if (sessionId && entry.sessionId !== sessionId) {
                        return false;
                    }
                    return true;
                })
                    .slice(-limit)
                    .reverse();
            },
            count() {
                return auditLog.length;
            },
        },
        registry: {
            async save(record) {
                saveRegistryIndex(record);
            },
            getById(registryId) {
                return registryById.get(registryId) ?? null;
            },
            getLatest(serviceId) {
                return (registryIdsByService.get(serviceId) ?? [])
                    .map((id) => registryById.get(id))
                    .filter((record) => !!record)
                    .find((record) => record.isLatest) ?? null;
            },
            getHistory(serviceId) {
                return (registryIdsByService.get(serviceId) ?? [])
                    .map((id) => registryById.get(id))
                    .filter((record) => !!record)
                    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
            },
            list({ orgId, tags, q, limit = 20 }) {
                const normalizedTags = (tags ?? []).map((tag) => tag.toLowerCase());
                const query = q?.toLowerCase().trim();
                return Array.from(registryById.values())
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
            },
            async markNotLatest(serviceId) {
                for (const record of this.getHistory(serviceId)) {
                    record.isLatest = false;
                }
            },
        },
        jobs: {
            get(jobId) {
                return jobsById.get(jobId) ?? null;
            },
            async set(jobId, data) {
                jobsById.set(jobId, data);
                saveJobIndex(data);
            },
            listByOrg(orgId) {
                return (jobIdsByOrg.get(orgId) ?? []).map((jobId) => jobsById.get(jobId)).filter((record) => !!record);
            },
        },
        meta: {
            backend: "memory",
            dbConnected: null,
            dbLatencyMs: null,
        },
        async ping() {
            return {
                backend: "memory",
                dbConnected: null,
                dbLatencyMs: null,
            };
        },
        async close() { },
    };
}
