let lastConfigRead = null;

export function markBridgeConfigRead(revision, at = new Date().toISOString()) {
  lastConfigRead = { revision: Number(revision) || 0, at };
}

export function getBridgeConfigStatus({ configured = false, now = Date.now(), staleAfterMs = 5 * 60 * 1000 } = {}) {
  if (!configured) return { configured: false, status: 'not_configured', lastReadAt: null, revision: null };
  if (!lastConfigRead) return { configured: true, status: 'awaiting_first_read', lastReadAt: null, revision: null };
  const isRecent = now - Date.parse(lastConfigRead.at) <= staleAfterMs;
  return {
    configured: true,
    status: isRecent ? 'connected' : 'stale',
    lastReadAt: lastConfigRead.at,
    revision: lastConfigRead.revision
  };
}
