import { spawn as defaultSpawn } from 'node:child_process';
import { constants as fsConstants, promises as defaultFs } from 'node:fs';
import path from 'node:path';
import { validatePortableRecord } from './portableStore.js';

const SERVICE_NAME = 'TokensMind Agent Network';
const APPLICATION_NAME = 'tokensmind-agent-network';
const RECORD_NAMES = new Set(['active', 'pending', 'instance']);
const MACOS_SECURITY_PATH = '/usr/bin/security';
const MACOS_ITEM_NOT_FOUND = 44;

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
    throw new Error(`System Agent Network ${name} credential is invalid JSON`, { cause: error });
  }
  validatePortableRecord(name, value);
  return value;
}

function commandFailure(backend, operation, result) {
  return new Error(
    `${backend} ${operation} failed with exit code ${String(result.code)}`,
  );
}

export function createCommandRunner({ spawnImpl = defaultSpawn } = {}) {
  return ({ command, args, input = '' }) => new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (error.code === 'EPIPE' || settled) return;
      settled = true;
      reject(error);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input);
  });
}

function createMacOperations({ namespace, run }) {
  return {
    async read(name) {
      const account = credentialAccount(namespace, name);
      const result = await run({
        command: MACOS_SECURITY_PATH,
        args: ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w'],
      });
      if (result.code === MACOS_ITEM_NOT_FOUND) return null;
      if (result.code !== 0) throw commandFailure('macOS Keychain', 'read', result);
      return parseRecord(name, result.stdout.trim());
    },
    async write(name, value) {
      validateRecordName(name);
      validatePortableRecord(name, value);
      const account = credentialAccount(namespace, name);
      const result = await run({
        command: MACOS_SECURITY_PATH,
        args: ['add-generic-password', '-a', account, '-s', SERVICE_NAME, '-U', '-w'],
        input: `${JSON.stringify(value)}\n`,
      });
      if (result.code !== 0) throw commandFailure('macOS Keychain', 'write', result);
    },
    async remove(name) {
      const account = credentialAccount(namespace, name);
      const result = await run({
        command: MACOS_SECURITY_PATH,
        args: ['delete-generic-password', '-a', account, '-s', SERVICE_NAME],
      });
      if (![0, MACOS_ITEM_NOT_FOUND].includes(result.code)) {
        throw commandFailure('macOS Keychain', 'remove', result);
      }
    },
  };
}

function linuxAttributes(namespace, name) {
  validateRecordName(name);
  return ['application', APPLICATION_NAME, 'origin', namespace, 'record', name];
}

function createLinuxOperations({ namespace, command, run }) {
  async function lookup(name) {
    const result = await run({
      command,
      args: ['lookup', ...linuxAttributes(namespace, name)],
    });
    const missing = result.code === 1 && !result.stdout.trim() && !result.stderr.trim();
    if (missing) return null;
    if (result.code !== 0) throw commandFailure('Linux Secret Service', 'read', result);
    return parseRecord(name, result.stdout.trim());
  }
  return {
    read: lookup,
    async write(name, value) {
      validatePortableRecord(name, value);
      const result = await run({
        command,
        args: ['store', `--label=${SERVICE_NAME}`, ...linuxAttributes(namespace, name)],
        input: `${JSON.stringify(value)}\n`,
      });
      if (result.code !== 0) throw commandFailure('Linux Secret Service', 'write', result);
    },
    async remove(name) {
      if (await lookup(name) === null) return;
      const result = await run({
        command,
        args: ['clear', ...linuxAttributes(namespace, name)],
      });
      if (result.code !== 0) throw commandFailure('Linux Secret Service', 'remove', result);
    },
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
