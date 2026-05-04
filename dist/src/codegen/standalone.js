import { randomUUID } from "node:crypto";
import { verifyApiKey } from "../auth/api-keys.js";
import { verifyOrgToken } from "../auth/index.js";
import { generateIntegrationCode } from "../codegen/orchestrator.js";
import { getSchemaHistory, getLatestSchema, getRegistryEntry } from "../registry/schema-store.js";
import { negotiate } from "../schema/negotiation.js";
export class StandaloneRequestError extends Error {
    statusCode;
    machineCode;
    constructor(message, statusCode = 400, machineCode = "VALIDATION_ERROR") {
        super(message);
        this.name = "StandaloneRequestError";
        this.statusCode = statusCode;
        this.machineCode = machineCode;
    }
}
function cloneContext(consumerContext, options) {
    return {
        ...(consumerContext ?? {}),
        endpoints_needed: options?.endpoints?.length
            ? [...options.endpoints]
            : [...(consumerContext?.endpoints_needed ?? [])],
    };
}
export function resolveRegistrySchema(serviceReference, version = "latest") {
    if (!serviceReference) {
        throw new StandaloneRequestError("service_id is required");
    }
    if (serviceReference.startsWith("reg_")) {
        const entry = getRegistryEntry(serviceReference);
        if (!entry) {
            throw new StandaloneRequestError("Registry entry not found", 404, "NOT_FOUND");
        }
        return {
            serviceId: entry.serviceId,
            serviceName: entry.serviceName,
            entry,
        };
    }
    if (version === "latest") {
        const entry = getLatestSchema(serviceReference);
        if (!entry) {
            throw new StandaloneRequestError("No published schema found for service", 404, "NOT_FOUND");
        }
        return {
            serviceId: entry.serviceId,
            serviceName: entry.serviceName,
            entry,
        };
    }
    const match = getSchemaHistory(serviceReference).find((entry) => entry.version === version);
    if (!match) {
        throw new StandaloneRequestError("Requested schema version not found", 404, "NOT_FOUND");
    }
    return {
        serviceId: match.serviceId,
        serviceName: match.serviceName,
        entry: match,
    };
}
export async function generateFromRegistry({ serviceReference, version = "latest", consumerContext, options, orgId, }) {
    const resolved = resolveRegistrySchema(serviceReference, version);
    const mergedContext = cloneContext(consumerContext, options);
    const negotiation = negotiate({
        publishedSchema: resolved.entry.schema,
        previousSchema: null,
        consumerContext: mergedContext,
    });
    const startedAt = Date.now();
    const generated = await generateIntegrationCode({
        sessionId: `standalone_${randomUUID().slice(0, 8)}`,
        orgId,
        contract: resolved.entry.schema,
        codeSamples: resolved.entry.codeSamples,
        consumerContext: mergedContext,
        negotiation,
        options,
    });
    return {
        service_id: resolved.serviceId,
        schema_version: resolved.entry.version,
        model_used: generated.model,
        generation_time_ms: Date.now() - startedAt,
        files: generated.files,
        summary: generated.summary,
        next_steps: generated.nextSteps,
        warnings: generated.warnings,
    };
}
export function validateGeneratedFiles({ entry, files, }) {
    const codeBlob = files.map((file) => file.content).join("\n");
    const issues = [];
    const contract = entry.schema;
    if (!codeBlob.includes(contract.base_url)) {
        issues.push({
            severity: "error",
            endpoint: null,
            message: `Generated code does not reference base URL ${contract.base_url}.`,
        });
    }
    if (contract.auth.key_name && !codeBlob.includes(contract.auth.key_name)) {
        issues.push({
            severity: "error",
            endpoint: null,
            message: `Generated code does not reference auth key ${contract.auth.key_name}.`,
        });
    }
    for (const endpoint of contract.endpoints) {
        for (const param of endpoint.required_params) {
            if (!codeBlob.includes(param.name)) {
                issues.push({
                    severity: "error",
                    endpoint: endpoint.path,
                    message: `Missing required param ${param.name} for ${endpoint.path}.`,
                });
            }
        }
    }
    return {
        passed: issues.length === 0,
        issue_count: issues.length,
        issues,
        schema_version: entry.version,
    };
}
export function shouldRunAsync(entry, options, consumerContext) {
    const requestedEndpoints = options?.endpoints?.length
        ? options.endpoints
        : consumerContext?.endpoints_needed ?? [];
    const endpointCount = requestedEndpoints.length > 0
        ? entry.schema.endpoints.filter((endpoint) => requestedEndpoints.includes(endpoint.path)).length
        : entry.schema.endpoints.length;
    return endpointCount > 5;
}
export function resolveStandaloneAuth({ bearerToken, rawApiKey, }) {
    if (bearerToken) {
        const claims = verifyOrgToken(bearerToken);
        return {
            orgId: claims.orgId,
            orgName: claims.orgName,
            role: claims.role,
            authType: "bearer",
        };
    }
    if (rawApiKey) {
        const record = verifyApiKey(rawApiKey);
        return {
            orgId: record.orgId,
            orgName: record.orgId,
            role: "api_key",
            authType: "api_key",
        };
    }
    throw new StandaloneRequestError("Missing authentication", 401, "AUTH_ERROR");
}
export function buildJobRecord(orgId, request) {
    return {
        jobId: `job_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        status: "pending",
        orgId,
        request,
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
    };
}
