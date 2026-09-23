export class AgentNetworkHttpError extends Error {
  constructor({ status, code, message, response, retryAfter, correction }) {
    super(message || `Agent Network request failed with HTTP ${status}`);
    this.name = 'AgentNetworkHttpError';
    this.status = status;
    this.code = code;
    this.response = response;
    this.retryAfter = retryAfter;
    this.correction = correction;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Agent Network returned non-JSON HTTP ${response.status}`);
  }
}

function unwrapSuccess(response, payload) {
  if (!response.ok) return undefined;
  if (payload?.success === true && Object.hasOwn(payload, 'data')) return payload.data;
  throw new Error('Agent Network returned an invalid success response envelope');
}

function throwHttpError(response, payload) {
  throw new AgentNetworkHttpError({
    status: response.status,
    code: payload?.code,
    message: payload?.message,
    response: payload,
    retryAfter: response.headers.get('Retry-After'),
    correction: payload?.correction,
  });
}

export function createHttpClient({ fetchImpl = fetch } = {}) {
  return {
    async request({ url, method = 'GET', headers, body, signal }) {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const payload = await parseResponse(response);
      if (response.ok) return unwrapSuccess(response, payload);
      return throwHttpError(response, payload);
    },
  };
}
