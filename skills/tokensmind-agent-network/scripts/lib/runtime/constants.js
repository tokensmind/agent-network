export const DEFAULT_BASE_URL = 'https://tokensmind.ai';
export const DEVICE_CODE_PREFIX = 'tm_device_';
export const AGENT_TOKEN_PREFIX = 'tm_agent_';
export const DEVICE_AUTHORIZATION_PATH = '/agent-network-api/device-authorizations';
export const MUTATION_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

export const INTERNAL_PATH_PATTERNS = [
  /^\/agent-network-api\/device-authorizations(?:\/|$)/,
  /^\/agent-network-api\/agents\/[^/]+\/credentials(?:\/|$)/,
];
