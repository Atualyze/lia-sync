import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CWD_KB_DIR = path.resolve(process.cwd(), 'data', 'knowledge-bases');
const FALLBACK_KB_DIR = path.resolve(MODULE_DIR, '..', 'data', 'knowledge-bases');

export const DEFAULT_KB_DIR = fsSync.existsSync(CWD_KB_DIR) ? CWD_KB_DIR : FALLBACK_KB_DIR;

let syncCache = {
  dir: '',
  signature: '',
  items: []
};

function extractMetaFromMarkdown(id, rawContent) {
  const lines = String(rawContent || '').split('\n');
  let title = id;
  let version = '';
  let summary = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      title = trimmed
        .replace(/^#\s+/, '')
        .replace(/^[^\wÀ-ÿ]+/, '')
        .replace(/^MANUAL DE CONHECIMENTO\s*[&E]\s*SUPORTE OPERACIONAL\s*[--]\s*/i, '')
        .trim() || trimmed.replace(/^#\s+/, '').trim();
      break;
    }
  }

  const versionMatch = rawContent.match(/Vers[ãa]o(?:\s+do\s+Sistema)?:\**\s*([0-9.]+)/i);
  if (versionMatch) version = versionMatch[1];

  const summaryMatch = rawContent.match(/###\s*1\.1\.[^\n]*\n+([^\n]+)/i) || rawContent.match(/>\s*\*\*Finalidade:\*\*\s*([^\n]+)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].replace(/\*\*/g, '').trim().slice(0, 180);
  }

  const copilotOnly = /<!--\s*scope:\s*copilot-only\s*-->/i.test(String(rawContent || ''));

  return {
    id,
    title,
    version: version || '1.0',
    copilotOnly,
    summary: summary || 'Base de conhecimento operacional vinculável a contatos.'
  };
}

export function sanitizeKbContent(rawContent = '') {
  return String(rawContent || '')
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (/^\*\s*`?(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(t)) return false;
      if (/^###\s*\d+\.\d+\.\s*(?:Roteamento de APIs|Estrutura do Banco de Dados|Stack Tecnol[óo]gica)/i.test(t)) return false;
      return true;
    })
    .map(line =>
      line
        .replace(/\(\s*`?(?:GET|POST|PUT|PATCH|DELETE)?\s*\/api\/[a-zA-Z0-9_/:.-]+`?\s*\)/g, '')
        .replace(/`(?:server|shared|client\/src)\/[a-zA-Z0-9_/:.-]+\.(?:ts|tsx|js|mjs|json)`/g, 'painel do sistema')
    )
    .join('\n');
}

export async function ensureKbDir(dir = DEFAULT_KB_DIR) {
  await fs.mkdir(dir, { recursive: true });
}

function isKbDocument(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower === 'readme.md') return false;
  return lower.endsWith('.md') || lower.endsWith('.txt');
}

async function walkKbFiles(rootDir, currentDir = rootDir, acc = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkKbFiles(rootDir, fullPath, acc);
    } else if (entry.isFile() && isKbDocument(entry.name)) {
      const relPath = path.relative(rootDir, fullPath);
      const folder = path.dirname(relPath) === '.' ? '' : path.dirname(relPath).replace(/\\/g, '/');
      acc.push({ fullPath, fileName: entry.name, relPath, folder });
    }
  }
  return acc;
}

function walkKbFilesSync(rootDir, currentDir = rootDir, acc = []) {
  const entries = fsSync.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkKbFilesSync(rootDir, fullPath, acc);
    } else if (entry.isFile() && isKbDocument(entry.name)) {
      const relPath = path.relative(rootDir, fullPath);
      const folder = path.dirname(relPath) === '.' ? '' : path.dirname(relPath).replace(/\\/g, '/');
      acc.push({ fullPath, fileName: entry.name, relPath, folder });
    }
  }
  return acc;
}

export async function listKnowledgeBases(dir = DEFAULT_KB_DIR) {
  try {
    await ensureKbDir(dir);
    const files = await walkKbFiles(dir);
    const bases = [];
    for (const { fullPath, fileName, folder } of files) {
      const id = fileName.replace(/\.(md|txt)$/i, '');
      const stat = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const meta = extractMetaFromMarkdown(id, content);
      bases.push({
        ...meta,
        folder,
        fileName,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
    return bases.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  } catch (err) {
    console.warn('[knowledge-bases] Erro ao listar bases:', err.message);
    return [];
  }
}

export function listKnowledgeBasesSync(dir = DEFAULT_KB_DIR) {
  try {
    const targetDir = fsSync.existsSync(dir)
      ? dir
      : (fsSync.existsSync(CWD_KB_DIR) ? CWD_KB_DIR : FALLBACK_KB_DIR);
    if (!fsSync.existsSync(targetDir)) return [];

    const files = walkKbFilesSync(targetDir);
    const sigParts = [];
    for (const { fullPath, relPath } of files) {
      try {
        const st = fsSync.statSync(fullPath);
        sigParts.push(`${relPath}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch {}
    }
    const signature = sigParts.join('|');
    if (syncCache.dir === targetDir && syncCache.signature === signature) {
      return syncCache.items;
    }

    const items = [];
    for (const { fullPath, fileName, folder } of files) {
      try {
        const id = fileName.replace(/\.(md|txt)$/i, '');
        const raw = fsSync.readFileSync(fullPath, 'utf-8');
        const content = sanitizeKbContent(raw);
        const meta = extractMetaFromMarkdown(id, content);
        items.push({
          ...meta,
          folder,
          fileName,
          content
        });
      } catch {}
    }
    items.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    syncCache = { dir: targetDir, signature, items };
    return items;
  } catch {
    return [];
  }
}

export function getKnowledgeBaseContentSync(id, dir = DEFAULT_KB_DIR) {
  if (!id || typeof id !== 'string') return null;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const all = listKnowledgeBasesSync(dir);
  const found = all.find(kb => kb.id.toLowerCase() === safeId.toLowerCase());
  if (found) return found;

  for (const ext of ['.md', '.txt']) {
    const fullPath = path.join(dir, `${safeId}${ext}`);
    if (fsSync.existsSync(fullPath)) {
      try {
        const content = fsSync.readFileSync(fullPath, 'utf-8');
        const meta = extractMetaFromMarkdown(safeId, content);
        return { ...meta, content };
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function getRelevantKnowledgeBaseContentSync(
  id,
  queryText = '',
  dir = DEFAULT_KB_DIR,
  { maxChars = 6500 } = {}
) {
  const kb = getKnowledgeBaseContentSync(id, dir);
  if (!kb) return null;
  const queryTokens = extractQueryTokens(queryText);
  const match = queryTokens.length ? scoreKbRelevance(kb, queryTokens) : null;
  const content = match
    ? buildRelevantSnippet(kb, match.scoredSections, maxChars)
    : `${kb.content.slice(0, Math.min(1800, maxChars)).trim()}\n\n[Demais seções disponíveis na base vinculada; consulte somente se necessário.]`;
  return { ...kb, content };
}

const SEARCH_STOPWORDS = new Set([
  'para', 'como', 'mais', 'com', 'sem', 'por', 'que', 'uma', 'uns', 'umas',
  'das', 'dos', 'isso', 'isto', 'aqui', 'sobre', 'voce', 'voces', 'cliente',
  'clientes', 'atendimento', 'sistema', 'lia', 'pode', 'quer', 'quero',
  'esta', 'estao', 'esse', 'essa', 'muito', 'tudo', 'onde', 'qual', 'quais',
  'quando', 'porque', 'fazer', 'manual', 'conhecimento', 'suporte',
  'operacional', 'base', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite'
]);

function normalizeSearchText(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractQueryTokens(text = '') {
  const norm = normalizeSearchText(text);
  const parts = norm.split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !SEARCH_STOPWORDS.has(t));
  return [...new Set(parts)];
}

function splitMarkdownSections(content = '') {
  const lines = String(content || '').split(/\r?\n/);
  const sections = [];
  let currentHeading = '';
  let currentBody = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (currentHeading || currentBody.length) {
        const bodyText = currentBody.join('\n').trim();
        sections.push({
          heading: currentHeading,
          body: bodyText,
          normHeading: normalizeSearchText(currentHeading),
          normBody: normalizeSearchText(bodyText)
        });
      }
      currentHeading = line.replace(/^##\s+/, '').trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading || currentBody.length) {
    const bodyText = currentBody.join('\n').trim();
    sections.push({
      heading: currentHeading,
      body: bodyText,
      normHeading: normalizeSearchText(currentHeading),
      normBody: normalizeSearchText(bodyText)
    });
  }
  return sections;
}

function scoreKbRelevance(kb, queryTokens) {
  if (!queryTokens.length) return null;
  const idAndTitleNorm = normalizeSearchText(`${kb.id.replace(/[-_]+/g, ' ')} ${kb.title}`);
  const sections = splitMarkdownSections(kb.content);
  const fullBodyNorm = normalizeSearchText(kb.content);

  let docScore = 0;
  let distinctMatches = 0;
  let hasTitleMatch = false;

  for (const token of queryTokens) {
    if (token.length >= 4 && idAndTitleNorm.includes(token)) {
      docScore += 8;
      distinctMatches++;
      hasTitleMatch = true;
    } else if (sections.some(sec => sec.normHeading && sec.normHeading.includes(token))) {
      docScore += 5;
      distinctMatches++;
    } else if (fullBodyNorm.includes(token)) {
      docScore += 2.5;
      distinctMatches++;
    }
  }

  if (!hasTitleMatch && (distinctMatches < 2 || docScore < 7.5)) return null;

  const scoredSections = [];
  for (const sec of sections) {
    let secScore = 0;
    for (const token of queryTokens) {
      if (sec.normHeading && sec.normHeading.includes(token)) secScore += 5;
      else if (sec.normBody && sec.normBody.includes(token)) secScore += 2.5;
    }
    if (secScore > 0) scoredSections.push({ ...sec, score: secScore });
  }

  scoredSections.sort((a, b) => b.score - a.score);
  return { kb, score: docScore, scoredSections };
}

function buildRelevantSnippet(kb, scoredSections, maxChars = 3600) {
  if (!maxChars || maxChars <= 0) return kb.content;
  const header = `# ${kb.title}\n\n`;
  if (!scoredSections.length) return kb.content.slice(0, maxChars);
  let out = header;
  for (const sec of scoredSections.slice(0, 3)) {
    const block = `${sec.heading ? `## ${sec.heading}\n` : ''}${sec.body}\n\n`;
    if (out.length + block.length > maxChars && out.length > header.length) break;
    out += block;
  }
  return out.slice(0, maxChars).trim();
}

export function findMatchingKnowledgeBaseSync(
  queryText = '',
  dir = DEFAULT_KB_DIR,
  { includeCopilotOnly = false, excludeFolders = null, onlyFolders = null, maxChars = 0 } = {}
) {
  const queryTokens = extractQueryTokens(queryText);
  if (!queryTokens.length) return null;

  const all = listKnowledgeBasesSync(dir);
  let best = null;
  for (const kb of all) {
    if (kb.copilotOnly && !includeCopilotOnly) continue;
    const folder = String(kb.folder || '');
    if (Array.isArray(onlyFolders) && !onlyFolders.some(f => folder === f || folder.startsWith(`${f}/`))) continue;
    if (Array.isArray(excludeFolders) && excludeFolders.some(f => folder === f || folder.startsWith(`${f}/`))) continue;

    const match = scoreKbRelevance(kb, queryTokens);
    if (match && (!best || match.score > best.score)) {
      best = match;
    }
  }
  if (!best) return null;
  if (maxChars > 0) {
    return {
      ...best.kb,
      content: buildRelevantSnippet(best.kb, best.scoredSections, maxChars)
    };
  }
  return best.kb;
}

export function findGuidanceKnowledgeSync(queryText = '', dir = DEFAULT_KB_DIR, { maxChars = 3000 } = {}) {
  return findMatchingKnowledgeBaseSync(queryText, dir, {
    includeCopilotOnly: false,
    onlyFolders: ['sales_intelligence', 'biblioteca_juridica'],
    maxChars
  });
}

export async function saveKnowledgeBase({ id, title, content }, dir = DEFAULT_KB_DIR) {
  await ensureKbDir(dir);
  const slug = String(id || title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('ID ou título inválido para a base de conhecimento.');
  const fullPath = path.join(dir, `${slug}.md`);
  const finalContent = String(content || '').trim();
  if (!finalContent) throw new Error('Conteúdo da base de conhecimento não pode ser vazio.');
  await fs.writeFile(fullPath, finalContent, 'utf-8');
  syncCache = { dir: '', signature: '', items: [] };
  return {
    ...extractMetaFromMarkdown(slug, finalContent),
    fileName: `${slug}.md`
  };
}
