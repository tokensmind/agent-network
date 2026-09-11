import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionExecutor } from '../src/action-executor.js';

function executorFor(response) {
  const calls = [];
  let workflow = null;
  const executor = createActionExecutor({
    api: {
      async request(request) {
        calls.push(request);
        return response;
      },
    },
    workflowStore: {
      async read() { return workflow; },
      async write(_name, value) { workflow = value; },
      async remove() {
        const existed = workflow !== null;
        workflow = null;
        return existed;
      },
    },
    randomId: () => 'workflow-1',
  });
  return { calls, executor };
}

test('report requires reasonCode before calling the API', async () => {
  const { calls, executor } = executorFor({});
  const result = await executor.execute({
    operation: 'report',
    input: { targetAgentId: 'agent-target' },
  });

  assert.deepEqual(result, {
    status: 'input_required',
    fields: ['reasonCode'],
    message: 'Agent Network action needs more input.',
  });
  assert.deepEqual(calls, []);
});

test('report normalizes its request body', async () => {
  const { calls, executor } = executorFor({ id: 'report-1' });
  const result = await executor.execute({
    operation: 'report',
    input: { reasonCode: '  spam  ', targetAgentId: ' agent-target ' },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0].body, {
    reasonCode: 'spam',
    description: '',
    reporterAgentId: null,
    targetAgentId: 'agent-target',
    conversationId: null,
    messageId: null,
  });
  assert.equal(calls[0].idempotencyKey, 'workflow-1:report:create');
});
