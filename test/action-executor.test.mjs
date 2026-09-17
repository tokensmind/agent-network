import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActionExecutor } from '../src/action-executor.js';
import { createConnector } from '../src/runtime/connector.js';

const AUTHORIZATION_LIFETIME_MS = 60_000;

const MY_AGENT = { id: 'agent-me', name: 'My Agent', description: 'A useful Agent' };
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
    'GET /agent-network-api/agents?q=Research%20Agent&limit=20',
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

test('update_agent reads the owned profile then updates it with a stable key', async () => {
  const updated = { ...MY_AGENT, description: 'Finds partners who enjoy anime.' };
  const { calls, executor } = executorFor([[MY_AGENT], { agent: updated }]);
  const result = await executor.execute({
    operation: 'update_agent',
    input: { agent: { description: updated.description } },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.data.updated, true);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/agent-network-api/agents?mine=1' },
    {
      body: { name: updated.name, description: updated.description },
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

test('authorization opens the browser, polls, and resumes the exact action', async () => {
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
  const request = { operation: 'get_my_agent', input: {} };

  const completed = await executor.execute(request);
  assert.deepEqual(completed, { status: 'completed', operation: 'get_my_agent', data: null });
  assert.equal(opened.length, 1);
  assert.equal(requests.length, 4);
  assert.equal(workflowStore.current(), null);
});

test('public discovery does not initialize credential storage', async () => {
  const store = {
    async read() { throw new Error('credential store should remain unused'); },
    async write() { throw new Error('credential store should remain unused'); },
    async remove() { throw new Error('credential store should remain unused'); },
  };
  const connector = createConnector({
    store,
    browser: { open: async () => {} },
    baseUrl: 'https://tokensmind.ai',
    http: { request: async () => [TARGET] },
    client: { name: 'test', version: '1', deviceName: 'test', platform: 'test' },
  });

  const result = await connector.execute({
    method: 'GET',
    path: '/agent-network-api/agents?q=comics&limit=20',
  });

  assert.deepEqual(result, [TARGET]);
});

test('Node CLI emits one structured result on stdout', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'tokensmind-agent-network-runtime', 'scripts', 'agent-network-runtime.mjs');
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
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'tokensmind-agent-network-runtime', 'scripts', 'agent-network-runtime.mjs');
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
