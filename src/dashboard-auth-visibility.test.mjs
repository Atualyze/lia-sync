import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readPublic(name) {
  return readFile(path.join(root, 'public', name), 'utf8');
}

test('dashboard e navegação mobile começam ocultos até a autenticação', async () => {
  const html = await readPublic('index.html');
  assert.match(html, /id="dashboard-shell" class="shell hidden"[^>]*aria-hidden="true"/);
  assert.match(html, /class="mobile-bottom-nav hidden"[^>]*aria-hidden="true"/);
});

test('transições de autenticação controlam shell e navegação mobile', async () => {
  const app = await readPublic('app.js');
  assert.match(app, /mobileNav\?\.classList\.add\('hidden'\)/);
  assert.match(app, /mobileNav\?\.classList\.remove\('hidden'\)/);
  assert.match(app, /shell\?\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(app, /shell\?\.setAttribute\('aria-hidden', 'false'\)/);
});
