import { INTERNAL_PATH_PATTERNS, MUTATION_METHODS } from './constants.js';

const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const PUBLIC_AGENT_DIRECTORY_PATH = '/agent-network-api/agents';

export function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Agent Network baseUrl must use http or https');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.origin;
}

export function validateBusinessRequest({ method, path, idempotencyKey, reauthorize }) {
  const normalizedMethod = String(method).toUpperCase();
  if (!SUPPORTED_METHODS.has(normalizedMethod)) {
    throw new Error(`Unsupported Agent Network method: ${normalizedMethod}`);
  }
  if (!path.startsWith('/agent-network-api/')) {
    throw new Error('Agent Network path must start with /agent-network-api/');
  }
  if (INTERNAL_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    throw new Error('This endpoint is not available through the ordinary-user connector');
  }
  if (MUTATION_METHODS.has(normalizedMethod) && !idempotencyKey?.trim()) {
    throw new Error('Mutating Agent Network requests require a stable Idempotency-Key');
  }
  if (reauthorize !== undefined && typeof reauthorize !== 'boolean') {
    throw new Error('Agent Network reauthorize must be a boolean');
  }
  return { method: normalizedMethod, path, idempotencyKey: idempotencyKey?.trim() };
}

export function buildBusinessUrl(baseUrl, path) {
  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== baseUrl || !url.pathname.startsWith('/agent-network-api/')) {
    throw new Error('Agent Network request must remain on the configured origin');
  }
  if (INTERNAL_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    throw new Error('This endpoint is not available through the ordinary-user connector');
  }
  return url.toString();
}

export function isPublicDiscoveryRequest({ method, path }) {
  if (method !== 'GET') return false;
  const url = new URL(path, 'https://tokensmind.invalid');
  const mineRequested = [...url.searchParams.entries()]
    .some(([key, value]) => key === 'mine' && value === '1');
  return url.pathname === PUBLIC_AGENT_DIRECTORY_PATH
    && !mineRequested;
}
