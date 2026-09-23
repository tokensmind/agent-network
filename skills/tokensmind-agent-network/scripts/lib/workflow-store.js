import { promises as defaultFs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { originNamespace, resolvePortableStateDir } from './runtime/portableStore.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function recordPath({ stateDir, origin, platform, homeDir }) {
  const base = stateDir || resolvePortableStateDir({ platform, homeDir });
  return path.join(path.resolve(base), originNamespace(origin), 'workflow.json');
}

async function ensureDirectory(fs, filePath, platform) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  if (platform !== 'win32') await fs.chmod(directory, DIRECTORY_MODE);
}

async function writeCandidate({ fs, filePath, platform, value }) {
  const temporary = path.join(path.dirname(filePath), `.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value), {
      encoding: 'utf8', mode: FILE_MODE, flag: 'wx',
    });
    if (platform !== 'win32') await fs.chmod(temporary, FILE_MODE);
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    try {
      await fs.unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function createWorkflowStore({
  stateDir,
  origin,
  platform = process.platform,
  homeDir = os.homedir(),
  fs = defaultFs,
} = {}) {
  const filePath = recordPath({ stateDir, origin, platform, homeDir });
  return {
    async read(name = 'workflow') {
      if (name !== 'workflow') throw new Error(`Unsupported workflow record: ${name}`);
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) throw new Error('Workflow state is invalid JSON', { cause: error });
        throw error;
      }
    },
    async write(name, value) {
      if (name !== 'workflow') throw new Error(`Unsupported workflow record: ${name}`);
      await ensureDirectory(fs, filePath, platform);
      await writeCandidate({ fs, filePath, platform, value });
    },
    async remove(name = 'workflow') {
      if (name !== 'workflow') throw new Error(`Unsupported workflow record: ${name}`);
      try {
        await fs.unlink(filePath);
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}
