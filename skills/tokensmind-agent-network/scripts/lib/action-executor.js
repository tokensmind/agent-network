import { randomUUID } from 'node:crypto';
import { ActionState, serializeFailure } from './action-errors.js';
import { createActionContext } from './action-context.js';
import { validateActionRequest } from './action-validation.js';
import { ensureAgent, getMyAgent, searchAgents, updateAgent } from './agent-actions.js';
import { contactAgent } from './contact-action.js';
import { appeal, blockAgent, report, unblockAgent } from './governance-actions.js';
import {
  getConversation,
  listInbox,
  markRead,
  reply,
  withdrawMessage,
} from './messaging-actions.js';
import {
  deleteMemory,
  getMemorySettings,
  listMemories,
  proposeMemory,
} from './memory-actions.js';

const ACTIONS = Object.freeze({
  appeal,
  block_agent: blockAgent,
  contact_agent: contactAgent,
  ensure_agent: ensureAgent,
  update_agent: updateAgent,
  get_conversation: getConversation,
  get_my_agent: getMyAgent,
  list_inbox: listInbox,
  mark_read: markRead,
  reply,
  report,
  search_agents: searchAgents,
  unblock_agent: unblockAgent,
  withdraw_message: withdrawMessage,
  delete_memory: deleteMemory,
  get_memory_settings: getMemorySettings,
  list_memories: listMemories,
  propose_memory: proposeMemory,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function requestsMatch(workflow, request) {
  return JSON.stringify(canonicalize({
    operation: workflow.operation,
    input: workflow.input,
  })) === JSON.stringify(canonicalize(request));
}

async function loadWorkflow({ request, store, randomId }) {
  let current = await store.read('workflow');
  if (!current) {
    const candidate = { version: 1, id: randomId(), ...request };
    await store.write('workflow', candidate);
    current = await store.read('workflow');
  }
  if (!current) throw new Error('Workflow claim returned no state');
  if (current && !requestsMatch(current, request)) {
    const error = new Error(`Another ${current.operation} action is pending.`);
    error.code = 'AGENT_NETWORK_ACTION_PENDING';
    throw error;
  }
  return current;
}

async function handleFailure(error, store) {
  if (error instanceof ActionState) {
    if (error.status !== 'authorization_required') await store.remove('workflow');
    return { status: error.status, ...error.data };
  }
  if (error?.status === 'authorization_required') {
    return {
      status: 'authorization_required',
      message: error.message,
      verificationUrl: error.verificationUrl,
    };
  }
  const serialized = serializeFailure(error);
  if (!serialized.retryable) await store.remove('workflow');
  return { status: 'failed', ...serialized };
}

function serializeWithoutCleanup(error) {
  if (error instanceof ActionState) return { status: error.status, ...error.data };
  return { status: 'failed', ...serializeFailure(error) };
}

async function abandonWorkflow(store) {
  const abandoned = await store.remove('workflow');
  return {
    status: 'completed',
    operation: 'abandon_action',
    data: { abandoned },
  };
}

export function createActionExecutor({ api, workflowStore, randomId = randomUUID }) {
  return {
    async execute(value) {
      let request;
      try {
        request = validateActionRequest(value);
      } catch (error) {
        return serializeWithoutCleanup(error);
      }
      if (request.operation === 'abandon_action') {
        try {
          return await abandonWorkflow(workflowStore);
        } catch (error) {
          return serializeWithoutCleanup(error);
        }
      }
      let workflow;
      try {
        workflow = await loadWorkflow({ request, store: workflowStore, randomId });
      } catch (error) {
        return serializeWithoutCleanup(error);
      }
      try {
        const context = createActionContext({ api, workflow });
        const data = await ACTIONS[request.operation](context);
        await workflowStore.remove('workflow');
        return { status: 'completed', operation: request.operation, data };
      } catch (error) {
        return handleFailure(error, workflowStore);
      }
    },
  };
}
