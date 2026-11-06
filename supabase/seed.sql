-- Clubinho HomeVet — carga inicial baseada no site oficial
-- Fonte: https://www.clubinhohomevet.com.br/
-- Verificado em 2026-10-16.
-- Execute depois das duas migrations operacionais.
-- A chave do provedor/modelo de IA continua sendo configurada no .env do runtime.

begin;

-- Limpa somente os dois registros artificiais criados pelo seed de testes anterior.
delete from public.plans
where slug in ('teste-preventivo', 'teste-filhote');

-- Planos publicados no site oficial: valores em centavos de BRL.
-- O site apresenta os mesmos três níveis para cães e gatos na página pública.
insert into public.plans (
  slug, name, pet_species, age_range,
  monthly_price_cents, annual_price_cents,
  active, description, metadata
)
values
(
  'plano-filhote', 'Plano Filhote', 'cao e gatos', 'até 12 meses',
  10500, 105000, true,
  'Um começo de vida seguro e protegido desde os primeiros meses, com protocolo preventivo completo.',
  '{"benefits":["protocolo vacinal completo","acompanhamento preventivo em domicílio","check-ups preventivos","consultoria preventiva","guia de cuidados personalizados","descontos exclusivos"],"payment_note":"R$ 1.050 à vista no Pix, equivalente a 10 mensalidades; assinatura mensal em até 12x.","source_url":"https://www.clubinhohomevet.com.br/","source_checked_at":"2026-10-16"}'::jsonb
),
(
  'plano-adulto', 'Plano Adulto', 'cao e gatos', '1 a 7 anos',
  7400, 74000, true,
  'Cuidado constante e preventivo para viver mais, melhor e longe de doenças silenciosas.',
  '{"benefits":["vacinação preventiva","consulta eletiva","check-up preventivo","consultoria preventiva","guia de cuidados personalizados","descontos exclusivos"],"payment_note":"R$ 740 à vista no Pix, equivalente a 10 mensalidades; assinatura mensal em até 12x.","source_url":"https://www.clubinhohomevet.com.br/","source_checked_at":"2026-10-16"}'::jsonb
),
(
  'plano-idoso', 'Plano Idoso', 'cao e gatos', 'a partir de 8 anos',
  12000, 120000, true,
  'Mais atenção, carinho e monitoramento preventivo em cada novo capítulo da vida sênior.',
  '{"benefits":["acompanhamento preventivo individualizado","check-ups adaptados à avaliação da Dra. Elisângela","consultoria preventiva","guia de cuidados personalizados","descontos exclusivos"],"payment_note":"R$ 1.200 à vista no Pix, equivalente a 10 mensalidades; assinatura mensal em até 12x.","source_url":"https://www.clubinhohomevet.com.br/","source_checked_at":"2026-10-16","benefits_note":"Itens para a melhor idade são adaptados conforme avaliação individual prévia."}'::jsonb
)
on conflict (slug) do update set
  name = excluded.name,
  pet_species = excluded.pet_species,
  age_range = excluded.age_range,
  monthly_price_cents = excluded.monthly_price_cents,
  annual_price_cents = excluded.annual_price_cents,
  active = excluded.active,
  description = excluded.description,
  metadata = excluded.metadata;

-- FAQ canônica. workspace_settings.aeo_faq abaixo é mantida para compatibilidade.
insert into public.faq (slug, question, keys, answer, active, sort_order, metadata)
values
  ('o-que-e-o-clubinho', 'O que é o Clubinho HomeVet?', array['o que e o clubinho','sobre o clubinho','como funciona'], 'O Clubinho HomeVet é um programa de acompanhamento veterinário preventivo contínuo em domicílio para cães e gatos, com visitas programadas da Dra. Elisângela em Teresina e na área urbana de Timon.', true, 10, '{"source_url":"https://www.clubinhohomevet.com.br/"}'::jsonb),
  ('atendimento-domiciliar', 'O atendimento é domiciliar?', array['domicilio','em casa','atendimento domiciliar','veterinaria em casa'], 'Sim. A Dra. Elisângela vai até a sua casa, com hora marcada, sem transporte, filas ou sala de espera.', true, 20, '{}'::jsonb),
  ('regioes-atendidas', 'Quais regiões são atendidas?', array['onde atende','regiao','teresina','timon','bairros'], 'O Clubinho atende todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA).', true, 30, '{}'::jsonb),
  ('horarios-atendimento', 'Quais são os horários?', array['horario','horarios','dias','sabado','fim de semana'], 'As visitas preventivas são realizadas de segunda a sexta, das 08h às 18h, e aos sábados, das 08h às 13h, sempre com horário agendado.', true, 40, '{}'::jsonb),
  ('primeira-visita', 'Quando posso agendar a primeira visita?', array['primeira visita','agendar','quando agendar','adesao'], 'Após a adesão, a equipe entra em contato pelo WhatsApp para conhecer o pet, conferir o histórico da carteirinha e marcar o melhor dia e horário.', true, 50, '{}'::jsonb),
  ('emergencia-24h', 'O Clubinho atende emergências 24h?', array['emergencia','urgencia','24 horas','pronto socorro'], 'Não. O Clubinho é um programa de prevenção domiciliar com horário marcado. Em uma emergência crítica, procure imediatamente um hospital veterinário ou pronto-socorro 24h.', true, 60, '{}'::jsonb),
  ('pet-doente-entre-visitas', 'E se meu pet ficar doente entre as visitas?', array['ficar doente','sintoma entre visitas','doente'], 'Você pode relatar a situação pelo WhatsApp da Dra. Elisângela. Ela orientará se é indicado atendimento domiciliar eletivo ou encaminhamento imediato, em caso de emergência crítica.', true, 70, '{}'::jsonb),
  ('formas-de-pagamento', 'Como funciona o pagamento?', array['pagamento','pagar','cartao','pix'], 'O site informa assinatura mensal no cartão em até 12x e opção de pagamento à vista via Pix com valor equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão.', true, 80, '{}'::jsonb),
  ('limite-do-cartao', 'A assinatura compromete o limite total do cartão?', array['limite do cartao','limite','cobranca mensal'], 'Não. Na assinatura mensal, somente o valor da mensalidade vigente é utilizado do limite a cada mês, e não o valor anual total.', true, 90, '{}'::jsonb),
  ('cancelamento', 'Posso cancelar quando quiser?', array['cancelar','cancelamento','fidelidade'], 'Sim. O site informa que não há fidelidade forçada e que o cancelamento pode ser solicitado pelo WhatsApp, respeitando o período mensal já faturado e as condições da adesão.', true, 100, '{}'::jsonb),
  ('multiplos-pets', 'Posso cadastrar mais de um pet?', array['mais de um pet','multiplos pets','dois pets','varios pets'], 'Sim. Cada pet deve ter seu plano individual para acompanhamento personalizado. O site informa benefício especial para famílias com múltiplos pets.', true, 110, '{}'::jsonb),
  ('vacinas-em-dia', 'Já tenho as vacinas deste ano. Posso assinar?', array['ja vacinei','vacinas deste ano','vacina em dia'], 'Sim. O Clubinho vai além da vacinação e inclui check-ups, orientações e acompanhamento preventivo contínuo.', true, 120, '{}'::jsonb),
  ('beneficios-dos-planos', 'O que o plano preventivo oferece?', array['beneficios','inclui','vacinas','check up','parasitas'], 'Os planos envolvem vacinação preventiva, consultas eletivas, check-ups, consultoria preventiva, orientação de cuidados e benefícios conforme a fase de vida e a avaliação do pet.', true, 130, '{}'::jsonb)
on conflict (slug) do update set
  question = excluded.question,
  keys = excluded.keys,
  answer = excluded.answer,
  active = excluded.active,
  sort_order = excluded.sort_order,
  metadata = excluded.metadata;

-- FAQ oficial publicada no site.
insert into public.workspace_settings (id, aeo_faq)
values (
  true,
  '[
    {"question":"O que é o Clubinho HomeVet?","keys":["o que e o clubinho","sobre o clubinho","como funciona"],"answer":"O Clubinho HomeVet é um programa de acompanhamento veterinário preventivo contínuo em domicílio para cães e gatos, com visitas programadas da Dra. Elisângela em Teresina e na área urbana de Timon."},
    {"question":"O atendimento é domiciliar?","keys":["domicilio","em casa","atendimento domiciliar","veterinaria em casa"],"answer":"Sim. A Dra. Elisângela vai até a sua casa, com hora marcada, sem transporte, filas ou sala de espera."},
    {"question":"Quais regiões são atendidas?","keys":["onde atende","regiao","teresina","timon","bairros"],"answer":"O Clubinho atende todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA)."},
    {"question":"Quais são os horários?","keys":["horario","horarios","dias","sabado","fim de semana"],"answer":"As visitas preventivas são realizadas de segunda a sexta, das 08h às 18h, e aos sábados, das 08h às 13h, sempre com horário agendado."},
    {"question":"Quando posso agendar a primeira visita?","keys":["primeira visita","agendar","quando agendar","adesao"],"answer":"Após a adesão, a equipe entra em contato pelo WhatsApp para conhecer o pet, conferir o histórico da carteirinha e marcar o melhor dia e horário."},
    {"question":"O Clubinho atende emergências 24h?","keys":["emergencia","urgencia","24 horas","pronto socorro"],"answer":"Não. O Clubinho é um programa de prevenção domiciliar com horário marcado. Em uma emergência crítica, procure imediatamente um hospital veterinário ou pronto-socorro 24h."},
    {"question":"E se meu pet ficar doente entre as visitas?","keys":["ficar doente","sintoma entre visitas","doente"],"answer":"Você pode relatar a situação pelo WhatsApp da Dra. Elisângela. Ela orientará se é indicado atendimento domiciliar eletivo ou encaminhamento imediato, em caso de emergência crítica."},
    {"question":"Como funciona o pagamento?","keys":["pagamento","pagar","cartao","pix"],"answer":"O site informa assinatura mensal no cartão em até 12x e opção de pagamento à vista via Pix com valor equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão."},
    {"question":"A assinatura compromete o limite total do cartão?","keys":["limite do cartao","limite","cobranca mensal"],"answer":"Não. Na assinatura mensal, somente o valor da mensalidade vigente é utilizado do limite a cada mês, e não o valor anual total."},
    {"question":"Posso cancelar quando quiser?","keys":["cancelar","cancelamento","fidelidade"],"answer":"Sim. O site informa que não há fidelidade forçada e que o cancelamento pode ser solicitado pelo WhatsApp, respeitando o período mensal já faturado e as condições da adesão."},
    {"question":"Posso cadastrar mais de um pet?","keys":["mais de um pet","multiplos pets","dois pets","varios pets"],"answer":"Sim. Cada pet deve ter seu plano individual para acompanhamento personalizado. O site informa benefício especial para famílias com múltiplos pets."},
    {"question":"Já tenho as vacinas deste ano. Posso assinar?","keys":["ja vacinei","vacinas deste ano","vacina em dia"],"answer":"Sim. O Clubinho vai além da vacinação e inclui check-ups, orientações e acompanhamento preventivo contínuo."},
    {"question":"O que o plano preventivo oferece?","keys":["beneficios","inclui","vacinas","check up","parasitas"],"answer":"Os planos envolvem vacinação preventiva, consultas eletivas, check-ups, consultoria preventiva, orientação de cuidados e benefícios conforme a fase de vida e a avaliação do pet."}
  ]'::jsonb
)
on conflict (id) do update set
  aeo_faq = excluded.aeo_faq;

update public.workspace_preferences
set service_regions = 'todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA)',
    working_start = '08:00',
    working_end = '18:00',
    timezone = 'America/Fortaleza'
where id = true;

-- Configuração publicada do bot, alimentada com o conteúdo institucional do site.
-- activeProvider e activeModel ficam vazios de propósito: são credenciais/modelos do ambiente,
-- não informações públicas do site e devem ser definidos no dashboard após configurar o .env.
insert into public.bot_config_state (id, revision, active_config, draft_config)
values (
  true,
  1,
  $$
  {
    "schemaVersion":1,
    "identity":{"botName":"LIA","veterinarian":"Dra. Elisângela","companyName":"Clubinho HomeVet","language":"pt-BR","tone":"Acolhedor, claro, humano e profissional. Responda em 1 a 4 frases e faça no máximo uma pergunta."},
    "business":{"areas":"todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA)","hours":"segunda a sexta, das 08h às 18h, e sábados, das 08h às 13h","timezone":"America/Fortaleza"},
    "messages":{"greeting":"Oi! Eu sou a LIA, assistente virtual da Dra. Elisângela, do Clubinho HomeVet. Como posso ajudar você e seu pet hoje?","plans":"O Clubinho HomeVet tem planos preventivos para filhotes, adultos e pets idosos, com atendimento veterinário em domicílio em Teresina e Timon. Posso te ajudar a escolher pela idade do seu pet.","services":"O Clubinho oferece acompanhamento preventivo contínuo em domicílio, vacinação, consultas eletivas, check-ups e orientações de cuidados, sempre com hora marcada.","policies":"O Clubinho é um programa de prevenção domiciliar contínua, não uma consulta avulsa nem pronto-socorro 24h. O cancelamento pode ser solicitado pelo WhatsApp, conforme as condições da adesão.","payment":"O site informa assinatura mensal no cartão em até 12x ou pagamento à vista via Pix equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão."},
    "behavior":{"allowClientResume":true,"maxClinicalTurns":3,"handoffReminderMinutes":15,"inactivityStaleHours":12,"fallbackMessage":"Estou com instabilidade para responder agora. Vou avisar a Dra. Elisângela para te atender."},
    "safety":{"emergencyMessage":"Sinto muito. Procure imediatamente um hospital veterinário ou pronto-socorro 24h. Vou avisar a Dra. Elisângela para acompanhar vocês.","blockedMessage":"Não consigo orientar sobre sintomas, medicação ou diagnóstico por aqui. Isso precisa da avaliação da Dra. Elisângela. Vou avisá-la agora.","protected":true},
    "knowledge":{"faq":[{"keys":["o que e o clubinho","sobre o clubinho","como funciona"],"answer":"O Clubinho HomeVet é um programa de acompanhamento veterinário preventivo contínuo em domicílio para cães e gatos, com visitas programadas da Dra. Elisângela em Teresina e na área urbana de Timon.","enabled":true},{"keys":["domicilio","em casa","atendimento domiciliar","veterinaria em casa"],"answer":"Sim. A Dra. Elisângela vai até a sua casa, com hora marcada, sem transporte, filas ou sala de espera.","enabled":true},{"keys":["onde atende","regiao","teresina","timon","bairros"],"answer":"O Clubinho atende todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA).","enabled":true},{"keys":["horario","horarios","dias","sabado"],"answer":"As visitas preventivas são realizadas de segunda a sexta, das 08h às 18h, e aos sábados, das 08h às 13h, sempre com horário agendado.","enabled":true},{"keys":["emergencia","urgencia","24 horas","pronto socorro"],"answer":"Não. O Clubinho é um programa de prevenção domiciliar com horário marcado. Em uma emergência crítica, procure imediatamente um hospital veterinário ou pronto-socorro 24h.","enabled":true},{"keys":["cancelar","cancelamento","fidelidade"],"answer":"Sim. O site informa que não há fidelidade forçada e que o cancelamento pode ser solicitado pelo WhatsApp, respeitando o período mensal já faturado e as condições da adesão.","enabled":true},{"keys":["pagamento","pagar","cartao","pix"],"answer":"O site informa assinatura mensal no cartão em até 12x e opção de pagamento à vista via Pix com valor equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão.","enabled":true}]},
    "ai":{"systemInstruction":"Nunca diagnostique, prescreva medicamento/dose/remédio caseiro, dê prognóstico ou invente preços/agenda.","activeProvider":"","activeModel":"","fallbackModels":[],"maxOutputTokens":1024,"structuredOutputs":false,"requireParameters":false},
    "human":{"phone":"5586999962542","enabled":true}
  }
  $$::jsonb,
  $$
  {
    "schemaVersion":1,
    "identity":{"botName":"LIA","veterinarian":"Dra. Elisângela","companyName":"Clubinho HomeVet","language":"pt-BR","tone":"Acolhedor, claro, humano e profissional. Responda em 1 a 4 frases e faça no máximo uma pergunta."},
    "business":{"areas":"todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA)","hours":"segunda a sexta, das 08h às 18h, e sábados, das 08h às 13h","timezone":"America/Fortaleza"},
    "messages":{"greeting":"Oi! Eu sou a LIA, assistente virtual da Dra. Elisângela, do Clubinho HomeVet. Como posso ajudar você e seu pet hoje?","plans":"O Clubinho HomeVet tem planos preventivos para filhotes, adultos e pets idosos, com atendimento veterinário em domicílio em Teresina e Timon. Posso te ajudar a escolher pela idade do seu pet.","services":"O Clubinho oferece acompanhamento preventivo contínuo em domicílio, vacinação, consultas eletivas, check-ups e orientações de cuidados, sempre com hora marcada.","policies":"O Clubinho é um programa de prevenção domiciliar contínua, não uma consulta avulsa nem pronto-socorro 24h. O cancelamento pode ser solicitado pelo WhatsApp, conforme as condições da adesão.","payment":"O site informa assinatura mensal no cartão em até 12x ou pagamento à vista via Pix equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão."},
    "behavior":{"allowClientResume":true,"maxClinicalTurns":3,"handoffReminderMinutes":15,"inactivityStaleHours":12,"fallbackMessage":"Estou com instabilidade para responder agora. Vou avisar a Dra. Elisângela para te atender."},
    "safety":{"emergencyMessage":"Sinto muito. Procure imediatamente um hospital veterinário ou pronto-socorro 24h. Vou avisar a Dra. Elisângela para acompanhar vocês.","blockedMessage":"Não consigo orientar sobre sintomas, medicação ou diagnóstico por aqui. Isso precisa da avaliação da Dra. Elisângela. Vou avisá-la agora.","protected":true},
    "knowledge":{"faq":[{"keys":["o que e o clubinho","sobre o clubinho","como funciona"],"answer":"O Clubinho HomeVet é um programa de acompanhamento veterinário preventivo contínuo em domicílio para cães e gatos, com visitas programadas da Dra. Elisângela em Teresina e na área urbana de Timon.","enabled":true},{"keys":["domicilio","em casa","atendimento domiciliar","veterinaria em casa"],"answer":"Sim. A Dra. Elisângela vai até a sua casa, com hora marcada, sem transporte, filas ou sala de espera.","enabled":true},{"keys":["onde atende","regiao","teresina","timon","bairros"],"answer":"O Clubinho atende todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA).","enabled":true},{"keys":["horario","horarios","dias","sabado"],"answer":"As visitas preventivas são realizadas de segunda a sexta, das 08h às 18h, e aos sábados, das 08h às 13h, sempre com horário agendado.","enabled":true},{"keys":["emergencia","urgencia","24 horas","pronto socorro"],"answer":"Não. O Clubinho é um programa de prevenção domiciliar com horário marcado. Em uma emergência crítica, procure imediatamente um hospital veterinário ou pronto-socorro 24h.","enabled":true},{"keys":["cancelar","cancelamento","fidelidade"],"answer":"Sim. O site informa que não há fidelidade forçada e que o cancelamento pode ser solicitado pelo WhatsApp, respeitando o período mensal já faturado e as condições da adesão.","enabled":true},{"keys":["pagamento","pagar","cartao","pix"],"answer":"O site informa assinatura mensal no cartão em até 12x e opção de pagamento à vista via Pix com valor equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão.","enabled":true}]},
    "ai":{"systemInstruction":"Nunca diagnostique, prescreva medicamento/dose/remédio caseiro, dê prognóstico ou invente preços/agenda.","activeProvider":"","activeModel":"","fallbackModels":[],"maxOutputTokens":1024,"structuredOutputs":false,"requireParameters":false},
    "human":{"phone":"5586999962542","enabled":true}
  }
  $$::jsonb
)
on conflict (id) do update set
  revision = excluded.revision,
  active_config = excluded.active_config,
  draft_config = excluded.draft_config,
  updated_at = now();

insert into public.bot_config_revisions (revision, action, snapshot)
select 1, 'published', active_config
from public.bot_config_state
where id = true
on conflict (revision, action) do update set snapshot = excluded.snapshot;

commit;
