import { randomUUID } from 'node:crypto';
import { AgentNetworkHttpError } from './httpClient.js';
import {
  createPendingAuthorization,
  createRemoteAuthorization,
  exchangeAuthorization,
  waitForApproval,
} from './deviceAuthorization.js';
import {
  buildBusinessUrl,
  validateBusinessRequest,
} from './requestPolicy.js';

function requestHeaders({ token, idempotencyKey }) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function operationsMatch(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assertPendingMatches(pending, operation) {
  if (!operationsMatch(pending.operation, operation)) {
    throw new Error(
      'A different Agent Network operation is pending; retry the original operation first',
    );
  }
}

function assertActiveCredential(active) {
  if (!active?.token) {
    throw new Error('Authorized Agent Network operation has no active stored credential');
  }
  return active;
}

async function executeBusinessRequest({ operation, token, baseUrl, http, signal }) {
  return http.request({
    url: buildBusinessUrl(baseUrl, operation.path),
    method: operation.method,
    headers: requestHeaders({ token, idempotencyKey: operation.idempotencyKey }),
    body: operation.body,
    signal,
  });
}

async function loadInstanceId(store) {
  const existing = await store.read('instance');
  if (existing?.id) return existing.id;
  const id = randomUUID();
  await store.write('instance', { id });
  return id;
}

async function preparePending({ operation, store }) {
  const existing = await store.read('pending');
  if (existing) return existing;
  const instanceId = await loadInstanceId(store);
  const pending = createPendingAuthorization({ operation, instanceId });
  await store.write('pending', pending);
  return pending;
}

async function authorize({ operation, store, browser, baseUrl, http, client, signal }) {
  try {
    let pending = await preparePending({ operation, store });
    if (pending.phase === 'prepared') {
      pending = await createRemoteAuthorization({ pending, baseUrl, http, client, signal });
      await store.write('pending', pending);
      await browser.open(pending.authorization.verificationUrl);
    }
    if (pending.phase === 'authorizing') {
      await waitForApproval({ pending, baseUrl, http, signal });
      const exchange = await exchangeAuthorization({ pending, baseUrl, http, signal });
      const active = {
        token: pending.token,
        agentId: exchange.agent?.id || null,
        credentialId: exchange.credential.id,
        tokenPrefix: exchange.credential.tokenPrefix,
      };
      await store.write('active', active);
      pending = { ...pending, phase: 'authorized' };
      await store.write('pending', pending);
      return active;
    }
    return store.read('active');
  } catch (error) {
    if (isTerminalAuthorizationError(error)) await store.remove('pending');
    throw error;
  }
}

function isTerminalAuthorizationError(error) {
  return error instanceof AgentNetworkHttpError
    && [
      'DEVICE_AUTHORIZATION_DENIED',
      'DEVICE_AUTHORIZATION_EXCHANGED',
      'DEVICE_AUTHORIZATION_EXPIRED',
    ].includes(error.code);
}

function isInvalidAgentCredential(error) {
  return error instanceof AgentNetworkHttpError
    && [
      'AGENT_CREDENTIAL_EXPIRED',
      'AGENT_CREDENTIAL_INVALID',
      'AGENT_CREDENTIAL_REVOKED',
    ].includes(error.code);
}

function requiresAuthorization(error) {
  return error instanceof AgentNetworkHttpError
    && (error.status === 401 || isInvalidAgentCredential(error));
}

async function executeAndFinalize({ pending, active, dependencies }) {
  assertActiveCredential(active);
  try {
    const result = await executeBusinessRequest({
      operation: pending.operation,
      token: active.token,
      ...dependencies,
    });
    await dependencies.store.remove('pending');
    return result;
  } catch (error) {
    if (error instanceof AgentNetworkHttpError && error.status < 500 && error.status !== 429) {
      await dependencies.store.remove('pending');
      if (requiresAuthorization(error)) await dependencies.store.remove('active');
    }
    throw error;
  }
}

export function createConnector({ store, browser, baseUrl, http, client }) {
  let executionQueue = Promise.resolve();

  const dependencies = (signal) => ({ store, browser, baseUrl, http, client, signal });

  async function authorizeAndExecute(operation, signal) {
    const active = await authorize({ operation, ...dependencies(signal) });
    const pending = await store.read('pending');
    return executeAndFinalize({ pending, active, dependencies: dependencies(signal) });
  }

  async function resumePending(pending, operation, signal) {
    assertPendingMatches(pending, operation);
    return authorizeAndExecute(pending.operation, signal);
  }

  async function executeWithActive(operation, active, signal) {
    try {
      return await executeBusinessRequest({ operation, token: active.token, baseUrl, http, signal });
    } catch (error) {
      if (!requiresAuthorization(error)) throw error;
      await store.remove('active');
      return authorizeAndExecute(operation, signal);
    }
  }

  async function executeOnce(params, { signal } = {}) {
    if (signal?.aborted) throw signal.reason;
    const normalized = validateBusinessRequest(params);
    const operation = { ...normalized, body: params.body };
    const reauthorize = params.reauthorize === true;

    const pending = await store.read('pending');
    const active = await store.read('active');
    if (pending) return resumePending(pending, operation, signal);
    if (!active || reauthorize) return authorizeAndExecute(operation, signal);
    return executeWithActive(operation, active, signal);
  }

  return {
    execute(params, options) {
      const result = executionQueue.then(() => executeOnce(params, options));
      executionQueue = result.catch(() => undefined);
      return result;
    },
  };
}
