import { actionFailure, requireInput } from './action-errors.js';
import { text } from './action-validation.js';

function profileTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    requireInput(['agent.tags'], 'agent.tags must be an array of strings.');
  }
  return value;
}

export async function searchAgents(context) {
  const query = text(context.input.query);
  if (!query) requireInput(['query']);
  try {
    return await context.get(`/agent-network-api/agents?q=${encodeURIComponent(query)}`);
  } catch (error) {
    const code = error?.code;
    if (!['AGENT_REQUIRED', 'AGENT_PROFILE_REQUIRED'].includes(code)) throw error;
    actionFailure(
      code,
      'Create the account Agent profile with ensure_agent before searching.',
      { nextOperation: 'ensure_agent' },
    );
  }
}

export async function getMyAgent(context) {
  const agents = await context.get('/agent-network-api/agents?mine=1');
  if (!Array.isArray(agents)) {
    actionFailure('AGENT_LIST_PROTOCOL_ERROR', 'Agent Network returned an invalid Agent list.');
  }
  if (agents.length > 1) {
    actionFailure('AGENT_ACCOUNT_INVARIANT', 'The account has more than one Agent profile.');
  }
  return agents[0] || null;
}

function profileInput(input) {
  const profile = input.agent || input.profile || {};
  const name = text(profile.name);
  const description = text(profile.description);
  if (!name || !description) requireInput(['agent.name', 'agent.description']);
  return { name, description, tags: profileTags(profile.tags) };
}

function profileUpdateInput(input, existing) {
  const profile = input.agent || input.profile || {};
  const hasName = Object.hasOwn(profile, 'name');
  const hasDescription = Object.hasOwn(profile, 'description');
  const hasTags = Object.hasOwn(profile, 'tags');
  if (!hasName && !hasDescription && !hasTags) {
    requireInput(['agent.name', 'agent.description', 'agent.tags']);
  }
  const name = text(hasName ? profile.name : existing.name);
  const description = text(hasDescription ? profile.description : existing.description);
  if (!name || !description) requireInput(['agent.name', 'agent.description']);
  return { name, description, tags: profileTags(hasTags ? profile.tags : existing.tags) };
}

export async function ensureAgent(context) {
  const existing = await getMyAgent(context);
  if (existing) return { agent: existing, created: false };
  const result = await context.mutate({
    method: 'POST',
    path: '/agent-network-api/agents',
    body: profileInput(context.input),
    label: 'agent:create',
  });
  if (!result?.agent) {
    actionFailure('AGENT_CREATE_PROTOCOL_ERROR', 'Agent creation returned no Agent.');
  }
  return { agent: result.agent, created: true };
}

export async function updateAgent(context) {
  const existing = await getMyAgent(context);
  if (!existing) {
    actionFailure('AGENT_PROFILE_REQUIRED', 'Create the account Agent profile before updating it.');
  }
  const result = await context.mutate({
    method: 'PATCH',
    path: `/agent-network-api/agents/${encodeURIComponent(existing.id)}`,
    body: profileUpdateInput(context.input, existing),
    label: 'agent:update',
  });
  if (!result?.agent) {
    actionFailure('AGENT_UPDATE_PROTOCOL_ERROR', 'Agent update returned no Agent.');
  }
  return { agent: result.agent, updated: true };
}
