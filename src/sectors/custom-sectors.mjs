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
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s/&]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
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
    if (this.client?.enabled && typeof this.client.select === 'function') {
      try {
        const rows = await this.client.select(
          'runtime_projections',
          `select=payload&key=eq.${PROJECTION_KEY}&limit=1`
        );
        const remoteList = rows?.[0]?.payload?.sectors;
        if (Array.isArray(remoteList) && remoteList.length) {
          this._applyList(remoteList);
        }
      } catch (err) {
        console.warn('[custom-sectors] falha ao carregar do Supabase:', err?.message || err);
      }
      return this;
    }

    if (!fs.existsSync(this.filePath)) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.sectors) ? raw.sectors : []);
      this._applyList(list);
    } catch (err) {
      console.warn('[custom-sectors] falha ao ler arquivo local:', err?.message || err);
    }
    return this;
  }

  async save() {
    const payload = { sectors: this.list() };
    if (this.client?.enabled && typeof this.client.upsert === 'function') {
      await this.client.upsert(
        'runtime_projections',
        [{ key: PROJECTION_KEY, payload, updated_at: new Date().toISOString() }],
        'key',
        { returnRepresentation: false }
      );
      return;
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    return Array.from(this.sectors.values());
  }

  async upsert(input = {}) {
    const id = sanitizeSectorId(input.id || input.name);
    if (!id) throw new Error('invalid_sector_id');
    if (!this.sectors.has(id) && this.sectors.size >= 100) {
      throw new Error('sector_limit_reached');
    }
    const prev = this.sectors.get(id);
    const prevEntry = prev ? { ...prev } : null;
    const rawKeywords = Array.isArray(input.keywords)
      ? input.keywords
      : String(input.keywords ?? ((prev?.keywords || []).join(','))).split(',');
    const keywords = [...new Set(rawKeywords.map((k) => String(k).trim().slice(0, 60)).filter(Boolean))].slice(0, 50);
    const rawPhone = String(input.responsiblePhone ?? prev?.responsiblePhone ?? '').trim();
    const cleanPhone = rawPhone ? rawPhone.replace(/\D/g, '').slice(0, 15) : '';

    const next = {
      id,
      name: String(input.name || prev?.name || id).trim().slice(0, 120),
      description: String(input.description ?? prev?.description ?? '').trim().slice(0, 500),
      keywords,
      promptInstructions: String(input.promptInstructions ?? prev?.promptInstructions ?? '').trim().slice(0, 2000),
      handoffEnabled: input.handoffEnabled !== undefined ? Boolean(input.handoffEnabled) : Boolean(prev?.handoffEnabled),
      responsiblePhone: cleanPhone,
      isActive: input.isActive !== undefined ? Boolean(input.isActive) : prev?.isActive !== false,
    };
    this.sectors.set(id, next);
    try {
      await this.save();
    } catch (err) {
      if (prevEntry) this.sectors.set(id, prevEntry);
      else this.sectors.delete(id);
      throw err;
    }
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
