import type { ServiceEntry } from "../types.js";
import { getStores } from "../persistence/index.js";

export async function registerInRegistry(serviceId: string, entry: ServiceEntry): Promise<ServiceEntry> {
  const stores = getStores();
  const next = { ...entry, id: serviceId };
  await stores.services.set(serviceId, next);
  return next;
}

export function getPublicServiceList(): ServiceEntry[] {
  return getStores().services.list();
}

export function getService(serviceId: string): ServiceEntry | null {
  return getStores().services.get(serviceId);
}

export function hasService(serviceId: string): boolean {
  return getStores().services.has(serviceId);
}
