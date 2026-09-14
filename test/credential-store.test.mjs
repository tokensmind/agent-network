import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore } from '../src/runtime/credentialStore.js';
import { createPortableStore } from '../src/runtime/portableStore.js';
import {
  resolveSystemCredentialStore,
  SystemCredentialStoreError,
} from '../src/runtime/systemCredentialStore.js';

const ORIGIN = 'https://tokensmind.ai';
const ORIGIN_HASH = createHash('sha256').update(ORIGIN).digest('hex');

async function withTemporaryHome(run) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-network-home-'));
  try {
    await run(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function unavailableSystemStore(message) {
  return {
    backend: 'macos-keychain',
    async verifyAvailability() {
      throw new SystemCredentialStoreError(message);
    },
    async read() { return null; },
    async write() {},
    async remove() {},
  };
}

function corruptSystemStore() {
  return {
    backend: 'macos-keychain',
    async verifyAvailability() {},
    async read() {
      throw new SystemCredentialStoreError('stored record is corrupt');
    },
    async write() {},
    async remove() {},
  };
}

function createMacRunner() {
  const records = new Map();
  const calls = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      const account = request.args[request.args.indexOf('-a') + 1];
      if (request.args[0] === 'add-generic-password') {
        const lines = request.input.trimEnd().split('\n');
        if (lines.length === 2 && lines[0] === lines[1]) records.set(account, lines[0]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (request.args[0] === 'find-generic-password') {
        return records.has(account)
          ? { code: 0, stdout: records.get(account), stderr: '' }
          : { code: 44, stdout: '', stderr: '' };
      }
      records.delete(account);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('system store failure migrates legacy state to the canonical file fallback', async () => {
  await withTemporaryHome(async (homeDir) => {
    const legacyDir = path.join(
      homeDir, 'Library', 'Application Support', 'TokensMind', 'AgentNetwork',
    );
    const legacy = createPortableStore({ stateDir: legacyDir, origin: ORIGIN });
    const instance = { id: randomUUID() };
    await legacy.write('instance', instance);
    const events = [];
    const store = createCredentialStore({
      origin: ORIGIN,
      platform: 'darwin',
      homeDir,
      secureStore: unavailableSystemStore('keychain locked'),
      onFallback: (event) => events.push(event),
    });

    assert.deepEqual(await store.read('instance'), instance);
    assert.equal(await legacy.read('instance'), null);
    const file = path.join(homeDir, '.tokensmind', 'agent-network', ORIGIN_HASH, 'instance.json');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), instance);
    assert.deepEqual(events, [{
      backend: 'macos-keychain',
      directory: path.dirname(file),
      reason: 'keychain locked',
    }]);
  });
});

test('macOS Keychain writes the same secret twice and verifies the stored record', async () => {
  const runner = createMacRunner();
  const store = await resolveSystemCredentialStore({
    platform: 'darwin',
    namespace: ORIGIN_HASH,
    fs: { access: async () => undefined },
    run: runner.run,
  });
  const instance = { id: randomUUID() };

  await store.write('instance', instance);

  assert.deepEqual(await store.read('instance'), instance);
  const write = runner.calls.find(({ args }) => args[0] === 'add-generic-password');
  const lines = write.input.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1]);
  assert.equal(write.args.join(' ').includes(instance.id), false);
});

test('corrupt system records select the file fallback without legacy state', async () => {
  await withTemporaryHome(async (homeDir) => {
    const events = [];
    const store = createCredentialStore({
      origin: ORIGIN,
      platform: 'darwin',
      homeDir,
      secureStore: corruptSystemStore(),
      onFallback: (event) => events.push(event),
    });
    const instance = { id: randomUUID() };

    assert.equal(await store.read('instance'), null);
    await store.write('instance', instance);

    const file = path.join(homeDir, '.tokensmind', 'agent-network', ORIGIN_HASH, 'instance.json');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), instance);
    assert.equal(events[0].reason, 'stored record is corrupt');
  });
});

test('macOS Keychain real command round-trips a temporary record', {
  skip: process.platform !== 'darwin',
}, async (context) => {
  const store = await resolveSystemCredentialStore({
    platform: 'darwin',
    namespace: `test-${randomUUID()}`,
  });
  const instance = { id: randomUUID() };
  context.after(async () => store.remove('instance'));

  await store.write('instance', instance);

  assert.deepEqual(await store.read('instance'), instance);
  await store.remove('instance');
});

test('macOS Keychain rejects the full-size availability probe when input is truncated', {
  skip: process.platform !== 'darwin',
}, async () => {
  const store = await resolveSystemCredentialStore({
    platform: 'darwin',
    namespace: `test-${randomUUID()}`,
  });

  await assert.rejects(
    store.verifyAvailability(),
    (error) => error instanceof SystemCredentialStoreError,
  );
});
