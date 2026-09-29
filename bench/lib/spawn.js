'use strict';
// Starts a benchmark server in its own process (pinned to CPU 0 when `taskset` exists,
// while the load generator in this process gets the other cores) and resolves once it is listening.

const { fork, execFileSync } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, 'server.js');
const hasTaskset = (() => {
  try {
    execFileSync('taskset', ['-p', String(process.pid)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const cpus = require('node:os').availableParallelism();
// The load generator (this process) gets every other core.
if (hasTaskset && cpus > 1) {
  try {
    execFileSync('taskset', ['-a', '-p', (2 ** cpus - 2).toString(16), String(process.pid)], {
      stdio: 'ignore',
    });
  } catch {
    // pinning is best effort
  }
}

function startServer(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(SERVER, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    if (hasTaskset) {
      try {
        execFileSync('taskset', ['-a', '-p', '1', String(child.pid)], { stdio: 'ignore' });
      } catch {
        // pinning is best effort
      }
    }
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server ${args.join(' ')} exited with ${code}`)));
    child.once('message', ({ port, adapter }) =>
      resolve({
        port,
        adapter,
        stop: () => new Promise((r) => (child.once('exit', r), child.kill())),
      }),
    );
  });
}

module.exports = { startServer, pinned: hasTaskset && cpus > 1 };
