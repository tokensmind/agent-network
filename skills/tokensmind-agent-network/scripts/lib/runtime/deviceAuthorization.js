import {
  AGENT_TOKEN_PREFIX,
  DEVICE_AUTHORIZATION_PATH,
  DEVICE_CODE_PREFIX,
} from './constants.js';
import { createAuthorizationMaterial } from './crypto.js';
import { AgentNetworkHttpError } from './httpClient.js';

const DEVICE_STATUSES = new Set(['pending', 'approved', 'denied', 'expired', 'exchanged']);
const CLIENT_FIELDS = ['name', 'version', 'deviceName', 'platform'];

function headers({ bearer, idempotencyKey } = {}) {
  return {
    'Content-Type': 'application/json',
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Agent Network authorization aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isExpectedVerificationUrl(url, pending, baseUrl) {
  const expectedPath = `/console/agent-network/authorize/${encodeURIComponent(pending.authorizationId)}`;
  return url.origin === baseUrl
    && url.pathname === expectedPath
    && !url.search
    && !url.hash;
}

function hasValidExpiry(response) {
  const expiresAt = Date.parse(response.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function hasValidInterval(response) {
  return Number.isInteger(response.intervalSeconds) && response.intervalSeconds > 0;
}

function assertCreateResponse(response, pending, baseUrl) {
  if (response?.authorizationId !== pending.authorizationId) {
    throw new Error('Agent Network authorization response has a mismatched identifier');
  }
  const verificationUrl = new URL(response.verificationUrl);
  if (!isExpectedVerificationUrl(verificationUrl, pending, baseUrl)) {
    throw new Error('Agent Network returned an invalid verification URL');
  }
  if (!hasValidExpiry(response)) {
    throw new Error('Agent Network returned an invalid authorization expiry');
  }
  if (!hasValidInterval(response)) {
    throw new Error('Agent Network returned an invalid polling interval');
  }
  if (typeof response.userCode !== 'string' || !response.userCode) {
    throw new Error('Agent Network authorization response is missing its user code');
  }
}

function hasMatchingCredential(exchange, pending, agentId) {
  return Boolean(exchange.credential?.id)
    && exchange.credential.agentId === agentId
    && exchange.credential.tokenPrefix === pending.tokenPrefix;
}

function exposesCredentialMaterial(exchange) {
  if (Object.hasOwn(exchange, 'apiToken')) return true;
  if (Object.hasOwn(exchange.credential, 'tokenHash')) return true;
  return Object.hasOwn(exchange.credential, 'apiToken');
}

function assertStatusResponse(status, pending) {
  if (status?.authorizationId !== pending.authorizationId
    || !DEVICE_STATUSES.has(status?.status)) {
    throw new Error('Agent Network returned an invalid authorization status');
  }
  if (Date.parse(status.expiresAt) !== Date.parse(pending.authorization.expiresAt)) {
    throw new Error('Agent Network authorization expiry changed unexpectedly');
  }
}

function assertExchange(exchange, pending) {
  if (exchange?.status !== 'exchanged') {
    throw new Error('Agent Network credential exchange did not complete');
  }
  if (exchange.authorizationId !== pending.authorizationId) {
    throw new Error('Agent Network credential exchange has a mismatched identifier');
  }
  if (exchange.credential?.tokenPrefix !== pending.tokenPrefix) {
    throw new Error('Agent Network credential prefix verification failed');
  }
  const agentId = exchange.agent?.id || null;
  if (!hasMatchingCredential(exchange, pending, agentId)) {
    throw new Error('Agent Network exchange response is missing credential metadata');
  }
  if (exposesCredentialMaterial(exchange)) {
    throw new Error('Agent Network exchange response exposed forbidden credential material');
  }
}

function assertClientMetadata(client) {
  if (!client || CLIENT_FIELDS.some((field) => typeof client[field] !== 'string'
    || !client[field].trim())) {
    throw new Error('Agent Network client metadata is incomplete');
  }
}

export function createPendingAuthorization({ operation, instanceId }) {
  return {
    phase: 'prepared',
    operation,
    instanceId,
    ...createAuthorizationMaterial({
      devicePrefix: DEVICE_CODE_PREFIX,
      tokenPrefix: AGENT_TOKEN_PREFIX,
    }),
  };
}

export async function createRemoteAuthorization({ pending, baseUrl, http, client, signal }) {
  assertClientMetadata(client);
  const response = await http.request({
    url: `${baseUrl}${DEVICE_AUTHORIZATION_PATH}`,
    method: 'POST',
    headers: headers({ idempotencyKey: pending.createIdempotencyKey }),
    body: {
      authorizationId: pending.authorizationId,
      deviceCodeHash: pending.deviceCodeHash,
      client: {
        ...client,
        instanceId: pending.instanceId,
      },
      credential: { tokenHash: pending.tokenHash, tokenPrefix: pending.tokenPrefix },
    },
    signal,
  });
  assertCreateResponse(response, pending, baseUrl);
  return { ...pending, phase: 'authorizing', authorization: response };
}

async function pollOnce({ pending, baseUrl, http, signal }) {
  return http.request({
    url: `${baseUrl}${DEVICE_AUTHORIZATION_PATH}/${pending.authorizationId}`,
    headers: headers({ bearer: pending.deviceCode }),
    signal,
  });
}

export async function waitForApproval({ pending, baseUrl, http, signal }) {
  const intervalMs = pending.authorization.intervalSeconds * 1000;
  while (Date.now() < Date.parse(pending.authorization.expiresAt)) {
    const status = await pollOnce({ pending, baseUrl, http, signal });
    assertStatusResponse(status, pending);
    if (status.status === 'approved' || status.status === 'exchanged') return status;
    if (status.status !== 'pending') {
      const denied = status.status === 'denied';
      throw new AgentNetworkHttpError({
        status: denied ? 403 : 410,
        code: denied ? 'DEVICE_AUTHORIZATION_DENIED' : 'DEVICE_AUTHORIZATION_EXPIRED',
        message: `Agent Network authorization ended with status ${status.status}`,
      });
    }
    await sleep(intervalMs, signal);
  }
  throw new AgentNetworkHttpError({
    status: 410,
    code: 'DEVICE_AUTHORIZATION_EXPIRED',
    message: 'Agent Network authorization expired',
  });
}

export async function exchangeAuthorization({ pending, baseUrl, http, signal }) {
  const exchange = await http.request({
    url: `${baseUrl}${DEVICE_AUTHORIZATION_PATH}/${pending.authorizationId}/exchange`,
    method: 'POST',
    headers: headers({
      bearer: pending.deviceCode,
      idempotencyKey: pending.exchangeIdempotencyKey,
    }),
    signal,
  });
  assertExchange(exchange, pending);
  return exchange;
}
