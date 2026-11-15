/**
 * Bateria sob demanda de avaliação de naturalidade da Lia.
 * Por padrão roda offline (custo zero) validando o Personality Engine e anti-padrões;
 * passe `--live` para testar contra o provedor de IA configurado.
 *
 * Uso:
 *   npm run eval:naturalness
 *   node scripts/eval-naturalness.mjs --live
 */
import { buildPersonalityPrompt, resolveAdaptiveTemperature, evaluateNaturalnessReply } from '../src/core/personality.mjs';
import { buildSystemPrompt } from '../src/knowledge.mjs';

const SCENARIOS = [
  { id: 'typo', userText: 'oi kero saber qto custa um sitw pra minha loja', expectMaxQuestions: 1 },
  { id: 'topic_switch', userText: 'alias, vcs aceitam cartao tbm?', expectMaxQuestions: 1 },
  { id: 'playful', userText: 'tu trabalha 24h ou tira soneca de tarde kkk', expectMaxQuestions: 1 },
  { id: 'frustrated', userText: 'ja mandei isso duas vezes e ninguem me respondeu direito', expectMaxQuestions: 1 },
  { id: 'uncertainty', userText: 'qual o codigo do meu pedido no correio?', expectMaxQuestions: 1 },
  { id: 'short_ref', userText: 'e aquele outro plano que vc falou?', expectMaxQuestions: 1 },
];

const isLive = process.argv.includes('--live');

async function main() {
  const prompt = buildSystemPrompt({
    session: { phone: '5511948273615', history: [{ role: 'user', content: 'oi' }] },
    botConfig: { ai: { agentMode: 'super_agente' } }
  });
  const personalityBlock = buildPersonalityPrompt({ botName: 'Lia' });

  console.log('=== Lia Personality Engine — Eval ===');
  console.log(`Tamanho da camada de personalidade: ${personalityBlock.length} chars (~${Math.ceil(personalityBlock.length / 4)} tokens)`);
  console.log(`Temperatura com tools: ${resolveAdaptiveTemperature({ hasTools: true })}`);
  console.log(`Temperatura conversa JSON: ${resolveAdaptiveTemperature({ isJsonResponse: true })}`);
  console.log(`Temperatura conversa livre: ${resolveAdaptiveTemperature({})}`);

  if (!prompt.includes('[PERSONALIDADE CONVERSACIONAL')) {
    console.error('FALHA: buildSystemPrompt não incluiu a camada de personalidade.');
    process.exit(1);
  }

  // Checagem determinística dos casos de referência
  const goodSample = 'Aqui aceitamos Pix e cartão sim! Qual tipo de site você está pensando em montar para a loja?';
  const badSample = 'Claro! Com certeza posso ajudar com isso!\n• Opção 1\n• Opção 2\n• Opção 3\n• Opção 4\nQual você prefere? E qual seu nome? Posso ajudar em algo mais?';

  const goodEval = evaluateNaturalnessReply(goodSample);
  const badEval = evaluateNaturalnessReply(badSample);
  if (!goodEval.ok || badEval.ok) {
    console.error('FALHA no avaliador determinístico:', { goodEval, badEval });
    process.exit(1);
  }
  console.log(`Avaliador determinístico OK (boa=${goodEval.score}, robótica=${badEval.score}, issues=${badEval.issues.join(',')})`);

  if (!isLive) {
    console.log(`Modo offline concluído (${SCENARIOS.length} cenários catalogados). Passe --live para testar com a IA real.`);
    return;
  }

  const { askAI } = await import('../src/ai/index.mjs');
  let passed = 0;
  for (const sc of SCENARIOS) {
    const res = await askAI({
      system: prompt,
      history: [],
      userText: sc.userText,
      botConfig: { ai: { agentMode: 'super_agente' } }
    });
    const ev = evaluateNaturalnessReply(res?.reply || '', { maxQuestions: sc.expectMaxQuestions });
    console.log(`[${sc.id}] ok=${ev.ok} score=${ev.score} issues=[${ev.issues.join(',')}] reply=${JSON.stringify(res?.reply || '')}`);
    if (ev.ok) passed++;
  }
  console.log(`Live eval: ${passed}/${SCENARIOS.length} aprovados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
