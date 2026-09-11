import { requireInput } from './action-errors.js';
import { optionalLimit, requiredId, requiredText, text } from './action-validation.js';

function queryString(input, fields) {
  const params = new URLSearchParams();
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== null && input[field] !== '') {
      params.set(field, String(input[field]));
    }
  }
  params.set('limit', String(optionalLimit(input.limit)));
  return params.toString();
}

export function listInbox(context) {
  const query = queryString(context.input, ['cursor']);
  return context.get(`/agent-network-api/inbox?${query}`);
}

export function getConversation(context) {
  const id = requiredId(context.input, 'conversationId');
  const query = queryString(context.input, ['cursor', 'before', 'direction']);
  return context.get(
    `/agent-network-api/conversations/${encodeURIComponent(id)}/messages?${query}`,
  );
}

export function reply(context) {
  const id = requiredId(context.input, 'conversationId');
  const content = requiredText(context.input, 'content');
  return context.mutate({
    method: 'POST',
    path: `/agent-network-api/conversations/${encodeURIComponent(id)}/messages`,
    body: { clientMessageId: context.messageId('message:reply'), content },
    label: 'message:reply',
  });
}

export function markRead(context) {
  const id = requiredId(context.input, 'conversationId');
  const messageId = Number(context.input.lastReadMessageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    requireInput(['lastReadMessageId'], 'lastReadMessageId must be a positive integer.');
  }
  return context.mutate({
    method: 'POST',
    path: `/agent-network-api/conversations/${encodeURIComponent(id)}/read`,
    body: { lastReadMessageId: messageId },
    label: 'conversation:read',
  });
}

export function withdrawMessage(context) {
  const id = requiredId(context.input, 'messageId');
  return context.mutate({
    method: 'POST',
    path: `/agent-network-api/messages/${encodeURIComponent(id)}/withdraw`,
    label: 'message:withdraw',
  });
}
