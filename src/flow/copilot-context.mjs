const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_CHARS = 700;

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function compactHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-MAX_HISTORY_ITEMS).map(item => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: text(item?.content, MAX_HISTORY_CHARS)
  })).filter(item => item.content);
}

/**
 * Builds a bounded, structured snapshot of the Copilot conversation and its
 * operational state. The result is context for model interpretation only;
 * it does not authorize or execute actions.
 */
export function buildCopilotContext({
  session = {},
  latestMessage = '',
  owner = '',
  identity = {},
  recentContext,
  now = Date.now()
} = {}) {
  const dispatch = session?.pendingOutboundDispatch;
  const dispatchStatus = text(dispatch?.status, 40) || null;
  const history = compactHistory(recentContext ?? session?.history);

  return {
    version: 1,
    latestUserMessage: text(latestMessage, 2000),
    actor: {
      role: 'owner',
      label: text(owner, 80),
      assistant: text(identity?.assistantName || identity?.assistant || '', 80),
      company: text(identity?.companyName || '', 100)
    },
    conversation: {
      contactLabel: text(session?.clientName || session?.contactName || '', 120),
      isInternalChat: session?.isInternalChat === true,
      humanMode: session?.human === true,
      recentHistory: history
    },
    activeTask: session?.pendingCopilotTask && typeof session.pendingCopilotTask === 'object'
      ? {
          type: text(session.pendingCopilotTask.type, 40) || 'general',
          originalRequest: text(session.pendingCopilotTask.originCommand, 500),
          lastQuestion: text(session.pendingCopilotTask.lastQuestion, 500),
          allowedTools: Array.isArray(session.pendingCopilotTask.allowedTools)
            ? session.pendingCopilotTask.allowedTools.slice(0, 8).map(item => text(item, 80))
            : []
        }
      : null,
    pendingActions: {
      outboundDispatch: dispatch && typeof dispatch === 'object'
        ? {
            id: text(dispatch.id, 40),
            recipient: text(dispatch.recipient, 120),
            message: text(dispatch.message, 1000),
            status: dispatchStatus,
            deliveryConfirmed: dispatchStatus === 'sent',
            createdAt: text(dispatch.createdAt, 80),
            administrativelyReviewed: Boolean(dispatch.reviewedAt),
            reviewNote: text(dispatch.reviewNote, 180)
          }
        : null,
      pixRequest: session?.pendingPixRequest
        ? {
            requestedAt: text(session.pendingPixRequest.requestedAt, 80),
            hasAmount: session.pendingPixRequest.amount !== null && session.pendingPixRequest.amount !== undefined,
            description: text(session.pendingPixRequest.description, 120)
          }
        : null,
      recipientAwaitingDispatch: text(session?.pendingRecipient, 120) || null,
      audioConfirmationPending: Boolean(session?.pendingAudioConfirmation),
      pdfPending: Boolean(session?.pendingPdf),
      controlActionPending: session?.pendingControlAction
        ? {
            type: text(session.pendingControlAction.type, 50),
            intent: text(session.pendingControlAction.intent, 50),
            label: text(session.pendingControlAction.label, 100)
          }
        : null
    },
    observedAt: new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString()
  };
}
