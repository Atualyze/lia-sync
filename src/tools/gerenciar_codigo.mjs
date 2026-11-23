const SAFE_PATHS = [
  /^src\//,
  /^scripts\//,
  /^test[s]?\//,
  /^\.github\/workflows\//,
  /^README\.md$/,
  /^docs\//
];

function repoParts(value = '') {
  const match = String(value || '').trim().match(/^([^/]+)\/([^/]+)$/);
  if (!match) throw new Error('Repositório GitHub inválido.');
  return { owner: match[1], repo: match[2] };
}

function safePath(path = '') {
  const value = String(path || '').trim().replace(/^\/+/, '');
  if (!value || value.includes('..') || !SAFE_PATHS.some(pattern => pattern.test(value))) {
    throw new Error('Caminho não permitido para manutenção automática.');
  }
  return value;
}

function githubConfig(context = {}) {
  const token = String(context.githubToken || process.env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('GITHUB_TOKEN não configurado para manutenção de código.');
  const repository = String(context.githubRepository || '').trim();
  if (!repository) throw new Error('Repositório GitHub não publicado na configuração ativa.');
  return { token, repository, ...repoParts(repository) };
}

async function githubRequest(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2026-03-10',
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.message || data?.error || `GitHub respondeu HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function normalizeContent(content = '') {
  return String(content || '').replace(/\r\n/g, '\n');
}

function branchName() {
  return `lia/self-maintenance-${Date.now()}`;
}

export const toolGerenciarCodigo = {
  name: 'gerenciar_codigo',
  description: 'Lê arquivos do código da Lia e cria alterações em uma branch de manutenção com Pull Request. Uso exclusivo do responsável. Nunca faz merge nem deploy. Para aplicar código, primeiro entenda a causa, altere somente arquivos permitidos e crie um PR para o CI validar. Nunca altere segredos, .env, package.json, package-lock.json ou arquivos de dados.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['ler_arquivo', 'criar_pr'],
        description: 'ler_arquivo consulta um arquivo; criar_pr cria uma branch e Pull Request com as alterações.'
      },
      caminho: {
        type: 'STRING',
        description: 'Caminho do arquivo no repositório.'
      },
      arquivos: {
        type: 'ARRAY',
        description: 'Arquivos completos a gravar. Cada item deve ter caminho e conteudo. Use apenas para criar_pr.'
      },
      titulo: {
        type: 'STRING',
        description: 'Título do Pull Request.'
      },
      descricao: {
        type: 'STRING',
        description: 'Descrição curta do problema, causa e correção.'
      },
      confirmar: {
        type: 'BOOLEAN',
        description: 'Precisa ser true quando o responsável pediu explicitamente para aplicar a alteração e abrir o PR.'
      }
    },
    required: ['acao']
  },

  async execute(args = {}, context = {}) {
    if (context.actor !== 'owner' && context.isOwner !== true) {
      return { success: false, error: 'Manutenção de código disponível somente no fluxo do responsável.' };
    }

    const action = String(args.acao || '').trim().toLowerCase();

    if (action === 'ler_arquivo') {
      let github;
      try { github = githubConfig(context); }
      catch (error) { return { success: false, error: String(error.message || error) }; }
      const { token, owner, repo } = github;
      let path;
      try {
        path = safePath(args.caminho);
      } catch (error) {
        return { success: false, error: String(error.message || error) };
      }
      const data = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=main`, { token });
      if (data?.type !== 'file') return { success: false, error: 'O caminho informado não é um arquivo.' };
      const content = Buffer.from(String(data.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
      return {
        success: true,
        acao: action,
        caminho: path,
        sha: data.sha,
        conteudo: content,
        tamanho: content.length
      };
    }

    if (action === 'criar_pr') {
      if (args.confirmar !== true) {
        return {
          success: false,
          code: 'confirmation_required',
          error: 'Para alterar o código, preciso de autorização explícita do responsável para criar o Pull Request.'
        };
      }

      let github;
      try { github = githubConfig(context); }
      catch (error) { return { success: false, error: String(error.message || error) }; }
      const { token, owner, repo } = github;

      const files = Array.isArray(args.arquivos) ? args.arquivos : [];
      if (!files.length) return { success: false, error: 'Nenhum arquivo foi informado para alteração.' };
      if (files.length > 8) return { success: false, error: 'Uma manutenção automática pode alterar no máximo 8 arquivos por PR.' };

      let normalizedFiles;
      try {
        normalizedFiles = files.map((file) => ({
          path: safePath(file?.caminho),
          content: normalizeContent(file?.conteudo)
        }));
      } catch (error) {
        return { success: false, error: String(error.message || error) };
      }

      const base = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/main`, { token });
      const baseSha = base?.object?.sha;
      if (!baseSha) throw new Error('Não consegui obter o SHA atual da main.');

      const branch = branchName();
      await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
        token,
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: baseSha }
      });

      const commits = [];
      for (const file of normalizedFiles) {
        let current = null;
        try {
          current = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(branch)}`, { token });
        } catch (error) {
          if (!/not found/i.test(String(error.message))) throw error;
        }

        const result = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}`, {
          token,
          method: 'PUT',
          body: {
            message: `fix(self-maintenance): ${String(args.titulo || 'corrigir comportamento da Lia').slice(0, 72)}`,
            content: Buffer.from(file.content, 'utf8').toString('base64'),
            branch,
            ...(current?.sha ? { sha: current.sha } : {})
          }
        });
        commits.push({ path: file.path, commit: result?.commit?.sha || null });
      }

      const pr = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
        token,
        method: 'POST',
        body: {
          title: String(args.titulo || 'Correção automática da Lia').slice(0, 120),
          head: branch,
          base: 'main',
          body: [
            '## Manutenção automática da Lia',
            '',
            String(args.descricao || 'Alteração solicitada pelo responsável.').trim(),
            '',
            '### Proteções',
            '- Branch separada da main',
            '- Sem merge automático',
            '- Sem deploy automático',
            '- CI do repositório deve validar a alteração antes de qualquer publicação'
          ].join('\n')
        }
      });

      return {
        success: true,
        acao: action,
        branch,
        pullRequest: {
          number: pr?.number,
          url: pr?.html_url,
          title: pr?.title
        },
        arquivos: commits
      };
    }

    return { success: false, error: 'Ação de manutenção de código não reconhecida.' };
  }
};
