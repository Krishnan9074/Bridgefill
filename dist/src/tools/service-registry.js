import { getStores } from "../persistence/index.js";
export async function registerInRegistry(serviceId, entry) {
    const stores = getStores();
    const next = { ...entry, id: serviceId };
    await stores.services.set(serviceId, next);
    return next;
}
export function getPublicServiceList() {
    return getStores().services.list();
}
export function getService(serviceId) {
    return getStores().services.get(serviceId);
}
export function hasService(serviceId) {
    return getStores().services.has(serviceId);
}
