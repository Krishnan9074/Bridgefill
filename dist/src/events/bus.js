const clients = new Set();
export function addClient(reply) {
    clients.add(reply);
    return () => {
        clients.delete(reply);
    };
}
export function broadcast(entry) {
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of clients) {
        try {
            client.raw.write(payload);
        }
        catch {
            clients.delete(client);
        }
    }
}
export function clientCount() {
    return clients.size;
}
