import { buildJobRecord, generateFromRegistry } from "../codegen/standalone.js";
const jobs = new Map();
export function createGenerateJob(orgId, request) {
    const job = buildJobRecord(orgId, request);
    jobs.set(job.jobId, job);
    return job;
}
export function getGenerateJob(jobId) {
    return jobs.get(jobId) ?? null;
}
export function updateGenerateJob(jobId, patch) {
    const current = jobs.get(jobId);
    if (!current) {
        throw new Error("Job not found");
    }
    const next = { ...current, ...patch };
    jobs.set(jobId, next);
    return next;
}
export function runGenerateJob(jobId) {
    const current = getGenerateJob(jobId);
    if (!current) {
        return;
    }
    setImmediate(async () => {
        updateGenerateJob(jobId, { status: "running", error: null });
        try {
            const result = await generateFromRegistry({
                serviceReference: current.request.service_id,
                version: current.request.version ?? "latest",
                consumerContext: current.request.consumer_context,
                options: current.request.options,
                orgId: current.orgId,
            });
            updateGenerateJob(jobId, {
                status: "complete",
                result,
                completedAt: new Date().toISOString(),
            });
        }
        catch (error) {
            updateGenerateJob(jobId, {
                status: "failed",
                error: error.message,
                completedAt: new Date().toISOString(),
            });
        }
    });
}
