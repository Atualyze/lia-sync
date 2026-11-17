import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './check-syntax.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'public');
const distDir = path.join(projectRoot, 'dist');
const distDashboardDir = path.join(distDir, 'dashboard');

// Allowlist explícita: só entra no dist o que o painel realmente serve
// (ver src/dashboard.mjs serveStatic). Nunca copiar README, fontes de build
// ou qualquer arquivo novo que apareça em public/ por acidente.
const REQUIRED_FILES = ['index.html', 'conectar.html', 'app.js', 'styles.css', 'logo.png', 'logo.webp', 'qrcode.png'];
const REQUIRED_DIRS = ['vendor'];

async function assertPresent(target, label) {
  try {
    await access(target);
  } catch {
    throw new Error(`Asset obrigatório ausente em public/: "${label}". Corrija public/ antes de gerar o dist.`);
  }
}

for (const file of REQUIRED_FILES) await assertPresent(path.join(publicDir, file), file);
for (const dir of REQUIRED_DIRS) await assertPresent(path.join(publicDir, dir), `${dir}/`);

await rm(distDir, { recursive: true, force: true });
for (const targetDir of [distDir, distDashboardDir]) {
  await mkdir(targetDir, { recursive: true });
  for (const file of REQUIRED_FILES) {
    await cp(path.join(publicDir, file), path.join(targetDir, file));
  }
  for (const dir of REQUIRED_DIRS) {
    await cp(path.join(publicDir, dir), path.join(targetDir, dir), { recursive: true });
  }
}

console.log(`Frontend empacotado em dist/ (e dist/dashboard/) com sucesso: ${REQUIRED_FILES.length} arquivos + ${REQUIRED_DIRS.length} diretório(s) em allowlist.`);
