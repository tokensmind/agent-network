import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'tokensmind-agent-network-runtime';
const target = path.join(root, 'skills', SKILL_NAME, 'scripts', 'lib');
const sources = [
  'action-errors.js',
  'action-validation.js',
  'action-context.js',
  'agent-actions.js',
  'contact-action.js',
  'messaging-actions.js',
  'governance-actions.js',
  'action-executor.js',
  'api-client.js',
  'workflow-store.js',
];

function validateSkill(content) {
  if (!content.includes('Use whenever the user mentions TokensMind.')) {
    throw new Error('Executable Agent Network Skill must trigger on TokensMind mentions');
  }
  if (!content.includes('agent_network_action') || content.includes('method + path + body')) {
    throw new Error('Executable Agent Network Skill content is invalid');
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
  validateSkill(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'));
}

if (process.argv.includes('--check')) await check();
else await sync();
