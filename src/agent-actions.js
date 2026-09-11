import { actionFailure, requireInput } from './action-errors.js';
import { optionalLimit, text } from './action-validation.js';

export async function searchAgents(context) {
  const query = text(context.input.query);
  const limit = optionalLimit(context.input.limit);
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('q', query);
  return context.get(`/agent-network-api/agents?${params}`);
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
  return { name, description };
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
