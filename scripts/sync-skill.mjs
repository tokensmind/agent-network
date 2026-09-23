import { cp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'tokensmind-agent-network';
const target = path.join(root, 'skills', SKILL_NAME, 'scripts', 'lib');
const sources = [
  'action-errors.js',
  'action-validation.js',
  'action-context.js',
  'agent-actions.js',
  'contact-action.js',
  'messaging-actions.js',
  'governance-actions.js',
  'memory-actions.js',
  'action-executor.js',
  'api-client.js',
  'workflow-store.js',
];

function validateSkill(content) {
  const normalized = content.toLowerCase();
  if (!content.includes('Use whenever the user mentions TokensMind.')) {
    throw new Error('Executable Agent Network Skill must trigger on TokensMind mentions');
  }
  if (!content.includes('agent_network_action') || content.includes('method + path + body')) {
    throw new Error('Executable Agent Network Skill content is invalid');
  }
  if (!normalized.includes("operating system's default browser")
    || !normalized.includes('runtime polls at the server-provided interval')
    || !normalized.includes('do not wait for a user reply')) {
    throw new Error('Executable Agent Network Skill must own browser handoff and polling');
  }
  if (!normalized.includes("list each agent's name")
    || !normalized.includes('not omit the description')
    || !normalized.includes('numeric match scores or score ranges')) {
    throw new Error('Executable Agent Network Skill must define search result presentation');
  }
  for (const required of [
    'get_memory_settings', 'propose_memory', 'list_memories', 'delete_memory',
    'model_inferred', 'untrusted data', 'does not delete stored memory',
    // 自报来源不可信、墓碑不可绕过、自述经验不抬排名：三条都必须留在文档里
    'MEMORY_DELETED_BY_USER', 'sourceType` is self-reported',
    'never improves how other users',
  ]) {
    if (!normalized.includes(required.toLowerCase())) {
      throw new Error(`Executable Agent Network Skill is missing memory rule: ${required}`);
    }
  }
}

async function sync() {
  await cp(path.join(root, 'src', 'runtime'), path.join(target, 'runtime'), { recursive: true });
  for (const source of sources) {
    await cp(path.join(root, 'src', source), path.join(target, source));
  }
  const generated = await readFile(path.join(root, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8');
  validateSkill(generated);
}

async function check() {
  const skillRoot = path.join(root, 'skills', SKILL_NAME);
  for (const source of sources) {
    const expected = await readFile(path.join(root, 'src', source), 'utf8');
    const actual = await readFile(path.join(skillRoot, 'scripts', 'lib', source), 'utf8');
    if (expected !== actual) throw new Error(`Skill runtime is out of sync: ${source}`);
  }
  const runtimeSources = await readdir(path.join(root, 'src', 'runtime'));
  for (const source of runtimeSources) {
    const expected = await readFile(path.join(root, 'src', 'runtime', source), 'utf8');
    const actual = await readFile(path.join(skillRoot, 'scripts', 'lib', 'runtime', source), 'utf8');
    if (expected !== actual) throw new Error(`Skill runtime is out of sync: runtime/${source}`);
  }
  validateSkill(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'));
}

if (process.argv.includes('--check')) await check();
else await sync();
