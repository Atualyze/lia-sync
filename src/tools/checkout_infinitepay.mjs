import {
  toolGerenciarCobrancaPagamento,
  InfinitePayOrderStore,
  infinitePayOrders,
  normalizeHandle,
  createInfinitePayLink,
  checkInfinitePayPayment
} from './gerenciar_cobranca_pagamento.mjs';

export { InfinitePayOrderStore, infinitePayOrders, normalizeHandle, createInfinitePayLink, checkInfinitePayPayment };

/** @deprecated Use gerenciar_cobranca_pagamento com acao: criar_checkout ou verificar_pagamento. */
export const toolCheckoutInfinitePay = {
  ...toolGerenciarCobrancaPagamento,
  name: 'checkout_infinitepay',
  async execute(args = {}, context = {}) {
    const acao = args.acao === 'verificar_pagamento' ? 'verificar_pagamento' : 'criar_checkout';
    return toolGerenciarCobrancaPagamento.execute({ ...args, acao }, context);
  }
};
