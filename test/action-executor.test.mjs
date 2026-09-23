import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActionExecutor } from '../src/action-executor.js';
import { createConnector } from '../src/runtime/connector.js';
import { AgentNetworkHttpError } from '../src/runtime/httpClient.js';

const AUTHORIZATION_LIFETIME_MS = 60_000;

const MY_AGENT = { id: 'agent-me', name: 'My Agent', description: 'A useful Agent', tags: [] };
const TARGET = { id: 'agent-target', name: 'Research Agent' };
const REQUIREMENT = { id: 'requirement-1', status: 'draft', title: 'Research help' };

function memoryStore() {
  let value = null;
  return {
    async read() { return value; },
    async write(_name, next) { value = next; },
    async remove() {
      const existed = value !== null;
      value = null;
      return existed;
    },
    current() { return value; },
    set(next) { value = next; },
  };
}

function executorFor(responses) {
  const calls = [];
  const store = memoryStore();
  let index = 0;
  const api = {
    request: async (request) => {
      calls.push(request);
      const response = responses[index];
      index += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { calls, store, executor: createActionExecutor({ api, workflowStore: store, randomId: () => 'workflow-1' }) };
}

function authorizationHttp({ credentialStore, requests }) {
  return {
    async request(request) {
      requests.push(request);
      if (request.method === 'POST' && request.url.endsWith('/device-authorizations')) {
        return {
          authorizationId: request.body.authorizationId,
          userCode: 'ABCD-EFGH',
          verificationUrl: `https://tokensmind.ai/console/agent-network/authorize/${request.body.authorizationId}`,
          expiresAt: new Date(Date.now() + AUTHORIZATION_LIFETIME_MS).toISOString(),
          intervalSeconds: 1,
        };
      }
      const pending = credentialStore.current();
      if (request.url.includes('/device-authorizations/') && !request.url.endsWith('/exchange')) {
        return {
          authorizationId: pending.pending.authorizationId,
          expiresAt: pending.pending.authorization.expiresAt,
          status: 'approved',
        };
      }
      if (request.url.endsWith('/exchange')) {
        return {
          authorizationId: pending.pending.authorizationId,
          status: 'exchanged',
          credential: { id: 'credential-1', agentId: null, tokenPrefix: pending.pending.tokenPrefix },
        };
      }
      return [];
    },
  };
}

function credentialStoreAdapter(credentialStore) {
  return {
    async read(name) {
      const state = credentialStore.current() || {};
      return state[name] || null;
    },
    async write(name, value) {
      const state = credentialStore.current() || {};
      credentialStore.set({ ...state, [name]: value });
    },
    async remove(name) {
      const state = credentialStore.current() || {};
      const next = { ...state };
      delete next[name];
      credentialStore.set(next);
    },
  };
}

test('contact_agent performs the business loop behind one action', async () => {
  const { calls, executor, store } = executorFor([
    [MY_AGENT],
    [TARGET],
    REQUIREMENT,
    { requirement: { ...REQUIREMENT, status: 'open' }, recommendationCount: 1 },
    [{ agent: TARGET, canReceiveNewConversations: true }],
    { conversation: { id: 'conversation-1' }, created: true, message: { id: 1 } },
  ]);
  const result = await executor.execute({
    operation: 'contact_agent',
    input: {
      target: { name: TARGET.name },
      message: 'Let us discuss research collaboration.',
      requirement: { title: 'Research help', description: 'A sufficiently detailed research collaboration request.' },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.created, true);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /agent-network-api/agents?mine=1',
    'GET /agent-network-api/agents?q=Research%20Agent',
    'POST /agent-network-api/requirements',
    'POST /agent-network-api/requirements/requirement-1/publish',
    'GET /agent-network-api/requirements/requirement-1/recommendations',
    'POST /agent-network-api/conversations',
  ]);
  assert.equal(calls[2].idempotencyKey, 'workflow-1:requirement:create');
  assert.equal(calls[5].body.initialMessage.clientMessageId, 'workflow-1:conversation:create:message');
  assert.equal(store.current(), null);
});

test('contact_agent asks for missing input before making requests', async () => {
  const { calls, executor } = executorFor([]);
  const result = await executor.execute({ operation: 'contact_agent', input: { target: { id: TARGET.id } } });
  assert.equal(result.status, 'input_required');
  assert.deepEqual(calls, []);
});

test('search_agents requires a query and omits client paging controls', async () => {
  const missing = executorFor([]);
  const missingResult = await missing.executor.execute({
    operation: 'search_agents', input: { limit: 100 },
  });
  assert.equal(missingResult.status, 'input_required');
  assert.deepEqual(missingResult.fields, ['query']);
  assert.deepEqual(missing.calls, []);

  const found = executorFor([[TARGET]]);
  const result = await found.executor.execute({
    operation: 'search_agents', input: { query: 'Research Agent', limit: 100 },
  });
  assert.equal(result.status, 'completed');
  assert.equal(found.calls[0].path, '/agent-network-api/agents?q=Research%20Agent');
});

test('search_agents fails explicitly when the account has no Agent', async () => {
  const error = Object.assign(new Error('Agent profile required'), {
    code: 'AGENT_REQUIRED',
    status: 409,
  });
  const { executor } = executorFor([error]);
  const result = await executor.execute({
    operation: 'search_agents', input: { query: 'research' },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'AGENT_REQUIRED');
  assert.equal(result.details.nextOperation, 'ensure_agent');
  assert.match(result.message, /ensure_agent/);
});

test('ensure_agent sends optional public tags', async () => {
  const { calls, executor } = executorFor([[], { agent: MY_AGENT }]);
  const result = await executor.execute({
    operation: 'ensure_agent',
    input: { agent: MY_AGENT },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[1].body, {
    description: MY_AGENT.description,
    name: MY_AGENT.name,
    tags: MY_AGENT.tags,
  });
});

test('update_agent reads the owned profile then updates tags with a stable key', async () => {
  const updated = { ...MY_AGENT, tags: ['anime', 'community'] };
  const { calls, executor } = executorFor([[MY_AGENT], { agent: updated }]);
  const result = await executor.execute({
    operation: 'update_agent',
    input: { agent: { tags: updated.tags } },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.updated, true);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/agent-network-api/agents?mine=1' },
    {
      body: { name: updated.name, description: updated.description, tags: updated.tags },
      idempotencyKey: 'workflow-1:agent:update',
      method: 'PATCH',
      path: '/agent-network-api/agents/agent-me',
    },
  ]);
});

test('ambiguous target is returned as selection_required', async () => {
  const { calls, executor } = executorFor([[MY_AGENT], [TARGET, { ...TARGET, id: 'agent-target-2' }]]);
  const result = await executor.execute({
    operation: 'contact_agent',
    input: {
      target: { name: TARGET.name },
      message: 'Let us discuss research collaboration.',
      requirement: { title: 'Research help', description: 'A sufficiently detailed research collaboration request.' },
    },
  });
  assert.equal(result.status, 'selection_required');
  assert.equal(result.candidates.length, 2);
  assert.equal(calls.length, 2);
});

test('failed retryable requests keep the action workflow', async () => {
  const { executor, store } = executorFor([Object.assign(new Error('temporary'), { status: 503, code: 'UPSTREAM_UNAVAILABLE' })]);
  const result = await executor.execute({ operation: 'get_my_agent', input: {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(store.current().operation, 'get_my_agent');
});

test('invalid mark_read input never reaches the API', async () => {
  const { calls, executor } = executorFor([]);
  const result = await executor.execute({
    operation: 'mark_read',
    input: { conversationId: 'conversation-1', lastReadMessageId: 'not-a-number' },
  });
  assert.equal(result.status, 'input_required');
  assert.deepEqual(result.fields, ['lastReadMessageId']);
  assert.equal(calls.length, 0);
});

test('unblock_agent includes and encodes an optional blocker ID', async () => {
  const { calls, executor } = executorFor([{}]);
  const result = await executor.execute({
    operation: 'unblock_agent',
    input: { blockedAgentId: 'agent/blocked', blockerAgentId: 'agent/owner' },
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].path, '/agent-network-api/blocks/agent%2Fblocked?blockerAgentId=agent%2Fowner');
});

test('search without a credential authorizes and resumes the exact action', async () => {
  const credentialStore = memoryStore();
  const workflowStore = memoryStore();
  const requests = [];
  const opened = [];
  const http = authorizationHttp({ credentialStore, requests });
  const connector = createConnector({
    store: credentialStoreAdapter(credentialStore),
    browser: { open: async (url) => opened.push(url) },
    baseUrl: 'https://tokensmind.ai',
    http,
    client: { name: 'test', version: '1', deviceName: 'test', platform: 'test' },
  });
  const api = { request: (request) => connector.execute(request) };
  const executor = createActionExecutor({ api, workflowStore, randomId: () => 'workflow-1' });
  const request = { operation: 'search_agents', input: { query: 'research' } };

  const completed = await executor.execute(request);
  assert.deepEqual(completed, { status: 'completed', operation: 'search_agents', data: [] });
  assert.equal(opened.length, 1);
  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /\/agent-network-api\/agents\?q=research$/);
  assert.match(requests[3].headers.Authorization, /^Bearer tm_agent_/);
  assert.equal(workflowStore.current(), null);
});

test('search HTTP 401 replaces the rejected credential and replays the search', async () => {
  const credentialStore = memoryStore();
  credentialStore.set({ active: { token: 'rejected-token', credentialId: 'old' } });
  const requests = [];
  const opened = [];
  const authorization = authorizationHttp({ credentialStore, requests });
  let rejected = false;
  const http = {
    async request(request) {
      if (!rejected && request.url.includes('/agents?q=research')) {
        rejected = true;
        requests.push(request);
        throw new AgentNetworkHttpError({
          status: 401, code: 'AUTH_REQUIRED', message: 'Sign in required',
        });
      }
      return authorization.request(request);
    },
  };
  const connector = createConnector({
    store: credentialStoreAdapter(credentialStore),
    browser: { open: async (url) => opened.push(url) },
    baseUrl: 'https://tokensmind.ai',
    http,
    client: { name: 'test', version: '1', deviceName: 'test', platform: 'test' },
  });

  const result = await connector.execute({
    method: 'GET', path: '/agent-network-api/agents?q=research',
  });

  assert.deepEqual(result, []);
  assert.equal(opened.length, 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer rejected-token');
  assert.match(requests.at(-1).headers.Authorization, /^Bearer tm_agent_/);
  assert.notEqual(requests.at(-1).headers.Authorization, 'Bearer rejected-token');
});

test('search requires the stored credential and sends it to the service', async () => {
  const requests = [];
  const store = {
    async read(name) {
      if (name === 'active') return { token: 'stored-token', credentialId: 'credential-1' };
      return null;
    },
    async write() {},
    async remove() {},
  };
  const connector = createConnector({
    store,
    browser: { open: async () => {} },
    baseUrl: 'https://tokensmind.ai',
    http: { request: async (request) => { requests.push(request); return [TARGET]; } },
    client: { name: 'test', version: '1', deviceName: 'test', platform: 'test' },
  });

  const result = await connector.execute({
    method: 'GET',
    path: '/agent-network-api/agents?q=comics',
  });

  assert.deepEqual(result, [TARGET]);
  assert.equal(requests[0].headers.Authorization, 'Bearer stored-token');
});

test('Node CLI emits one structured result on stdout', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'tokensmind-agent-network', 'scripts', 'agent-network-runtime.mjs');
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ operation: 'unsupported_operation', input: {} }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'input_required',
    message: 'Unsupported Agent Network operation: unsupported_operation',
    fields: ['operation'],
  });
  assert.equal(result.stderr, '');
});

test('Node CLI runs through an npm bin symlink', (context) => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'tokensmind-agent-network', 'scripts', 'agent-network-runtime.mjs');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-network-runtime-bin-'));
  const bin = path.join(tempDir, 'agent-network');
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));
  symlinkSync(script, bin);
  const result = spawnSync(bin, [], {
    input: JSON.stringify({ operation: 'unsupported_operation', input: {} }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, 'input_required');
  assert.equal(result.stderr, '');
});
