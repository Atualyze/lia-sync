import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './check-syntax.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'public');
const distDir = path.join(projectRoot, 'dist');
const distDashboardDir = path.join(distDir, 'dashboard');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDashboardDir, { recursive: true });
await cp(publicDir, distDir, { recursive: true });
await cp(publicDir, distDashboardDir, { recursive: true });

console.log('Frontend empacotado em dist/ (e dist/dashboard/) com sucesso.');
