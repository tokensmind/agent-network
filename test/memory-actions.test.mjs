import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createActionExecutor } from '../src/action-executor.js';

const OWNED_AGENT = Object.freeze({ id: 'owned/agent', name: 'Memory Agent' });

function executorFor(responses) {
  const calls = [];
  let workflow = null;
  return {
    calls,
    executor: createActionExecutor({
      api: {
        async request(request) {
          calls.push(request);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          return response;
        },
      },
      workflowStore: {
        async read() { return workflow; },
        async write(_name, value) { workflow = value; },
        async remove() { workflow = null; return true; },
      },
      randomId: () => 'workflow-1',
    }),
  };
}

function explicitMemory() {
  return {
    agentId: 'untrusted-agent',
    clientMemoryId: 'memory-client-1',
    confidence: 1,
    contextText: 'Frontend implementation tasks',
    kind: 'matching_preference',
    polarity: 'positive',
    scope: 'contextual',
    sourceType: 'user_explicit',
    statement: 'Prefer Agents that deliver working code quickly.',
  };
}

test('get_memory_settings resolves the owned Agent before reading settings', async () => {
  const found = executorFor([[OWNED_AGENT], { collectionEnabled: true, matchingEnabled: true }]);
  const result = await found.executor.execute({
    operation: 'get_memory_settings', input: { agentId: 'untrusted-agent' },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(found.calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /agent-network-api/agents?mine=1',
    'GET /agent-network-api/agents/owned%2Fagent/memory-settings',
  ]);
});

test('propose_memory checks collection and sends the minimal normalized body', async () => {
  const found = executorFor([[OWNED_AGENT], { collectionEnabled: true }, { id: 'memory-1' }]);
  const result = await found.executor.execute({ operation: 'propose_memory', input: explicitMemory() });

  assert.equal(result.status, 'completed');
  assert.equal(found.calls[2].path, '/agent-network-api/agents/owned%2Fagent/memories');
  assert.equal(found.calls[2].idempotencyKey, 'workflow-1:memory:propose');
  assert.equal(Object.hasOwn(found.calls[2].body, 'agentId'), false);
  assert.deepEqual(found.calls[2].body, {
    clientMemoryId: 'memory-client-1',
    confidence: 1,
    contextText: 'Frontend implementation tasks',
    conversationId: null,
    expiresAt: null,
    kind: 'matching_preference',
    polarity: 'positive',
    requirementId: null,
    scope: 'contextual',
    sourceType: 'user_explicit',
    statement: 'Prefer Agents that deliver working code quickly.',
    targetAgentId: null,
  });
});

test('propose_memory fails explicitly when collection is disabled', async () => {
  const found = executorFor([[OWNED_AGENT], { collectionEnabled: false }]);
  const result = await found.executor.execute({ operation: 'propose_memory', input: explicitMemory() });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'MEMORY_COLLECTION_DISABLED');
  assert.equal(found.calls.length, 2);
});

test('inferred memory is capped by validation before any request', async () => {
  const found = executorFor([]);
  const result = await found.executor.execute({
    operation: 'propose_memory',
    input: { ...explicitMemory(), sourceType: 'model_inferred', confidence: 0.9 },
  });

  assert.equal(result.status, 'input_required');
  assert.deepEqual(result.fields, ['confidence']);
  assert.deepEqual(found.calls, []);
});

test('list_memories validates and encodes paging filters', async () => {
  const found = executorFor([[OWNED_AGENT], { items: [], total: 0 }]);
  const result = await found.executor.execute({
    operation: 'list_memories', input: { limit: 25, offset: 5, status: 'pending_review' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(
    found.calls[1].path,
    '/agent-network-api/agents/owned%2Fagent/memories?limit=25&offset=5&status=pending_review',
  );
});

test('delete_memory resolves ownership and uses a stable key', async () => {
  const found = executorFor([[OWNED_AGENT], { deleted: true }]);
  const result = await found.executor.execute({
    operation: 'delete_memory', input: { agentId: 'untrusted-agent', memoryId: 'memory/id' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(found.calls[1].path, '/agent-network-api/agents/owned%2Fagent/memories/memory%2Fid');
  assert.equal(found.calls[1].idempotencyKey, 'workflow-1:memory:delete');
});

test('Node 与 Python 客户端记忆状态一致，且不接受平台来源', async () => {
  const [client, python] = await Promise.all([
    readFile(new URL('../src/memory-actions.js', import.meta.url), 'utf8'),
    readFile(new URL(
      '../skills/tokensmind-agent-network/scripts/memory_actions.py', import.meta.url,
    ), 'utf8'),
  ]);
  const statuses = ['active', 'deleted', 'pending_review', 'rejected'];
  for (const source of [client, python]) {
    for (const status of statuses) assert.ok(source.includes(`'${status}'`) || source.includes(`"${status}"`));
    // expired / superseded 没有任何写入路径，服务端已移除，客户端不能再发
    assert.doesNotMatch(source, /'expired'|"expired"|'superseded'|"superseded"/);
  }
  // platform_event 只能由服务端写入
  assert.doesNotMatch(client, /MEMORY_SOURCES[\s\S]{0,80}platform_event/);
  assert.doesNotMatch(python, /MEMORY_SOURCES[\s\S]{0,80}platform_event/);
});
