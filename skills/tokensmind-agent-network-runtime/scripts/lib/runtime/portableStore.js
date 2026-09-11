import { createHash, randomUUID } from 'node:crypto';
import { promises as defaultFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RECORD_NAMES = new Set(['active', 'pending', 'instance']);
const PENDING_PHASES = new Set(['prepared', 'authorizing', 'authorized']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEVICE_CODE_PATTERN = /^tm_device_[A-Za-z0-9_-]{43}$/;
const AGENT_TOKEN_PATTERN = /^tm_agent_[A-Za-z0-9_-]{43}$/;

function requireHomeDirectory(homeDir) {
  const value = String(homeDir || '').trim();
  if (!value) throw new Error('Unable to resolve the current user home directory');
  return value;
}

export function resolvePortableStateDir({
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  return pathApi.join(requireHomeDirectory(homeDir), '.tokensmind', 'agent-network');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isOperation(value) {
  return isObject(value)
    && ['GET', 'POST', 'PATCH', 'DELETE'].includes(value.method)
    && isNonEmptyString(value.path);
}

function isInstance(value) {
  return isObject(value) && UUID_PATTERN.test(value.id);
}

function isActive(value) {
  return isObject(value)
    && AGENT_TOKEN_PATTERN.test(value.token)
    && (value.agentId === null || isNonEmptyString(value.agentId))
    && isNonEmptyString(value.credentialId)
    && isNonEmptyString(value.tokenPrefix)
    && value.token.startsWith(value.tokenPrefix);
}

function hasPendingSecrets(value) {
  return UUID_PATTERN.test(value.authorizationId)
    && UUID_PATTERN.test(value.instanceId)
    && UUID_PATTERN.test(value.createIdempotencyKey)
    && UUID_PATTERN.test(value.exchangeIdempotencyKey)
    && DEVICE_CODE_PATTERN.test(value.deviceCode)
    && SHA256_PATTERN.test(value.deviceCodeHash)
    && AGENT_TOKEN_PATTERN.test(value.token)
    && SHA256_PATTERN.test(value.tokenHash)
    && isNonEmptyString(value.tokenPrefix)
    && value.token.startsWith(value.tokenPrefix);
}

function hasAuthorization(value) {
  return isObject(value.authorization)
    && value.authorization.authorizationId === value.authorizationId
    && isNonEmptyString(value.authorization.verificationUrl)
    && Number.isFinite(Date.parse(value.authorization.expiresAt))
    && Number.isInteger(value.authorization.intervalSeconds)
    && value.authorization.intervalSeconds > 0;
}

function isPending(value) {
  if (!isObject(value) || !PENDING_PHASES.has(value.phase)) return false;
  if (!isOperation(value.operation) || !hasPendingSecrets(value)) return false;
  return value.phase === 'prepared' || hasAuthorization(value);
}

export function validatePortableRecord(name, value) {
  const valid = name === 'active'
    ? isActive(value)
    : name === 'pending'
      ? isPending(value)
      : isInstance(value);
  if (!valid) throw new Error(`Portable Agent Network ${name} state has an invalid structure`);
}

function validateRecordName(name) {
  if (!RECORD_NAMES.has(name)) throw new Error(`Unsupported portable state record: ${name}`);
}

export function originNamespace(origin) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new Error('Portable Agent Network store requires a normalized HTTP origin');
  }
  return createHash('sha256').update(origin, 'utf8').digest('hex');
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function ensurePrivateDirectory({ fs, directory, platform }) {
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  if (platform !== 'win32') await fs.chmod(directory, DIRECTORY_MODE);
}

async function removeTemporaryFile(fs, filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function createReadOperation({ fs, recordPath }) {
  return async function read(name) {
    validateRecordName(name);
    let source;
    try {
      source = await fs.readFile(recordPath(name), 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error(`Portable Agent Network ${name} state is invalid JSON`, { cause: error });
    }
    validatePortableRecord(name, value);
    return value;
  };
}

function createWriteOperation({ fs, directory, platform, randomId, recordPath }) {
  return async function write(name, value) {
    validateRecordName(name);
    validatePortableRecord(name, value);
    await ensurePrivateDirectory({ fs, directory, platform });
    const target = recordPath(name);
    const temporary = path.join(directory, `.${name}.${process.pid}.${randomId()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value), {
        encoding: 'utf8', mode: FILE_MODE, flag: 'wx',
      });
      if (platform !== 'win32') await fs.chmod(temporary, FILE_MODE);
      await fs.rename(temporary, target);
      if (platform !== 'win32') await fs.chmod(target, FILE_MODE);
    } catch (error) {
      await removeTemporaryFile(fs, temporary);
      throw error;
    }
  };
}

function createRemoveOperation({ fs, recordPath }) {
  return async function remove(name) {
    validateRecordName(name);
    try {
      await fs.unlink(recordPath(name));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
}

export function createPortableStore({
  stateDir,
  origin,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  fs = defaultFs,
  randomId = randomUUID,
} = {}) {
  const baseDirectory = path.resolve(stateDir || resolvePortableStateDir({ platform, env, homeDir }));
  const directory = path.join(baseDirectory, originNamespace(origin));
  const recordPath = (name) => path.join(directory, `${name}.json`);
  const context = { fs, directory, platform, randomId, recordPath };
  return {
    read: createReadOperation(context),
    write: createWriteOperation(context),
    remove: createRemoveOperation(context),
  };
}
