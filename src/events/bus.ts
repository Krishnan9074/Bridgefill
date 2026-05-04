import type { FastifyReply } from "fastify";

const clients = new Set<FastifyReply>();

export function addClient(reply: FastifyReply): () => void {
  clients.add(reply);

  return () => {
    clients.delete(reply);
  };
}

export function broadcast(entry: unknown): void {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;

  for (const client of clients) {
    try {
      client.raw.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
