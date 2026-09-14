import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserOpener } from '../src/runtime/browser.js';

function spawnRecorder(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

test('browser opener delegates to each operating system default browser', async () => {
  const cases = [
    ['darwin', 'open', ['https://tokensmind.ai/authorize']],
    ['win32', 'cmd', ['/c', 'start', '', 'https://tokensmind.ai/authorize']],
    ['linux', 'xdg-open', ['https://tokensmind.ai/authorize']],
  ];

  for (const [platform, command, args] of cases) {
    const calls = [];
    const browser = createBrowserOpener({ platform, spawnImpl: spawnRecorder(calls) });
    await browser.open('https://tokensmind.ai/authorize');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, command);
    assert.deepEqual(calls[0].args, args);
    assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore' });
  }
});
