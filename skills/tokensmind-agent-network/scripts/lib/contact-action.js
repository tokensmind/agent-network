import { actionFailure, requireInput, requireSelection } from './action-errors.js';
import { text } from './action-validation.js';
import { ensureAgent } from './agent-actions.js';

const STOPPED_REQUIREMENT_STATES = new Set(['paused', 'completed', 'cancelled']);

function exactName(agent, name) {
  return text(agent?.name).toLocaleLowerCase() === name.toLocaleLowerCase();
}

function defaultTo(value, fallback) {
  return value || fallback;
}

async function resolveTarget(context) {
  const target = context.input.target || {};
  const id = text(target.id);
  if (id) return { id, name: text(target.name) };
  const name = text(target.name);
  if (!name) requireInput(['target.id or target.name']);
  const agents = await context.get(
    `/agent-network-api/agents?q=${encodeURIComponent(name)}`,
  );
  if (!Array.isArray(agents) || agents.length === 0) {
    actionFailure('TARGET_AGENT_NOT_FOUND', `No Agent matched "${name}".`);
  }
  const exact = agents.filter((agent) => exactName(agent, name));
  const candidates = exact.length ? exact : agents;
  if (candidates.length !== 1) {
    requireSelection(candidates, `Choose the Agent to use for "${name}".`);
  }
  return candidates[0];
}

function newRequirementInput(input, agentId) {
  const requirement = input.requirement || {};
  const title = text(requirement.title);
  const description = text(requirement.description);
  if (!title || !description) requireInput(['requirement.title', 'requirement.description']);
  return {
    publisherAgentId: agentId,
    title,
    description,
    requiredCapabilities: defaultTo(requirement.requiredCapabilities, []),
    optionalCapabilities: defaultTo(requirement.optionalCapabilities, []),
    industries: defaultTo(requirement.industries, []),
    languages: defaultTo(requirement.languages, []),
    budgetMin: requirement.budgetMin ?? null,
    budgetMax: requirement.budgetMax ?? null,
    currency: defaultTo(requirement.currency, 'USD'),
    deadline: requirement.deadline ?? null,
    visibility: requirement.visibility || 'public',
  };
}

function validateContactInput(input) {
  if (!text(input.message)) requireInput(['message']);
  if (text(input.requirement?.id)) return;
  newRequirementInput(input, text(input.target?.id) || 'pending-agent-id');
}

function contactResult({ agent, target, requirement, result }) {
  const created = result?.created === true;
  return {
    agent,
    target,
    requirement,
    conversation: result?.conversation,
    message: result?.message || null,
    created,
    messageSent: created,
  };
}

async function loadRequirement(context, agentId) {
  const id = text(context.input.requirement?.id);
  if (id) return context.get(`/agent-network-api/requirements/${encodeURIComponent(id)}`);
  return context.mutate({
    method: 'POST',
    path: '/agent-network-api/requirements',
    body: newRequirementInput(context.input, agentId),
    label: 'requirement:create',
  });
}

async function publishRequirement(context, requirement) {
  if (requirement.status === 'open') return requirement;
  if (STOPPED_REQUIREMENT_STATES.has(requirement.status)) {
    actionFailure(
      'REQUIREMENT_NOT_OPENABLE',
      `Requirement ${requirement.id} has terminal status ${requirement.status}.`,
      { requirement },
    );
  }
  if (requirement.status !== 'draft') {
    actionFailure('REQUIREMENT_PROTOCOL_ERROR', 'Requirement has an unsupported status.');
  }
  const result = await context.mutate({
    method: 'POST',
    path: `/agent-network-api/requirements/${encodeURIComponent(requirement.id)}/publish`,
    label: 'requirement:publish',
  });
  if (result?.requirement?.status !== 'open') {
    actionFailure('REQUIREMENT_PUBLISH_PROTOCOL_ERROR', 'Requirement did not become open.');
  }
  return result.requirement;
}

async function eligibleRecommendation(context, requirement, target) {
  const results = await context.get(
    `/agent-network-api/requirements/${encodeURIComponent(requirement.id)}/recommendations`,
  );
  const recommendation = Array.isArray(results)
    ? results.find((item) => item?.agent?.id === target.id)
    : null;
  if (!recommendation || recommendation.canReceiveNewConversations !== true) {
    actionFailure(
      'TARGET_NOT_ELIGIBLE',
      'The requested Agent is not an eligible recommendation for this Requirement.',
      { requirement, target },
    );
  }
  return recommendation;
}

async function createConversation(context, { agent, requirement, target }) {
  const message = text(context.input.message);
  if (!message) requireInput(['message']);
  return context.mutate({
    method: 'POST',
    path: '/agent-network-api/conversations',
    body: {
      requesterAgentId: agent.id,
      requirementId: requirement.id,
      targetAgentId: target.id,
      initialMessage: {
        clientMessageId: context.messageId('conversation:create'),
        content: message,
      },
    },
    label: 'conversation:create',
  });
}

export async function contactAgent(context) {
  validateContactInput(context.input);
  const { agent } = await ensureAgent(context);
  const target = await resolveTarget(context);
  const draft = await loadRequirement(context, agent.id);
  const requirement = await publishRequirement(context, draft);
  await eligibleRecommendation(context, requirement, target);
  const result = await createConversation(context, { agent, requirement, target });
  return contactResult({ agent, target, requirement, result });
}
