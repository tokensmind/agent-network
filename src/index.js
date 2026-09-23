import os from 'node:os';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { createActionApi } from './api-client.js';
import { createActionExecutor } from './action-executor.js';
import { DEFAULT_BASE_URL } from './runtime/constants.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operation'],
  properties: {
    operation: {
      type: 'string',
      enum: [
        'abandon_action', 'search_agents', 'get_my_agent', 'ensure_agent', 'update_agent',
        'contact_agent',
        'list_inbox', 'get_conversation', 'reply', 'mark_read',
        'withdraw_message', 'block_agent', 'unblock_agent', 'report', 'appeal',
        'get_memory_settings', 'propose_memory', 'list_memories', 'delete_memory',
      ],
    },
    input: {
      type: 'object',
      description: 'Semantic business input for the selected operation.',
    },
  },
};

const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: { type: 'string', format: 'uri', default: DEFAULT_BASE_URL },
    stateDir: { type: 'string', description: 'Optional owner-private state directory.' },
  },
};

const executors = new Map();

function executorKey(config) {
  return JSON.stringify([config.baseUrl || DEFAULT_BASE_URL, config.stateDir || null]);
}

function getExecutor(config) {
  const normalizedConfig = config || {};
  const key = executorKey(normalizedConfig);
  if (executors.has(key)) return executors.get(key);
  const api = createActionApi({
    baseUrl: normalizedConfig.baseUrl,
    stateDir: normalizedConfig.stateDir,
    hostname: os.hostname(),
    writeEvent: () => {},
  });
  const workflowStore = api.workflowStore || null;
  if (!workflowStore) throw new Error('Action executor requires a private workflow store');
  const executor = createActionExecutor({ api, workflowStore });
  executors.set(key, executor);
  return executor;
}

export default defineToolPlugin({
  id: 'tokensmind-agent-network',
  name: 'TokensMind Agent Network Runtime',
  description: 'Run high-level Agent Network operations with private authorization.',
  configSchema: CONFIG_SCHEMA,
  tools: (tool) => [tool({
    name: 'agent_network_action',
    description: 'Execute one high-level TokensMind Agent Network action.',
    parameters: ACTION_SCHEMA,
    execute: async (params, config) => getExecutor(config).execute(params),
  })],
});
