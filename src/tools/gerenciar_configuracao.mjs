const BLOCKED_KEYS = /(?:apiKey|apikey|token|secret|password|senha|privateKey|serviceRole|service_role|credential)/i;
const ALLOWED_ROOTS = new Set(['ai', 'automation', 'behavior', 'business', 'voice', 'tools', 'webSearch', 'human', 'knowledge', 'sync']);

function sanitizePatch(value, path = '') {
  if (Array.isArray(value)) return value.map((item, index) => sanitizePatch(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const current = path ? `${path}.${key}` : key;
    if (BLOCKED_KEYS.test(key)) throw new Error(`Campo sensível bloqueado: ${current}`);
    if (!path && !ALLOWED_ROOTS.has(key)) throw new Error(`Seção de configuração não permitida: ${key}`);
    output[key] = sanitizePatch(child, current);
  }
  return output;
}

function publicConfig(config = {}) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  const redact = value => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = BLOCKED_KEYS.test(key) ? '[bloqueado]' : redact(child);
    }
    return result;
  };
  return redact(clone);
}

export const toolGerenciarConfiguracao = {
  name: 'gerenciar_configuracao',
  description: 'Consulta ou altera a configuração operacional publicada da Lia. Uso exclusivo do responsável. Alterações passam primeiro pelo rascunho e publicação do AdminConfigStore, com validação e persistência. Nunca aceita segredos, tokens, senhas ou credenciais.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['consultar', 'alterar_rascunho', 'publicar'],
        description: 'Consultar estado; alterar_rascunho salva mudanças sem ativá-las; publicar ativa um rascunho já validado.'
      },
      patch: {
        type: 'OBJECT',
        description: 'Alterações parciais de configuração. Use somente seções permitidas e nunca inclua segredos.'
      },
      confirmar: {
        type: 'BOOLEAN',
        description: 'Necessário para publicar uma configuração. Deve ser true quando o responsável autorizou explicitamente a publicação.'
      },
      baseRevision: {
        type: 'NUMBER',
        description: 'Revisão conhecida da configuração, quando disponível, para evitar sobrescrever alterações concorrentes.'
      }
    },
    required: ['acao']
  },

  async execute(args = {}, context = {}) {
    if (context.actor !== 'owner' && context.isOwner !== true) {
      return { success: false, error: 'Configuração disponível somente no fluxo do responsável.' };
    }

    const adminConfig = context.adminConfig;
    if (!adminConfig) return { success: false, error: 'Ponte de configuração não está disponível neste runtime.' };

    const action = String(args.acao || '').trim().toLowerCase();

    if (action === 'consultar') {
      return {
        success: true,
        acao: action,
        revision: Number(adminConfig.revision || 0),
        active: publicConfig(adminConfig.active),
        draft: publicConfig(adminConfig.draft),
        persistence: adminConfig.persistence || 'fallback'
      };
    }

    if (action === 'alterar_rascunho') {
      if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
        return { success: false, error: 'Informe um patch de configuração em formato de objeto.' };
      }
      let patch;
      try {
        patch = sanitizePatch(args.patch);
      } catch (error) {
        return { success: false, error: error.message, code: 'config_field_blocked' };
      }
      const result = await adminConfig.updateDraft(
        patch,
        'lia-self-maintenance',
        args.baseRevision === undefined ? undefined : Number(args.baseRevision)
      );
      return {
        success: Boolean(result?.ok),
        acao: action,
        revision: result?.snapshot?.revision ?? adminConfig.revision,
        errors: result?.errors || [],
        draft: result?.snapshot?.draft ? publicConfig(result.snapshot.draft) : undefined
      };
    }

    if (action === 'publicar') {
      if (args.confirmar !== true) {
        return {
          success: false,
          code: 'confirmation_required',
          error: 'A publicação da configuração exige autorização explícita do responsável.'
        };
      }
      const result = await adminConfig.publish(
        'lia-self-maintenance',
        args.baseRevision === undefined ? undefined : Number(args.baseRevision)
      );
      return {
        success: Boolean(result?.ok),
        acao: action,
        revision: result?.snapshot?.revision ?? adminConfig.revision,
        errors: result?.errors || [],
        active: result?.snapshot?.active ? publicConfig(result.snapshot.active) : undefined
      };
    }

    return { success: false, error: 'Ação de configuração não reconhecida.' };
  }
};
