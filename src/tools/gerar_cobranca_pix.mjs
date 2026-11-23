import { toolGerenciarCobrancaPagamento, buildPixPayload, normalizePixKey } from './gerenciar_cobranca_pagamento.mjs';

/** @deprecated Use gerenciar_cobranca_pagamento com acao: criar_pix. */
export { buildPixPayload, normalizePixKey };
export const toolGerarCobrancaPix = {
  ...toolGerenciarCobrancaPagamento,
  name: 'gerar_cobranca_pix',
  async execute(args = {}, context = {}) {
    return toolGerenciarCobrancaPagamento.execute({ ...args, acao: 'criar_pix' }, context);
  }
};
