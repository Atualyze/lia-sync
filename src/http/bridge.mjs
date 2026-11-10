// Registro dos clientes SSE conectados em /api/bridge/events.
export const bridgeSubscribers = new Set();

export function broadcastBridgeEvent(type, data) {
  if (bridgeSubscribers.size === 0) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of Array.from(bridgeSubscribers)) {
    try {
      res.write(payload);
    } catch {
      bridgeSubscribers.delete(res);
    }
  }
}
