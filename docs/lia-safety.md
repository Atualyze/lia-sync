# Lia Safety, Permissões e Recuperação

Esta documentação define explicitamente os limites operacionais do **Lia Runtime + Learning + Autonomy**.

## Matriz de Permissões (`src/autonomy/permissions.mjs`)

### Categoria A — O que a Lia pode fazer sozinha (Autonomia Interna)
- Pesquisar, analisar, classificar, observar e investigar somente-leitura (`consultar_saude_infra`, `consultar_contato_ou_lead`, `consultar_base_conhecimento`, `consultar_dados_brasil`, `consultar_web`).
- Atualizar memória operacional, criar hipóteses, avaliar estratégias, preparar conteúdo e organizar dados permitidos.

### Categoria B — O que exige autorização prévia persistente (por Organização)
- `follow_up`, `commercial_message`, `crm_update`, `create_calendar_event`, `preapproved_operation`, `support_action`.
- Mesmo com pré-autorização na política da organização (`lia_org_autonomy_policies`), continuam obrigatórios: `suppression`, `opt-out`, `business_hours`, `daily_limits` e `AutonomyBudget`.

### Categoria C — O que SEMPRE exige confirmação humana explícita
- `pix_charge`, `financial_transfer`, `irreversible_action`, `critical_deletion`, `high_impact_operation`, `permission_change`, `sensitive_data_access`.
- Ações desconhecidas falham fechado para Categoria C.

### Categoria D — O que é estritamente PROIBIDO
- `bypass_policy`, `remove_controls`, `falsify_evidence`, `hide_actions`, `self_elevate_permissions`, `modify_security_mechanisms`, `edit_production_code`.
- Qualquer proposta de melhoria de código vira `improvement_proposal` em `lia_improvement_proposals` aguardando engenharia/CI humano.

## Como ela recupera falhas (`src/autonomy/verification.mjs`)
- **Somente-leitura transitória:** retry seguro até `maxAutonomousRetries`.
- **Provedor sem créditos (`AI_PROVIDER_CREDITS_EXHAUSTED`):** pausa ações dependentes de LLM sem loop de retry e aciona fallback determinístico.
- **Efeitos externos (`outbound`, `pix`, `payment`, `irreversible`) e estados `uncertain`:** **NUNCA** recebem retry automático; escalam para `needs_human`.
- **Ambiguidade contextual (`resolveContextualConflict`):** mensagens curtas como `"sim"` diante de estado `uncertain` ou múltiplos contextos concorrentes exigem esclarecimento explícito.
