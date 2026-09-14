import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as defaultFs } from 'node:fs';
import path from 'node:path';
import { validatePortableRecord } from './portableStore.js';
import {
  commandFailure,
  createCommandRunner,
  runCommand,
  SystemCredentialStoreError,
  verifyRoundTrip,
} from './systemCredentialSupport.js';

export { createCommandRunner, SystemCredentialStoreError } from './systemCredentialSupport.js';

const SERVICE_NAME = 'TokensMind Agent Network';
const APPLICATION_NAME = 'tokensmind-agent-network';
const RECORD_NAMES = new Set(['active', 'pending', 'instance']);
const MACOS_SECURITY_PATH = '/usr/bin/security';
const MACOS_ITEM_NOT_FOUND = 44;
const SYSTEM_STORE_PROBE_LENGTH = 1024;

function validateRecordName(name) {
  if (!RECORD_NAMES.has(name)) throw new Error(`Unsupported portable state record: ${name}`);
}

function credentialAccount(namespace, name) {
  validateRecordName(name);
  return `${namespace}:${name}`;
}

function parseRecord(name, source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new SystemCredentialStoreError(
      `System Agent Network ${name} credential is invalid JSON`,
      { cause: error },
    );
  }
  try {
    validatePortableRecord(name, value);
  } catch (error) {
    throw new SystemCredentialStoreError(
      `System Agent Network ${name} credential has an invalid structure`,
      { cause: error },
    );
  }
  return value;
}

function macPasswordInput(source) {
  return `${source}\n${source}\n`;
}

function createProbeValue() {
  return randomUUID().padEnd(SYSTEM_STORE_PROBE_LENGTH, 'x');
}

function createMacCommands(run) {
  const backend = 'macOS Keychain';
  async function readSource(account) {
    const result = await runCommand({
      run, backend, operation: 'read',
      request: {
        command: MACOS_SECURITY_PATH,
        args: ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w'],
      },
    });
    if (result.code === MACOS_ITEM_NOT_FOUND) return null;
    if (result.code !== 0) throw commandFailure(backend, 'read', result);
    return result.stdout.trim();
  }
  async function writeSource(account, source) {
    const result = await runCommand({
      run, backend, operation: 'write',
      request: {
        command: MACOS_SECURITY_PATH,
        args: ['add-generic-password', '-a', account, '-s', SERVICE_NAME, '-U', '-w'],
        input: macPasswordInput(source),
      },
    });
    if (result.code !== 0) throw commandFailure(backend, 'write', result);
  }
  async function removeAccount(account) {
    const result = await runCommand({
      run, backend, operation: 'remove',
      request: {
        command: MACOS_SECURITY_PATH,
        args: ['delete-generic-password', '-a', account, '-s', SERVICE_NAME],
      },
    });
    if (![0, MACOS_ITEM_NOT_FOUND].includes(result.code)) {
      throw commandFailure(backend, 'remove', result);
    }
  }
  return { readSource, writeSource, removeAccount };
}

function createMacOperations({ namespace, run }) {
  const { readSource, writeSource, removeAccount } = createMacCommands(run);
  async function readRecord(name) {
    const source = await readSource(credentialAccount(namespace, name));
    return source === null ? null : parseRecord(name, source);
  }
  return {
    read: readRecord,
    async write(name, value) {
      validateRecordName(name);
      validatePortableRecord(name, value);
      const account = credentialAccount(namespace, name);
      await writeSource(account, JSON.stringify(value));
      const stored = await readRecord(name);
      if (!isDeepStrictEqual(stored, value)) {
        throw new SystemCredentialStoreError(`macOS Keychain ${name} write verification failed`);
      }
    },
    async remove(name) {
      await removeAccount(credentialAccount(namespace, name));
    },
    async verifyAvailability() {
      const account = `${namespace}:probe:${randomUUID()}`;
      const expected = createProbeValue();
      await verifyRoundTrip({
        expected,
        write: (source) => writeSource(account, source),
        read: () => readSource(account),
        remove: () => removeAccount(account),
      });
    },
    backend: 'macos-keychain',
  };
}

function linuxAttributes(namespace, name) {
  validateRecordName(name);
  return ['application', APPLICATION_NAME, 'origin', namespace, 'record', name];
}

function createLinuxCommands({ command, run }) {
  const backend = 'Linux Secret Service';
  async function lookupSource(attributes) {
    const result = await runCommand({
      run, backend, operation: 'read',
      request: { command, args: ['lookup', ...attributes] },
    });
    const missing = result.code === 1 && !result.stdout.trim() && !result.stderr.trim();
    if (missing) return null;
    if (result.code !== 0) throw commandFailure(backend, 'read', result);
    return result.stdout.trim();
  }
  async function writeSource(attributes, source) {
    const result = await runCommand({
      run, backend, operation: 'write',
      request: {
        command,
        args: ['store', `--label=${SERVICE_NAME}`, ...attributes],
        input: `${source}\n`,
      },
    });
    if (result.code !== 0) throw commandFailure(backend, 'write', result);
  }
  async function removeAttributes(attributes) {
    if (await lookupSource(attributes) === null) return;
    const result = await runCommand({
      run, backend, operation: 'remove',
      request: { command, args: ['clear', ...attributes] },
    });
    if (result.code !== 0) throw commandFailure(backend, 'remove', result);
  }
  return { lookupSource, writeSource, removeAttributes };
}

function createLinuxOperations({ namespace, command, run }) {
  const { lookupSource, writeSource, removeAttributes } = createLinuxCommands({ command, run });
  async function readRecord(name) {
    const source = await lookupSource(linuxAttributes(namespace, name));
    return source === null ? null : parseRecord(name, source);
  }
  return {
    read: readRecord,
    async write(name, value) {
      validatePortableRecord(name, value);
      const attributes = linuxAttributes(namespace, name);
      await writeSource(attributes, JSON.stringify(value));
      if (!isDeepStrictEqual(await readRecord(name), value)) {
        throw new SystemCredentialStoreError(`Linux Secret Service ${name} write verification failed`);
      }
    },
    async remove(name) {
      await removeAttributes(linuxAttributes(namespace, name));
    },
    async verifyAvailability() {
      const probeName = `probe-${randomUUID()}`;
      const attributes = [
        'application', APPLICATION_NAME, 'origin', namespace, 'record', probeName,
      ];
      const expected = createProbeValue();
      await verifyRoundTrip({
        expected,
        write: (source) => writeSource(attributes, source),
        read: () => lookupSource(attributes),
        remove: () => removeAttributes(attributes),
      });
    },
    backend: 'linux-secret-service',
  };
}

async function isExecutable(fs, filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable({ name, env, fs }) {
  const directories = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (await isExecutable(fs, candidate)) return candidate;
  }
  return null;
}

export async function resolveSystemCredentialStore({
  platform,
  namespace,
  env = process.env,
  fs = defaultFs,
  run = createCommandRunner(),
} = {}) {
  if (platform === 'darwin') {
    if (!await isExecutable(fs, MACOS_SECURITY_PATH)) return null;
    return createMacOperations({ namespace, run });
  }
  if (platform === 'linux') {
    const command = await findExecutable({ name: 'secret-tool', env, fs });
    return command ? createLinuxOperations({ namespace, command, run }) : null;
  }
  return null;
}
