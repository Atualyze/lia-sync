import fs from 'node:fs';
import { normalizePhone } from '../src/sessions.mjs';

const f = process.argv[2] || 'data/sessions.json';
if (!fs.existsSync(f)) {
  console.log(`[migrate-phones] Arquivo ${f} não encontrado, criando vazio.`);
  fs.writeFileSync(f, '{}');
}
const raw = fs.readFileSync(f, 'utf8');
const s = JSON.parse(raw || '{}');
const out = {};
for (const [k, v] of Object.entries(s)) {
  const nk = normalizePhone(k);
  if (!out[nk] || new Date(v.updatedAt || 0) > new Date(out[nk].updatedAt || 0)) out[nk] = v;
  out[nk].phone = nk.replace(/^sim:/, '');
}
fs.copyFileSync(f, `${f}.bak`);
fs.writeFileSync(f, JSON.stringify(out, null, 2));
console.log(`[migrate-phones] Migração concluída: ${Object.keys(out).length} sessões.`);
