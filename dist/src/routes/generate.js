import { buildJobRecord, generateFromRegistry } from "../codegen/standalone.js";
import { getStores } from "../persistence/index.js";
export async function createGenerateJob(orgId, request) {
    const job = buildJobRecord(orgId, request);
    await getStores().jobs.set(job.jobId, job);
    return job;
}
export function getGenerateJob(jobId) {
    return getStores().jobs.get(jobId);
}
export async function updateGenerateJob(jobId, patch) {
    const current = getStores().jobs.get(jobId);
    if (!current) {
        throw new Error("Job not found");
    }
    const next = { ...current, ...patch };
    await getStores().jobs.set(jobId, next);
    return next;
}
export function runGenerateJob(jobId) {
    const current = getGenerateJob(jobId);
    if (!current) {
        return;
    }
    setImmediate(async () => {
        await updateGenerateJob(jobId, { status: "running", error: null });
        try {
            const result = await generateFromRegistry({
                serviceReference: current.request.service_id,
                version: current.request.version ?? "latest",
                consumerContext: current.request.consumer_context,
                options: current.request.options,
                orgId: current.orgId,
            });
            await updateGenerateJob(jobId, {
                status: "complete",
                result,
                completedAt: new Date().toISOString(),
            });
        }
        catch (error) {
            await updateGenerateJob(jobId, {
                status: "failed",
                error: error.message,
                completedAt: new Date().toISOString(),
            });
        }
    });
}
