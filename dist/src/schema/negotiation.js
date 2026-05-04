function parseEndpointKey(endpoint) {
    return `${endpoint.method}:${endpoint.path}`;
}
function groupParams(params = []) {
    const required = [];
    const optional = [];
    const byName = new Map();
    for (const param of params) {
        byName.set(param.name, param);
        if (param.required) {
            required.push(param);
        }
        else {
            optional.push(param);
        }
    }
    return { required, optional, byName };
}
function compareValues(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function endpointPathFromChange(changePath) {
    const match = /^endpoints\.([^.:]+:[^.:]+)/.exec(changePath);
    if (!match) {
        return null;
    }
    return match[1].replace(/^[A-Z]+:/, "");
}
function makeChange(severity, path, change, from, to, message) {
    return { severity, path, change, from, to, message };
}
function determineBump(counts) {
    if (counts.breaking > 0) {
        return "major";
    }
    if (counts.warning > 0 || counts.additive > 0) {
        return "minor";
    }
    return "patch";
}
export function diff(prev, next) {
    const changes = [];
    const prevEndpoints = new Map((prev.endpoints ?? []).map((endpoint) => [parseEndpointKey(endpoint), endpoint]));
    const nextEndpoints = new Map((next.endpoints ?? []).map((endpoint) => [parseEndpointKey(endpoint), endpoint]));
    if (prev.base_url !== next.base_url) {
        changes.push(makeChange("breaking", "base_url", "modified", prev.base_url, next.base_url, "Base URL changed. Consumers must update HTTP client configuration."));
    }
    if ((prev.auth?.type ?? "none") !== (next.auth?.type ?? "none")) {
        changes.push(makeChange("breaking", "auth.type", "modified", prev.auth?.type ?? "none", next.auth?.type ?? "none", "Auth type changed. Consumers must update credential handling."));
    }
    if ((prev.auth?.key_name ?? null) !== (next.auth?.key_name ?? null)) {
        changes.push(makeChange("breaking", "auth.key_name", "modified", prev.auth?.key_name ?? null, next.auth?.key_name ?? null, "Auth key name changed. Consumers must update the credential field they send."));
    }
    const prevLimits = prev.rate_limits ?? {};
    const nextLimits = next.rate_limits ?? {};
    for (const key of ["requests_per_second", "requests_per_day"]) {
        if (typeof prevLimits[key] === "number" && typeof nextLimits[key] === "number" && prevLimits[key] !== nextLimits[key]) {
            if (nextLimits[key] < prevLimits[key]) {
                changes.push(makeChange("warning", `rate_limits.${key}`, "modified", prevLimits[key], nextLimits[key], `Rate limit ${key} tightened. Consumers may hit 429s sooner.`));
            }
            else {
                changes.push(makeChange("info", `rate_limits.${key}`, "modified", prevLimits[key], nextLimits[key], `Rate limit ${key} loosened.`));
            }
        }
    }
    for (const [endpointKey, prevEndpoint] of prevEndpoints.entries()) {
        const nextEndpoint = nextEndpoints.get(endpointKey);
        if (!nextEndpoint) {
            changes.push(makeChange("breaking", `endpoints.${endpointKey}`, "removed", prevEndpoint, null, `Endpoint ${endpointKey} was removed.`));
            continue;
        }
        if ((prevEndpoint.summary ?? "") !== (nextEndpoint.summary ?? "")) {
            changes.push(makeChange("info", `endpoints.${endpointKey}.summary`, "modified", prevEndpoint.summary ?? "", nextEndpoint.summary ?? "", `Endpoint ${endpointKey} summary changed.`));
        }
        const prevParams = groupParams(prevEndpoint.all_params ?? []);
        const nextParams = groupParams(nextEndpoint.all_params ?? []);
        for (const [name, prevParam] of prevParams.byName.entries()) {
            const nextParam = nextParams.byName.get(name);
            if (!nextParam) {
                if (prevParam.required) {
                    changes.push(makeChange("breaking", `endpoints.${endpointKey}.params.${name}`, "removed_required", prevParam, null, `Required parameter ${name} was removed from ${endpointKey}.`));
                }
                continue;
            }
            if (prevParam.required && !nextParam.required) {
                changes.push(makeChange("additive", `endpoints.${endpointKey}.params.${name}`, "made_optional", prevParam, nextParam, `Required parameter ${name} on ${endpointKey} is now optional.`));
            }
            if (!compareValues(prevParam.schema, nextParam.schema)) {
                changes.push(makeChange("warning", `endpoints.${endpointKey}.params.${name}.schema`, "modified", prevParam.schema, nextParam.schema, `Parameter ${name} on ${endpointKey} changed schema.`));
            }
        }
        for (const [name, nextParam] of nextParams.byName.entries()) {
            if (prevParams.byName.has(name)) {
                continue;
            }
            if (nextParam.required) {
                changes.push(makeChange("breaking", `endpoints.${endpointKey}.params.${name}`, "added_required", null, nextParam, `New required parameter ${name} was added to ${endpointKey}.`));
            }
            else {
                changes.push(makeChange("additive", `endpoints.${endpointKey}.params.${name}`, "added_optional", null, nextParam, `New optional parameter ${name} was added to ${endpointKey}.`));
            }
        }
    }
    for (const [endpointKey, nextEndpoint] of nextEndpoints.entries()) {
        if (!prevEndpoints.has(endpointKey)) {
            changes.push(makeChange("additive", `endpoints.${endpointKey}`, "added", null, nextEndpoint, `Endpoint ${endpointKey} was added.`));
        }
    }
    const counts = {
        breaking: changes.filter((change) => change.severity === "breaking").length,
        warning: changes.filter((change) => change.severity === "warning").length,
        additive: changes.filter((change) => change.severity === "additive").length,
        info: changes.filter((change) => change.severity === "info").length,
    };
    return {
        hasDiff: changes.length > 0,
        isBreaking: counts.breaking > 0,
        breakingCount: counts.breaking,
        warningCount: counts.warning,
        additiveCount: counts.additive,
        infoCount: counts.info,
        suggestedVersionBump: determineBump(counts),
        changes,
    };
}
export function detectConflicts(schemaDiff, consumerContext = {}) {
    const endpointsNeeded = Array.isArray(consumerContext.endpoints_needed) ? consumerContext.endpoints_needed : [];
    const filterByEndpoint = endpointsNeeded.length > 0;
    const relevantBreaking = (schemaDiff?.changes ?? []).filter((change) => {
        if (change.severity !== "breaking") {
            return false;
        }
        if (!filterByEndpoint) {
            return true;
        }
        const endpointPath = endpointPathFromChange(change.path);
        if (!endpointPath) {
            return true;
        }
        return endpointsNeeded.includes(endpointPath);
    });
    const warnings = (schemaDiff?.changes ?? []).filter((change) => {
        if (change.severity !== "warning") {
            return false;
        }
        if (!filterByEndpoint) {
            return true;
        }
        const endpointPath = endpointPathFromChange(change.path);
        return !endpointPath || endpointsNeeded.includes(endpointPath);
    });
    const language = consumerContext.language ?? "consumer";
    const enrich = (change) => ({
        ...change,
        consumer_impact: `${language} integration using ${endpointPathFromChange(change.path) ?? "this contract"} will break if unchanged.`,
        remediation: change.change === "added_required"
            ? "Add the new required parameter before sending requests."
            : change.change === "removed"
                ? "Stop generating or calling this endpoint."
                : "Update the consumer integration to match the new contract.",
    });
    return {
        hasConflicts: relevantBreaking.length > 0,
        conflictCount: relevantBreaking.length,
        warningCount: warnings.length,
        conflicts: relevantBreaking.map(enrich),
        warnings: warnings.map(enrich),
        recommendation: relevantBreaking.length > 0
            ? "Consumer changes are required before proceeding."
            : "No consumer-blocking schema conflicts detected.",
    };
}
export function negotiate({ publishedSchema, previousSchema, consumerContext = {} }) {
    const schemaDiff = previousSchema ? diff(previousSchema, publishedSchema) : {
        hasDiff: false,
        isBreaking: false,
        breakingCount: 0,
        warningCount: 0,
        additiveCount: 0,
        infoCount: 0,
        suggestedVersionBump: "patch",
        changes: [],
    };
    const conflicts = detectConflicts(schemaDiff, consumerContext);
    const requestedEndpoints = Array.isArray(consumerContext.endpoints_needed) ? consumerContext.endpoints_needed : [];
    const allEndpoints = (publishedSchema.endpoints ?? []).map((endpoint) => endpoint.path);
    const blockedEndpoints = Array.from(new Set(conflicts.conflicts.map((change) => endpointPathFromChange(change.path)).filter((value) => !!value)));
    const consideredEndpoints = requestedEndpoints.length > 0 ? requestedEndpoints : allEndpoints;
    const usableEndpoints = consideredEndpoints.filter((path) => !blockedEndpoints.includes(path));
    return {
        canProceed: blockedEndpoints.length === 0,
        blockedEndpoints,
        usableEndpoints,
        diff: schemaDiff,
        conflicts,
        negotiationMessages: [
            {
                to: conflicts.hasConflicts ? "both" : "consumer",
                type: conflicts.hasConflicts ? "schema_conflict" : "schema_ok",
                content: conflicts.recommendation,
            },
        ],
    };
}
function incrementVersion(version, bump) {
    const [major, minor, patch] = version.split(".").map((part) => parseInt(part, 10));
    if (bump === "major") {
        return `${major + 1}.0.0`;
    }
    if (bump === "minor") {
        return `${major}.${minor + 1}.0`;
    }
    return `${major}.${minor}.${patch + 1}`;
}
export function bumpVersion(history, newSchema, schemaDiff) {
    if (!history.length) {
        return {
            version: "1.0.0",
            history: [
                {
                    version: "1.0.0",
                    publishedAt: new Date().toISOString(),
                    isBreaking: false,
                    schema: newSchema,
                },
            ],
        };
    }
    const latest = history[history.length - 1];
    const version = incrementVersion(latest.version, schemaDiff?.suggestedVersionBump ?? "patch");
    return {
        version,
        history: [
            ...history,
            {
                version,
                publishedAt: new Date().toISOString(),
                isBreaking: !!schemaDiff?.breakingCount,
                schema: newSchema,
            },
        ],
    };
}
