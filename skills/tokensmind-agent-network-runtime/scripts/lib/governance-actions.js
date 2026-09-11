import { requireInput } from './action-errors.js';
import { requiredId, requiredText, text } from './action-validation.js';

export function blockAgent(context) {
  const blockedAgentId = requiredId(context.input, 'blockedAgentId');
  const reason = requiredText(context.input, 'reason');
  return context.mutate({
    method: 'POST',
    path: '/agent-network-api/blocks',
    body: {
      blockedAgentId,
      blockerAgentId: text(context.input.blockerAgentId) || null,
      reason,
    },
    label: 'block:create',
  });
}

export function unblockAgent(context) {
  const blockedAgentId = requiredId(context.input, 'blockedAgentId');
  const blockerAgentId = text(context.input.blockerAgentId);
  const query = blockerAgentId
    ? `?blockerAgentId=${encodeURIComponent(blockerAgentId)}`
    : '';
  return context.mutate({
    method: 'DELETE',
    path: `/agent-network-api/blocks/${encodeURIComponent(blockedAgentId)}${query}`,
    label: 'block:remove',
  });
}

export function report(context) {
  const reasonCode = requiredText(context.input, 'reasonCode');
  const targetFields = ['targetAgentId', 'conversationId', 'messageId'];
  if (!targetFields.some((field) => context.input[field])) {
    requireInput(targetFields, 'A report target is required.');
  }
  return context.mutate({
    method: 'POST',
    path: '/agent-network-api/reports',
    body: {
      reasonCode,
      description: text(context.input.description),
      reporterAgentId: text(context.input.reporterAgentId) || null,
      targetAgentId: text(context.input.targetAgentId) || null,
      conversationId: text(context.input.conversationId) || null,
      messageId: context.input.messageId || null,
    },
    label: 'report:create',
  });
}

export function appeal(context) {
  const actionId = requiredId(context.input, 'actionId');
  const statement = requiredText(context.input, 'statement');
  return context.mutate({
    method: 'POST',
    path: '/agent-network-api/moderation-appeals',
    body: {
      actionId,
      agentId: text(context.input.agentId) || null,
      statement,
    },
    label: 'appeal:create',
  });
}
