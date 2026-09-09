-- 62_titulo_e_fornecedor_da_despesa.sql
-- Forward-only. Fatia do Ticket 05 — detalhe da movimentação financeira.
--
-- ---------------------------------------------------------------------------
-- A LACUNA
-- ---------------------------------------------------------------------------
-- O detalhe de uma despesa precisa responder duas perguntas que o banco hoje
-- não sabe responder:
--
-- 1. **O que é esta despesa, em uma linha, separado do que ela descreve.**
--    `titulos_financeiros` tem uma única coluna de texto, `descricao`, e ela é
--    o `historico` que vai para o Bling. Mostrar a mesma frase como "Título" e
--    como "Descrição" seria fingir dois campos onde só existe um.
--
-- 2. **Para quem esta despesa foi lançada.** A coluna `fornecedor_id` existe
--    desde `08_contas_financeiras_fornecedores.sql`, mas nunca é preenchida
--    pelo lançamento de despesa: o contato escolhido no formulário vai para o
--    Bling e **não fica** no ORBITA. O espelho local `public.fornecedores`
--    também não é escrito por esse caminho — a listagem de fornecedores é lida
--    ao vivo do ERP. Resultado: o histórico de uma despesa não sabe quem foi o
--    fornecedor, nem hoje nem depois.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTA MIGRATION FAZ, E O QUE ELA NÃO FAZ
-- ---------------------------------------------------------------------------
-- Três colunas, todas `nullable`, todas aditivas. Nenhuma linha existente é
-- reescrita e nenhum histórico é reinterpretado.
--
-- **Não há backfill.** Um título importado do Bling não tem título separado da
-- descrição, e uma despesa lançada antes desta fatia não registrou fornecedor
-- nenhum. Preencher isso seria inventar dado. Os antigos ficam `null`, e a
-- tela lida com a ausência honestamente: onde não há `titulo`, ela **exibe** a
-- `descricao` no lugar — fallback de apresentação, declarado, nunca gravado.
--
-- `fornecedor_bling_id` é o identificador estrutural do contato no ERP, e é
-- ele que vale como referência. `fornecedor_nome` é um **retrato do momento do
-- lançamento**, não uma chave: contato renomeado ou removido no Bling não pode
-- apagar de quem era a despesa. Nada é procurado por esse texto.
--
-- Tenancy: as três colunas pertencem a `titulos_financeiros`, que já é
-- `organizacao_id NOT NULL` desde `45_contract_organizacao_obrigatoria_financeiro.sql`
-- e já tem RLS. Nenhuma política muda, nenhuma chave nova cruza organização.
--
-- REINTRODUZIR O DEFEITO: remova as colunas. O pgTAP
-- `titulo_e_fornecedor_da_despesa.test.sql` falha.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. O TÍTULO, separado da descrição.
-- ---------------------------------------------------------------------------
alter table public.titulos_financeiros
    add column if not exists titulo text;

comment on column public.titulos_financeiros.titulo is
    'Nome curto da movimentação, informado no lançamento de despesa. Nulo em tudo que veio do Bling e em tudo lançado antes desta coluna — a tela exibe a descricao no lugar, como fallback de apresentação; nada é gravado por esse fallback.';

-- ---------------------------------------------------------------------------
-- 2. O FORNECEDOR, que hoje só existia na chamada ao Bling.
-- ---------------------------------------------------------------------------
alter table public.titulos_financeiros
    add column if not exists fornecedor_bling_id bigint;

alter table public.titulos_financeiros
    add column if not exists fornecedor_nome text;

comment on column public.titulos_financeiros.fornecedor_bling_id is
    'Contato/fornecedor no Bling a quem a despesa foi lançada. Identificador estrutural — é por ele que o fornecedor é referenciado, nunca pelo nome.';
comment on column public.titulos_financeiros.fornecedor_nome is
    'Retrato do nome do fornecedor no momento do lançamento, para o histórico continuar legível se o contato for renomeado ou removido no ERP. Não é chave: nada é procurado por este texto.';

-- O detalhe abre por título, mas a pergunta "quais despesas foram lançadas
-- para este fornecedor" é a que varre a tabela. O índice é parcial porque a
-- coluna é nula na maioria das linhas (todo título importado do Bling).
create index if not exists idx_titulos_financeiros_fornecedor_bling
    on public.titulos_financeiros(organizacao_id, fornecedor_bling_id)
    where fornecedor_bling_id is not null;
