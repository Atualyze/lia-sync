const DEFAULT_TOPIC_GAP_MS = 2 * 60 * 60 * 1000;

function messageTime(message) {
  const value = message?.createdAt || message?.timestamp || null;
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Selects the active conversational episode without deleting or mutating the
 * stored history. A long idle gap starts a new active thread unless a structured
 * workflow is still pending, in which case its context remains available.
 */
export function selectActiveClientHistory(history = [], {
  maxTurns = 24,
  nowMs = Date.now(),
  topicGapMs = DEFAULT_TOPIC_GAP_MS,
  preservePendingContext = false
} = {}) {
  const all = Array.isArray(history) ? history : [];
  if (all.length === 0) return { history: [], topicBoundary: false, boundaryIndex: 0 };

  let boundaryIndex = 0;
  if (!preservePendingContext) {
    for (let i = all.length - 1; i > 0; i -= 1) {
      const currentTime = messageTime(all[i]);
      const previousTime = messageTime(all[i - 1]);
      if (currentTime === null || previousTime === null) continue;
      if (currentTime - previousTime > topicGapMs && currentTime <= nowMs + 60_000) {
        boundaryIndex = i;
        break;
      }
    }
  }

  const limit = Math.max(1, Math.min(100, Number(maxTurns) || 24));
  const active = all.slice(boundaryIndex);
  return {
    history: active.slice(-limit),
    topicBoundary: boundaryIndex > 0,
    boundaryIndex
  };
}
