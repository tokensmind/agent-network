import { spawn } from 'node:child_process';

function browserCommand(platform) {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

export function createBrowserOpener({ platform = process.platform, spawnImpl = spawn } = {}) {
  return {
    open(url) {
      return new Promise((resolve, reject) => {
        const target = browserCommand(platform);
        const child = spawnImpl(target.command, [...target.args, url], {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('spawn', () => {
          child.unref();
          resolve();
        });
      });
    },
  };
}
