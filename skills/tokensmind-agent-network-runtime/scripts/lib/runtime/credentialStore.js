import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {
  createPortableStore,
  originNamespace,
  resolvePortableStateDir,
} from './portableStore.js';
import {
  resolveSystemCredentialStore,
  SystemCredentialStoreError,
} from './systemCredentialStore.js';

const RECORD_NAMES = Object.freeze(['instance', 'pending', 'active']);

function requireHome(homeDir) {
  const home = String(homeDir || '').trim();
  if (!home) throw new Error('Unable to resolve the current user home directory');
  return home;
}

function windowsLegacyDirs(env) {
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  return localAppData ? [path.win32.join(localAppData, 'TokensMind', 'AgentNetwork')] : [];
}

function linuxLegacyDirs({ env, home }) {
  const defaultDirectory = path.join(home, '.local', 'state', 'tokensmind', 'agent-network');
  const xdgStateHome = String(env.XDG_STATE_HOME || '').trim();
  if (!xdgStateHome) return [defaultDirectory];
  return [...new Set([
    path.join(xdgStateHome, 'tokensmind', 'agent-network'), defaultDirectory,
  ])];
}

export function resolveLegacyStateDirs({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const home = requireHome(homeDir);
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'TokensMind', 'AgentNetwork')];
  }
  if (platform === 'win32') return windowsLegacyDirs(env);
  if (platform !== 'linux') return [];
  return linuxLegacyDirs({ env, home });
}

async function collectSourceRecords(sources) {
  const candidates = new Map();
  for (const source of sources) {
    for (const name of RECORD_NAMES) {
      const value = await source.read(name);
      if (value === null) continue;
      const candidate = candidates.get(name);
      if (candidate && !isDeepStrictEqual(candidate.value, value)) {
        throw new Error(`Conflicting Agent Network ${name} records exist in known local stores`);
      }
      if (candidate) candidate.sources.push(source);
      else candidates.set(name, { value, sources: [source] });
    }
  }
  return candidates;
}

async function validateMigrationTarget(target, candidates) {
  const missing = [];
  for (const [name, candidate] of candidates) {
    const current = await target.read(name);
    if (current === null) missing.push([name, candidate.value]);
    else if (!isDeepStrictEqual(current, candidate.value)) {
      throw new Error(`Stored Agent Network ${name} conflicts with a known legacy record`);
    }
  }
  return missing;
}

async function verifyWrites(target, records) {
  for (const [name, expected] of records) {
    const actual = await target.read(name);
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`Agent Network ${name} migration could not be verified`);
    }
  }
}

async function removeMigratedSources(candidates) {
  for (const [name, candidate] of candidates) {
    for (const source of candidate.sources) await source.remove(name);
  }
}

export async function migrateCredentialStores({ target, sources }) {
  const candidates = await collectSourceRecords(sources);
  if (candidates.size === 0) return;
  const missing = await validateMigrationTarget(target, candidates);
  for (const [name, value] of missing) await target.write(name, value);
  await verifyWrites(target, [...candidates].map(([name, item]) => [name, item.value]));
  await removeMigratedSources(candidates);
}

function createLazyStore(resolveStore) {
  let storePromise;
  const getStore = () => {
    storePromise ||= resolveStore();
    return storePromise;
  };
  return {
    async read(name) {
      return (await getStore()).read(name);
    },
    async write(name, value) {
      return (await getStore()).write(name, value);
    },
    async remove(name) {
      return (await getStore()).remove(name);
    },
  };
}

function createFileStores({ directories, origin, platform, env, homeDir, fs, randomId }) {
  return directories.map((stateDir) => createPortableStore({
    stateDir, origin, platform, env, homeDir, fs, randomId,
  }));
}

async function validateSystemRecords(systemStore) {
  for (const name of RECORD_NAMES) await systemStore.read(name);
}

async function initializeStore({
  systemStore, fallback, fallbackDirectory, legacyDirectories, storeOptions, onFallback,
}) {
  const recordDirectory = path.join(
    fallbackDirectory, originNamespace(storeOptions.origin),
  );
  const legacySources = createFileStores({
    ...storeOptions, directories: legacyDirectories,
  });
  if (!systemStore) {
    onFallback({
      backend: null,
      directory: recordDirectory,
      reason: 'No supported system credential store is available',
    });
    await migrateCredentialStores({ target: fallback, sources: legacySources });
    return fallback;
  }
  try {
    if (typeof systemStore.verifyAvailability !== 'function') {
      throw new SystemCredentialStoreError(
        'System credential store does not support availability verification',
      );
    }
    await systemStore.verifyAvailability();
    await validateSystemRecords(systemStore);
    const sources = createFileStores({
      ...storeOptions, directories: [fallbackDirectory, ...legacyDirectories],
    });
    await migrateCredentialStores({ target: systemStore, sources });
    return systemStore;
  } catch (error) {
    if (!(error instanceof SystemCredentialStoreError)) throw error;
    onFallback({
      backend: systemStore.backend,
      directory: recordDirectory,
      reason: error.message,
    });
    await migrateCredentialStores({ target: fallback, sources: legacySources });
    return fallback;
  }
}

export function createCredentialStore({
  stateDir,
  origin,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  fs,
  randomId,
  secureStore,
  resolveSecureStore = resolveSystemCredentialStore,
  run,
  onFallback = () => {},
} = {}) {
  if (stateDir) {
    return createPortableStore({ stateDir, origin, platform, env, homeDir, fs, randomId });
  }
  const fallbackDirectory = resolvePortableStateDir({ platform, env, homeDir });
  const fallback = createPortableStore({
    stateDir: fallbackDirectory, origin, platform, env, homeDir, fs, randomId,
  });
  return createLazyStore(async () => {
    const systemStore = secureStore === undefined
      ? await resolveSecureStore({
        platform, namespace: originNamespace(origin), env, fs, run,
      })
      : secureStore;
    const legacyDirectories = resolveLegacyStateDirs({ platform, env, homeDir });
    return initializeStore({
      systemStore,
      fallback,
      fallbackDirectory,
      legacyDirectories: [...new Set(legacyDirectories)],
      storeOptions: { origin, platform, env, homeDir, fs, randomId },
      onFallback,
    });
  });
}
