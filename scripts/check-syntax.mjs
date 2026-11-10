import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');

async function listModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listModules(target);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [target] : [];
  }));
  return nested.flat();
}

function checkSyntax(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Falha de sintaxe: ${path.relative(projectRoot, file)}`)));
  });
}

const modules = await listModules(sourceRoot);
for (const module of modules) await checkSyntax(module);
console.log(`Sintaxe verificada: ${modules.length} módulos.`);
