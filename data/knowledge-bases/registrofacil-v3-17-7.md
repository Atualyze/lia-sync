# BASE DE CONHECIMENTO E SUPORTE — REGISTRO FÁCIL v3.17.7

> **Finalidade:** Orientar usuários e administradores sobre as funções documentadas do Registro Fácil, do primeiro acesso ao suporte operacional.
> **Diretriz para a IA de Suporte (Lia):** Responda de modo enxuto, direto e prático. Diga o que a função faz, onde fica na tela/menu e como usá-la, apenas quando isso estiver documentado nesta base. Diferencie ações de usuário comum e administrador. Não invente menus, resultados, regras, prazos ou funções. Não revele credenciais padrão, tokens, segredos, CNPJ, telefone ou dados reais. Não exponha caminhos internos de código nem peça banco, logs, uploads ou arquivos de segurança. Em exclusão, restauração ou reparo, explique o risco e encaminhe ao administrador, sem instruções destrutivas. Dúvidas jurídicas devem ser encaminhadas a um profissional responsável.
> **Versão do Sistema:** 3.17.7 (4 de novembro de 2026)

---

## 1. VISÃO GERAL

### 1.1. O que é o Registro Fácil?
É um sistema local para organizar processos, titulares e documentos, usado em uma máquina Windows ou em arquitetura cliente-servidor numa rede local.

### 1.2. O sistema funciona sem internet?
As funções essenciais foram projetadas para operar offline e os recursos necessários à interface são locais. Em uma instalação cliente-servidor, cada estação precisa conseguir se comunicar com o computador servidor pela rede local. A falta de internet, por si só, não deve ser apresentada como causa de toda falha.

### 1.3. Onde os dados ficam?
Na instalação feita pelo instalador Windows, os dados persistentes ficam em ProgramData, separados dos arquivos do aplicativo. No modo executado como script, ficam na raiz do projeto. Não oriente usuários a mover ou abrir esses dados; dúvidas de localização devem ir para o administrador.

### 1.4. Componentes técnicos
A versão 3.17.7 usa Python 3.12, Flask 3, Waitress e SQLite em modo WAL. O navegador acessa o servidor pela porta 5000. Esses detalhes ajudam o administrador a identificar o sistema; usuários finais não precisam instalar ou configurar os componentes.

---

## 2. REQUISITOS, INSTALAÇÃO E PRIMEIRO ACESSO

### 2.1. Requisitos do computador servidor
A documentação indica como mínimos: Windows 10, processador de 2 núcleos, 2 GB de RAM, 10 GB livres e rede local Wi-Fi. Recomenda Windows 10/11 de 64 bits, 4 ou mais núcleos, 4 GB ou mais de RAM, 20 GB ou mais de espaço e conexão Ethernet para maior estabilidade. Os requisitos são do servidor; uma estação cliente precisa de navegador moderno e acesso à rede local.

### 2.2. Como instalar?
A instalação é uma tarefa do administrador. O administrador executa o instalador oficial do Registro Fácil com os privilégios necessários e segue o assistente. Depois, inicia o sistema pelo atalho. A janela do servidor precisa permanecer aberta enquanto o sistema estiver em uso. Não peça ao usuário comum para instalar dependências ou alterar o computador servidor.

### 2.3. Como entrar pela primeira vez?
Use a conta e as credenciais fornecidas pelo administrador. No primeiro login, o sistema exige a troca da senha inicial antes de continuar. Não informe nem tente adivinhar senhas padrão. Se ninguém forneceu credenciais, a senha foi esquecida ou o e-mail de recuperação não chegou, acione o administrador.

### 2.4. Como recuperar uma senha?
A recuperação por e-mail depende de o administrador ter configurado e habilitado o envio SMTP. Se a mensagem não chegar, não peça a senha atual nem dados secretos pelo chat; encaminhe ao administrador para conferir a configuração e orientar o reset.

### 2.5. Por que minha sessão expirou?
Por padrão, a sessão termina após 30 minutos sem atividade. Entre novamente com sua conta. Um administrador pode habilitar **Sessão Permanente (Sem expiração de 30 min)** para uma conta específica em **Painel Admin > Usuários**. A mudança vale a partir do próximo login e mantém a sessão ativa enquanto a janela do navegador permanecer aberta. Não altere a sessão de outra pessoa sem autorização.

### 2.6. O que a atualização 3.17.7 preserva?
O instalador atualiza os arquivos do aplicativo sem substituir o banco de dados existente e preserva os uploads. Na inicialização, a migração automática adiciona à tabela de usuários a coluna de dados sessao_permanente, usada pela opção de sessão permanente. Se a atualização falhar ou dados parecerem ausentes, acione o administrador; não tente reparar ou substituir arquivos.

---

## 3. ACESSO E CONECTIVIDADE

### 3.1. Qual endereço abrir?
No próprio computador servidor, o endereço local documentado é http://localhost:5000. Em outra estação, use o endereço IP do servidor seguido de :5000, conforme informado pelo administrador. O navegador pode abrir automaticamente ao iniciar o sistema.

### 3.2. A página não abre. O que verificar primeiro?
1. Confirme com o administrador se o sistema foi iniciado no computador servidor e se a janela do servidor continua aberta.
2. Se estiver no servidor, tente o endereço local documentado.
3. Se estiver em outra estação, confirme que está na rede local correta e usando o endereço do servidor fornecido pelo administrador.
4. Se o acesso local funciona, mas as estações não conectam, encaminhe ao administrador para verificar rede e liberação da porta TCP 5000 no firewall do servidor.

A Lia não deve orientar o usuário final a criar regras de firewall, mudar endereços de rede, desligar proteções ou reinstalar o sistema. Se a falha persistir, encaminhe ao administrador.

---

## 4. MÓDULO DASHBOARD

O Dashboard é a tela inicial após o login.

### 4.1. O que mostram os cards?
- **Processos Concluídos:** total de processos com status de conclusão.
- **Processos Hoje:** processos com prazo final no dia atual.
- **Processos Pendentes:** total ainda não concluído.
- **Meus Processos:** processos atribuídos ao usuário logado.

Os cards funcionam como atalhos visuais. O Dashboard também mostra processos recentes ainda abertos e prazos próximos ou vencidos, com destaque por cor. Os gráficos distribuem processos por status, tipo de serviço e período.

Se um card, processo ou gráfico não estiver disponível para uma conta, o administrador deve verificar as permissões e os dados configurados. Não deduza que um número ou alerta altera o prazo oficial de um processo.

---

## 5. MÓDULO PROCESSOS

O módulo acompanha o processo desde o cadastro até a conclusão. As opções exibidas dependem das permissões da conta.

### 5.1. Como localizar processos?
No menu **Processos**, use uma visualização pré-configurada:
- **Todos os Processos:** lista geral com filtros.
- **Processos do Dia:** processos com prazo final hoje.
- **Pendentes:** processos ainda não concluídos.
- **Meus Processos:** processos em que o usuário logado é responsável.
- **Em Andamento:** processos em status ativo de andamento.

Nas listagens, os filtros avançados documentados incluem titular, status, tipo de serviço, período e responsável. Use a busca rápida quando disponível.

### 5.2. Como criar um processo?
1. Abra **Processos > Novo Processo** ou use **Alt+N**.
2. Preencha os campos obrigatórios indicados na tela: titular, tipo de serviço, status e prazo final.
3. Selecione o tipo de serviço. Quando houver prazo padrão configurado, o prazo final é calculado a partir da data de entrada.
4. Se o processo tiver matrícula ou número da ordem, marque **Possui matrícula?** para exibir o campo.
5. Se necessário, preencha os campos opcionais: apresentante, telefone e e-mail do apresentante, responsável, indicador de envolvimento em notas e observações.
6. Inclua anexos PDF, se necessário, e clique em **Salvar**.

O número do processo é gerado pelo sistema. Se o nome informado ainda não existir, o registro do titular é criado automaticamente. No campo de titular, o caractere % pode ser usado para listar os titulares cadastrados.

### 5.3. Campos, status, matrícula e prazos
Titular, tipo de serviço, status e prazo final são obrigatórios. Os status e os tipos de serviço são configuráveis pelo administrador. Os tipos podem ter prazo padrão em dias, usado para calcular o prazo final do processo a partir da entrada.

Matrícula/número da ordem é opcional e aparece quando **Possui matrícula?** está marcado. É um campo livre de até 50 caracteres. Desde a versão 3.17.6, pode ficar ausente ou repetir valores. Não trate matrícula ou prazo configurável como validação de registro público nem como prazo legal.

### 5.4. Como editar um processo?
Ao abrir um processo para edição, o sistema bloqueia temporariamente o registro para evitar duas edições simultâneas. Se outra pessoa já estiver editando, os demais usuários recebem um aviso indicando quem está com o bloqueio e podem apenas visualizar. O bloqueio expira após inatividade e é liberado ao sair da tela de edição.

Se a tela informar que outra pessoa está editando, aguarde ou fale com essa pessoa antes de tentar novamente. Não tente contornar o bloqueio. Se parecer preso por muito tempo, peça ao administrador para avaliar.

### 5.5. Como visualizar o histórico?
Na tela **Visualizar Processo**, a linha do tempo registra criação, alterações de campos, anexos adicionados ou removidos, usuário responsável e data/hora. Quando o acesso estiver autorizado, o histórico também pode ser impresso.

### 5.6. Como anexar ou baixar documentos?
Na criação ou edição do processo, arraste o arquivo para a área de anexos ou clique nela para selecionar. São aceitos somente PDFs válidos, até 200 MB por arquivo. A tela de visualização lista os anexos e oferece download, desde que a conta tenha autenticação e permissão de acesso ao processo.

Um arquivo com extensão PDF pode ser recusado se o conteúdo real não for um PDF válido. Não renomeie arquivos para tentar contornar a validação. Se um PDF válido dentro do limite falhar, acione o administrador.

### 5.7. Como exportar, imprimir ou gerar relatório?
A partir das listagens, usuários com permissão podem exportar os processos filtrados para Excel (.xlsx), preservando as cores de status; imprimir a lista; ou gerar PDF da lista. Na visualização individual também é possível gerar relatórios do processo em formatos oferecidos pelo sistema e imprimir o histórico de alterações.

Se uma opção não aparecer, peça ao administrador para conferir as permissões. Arquivos exportados podem conter dados operacionais; guarde-os somente em local autorizado.

---

## 6. MÓDULO TITULARES

O módulo **Titulares** mantém o cadastro das pessoas físicas ou jurídicas vinculadas a processos.

### 6.1. Quais dados são usados?
O nome é obrigatório. Telefone e e-mail são opcionais e devem ser únicos entre titulares diferentes. Não envie dados reais de titulares à Lia para procurar ou atualizar um cadastro.

### 6.2. Como um titular é criado?
O administrador ou usuário com permissão pode cadastrar o titular no módulo. Também há criação automática: ao salvar um processo com um nome ainda não cadastrado, o sistema cria o titular correspondente.

### 6.3. O que é possível fazer?
Conforme as permissões, é possível visualizar o cadastro e os processos vinculados, editar nome/telefone/e-mail, exportar a lista para Excel e imprimir. A exclusão só é permitida quando não há processos vinculados. Como a exclusão pode remover um cadastro, solicitações de exclusão devem ser encaminhadas ao administrador; não oriente a execução passo a passo.

Se telefone ou e-mail já estiver associado a outro titular, peça ao administrador para revisar o cadastro. Não sugira usar dados falsos para contornar a validação.

---

## 7. MÉTRICAS E RELATÓRIOS

O painel **Métricas e Relatórios** apresenta indicadores como:
- volume de processos por período diário, semanal ou mensal;
- distribuição por status e tipo de serviço;
- taxa de conclusão dentro do prazo configurado;
- desempenho por usuário responsável;
- processos em atraso.

O acesso depende das permissões de métricas e relatórios. Os indicadores ajudam a acompanhar a operação; não substituem a análise do processo nem determinam prazos legais. Se um indicador parecer incorreto, encaminhe a dúvida ao administrador com o período e o tipo de informação afetada, sem enviar dados pessoais no chat.

---

## 8. USUÁRIOS, PERFIS E PERMISSÕES

### 8.1. Quais são os perfis?
- **admin:** acesso total às funcionalidades.
- **suporte:** acesso equivalente ao admin para manutenção.
- **user:** acesso limitado às permissões concedidas explicitamente.

As permissões granulares cobrem processos, titulares, atividades, métricas/relatórios, configurações, backup, dados da empresa e administração de usuários. Perfis reutilizáveis agrupam permissões para aplicação a várias contas.

### 8.2. O que pode fazer um administrador?
Em **Menu > Usuários**, administrador autorizado pode:
1. Criar uma conta informando nome, usuário, e-mail e role; pode exigir que a senha seja trocada no próximo login.
2. Editar dados cadastrais, ativar ou desativar o acesso, ou gerar uma senha temporária para redefinição.
3. Conceder ou revogar permissões individuais e atribuir um perfil de permissões reutilizável.

Alterações administrativas de usuários ficam registradas na auditoria. A documentação chama a exclusão de usuário de remoção definitiva (soft-delete); por afetar uma conta, não oriente essa ação passo a passo e encaminhe a solicitação a outro administrador/responsável.

Usuários comuns não podem conceder permissões nem administrar outras contas. Se uma opção não aparecer ou o acesso for negado, peça ao administrador para confirmar o perfil e as permissões necessárias. Não peça senha ou token da outra pessoa.

### 8.3. Como aplicar um perfil de permissões?
Um administrador com permissão de perfis pode abrir **Menu > Perfis de Permissão**, criar um conjunto reutilizável de permissões e aplicá-lo a várias contas. As permissões cobrem processos, titulares, atividades, métricas/relatórios, configurações, empresa, backup e administração de usuários. Se o menu ou uma ação não estiver disponível, peça ao administrador para verificar a permissão associada.

---

## 9. CONFIGURAÇÕES DO ADMINISTRADOR

As configurações são restritas a administradores com permissão. **Alt+S** abre Configurações.

### 9.1. Status de processo
Na aba **Status**, o administrador cria ou gerencia estágios do fluxo, define o nome e a cor e pode ativar ou desativar cada status. Desativar um status permite deixar de usá-lo sem excluir o cadastro.

### 9.2. Tipos de serviço e prazos padrão
Na aba **Tipos de Serviço**, o administrador define categorias de processo e, quando aplicável, um prazo padrão em dias. Ao selecionar o tipo num processo novo, esse prazo preenche a data final a partir da data de entrada. É apenas uma configuração operacional: não significa prazo previsto em lei, não calcula direito e não deve ser apresentado como orientação jurídica.

### 9.3. Dados do estabelecimento
Na configuração de **Estabelecimento/Empresa**, o administrador gerencia nome institucional, CNPJ, endereço, telefone e logotipo exibidos em relatórios e PDFs. A Lia não deve solicitar nem registrar esses dados reais em conversa.

### 9.4. E-mail SMTP
Na aba **E-mail**, o administrador configura servidor e porta, usuário/remetente, credencial SMTP e TLS/SSL; depois usa **Testar Envio** para verificar o envio antes de salvar. Essa configuração habilita a recuperação de senha por e-mail. Não solicite nem repita a credencial; falhas de envio devem ser encaminhadas ao administrador.

### 9.5. Backup
Na aba **Backup**, o administrador configura agendamento, frequência, horário, destino local e, se habilitado, destino remoto SFTP. Veja a seção **11. Backups e manutenção**. Não compartilhe credenciais de SFTP em conversas.

---

## 10. ATIVIDADES, AUDITORIA E NOTIFICAÇÕES

### 10.1. Atividades gerais
O menu **Atividades** (atalho **Alt+A**) exibe histórico paginado, com filtros por usuário, tipo de ação e data. Registra logins/logouts, operações com usuários, geração de backups e exportações, além de acessos a seções principais. Usuários com permissão podem exportar a listagem para Excel.

### 10.2. Auditoria de processo e de administração
O histórico do processo é uma linha do tempo permanente com criação, campos alterados, valores anterior/novo, anexos, usuário e data/hora. A auditoria administrativa registra ações sobre usuários, quem as realizou, conta afetada, mudanças e justificativa quando exigida. São registros internos; não peça ao usuário que copie logs ou informações de outras pessoas para o chat.

### 10.3. Logs e retenção
Logs técnicos são separados por domínio de autenticação, operação, sistema e manutenção. Uma rotina diária remove logs com mais de 90 dias. Isso não é o mesmo que o histórico de alterações do processo, que é mantido permanentemente. Se houver falha ou suspeita de segurança, informe o administrador rapidamente; não oriente o usuário final a abrir ou enviar arquivos de log.

### 10.4. Notificações
O sino na barra superior mostra notificações em tempo real. Cada item pode ter tipo, título, mensagem, prioridade normal/alta e link para um processo. É possível marcar uma notificação como lida ou marcar todas como lidas.

No perfil, cada usuário pode habilitar ou desabilitar alertas dentro do sistema e notificações por e-mail. O envio por e-mail depende de SMTP configurado pelo administrador.

---

## 11. BACKUPS E MANUTENÇÃO

### 11.1. Backup manual
Abra o módulo **Backup** com **Alt+B**. Administradores com permissão de criar backup podem gerar uma cópia completa, que contém o banco de dados e os anexos de processo. A tela lista as cópias e oferece download. O arquivo é sensível e deve ser guardado em local autorizado.

A tela também permite excluir cópias. Excluir pode eliminar uma opção de recuperação; não instrua usuário final a apagar backups. Encaminhe a decisão ao administrador responsável.

### 11.2. Backup automático
O administrador configura o agendamento em **Configurações > Backup**. As opções documentadas são frequência diária, semanal ou mensal; horário configurável, com padrão 02:00; destino local; e envio SFTP opcional. O fuso usado pelo agendador é America/Fortaleza. A cópia remota só existe se SFTP estiver configurado. Não prometa que um backup foi concluído sem confirmação do administrador.

### 11.3. Restauração, integridade e reparo
A restauração substitui os dados atuais pelos dados da cópia e pode fazer perder alterações posteriores ao backup. Testes de integridade, otimização e reparo do banco também são ferramentas administrativas. Se for preciso restaurar, reparar ou investigar falha de banco, pare e acione o administrador/responsável; não forneça comandos, caminhos ou passos de substituição de arquivos.

---

## 12. SEGURANÇA E LIMITES DE ACESSO

O sistema documenta senhas armazenadas com bcrypt, bloqueio temporário de IP após cinco tentativas consecutivas de login incorretas, recuperação por token temporário, cookies HttpOnly e SameSite=Lax, validação CSRF em formulários e validação/sanitização de entradas. As permissões limitam ações por conta. Downloads de anexos de processo exigem autenticação e permissão.

Se houver suspeita de acesso indevido, bloqueio inesperado, arquivo suspeito ou exposição de dados, encaminhe ao administrador imediatamente. Não solicite senhas, tokens, chaves, cópias do banco, arquivos de segurança, logs, backups ou uploads no chat. Não recomende desativar proteções para resolver um problema.

---

## 13. ATALHOS DE TECLADO

Use **Alt** junto da tecla indicada; em alguns sistemas pode ser necessário **Alt+Shift**.

**Processos**
- **Alt+Q:** busca rápida.
- **Alt+N:** novo processo.
- **Alt+T:** todos os processos.
- **Alt+H:** processos do dia.
- **Alt+E:** pendentes.
- **Alt+F:** meus processos.

**Sistema**
- **Alt+S:** configurações.
- **Alt+U:** usuários.
- **Alt+A:** atividades.
- **Alt+B:** backup.
- **Alt+J:** abrir o modal de atalhos.
- **Alt+X:** sair da sessão (logout).

Um atalho pode depender da página ativa ou das permissões da conta. Se não funcionar, use o menu correspondente ou peça ajuda ao administrador.

---

## 14. LIMITES DE SUPORTE E PERGUNTAS FREQUENTES

### 14.1. O prazo padrão do tipo de serviço é um prazo legal?
Não. É um preenchimento operacional configurado no sistema. Prazos legais, validade de documentos e interpretação de regras devem ser confirmados com profissional responsável. A Lia não dá orientação jurídica.

### 14.2. O banco apresentou falha; posso tentar recuperar?
Não faça reparos ou restaurações por conta própria. A intervenção pode substituir ou danificar dados. Encaminhe ao administrador/responsável.

### 14.3. Há problema de instalação, conexão ou acesso?
Informe ao administrador o computador em que ocorre, se o problema acontece no servidor ou em uma estação, e a mensagem mostrada. Não altere firewall, rede ou instalação por conta própria.

### 14.4. O que a Lia não pode confirmar?
A Lia não pode confirmar que backup foi executado, que uma migração concluiu, que um registro foi juridicamente aceito, nem um prazo legal. Ela também não inventa opções de tela, canais de suporte ou prazos de atendimento. Para fatos não documentados, peça validação ao administrador/responsável.

### 14.5. Exclusões ou restaurações
Exclusão de titular, exclusão de backup e restauração podem afetar dados ou cópias de segurança. Explique o impacto de forma breve e encaminhe a solicitação ao administrador; não forneça o passo a passo da ação.
