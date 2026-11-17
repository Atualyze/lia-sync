// Gera supabase/complete_schema_migration.sql a partir das migrations em
// supabase/migrations (ordem cronológica de nome de arquivo). Fonte da verdade
// são as migrations; este arquivo é somente uma conveniência para o SQL Editor.
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const outFile = path.join(root, 'supabase', 'complete_schema_migration.sql');

const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
if (!files.length) throw new Error('nenhuma migration encontrada em supabase/migrations');

const header = `-- ==============================================================================
-- LIA - ESQUEMA COMPLETO SUPABASE (GERADO)
-- ==============================================================================
-- GERADO AUTOMATICAMENTE: nao editar a mao. Fonte da verdade:
--   supabase/migrations/*.sql (em ordem cronologica de nome de arquivo).
-- Regenerar via scripts/generate-complete-schema.mjs.
-- Como aplicar: SQL Editor do Supabase -> colar este arquivo -> Run.
-- Cada migration e aditiva e idempotente; transacoes internas (begin/commit)
-- sao preservadas como estao, executadas em sequencia.
-- ==============================================================================

`;

const parts = [];
for (const name of files) {
  const content = (await fs.readFile(path.join(migrationsDir, name), 'utf8')).trimEnd();
  parts.push(`-- ======== ${name} ========\n${content}`);
}

await fs.writeFile(outFile, header + parts.join('\n\n\n') + '\n', 'utf8');
console.log(`gerado ${path.relative(root, outFile)} (${files.length} migrations)`);
