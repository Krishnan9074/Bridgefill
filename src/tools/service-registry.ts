import type { ServiceEntry } from "../types.js";

const serviceRegistry = new Map<string, ServiceEntry>();

export function registerInRegistry(serviceId: string, entry: ServiceEntry): ServiceEntry {
  serviceRegistry.set(serviceId, { ...entry, id: serviceId });
  return serviceRegistry.get(serviceId)!;
}

export function getPublicServiceList(): ServiceEntry[] {
  return Array.from(serviceRegistry.values());
}

export function getService(serviceId: string): ServiceEntry | null {
  return serviceRegistry.get(serviceId) ?? null;
}

export function hasService(serviceId: string): boolean {
  return serviceRegistry.has(serviceId);
}
