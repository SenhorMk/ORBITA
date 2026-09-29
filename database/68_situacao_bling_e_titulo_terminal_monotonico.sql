-- 68_situacao_bling_e_titulo_terminal_monotonico.sql
-- Forward-only. Correção da semântica financeira da sincronização com o Bling.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO
-- ---------------------------------------------------------------------------
-- 1. A sincronização mapeava o código 3 do Bling para `cancelado`. No contrato
--    oficial (`ContasDadosBaseDTO.situacao`) os códigos são 1 Aberto, 2 Pago,
--    3 Parcial, 4 Devolvido, 5 Cancelado, 6 Devolvido parcial, 7 Confirmado.
--    Uma conta PARCIALMENTE paga virava terminal e sumia dos totais; e o
--    cancelamento de verdade (5) virava `aberto`.
--
-- 2. O upsert da sincronização sobrescrevia `situacao` incondicionalmente. Um
--    título `cancelado`/`estornado` no ORBITA — por exemplo, a receita de um
--    pedido cancelado (migration 61), que no Bling continua aberta — voltava a
--    `aberto` na próxima sincronização e passava a somar de novo. Isso viola a
--    decisão da migration 61: registro terminal fica no histórico e não é
--    reescrito como se a operação nunca tivesse acontecido.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTA MIGRATION FAZ
-- ---------------------------------------------------------------------------
-- 1. `situacao_bling smallint null`, com CHECK de 1 a 7. O modelo local tem
--    quatro estados e o Bling sete: a projeção local (3, 4, 6 e 7 viram
--    `aberto` — ver `src/lib/integrations/bling/situacaoDaContaBling.ts`) perde
--    informação, e esta coluna guarda o código original para que nada se
--    perca. Nula em título interno e em título ainda não ressincronizado.
--
-- 2. O gatilho `tg_titulo_terminal_nao_regride`: numa atualização, um título
--    `cancelado` ou `estornado` mantém a situação que tinha. As demais colunas
--    (valor, datas, `situacao_bling`) continuam atualizáveis — o código bruto
--    do Bling é justamente o registro honesto de que o ERP diz outra coisa.
--
--    A regra MANTÉM em vez de recusar, e isso é deliberado: recusar faria cada
--    sincronização falhar em todo título terminal que o Bling ainda lista como
--    aberto (o caso normal da receita de pedido cancelado), e a sincronização
--    inteira passaria a reportar falha para sempre. Reabrir um título terminal,
--    se um dia for necessário, é uma reconciliação administrativa com caminho
--    explícito próprio — que hoje não existe.
--
-- O QUE ELA NÃO FAZ: não reinterpreta títulos existentes. Um título que a
-- regra antiga tenha levado a `cancelado` a partir do código 3 ficaria
-- congelado; medido no Orbita_Staging em 2026-09-29 (só leitura), nenhum título
-- sincronizado sem pedido está `cancelado` — não há legado a corrigir.
--
-- REINTRODUZIR O DEFEITO: remova o gatilho `tg_titulo_terminal_nao_regride`.
-- O pgTAP `titulo_terminal_monotonico.test.sql` falha nas asserções de
-- regressão (um `cancelado` volta a `aberto`).
-- ---------------------------------------------------------------------------

alter table public.titulos_financeiros
    add column if not exists situacao_bling smallint;

alter table public.titulos_financeiros
    drop constraint if exists chk_titulo_situacao_bling;
alter table public.titulos_financeiros
    add constraint chk_titulo_situacao_bling
    check (situacao_bling is null or situacao_bling between 1 and 7);

comment on column public.titulos_financeiros.situacao_bling is
    'Código bruto da situação no Bling: 1 Aberto, 2 Pago, 3 Parcial, 4 Devolvido, 5 Cancelado, 6 Devolvido parcial, 7 Confirmado. Nulo em título interno.';

create or replace function public.fn_titulo_terminal_nao_regride()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if old.situacao in ('cancelado', 'estornado') and new.situacao is distinct from old.situacao then
        new.situacao := old.situacao;
    end if;
    return new;
end;
$$;

revoke all on function public.fn_titulo_terminal_nao_regride() from public, anon, authenticated;

drop trigger if exists tg_titulo_terminal_nao_regride on public.titulos_financeiros;
create trigger tg_titulo_terminal_nao_regride
    before update on public.titulos_financeiros
    for each row execute function public.fn_titulo_terminal_nao_regride();
