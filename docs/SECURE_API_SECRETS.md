# Armazenamento seguro de credenciais

As credenciais marcadas como secret no catálogo de configurações e as chaves de provedores personalizados são criptografadas no backend com AES-256-GCM antes de serem gravadas em runtime_projections ou no arquivo local de fallback. O painel recebe somente valores mascarados; o valor em claro permanece apenas em memória durante a execução.

## Chave mestra

Defina API_SECRETS_ENCRYPTION_KEY na VPS com uma chave aleatória de 32 bytes em Base64. Gere-a com:

openssl rand -base64 32

Guarde o valor em um gerenciador de segredos e mantenha uma cópia de recuperação offline. A chave mestra não deve ser cadastrada no Supabase, no painel, no Git ou em logs. Perder ou substituir essa chave sem recriptografar os dados torna os segredos armazenados ilegíveis.

## Migração automática

No primeiro startup com a chave mestra configurada, a aplicação:
- importa para a projeção de API settings as credenciais legadas de variáveis de ambiente que já possuem campo secreto no painel;
- recriptografa os segredos previamente persistidos em texto claro;
- recriptografa as chaves de provedores personalizados;
- conserva a precedência das credenciais já cadastradas no painel;
- registra apenas o resultado da migração, nunca os valores.

A migração para Supabase depende de SUPABASE_URL e SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) funcionando. Se o Supabase estiver indisponível, o fallback local também é gravado criptografado e com permissão restrita.

## Segredos que permanecem na VPS

Mantenha no .env as credenciais estruturais necessárias para iniciar e proteger a própria aplicação, incluindo SUPABASE_*, WEBHOOK_TOKEN, LIA_API_KEY/LIA_API_KEYS e API_SECRETS_ENCRYPTION_KEY. A autenticação Baileys continua no volume persistente de dados.

Depois de confirmar que as credenciais aparecem como origem panel no painel e que os provedores continuam funcionando, remova do .env as variáveis legadas correspondentes aos campos secretos migrados. Não remova a chave mestra.

## Escritas e rotação

Novas credenciais não são gravadas em texto claro. Sem uma chave mestra válida, alterações em campos secretos são recusadas. Para rotacionar a chave mestra, implemente uma migração de recriptografia com a chave antiga e a nova; não basta substituir o valor no .env.
