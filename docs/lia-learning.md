# Lia Learning Engine (`src/learning/`)

O **Learning Engine** permite que a Lia melhore progressivamente estratégias, priorização, timing e seleção de ferramentas a partir de experiências reais — nunca alterando código de produção ou políticas de segurança.

## Como ela aprende
1. **Experience Store (`experience.mjs`)**: registra experiências relevantes com deduplicação idempotente, sanitização de segredos e TTL (90 dias padrão).
2. **Feedback Engine (`experience.mjs`)**: agrega sinais objetivos e humanos (correção humana explícita tem peso `3.0`, acima de inferências implícitas `0.6`).
3. **Reflection Engine (`reflection.mjs`)**: aciona reflexão apenas em eventos significativos, com cooldown, cota por janela e fallback determinístico completo se o provedor de IA retornar `AI_PROVIDER_CREDITS_EXHAUSTED`.
4. **Knowledge & Confidence (`knowledge.mjs`)**: todo aprendizado novo inicia como `candidate` (nunca vira regra consolidada imediatamente) e evolui por evidências (`candidate` → `experimental` → `supported` → `consolidated`), isolado por escopo (`individual`, `relationship`, `business`, `segment`, `global`).
5. **Hypotheses, Strategies & Experiments (`experiments.mjs`)**: estratégias declarativas versionadas e experimentos controlados com avaliação objetiva (`evaluateExperiment`) e auto-rollback em alta taxa de reclamação/falha.

## Como ela desaprende e resolve conflitos
- Evidências negativas reduzem a confiança e movem o conhecimento para `deprecated` ou `contradicted`, **sempre preservando o histórico** em `history`.
- Conflitos (`resolveConflict`) são decididos por confiança, volume de evidências, especificidade de escopo e recência — nunca por "última memória vence".
- Preferências `individual`/`relationship` são bloqueadas de promoção para `global`.
- Erros corrigidos podem ser registrados em `RegressionKnowledgeStore` e exportados como especificações de teste.
