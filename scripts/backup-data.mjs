import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Argumentos via CLI ou variáveis de ambiente
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const sourceDir = path.resolve(getArg('source', process.env.DATA_DIR || path.join(projectRoot, 'data')));
const targetDir = path.resolve(getArg('target', process.env.BACKUP_DIR || path.join(projectRoot, 'backups')));
const keepCount = Math.max(1, Number(getArg('keep', process.env.BACKUP_KEEP || 10)));
const verifyOnly = args.includes('--verify');

async function fileHash(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

async function getGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

async function getPackageVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function copyRecursive(src, dest, filesAcc = []) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Ignora arquivos temporários e corrompidos
    if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp-') || entry.name.includes('.corrupt-')) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyRecursive(srcPath, destPath, filesAcc);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      const stat = await fs.stat(destPath);
      const sha256 = await fileHash(destPath);
      const relativeName = path.relative(dest, destPath).replace(/\\/g, '/');
      filesAcc.push({
        path: path.relative(src, srcPath).replace(/\\/g, '/'),
        size: stat.size,
        sha256
      });
    }
  }
  return filesAcc;
}

async function rotateOldBackups(baseDir, keep) {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const backupFolders = entries
      .filter(e => e.isDirectory() && e.name.startsWith('data-'))
      .map(e => ({ name: e.name, fullPath: path.join(baseDir, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name)); // decrescente (mais recente primeiro)

    if (backupFolders.length > keep) {
      const toRemove = backupFolders.slice(keep);
      for (const item of toRemove) {
        await fs.rm(item.fullPath, { recursive: true, force: true });
        console.log(`[backup] backup antigo removido: ${item.name}`);
      }
    }
  } catch (err) {
    console.warn(`[backup] aviso na rotação de backups antigos: ${err.message}`);
  }
}

export async function createDataBackup({ src = sourceDir, destBase = targetDir, keep = keepCount } = {}) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backupName = `data-${timestamp}`;
  const backupPath = path.join(destBase, backupName);

  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(destBase, { recursive: true });

  console.log(`[backup] iniciando cópia de ${src} -> ${backupPath}`);
  const backedFiles = [];
  await copyRecursive(src, backupPath, backedFiles);

  const manifest = {
    backupName,
    createdAt: new Date().toISOString(),
    gitCommit: await getGitSha(),
    appVersion: await getPackageVersion(),
    sourceDirectory: src,
    fileCount: backedFiles.length,
    files: backedFiles
  };

  const manifestPath = path.join(backupPath, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[backup] concluído: ${backedFiles.length} arquivos salvos em ${backupName}`);
  console.log(`[backup] manifesto registrado com hash SHA-256 de integridade.`);

  await rotateOldBackups(destBase, keep);

  return { ok: true, backupPath, fileCount: backedFiles.length, manifest };
}

// Execução direta via CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (verifyOnly) {
    console.log('[backup] modo verificação: checando pastas de backup existentes...');
    const exists = await fs.stat(targetDir).catch(() => null);
    if (!exists) {
      console.log('[backup] diretório de backups ainda não existe.');
      process.exit(0);
    }
    const entries = await fs.readdir(targetDir);
    console.log(`[backup] ${entries.filter(e => e.startsWith('data-')).length} backups encontrados.`);
  } else {
    createDataBackup().catch(err => {
      console.error(`[backup] erro fatal: ${err.message}`);
      process.exit(1);
    });
  }
}
