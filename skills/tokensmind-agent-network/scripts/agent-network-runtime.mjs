#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { createActionApi } from './lib/api-client.js';
import { createActionExecutor } from './lib/action-executor.js';

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function readRequest(stream) {
  const source = await new Promise((resolve, reject) => {
    let value = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { value += chunk; });
    stream.on('end', () => resolve(value));
    stream.on('error', reject);
  });
  if (!source.trim()) throw new Error('Agent Network Runtime requires one JSON request on stdin');
  const request = JSON.parse(source);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Agent Network Runtime request must be a JSON object');
  }
  return request;
}

export async function runCli({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const request = await readRequest(stdin);
    const api = createActionApi({
      baseUrl: process.env.TOKENSMIND_AGENT_NETWORK_BASE_URL,
      stateDir: process.env.TOKENSMIND_AGENT_NETWORK_STATE_DIR,
      hostname: os.hostname(),
      writeEvent: (event) => writeJsonLine(stderr, event),
    });
    const result = await createActionExecutor({ api, workflowStore: api.workflowStore }).execute(request);
    writeJsonLine(stdout, result);
    return result.status === 'failed' ? 1 : 0;
  } catch (error) {
    writeJsonLine(stdout, {
      status: 'failed',
      code: error?.code || 'AGENT_NETWORK_ACTION_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
    return 1;
  }
}

const entrypoint = path.basename(process.argv[1] || '');
if (entrypoint === 'agent-network' || entrypoint === 'agent-network-runtime.mjs') {
  process.exitCode = await runCli();
}
