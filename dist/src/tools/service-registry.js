const serviceRegistry = new Map();
export function registerInRegistry(serviceId, entry) {
    serviceRegistry.set(serviceId, { ...entry, id: serviceId });
    return serviceRegistry.get(serviceId);
}
export function getPublicServiceList() {
    return Array.from(serviceRegistry.values());
}
export function getService(serviceId) {
    return serviceRegistry.get(serviceId) ?? null;
}
export function hasService(serviceId) {
    return serviceRegistry.has(serviceId);
}
