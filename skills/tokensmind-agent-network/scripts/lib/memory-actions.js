import { actionFailure, requireInput } from './action-errors.js';
import { getMyAgent } from './agent-actions.js';
import { isObject, optionalLimit, requiredId, requiredText, text } from './action-validation.js';

const MEMORY_KINDS = new Set(['agent_experience', 'matching_preference']);
const MEMORY_POLARITIES = new Set(['negative', 'positive']);
const MEMORY_SCOPES = new Set(['contextual', 'global']);
// platform_event 由服务端独占写入，客户端提交会被拒绝。
const MEMORY_SOURCES = new Set(['model_inferred', 'user_explicit']);
const MEMORY_STATUSES = new Set(['active', 'deleted', 'pending_review', 'rejected']);
const MAX_INFERRED_CONFIDENCE = 0.6;

function requireChoice(input, field, allowed) {
  const value = text(input?.[field]).toLowerCase();
  if (!allowed.has(value)) requireInput([field], `${field} has an unsupported value.`);
  return value;
}

function optionalConfidence(value, sourceType) {
  if (value === undefined || value === null || value === '') {
    return sourceType === 'model_inferred' ? MAX_INFERRED_CONFIDENCE : 1;
  }
  const confidence = Number(value);
  const inferredLimitExceeded = sourceType === 'model_inferred'
    && confidence > MAX_INFERRED_CONFIDENCE;
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1 || inferredLimitExceeded) {
    requireInput(['confidence'], 'confidence must be above 0 and no more than 0.6 for inferred memory.');
  }
  return confidence;
}

async function ownedAgent(context) {
  const agent = await getMyAgent(context);
  if (!agent) actionFailure('AGENT_PROFILE_REQUIRED', 'Create the account Agent profile first.');
  return agent;
}

function agentPath(agentId, suffix) {
  return `/agent-network-api/agents/${encodeURIComponent(agentId)}/${suffix}`;
}

function optionalText(input, field) {
  return Object.hasOwn(input, field) ? text(input[field]) || null : null;
}

function memoryBody(input) {
  if (!isObject(input)) requireInput(['input']);
  const sourceType = requireChoice(input, 'sourceType', MEMORY_SOURCES);
  const scope = input.scope ? requireChoice(input, 'scope', MEMORY_SCOPES) : 'contextual';
  const contextText = scope === 'global' ? '' : requiredText(input, 'contextText');
  return {
    clientMemoryId: requiredText(input, 'clientMemoryId'),
    confidence: optionalConfidence(input.confidence, sourceType),
    contextText,
    conversationId: optionalText(input, 'conversationId'),
    expiresAt: optionalText(input, 'expiresAt'),
    kind: requireChoice(input, 'kind', MEMORY_KINDS),
    polarity: requireChoice(input, 'polarity', MEMORY_POLARITIES),
    requirementId: optionalText(input, 'requirementId'),
    scope,
    sourceType,
    statement: requiredText(input, 'statement'),
    targetAgentId: optionalText(input, 'targetAgentId'),
  };
}

function listQuery(input) {
  const params = new URLSearchParams({ limit: String(optionalLimit(input.limit)) });
  if (input.offset !== undefined) {
    const offset = Number(input.offset);
    if (!Number.isInteger(offset) || offset < 0) requireInput(['offset']);
    params.set('offset', String(offset));
  }
  if (input.status) params.set('status', requireChoice(input, 'status', MEMORY_STATUSES));
  return params.toString();
}

export async function getMemorySettings(context) {
  const agent = await ownedAgent(context);
  return context.get(agentPath(agent.id, 'memory-settings'));
}

export async function proposeMemory(context) {
  const body = memoryBody(context.input);
  const agent = await ownedAgent(context);
  const settings = await context.get(agentPath(agent.id, 'memory-settings'));
  if (settings?.collectionEnabled !== true) {
    actionFailure('MEMORY_COLLECTION_DISABLED', 'Memory collection is disabled for this Agent.');
  }
  return context.mutate({
    method: 'POST',
    path: agentPath(agent.id, 'memories'),
    body,
    label: 'memory:propose',
  });
}

export async function listMemories(context) {
  const query = listQuery(context.input);
  const agent = await ownedAgent(context);
  return context.get(`${agentPath(agent.id, 'memories')}?${query}`);
}

export async function deleteMemory(context) {
  const memoryId = requiredId(context.input, 'memoryId');
  const agent = await ownedAgent(context);
  return context.mutate({
    method: 'DELETE',
    path: `${agentPath(agent.id, 'memories')}/${encodeURIComponent(memoryId)}`,
    label: 'memory:delete',
  });
}
