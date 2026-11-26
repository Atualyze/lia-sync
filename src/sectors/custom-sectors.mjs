import fs from 'node:fs';
import path from 'node:path';

const PROJECTION_KEY = 'lia_custom_sectors';

const DEFAULT_SECTORS = [
  {
    id: 'triagem',
    name: 'Triagem & Roteamento',
    description: 'Recepção inicial para identificar a intenção e direcionar ao setor correto.',
    keywords: ['oi', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'atendimento', 'ajuda'],
    promptInstructions: 'Cumprimente de forma acolhedora, entenda rapidamente o assunto e encaminhe para o setor adequado.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'vendas',
    name: 'Comercial / Vendas',
    description: 'Orçamentos, planos, preços, propostas e contratação.',
    keywords: ['preço', 'valor', 'orçamento', 'plano', 'proposta', 'contratar', 'comprar'],
    promptInstructions: 'Seja consultiva, entenda a necessidade do cliente e conduza para agendamento ou fechamento.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'suporte',
    name: 'Suporte / Técnico',
    description: 'Dúvidas de uso, erros, problemas de acesso e tutoriais.',
    keywords: ['suporte', 'erro', 'bug', 'acesso', 'login', 'senha', 'não funciona', 'tutorial'],
    promptInstructions: 'Peça detalhes objetivos do problema e consulte a base de conhecimento antes de escalar.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'financeiro',
    name: 'Financeiro / Cobrança',
    description: 'Boletos, Pix, faturas, notas fiscais, 2ª via e reembolsos.',
    keywords: ['boleto', 'fatura', 'pix', 'nota fiscal', 'pagamento', '2a via', 'estorno', 'reembolso'],
    promptInstructions: 'Valide os dados do pagamento com clareza e transfira se envolver estorno ou contestação.',
    handoffEnabled: true,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'ouvidoria',
    name: 'Ouvidoria / Reclamações',
    description: 'Tratativa prioritária para insatisfações, defeitos e reclamações formais.',
    keywords: ['reclamação', 'reclamar', 'insatisfeito', 'péssimo', 'defeito', 'cancelar'],
    promptInstructions: 'Acolha com empatia, registre o ocorrido sem discutir e encaminhe com prioridade para um humano.',
    handoffEnabled: true,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'diretoria',
    name: 'Diretoria / Responsável',
    description: 'Casos urgentes ou pedidos diretos para falar com o responsável/dono.',
    keywords: ['responsável', 'dono', 'diretor', 'diretoria', 'urgente', 'emergência'],
    promptInstructions: 'Confirme o motivo da urgência de forma breve e transfira imediatamente para o responsável.',
    handoffEnabled: true,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'agendamento',
    name: 'Recepção & Agendamento',
    description: 'Marcação, confirmação, reagendamento e recuperação de ligações perdidas.',
    keywords: ['agendar', 'agenda', 'horário', 'marcar', 'consulta', 'reunião', 'reagendar'],
    promptInstructions: 'Consulte a disponibilidade no Google Agenda e confirme data, horário e nome completo do cliente.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'followup',
    name: 'Follow-up & Prospecção',
    description: 'Retomada de leads ociosos, cadências automáticas e reativação.',
    keywords: ['retorno', 'novidade', 'proposta', 'continuar', 'retomar'],
    promptInstructions: 'Retome a conversa de forma leve, contextualizada no último assunto e sem pressionar.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'pos_atendimento',
    name: 'Pós-atendimento & Reputação',
    description: 'Pesquisa de satisfação (1 a 5) e direcionamento ao Google Meu Negócio.',
    keywords: ['avaliação', 'nota', 'feedback', 'atendimento', 'google'],
    promptInstructions: 'Agradeça o contato, colete a nota de 1 a 5 e envie o link de avaliação apenas para notas altas.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
  {
    id: 'copiloto',
    name: 'Copiloto Interno (Gestão)',
    description: 'Canal interno do gestor para tarefas autônomas, PDFs, planilhas, Drive e Gmail.',
    keywords: ['relatório', 'pdf', 'planilha', 'tarefa', 'resumo', 'infra'],
    promptInstructions: 'Execute as solicitações internas com objetividade e retorne os resultados consolidados ao gestor.',
    handoffEnabled: false,
    responsiblePhone: '',
    isActive: true,
  },
];

export function sanitizeSectorId(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

export class CustomSectorStore {
  constructor(filePath = path.resolve('./data/custom-sectors.json'), { client = null } = {}) {
    this.filePath = filePath;
    this.client = client;
    this.sectors = new Map(DEFAULT_SECTORS.map((s) => [s.id, { ...s }]));
  }

  _applyList(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.sectors.clear();
    for (const item of list) {
      const id = sanitizeSectorId(item?.id || item?.name);
      if (!id) continue;
      this.sectors.set(id, {
        id,
        name: String(item.name || id).trim().slice(0, 120),
        description: String(item.description || '').trim().slice(0, 500),
        keywords: Array.isArray(item.keywords)
          ? item.keywords.map((k) => String(k).trim()).filter(Boolean)
          : String(item.keywords || '').split(',').map((k) => k.trim()).filter(Boolean),
        promptInstructions: String(item.promptInstructions || '').trim().slice(0, 2000),
        handoffEnabled: Boolean(item.handoffEnabled),
        responsiblePhone: String(item.responsiblePhone || '').trim().slice(0, 32),
        isActive: item.isActive !== false,
      });
    }
  }

  async load() {
    if (this.client) {
      try {
        const { data, error } = await this.client
          .from('runtime_projections')
          .select('payload')
          .eq('key', PROJECTION_KEY)
          .maybeSingle();
        if (!error && data?.payload?.sectors) {
          this._applyList(data.payload.sectors);
        }
      } catch {
        // mantém fallback padrão
      }
      return this;
    }

    if (!fs.existsSync(this.filePath)) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.sectors) ? raw.sectors : []);
      this._applyList(list);
    } catch {
      // mantém fallback padrão
    }
    return this;
  }

  async save() {
    const payload = { sectors: this.list() };
    if (this.client) {
      const { error } = await this.client
        .from('runtime_projections')
        .upsert({ key: PROJECTION_KEY, payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(`Falha ao salvar setores no banco: ${error.message}`);
      return;
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  list() {
    return Array.from(this.sectors.values());
  }

  async upsert(input = {}) {
    const id = sanitizeSectorId(input.id || input.name);
    if (!id) throw new Error('invalid_sector_id');
    const prev = this.sectors.get(id) || {};
    const keywords = Array.isArray(input.keywords)
      ? input.keywords.map((k) => String(k).trim()).filter(Boolean)
      : String(input.keywords ?? (prev.keywords || []).join(',')).split(',').map((k) => k.trim()).filter(Boolean);

    const next = {
      id,
      name: String(input.name || prev.name || id).trim().slice(0, 120),
      description: String(input.description ?? prev.description ?? '').trim().slice(0, 500),
      keywords,
      promptInstructions: String(input.promptInstructions ?? prev.promptInstructions ?? '').trim().slice(0, 2000),
      handoffEnabled: input.handoffEnabled !== undefined ? Boolean(input.handoffEnabled) : Boolean(prev.handoffEnabled),
      responsiblePhone: String(input.responsiblePhone ?? prev.responsiblePhone ?? '').trim().slice(0, 32),
      isActive: input.isActive !== undefined ? Boolean(input.isActive) : prev.isActive !== false,
    };
    this.sectors.set(id, next);
    await this.save();
    return next;
  }

  async remove(id) {
    const clean = sanitizeSectorId(id);
    if (!clean) return false;
    const deleted = this.sectors.delete(clean);
    if (deleted) await this.save();
    return deleted;
  }
}
