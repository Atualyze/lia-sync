const holidayCache = new Map();

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

function normalizeBrDateToIso(raw) {
  const s = String(raw || '').trim();
  if (!s) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return '';
}

export async function fetchBrazilianHolidays(year) {
  const y = Number(year) || new Date().getFullYear();
  const cached = holidayCache.get(y);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${y}`, {
    signal: AbortSignal.timeout(8_000)
  });
  if (!res.ok) throw new Error(`BrasilAPI feriados HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Resposta inválida da BrasilAPI feriados');
  holidayCache.set(y, { data, expiresAt: Date.now() + 24 * 3600 * 1000 });
  return data;
}

export async function isBrazilianNationalHoliday(dateInput) {
  const iso = normalizeBrDateToIso(dateInput);
  if (!iso) return { isHoliday: false, holiday: null };
  const year = Number(iso.slice(0, 4));
  const list = await fetchBrazilianHolidays(year);
  const match = list.find((item) => item.date === iso) || null;
  return { isHoliday: Boolean(match), holiday: match, date: iso };
}

export const toolConsultarDadosBrasil = {
  name: 'consultar_dados_brasil',
  description:
    'Consulta CEP (ViaCEP/BrasilAPI), dados cadastrais de CNPJ (BrasilAPI) e feriados nacionais brasileiros (BrasilAPI) gratuitamente.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['consultar_cep', 'consultar_cnpj', 'consultar_feriados'],
        description: 'Tipo de consulta pública brasileira.'
      },
      cep: {
        type: 'STRING',
        description: 'CEP com 8 dígitos (para consultar_cep).'
      },
      cnpj: {
        type: 'STRING',
        description: 'CNPJ com 14 dígitos (para consultar_cnpj).'
      },
      ano: {
        type: 'INTEGER',
        description: 'Ano para consultar_feriados (padrão: ano atual).'
      },
      data: {
        type: 'STRING',
        description: 'Data opcional YYYY-MM-DD ou DD/MM/AAAA para verificar se é feriado nacional.'
      }
    },
    required: ['acao']
  },

  async execute(args = {}) {
    const acao = String(args.acao || '').trim();

    if (acao === 'consultar_cep') {
      const cep = onlyDigits(args.cep);
      if (cep.length !== 8) {
        return { success: false, error: 'invalid_cep', message: 'Informe um CEP válido com 8 dígitos.' };
      }
      try {
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(7_000) });
        if (res.ok) {
          const data = await res.json();
          if (data && !data.erro) {
            return {
              success: true,
              source: 'viacep',
              cep: data.cep || cep,
              logradouro: data.logradouro || '',
              complemento: data.complemento || '',
              bairro: data.bairro || '',
              cidade: data.localidade || '',
              uf: data.uf || '',
              ibge: data.ibge || '',
              ddd: data.ddd || ''
            };
          }
        }
      } catch { /* fallback to BrasilAPI */ }

      const fallbackRes = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal: AbortSignal.timeout(7_000) });
      if (!fallbackRes.ok) {
        return { success: false, error: 'cep_not_found', message: `CEP ${cep} não encontrado.` };
      }
      const fb = await fallbackRes.json();
      return {
        success: true,
        source: 'brasilapi',
        cep: fb.cep || cep,
        logradouro: fb.street || '',
        complemento: '',
        bairro: fb.neighborhood || '',
        cidade: fb.city || '',
        uf: fb.state || '',
        ibge: '',
        ddd: ''
      };
    }

    if (acao === 'consultar_cnpj') {
      const cnpj = onlyDigits(args.cnpj);
      if (cnpj.length !== 14) {
        return { success: false, error: 'invalid_cnpj', message: 'Informe um CNPJ válido com 14 dígitos.' };
      }
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(10_000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { success: false, error: 'cnpj_not_found', status: res.status, message: data?.message || `CNPJ ${cnpj} não encontrado.` };
      }
      return {
        success: true,
        source: 'brasilapi',
        cnpj: data.cnpj || cnpj,
        razaoSocial: data.razao_social || '',
        nomeFantasia: data.nome_fantasia || '',
        situacaoCadastral: data.descricao_situacao_cadastral || '',
        cnaePrincipal: data.cnae_fiscal_descricao || '',
        porte: data.porte || '',
        logradouro: [data.descricao_tipo_de_logradouro, data.logradouro, data.numero].filter(Boolean).join(' '),
        bairro: data.bairro || '',
        cidade: data.municipio || '',
        uf: data.uf || '',
        cep: data.cep || '',
        telefone: data.ddd_telefone_1 || ''
      };
    }

    if (acao === 'consultar_feriados') {
      const iso = args.data ? normalizeBrDateToIso(args.data) : '';
      const year = Number(args.ano) || (iso ? Number(iso.slice(0, 4)) : new Date().getFullYear());
      const feriados = await fetchBrazilianHolidays(year);
      const match = iso ? feriados.find((f) => f.date === iso) || null : null;
      return {
        success: true,
        source: 'brasilapi',
        ano: year,
        ...(iso ? { dataConsultada: iso, eFeriadoNacional: Boolean(match), feriado: match } : {}),
        totalFeriados: feriados.length,
        feriados
      };
    }

    return { success: false, error: 'unknown_action', message: 'Ação inválida para consultar_dados_brasil.' };
  }
};
