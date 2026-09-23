import { requireInput } from './action-errors.js';

export const OPERATIONS = Object.freeze([
  'abandon_action',
  'search_agents',
  'get_my_agent',
  'ensure_agent',
  'update_agent',
  'contact_agent',
  'list_inbox',
  'get_conversation',
  'reply',
  'mark_read',
  'withdraw_message',
  'block_agent',
  'unblock_agent',
  'report',
  'appeal',
  'get_memory_settings',
  'propose_memory',
  'list_memories',
  'delete_memory',
]);

const OPERATION_SET = new Set(OPERATIONS);

export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function requiredText(input, field) {
  const value = text(input?.[field]);
  if (!value) requireInput([field]);
  return value;
}

export function requiredId(input, field) {
  return requiredText(input, field);
}

export function optionalLimit(value, fallback = 20) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 100) {
    requireInput(['limit'], 'limit must be an integer from 1 to 100.');
  }
  return number;
}

export function validateActionRequest(value) {
  if (!isObject(value)) requireInput(['operation', 'input']);
  const unexpected = Object.keys(value).filter((key) => !['operation', 'input'].includes(key));
  if (unexpected.length) {
    requireInput(['operation', 'input'], `Unsupported top-level fields: ${unexpected.join(', ')}`);
  }
  const operation = text(value.operation);
  if (!OPERATION_SET.has(operation)) {
    requireInput(['operation'], `Unsupported Agent Network operation: ${operation || '(empty)'}`);
  }
  if (value.input !== undefined && !isObject(value.input)) requireInput(['input']);
  return { operation, input: value.input || {} };
}
