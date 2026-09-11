export class ActionState extends Error {
  constructor(status, data) {
    super(data?.message || status);
    this.name = 'ActionState';
    this.status = status;
    this.data = data || {};
  }
}

export class ActionFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ActionFailure';
    this.code = code;
    this.details = details;
    this.retryable = false;
  }
}

export function requireInput(fields, message = 'Agent Network action needs more input.') {
  throw new ActionState('input_required', { fields, message });
}

export function requireSelection(candidates, message) {
  throw new ActionState('selection_required', { candidates, message });
}

export function actionFailure(code, message, details) {
  throw new ActionFailure(code, message, details);
}

function isRetryable(error) {
  if (error?.retryable === true) return true;
  if (error?.status === 429) return true;
  if (Number(error?.status) >= 500) return true;
  return error?.code === 'AGENT_NETWORK_TRANSPORT_ERROR';
}

function optionalFailureFields(error) {
  const fields = {};
  if (Number.isInteger(error?.status)) fields.httpStatus = error.status;
  if (error?.correction) fields.correction = error.correction;
  if (error?.retryAfter) fields.retryAfter = error.retryAfter;
  if (error?.details) fields.details = error.details;
  return fields;
}

export function serializeFailure(error) {
  return {
    code: error?.code || 'AGENT_NETWORK_ACTION_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: isRetryable(error),
    ...optionalFailureFields(error),
  };
}
