import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'server.mjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN || 'dev-preview-webhook-token',
    ALLOW_UNAUTHENTICATED_DASHBOARD: process.env.ALLOW_UNAUTHENTICATED_DASHBOARD || 'true',
    AI_STUDIO_PREVIEW: process.env.AI_STUDIO_PREVIEW || 'true',
    EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'lia'
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
