import { createMemoryStores } from "./backends/memory.js";
import { createPostgresStores } from "./backends/postgres.js";
let stores = null;
export async function initStores(opts = {}) {
    if (stores && !opts.force) {
        return stores;
    }
    if (stores && opts.force) {
        await stores.close();
        stores = null;
    }
    const backend = (opts.backend ?? process.env.STORE_BACKEND ?? "memory").toLowerCase();
    stores = backend === "postgres"
        ? await createPostgresStores({ pgUrl: opts.pgUrl ?? process.env.DATABASE_URL ?? null })
        : createMemoryStores();
    return stores;
}
export function getStores() {
    if (!stores) {
        throw new Error("Stores not initialised — call initStores() at startup");
    }
    return stores;
}
export async function getStoreStatus() {
    return getStores().ping();
}
export async function closeStores() {
    if (!stores) {
        return;
    }
    await stores.close();
    stores = null;
}
