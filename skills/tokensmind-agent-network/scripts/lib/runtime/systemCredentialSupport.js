import { spawn as defaultSpawn } from 'node:child_process';

export class SystemCredentialStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SystemCredentialStoreError';
    this.code = 'SYSTEM_CREDENTIAL_STORE_UNAVAILABLE';
  }
}

export function commandFailure(backend, operation, result) {
  return new SystemCredentialStoreError(
    `${backend} ${operation} failed with exit code ${String(result.code)}`,
  );
}

export async function runCommand({ run, backend, operation, request }) {
  try {
    return await run(request);
  } catch (error) {
    throw new SystemCredentialStoreError(`${backend} ${operation} failed`, { cause: error });
  }
}

export async function verifyRoundTrip({ write, read, remove, expected }) {
  let failure;
  try {
    await write(expected);
    if (await read() !== expected) {
      failure = new SystemCredentialStoreError('System credential store round-trip failed');
    }
  } catch (error) {
    failure = error;
  }
  try {
    await remove();
  } catch (error) {
    failure ||= error;
  }
  if (failure) throw failure;
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
