// Isola cada arquivo de teste num diretório temporário próprio.
// Vários módulos gravam em caminhos relativos ao cwd (./data/*.json); sem isto os testes
// sobrescreviam dados reais de desenvolvimento. Carregado via `node --import` (ver package.json).
// O runner pai não é afetado: só os subprocessos de teste (NODE_TEST_CONTEXT) trocam de cwd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.NODE_TEST_CONTEXT && !process.env.LIA_TEST_NO_SANDBOX) {
  const projectRoot = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-test-'));
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Bases de conhecimento são somente leitura nos testes: link simbólico para as reais.
  const kbSource = path.join(projectRoot, 'data', 'knowledge-bases');
  if (fs.existsSync(kbSource)) fs.symlinkSync(kbSource, path.join(dataDir, 'knowledge-bases'), process.platform === 'win32' ? 'junction' : 'dir');

  process.env.LIA_TEST_PROJECT_ROOT = projectRoot;
  process.env.DATA_FILE = path.join(dataDir, 'sessions.json');
  process.env.BAILEYS_AUTH_DIR = path.join(dataDir, 'baileys-auth');
  process.chdir(sandbox);

  process.on('exit', () => {
    try { process.chdir(os.tmpdir()); fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* melhor esforço */ }
  });
}
