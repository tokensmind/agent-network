import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createActionExecutor } from '../src/action-executor.js';
import { createWorkflowStore } from '../src/workflow-store.js';

const execFileAsync = promisify(execFile);
const ORIGIN = 'https://tokensmind.ai';

function memoryStore() {
  let value = null;
  return {
    async read() { return value; },
    async write(_name, next) { if (!value) value = next; },
    async remove() {
      const existed = value !== null;
      value = null;
      return existed;
    },
    current() { return value; },
  };
}

test('pending workflow survives another request until explicitly abandoned', async () => {
  const workflowStore = memoryStore();
  const temporary = Object.assign(new Error('temporary'), { status: 503 });
  const api = { request: async () => { throw temporary; } };
  const executor = createActionExecutor({ api, workflowStore, randomId: () => 'workflow-1' });

  const failed = await executor.execute({ operation: 'get_my_agent', input: {} });
  assert.equal(failed.retryable, true);
  const pending = await executor.execute({ operation: 'search_agents', input: {} });
  assert.equal(pending.code, 'AGENT_NETWORK_ACTION_PENDING');
  assert.equal(workflowStore.current().id, 'workflow-1');

  const abandoned = await executor.execute({ operation: 'abandon_action', input: {} });
  assert.deepEqual(abandoned.data, { abandoned: true });
  assert.equal(workflowStore.current(), null);
});

test('abandon_action removes unreadable workflow state without parsing it', async () => {
  let read = false;
  const workflowStore = {
    async read() { read = true; throw new Error('invalid JSON'); },
    async remove() { return true; },
  };
  const executor = createActionExecutor({ api: {}, workflowStore });
  const result = await executor.execute({ operation: 'abandon_action', input: {} });
  assert.deepEqual(result.data, { abandoned: true });
  assert.equal(read, false);
});

test('Node and Python atomically claim one cross-process workflow', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'agent-network-workflow-'));
  const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'tokensmind-agent-network', 'scripts');
  const store = createWorkflowStore({ stateDir, origin: ORIGIN });
  const python = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from action_support import WorkflowStore',
    'store = WorkflowStore(sys.argv[3], sys.platform, state_dir=sys.argv[2])',
    'store.write({"version": 1, "id": "python", "operation": "reply", "input": {}})',
    'print(json.dumps(store.read(), separators=(",", ":")))',
  ].join('\n');

  try {
    const [, pythonResult] = await Promise.all([
      store.write('workflow', { version: 1, id: 'node', operation: 'reply', input: {} }),
      execFileAsync('python3', ['-B', '-c', python, scripts, stateDir, ORIGIN]),
    ]);
    const nodeResult = await store.read('workflow');
    assert.ok(['node', 'python'].includes(nodeResult.id));
    assert.equal(JSON.parse(pythonResult.stdout).id, nodeResult.id);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
