-- Lia Sync - seed base
--
-- A Lia Sync atende vários clientes. Cada cliente tem a sua própria
-- base de conhecimento em data/knowledge-bases/<cliente>.md e, quando
-- necessário, os seus próprios planos na tabela public.plans.
--
-- Este arquivo não traz dados de nenhum cliente. Para carregar dados de
-- um cliente específico, crie um seed separado (ex.: supabase/seeds/<cliente>.sql)
-- ou cadastre pelo dashboard, em Administração > Base de conhecimento.
--
-- Execute depois das migrations operacionais.
-- A chave do provedor/modelo de IA continua sendo configurada no .env do runtime.

begin;

-- Limpa somente os registros artificiais criados por seeds de teste anteriores.
delete from public.plans
where slug in ('teste-preventivo', 'teste-filhote');

-- Nenhum plano é inserido aqui de propósito: preços e planos são dados do
-- cliente e devem vir do cadastro dele, não do código do produto.

commit;
