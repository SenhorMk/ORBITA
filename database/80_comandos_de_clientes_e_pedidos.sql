-- 80_comandos_de_clientes_e_pedidos.sql
-- Forward-only. PRE-006C: comandos de clientes e pedidos.
--
-- Nenhuma tabela, coluna, policy ou grant de tabela muda. São duas funções
-- estreitas, executáveis só por `service_role`, e os eventos de auditoria do
-- catálogo. O ator e a organização chegam do escopo verificado no servidor; a
-- função ainda confere a membership, como `registrar_evento_auditoria`.
--
-- 1. `registrar_cliente_do_sac`
--    O auto-registro de cliente da sincronização do SAC lia os telefones e
--    depois inseria: duas sincronizações simultâneas (dois atendentes) criavam
--    o mesmo cliente duas vezes. Uma trava consultiva por (organização,
--    telefone) serializa a decisão, e a função só insere — nunca sobrescreve
--    um cliente existente.
--
-- 2. `alinhar_estoque_ao_saldo_do_bling`
--    Depois de mudar a situação do pedido, o servidor lia o estoque local e o
--    sobrescrevia com o saldo do Bling, sem condição e sem lançamento no livro:
--    uma baixa da venda manual entre a leitura e a escrita era desfeita, e o
--    livro deixava de explicar o saldo. Agora a escrita é condicional ao valor
--    lido (compare-and-set sob a trava da linha) e grava, na mesma transação,
--    o lançamento do delta efetivamente aplicado. Repetir com o mesmo valor
--    lido não lança nada de novo.

-- ---------------------------------------------------------------------------
-- 1. Auto-registro de cliente pelo SAC
-- ---------------------------------------------------------------------------
create or replace function public.registrar_cliente_do_sac(
    p_organizacao_id uuid,
    p_ator_id uuid,
    p_nome text,
    p_email text,
    p_telefone text,
    p_telefone_normalizado text
)
returns table (desfecho text, cliente_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cliente_id uuid;
begin
    if p_organizacao_id is null or p_ator_id is null or nullif(btrim(coalesce(p_telefone_normalizado, '')), '') is null then
        raise exception 'Organizacao, ator e telefone normalizado sao obrigatorios.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.membros_organizacao m
         where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id
    ) then
        raise exception 'Ator nao pertence a organizacao verificada.' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_organizacao_id::text || ':cliente-sac:' || p_telefone_normalizado, 0));

    select c.id into v_cliente_id
      from public.clientes c
     where c.organizacao_id = p_organizacao_id
       and c.telefone_normalizado = p_telefone_normalizado
     limit 1;
    if found then
        return query select 'ja_existia'::text, v_cliente_id;
        return;
    end if;

    insert into public.clientes (organizacao_id, user_id, bling_id, nome, email, telefone, telefone_normalizado)
    values (
        p_organizacao_id,
        p_ator_id,
        'temp_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
        coalesce(nullif(btrim(coalesce(p_nome, '')), ''), 'Cliente Chatwoot'),
        nullif(btrim(coalesce(p_email, '')), ''),
        coalesce(nullif(btrim(coalesce(p_telefone, '')), ''), p_telefone_normalizado),
        p_telefone_normalizado
    )
    returning id into v_cliente_id;

    return query select 'criado'::text, v_cliente_id;
end;
$$;

revoke all on function public.registrar_cliente_do_sac(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.registrar_cliente_do_sac(uuid, uuid, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Alinhamento do estoque ao saldo do Bling, com lançamento no livro
-- ---------------------------------------------------------------------------
create or replace function public.alinhar_estoque_ao_saldo_do_bling(
    p_organizacao_id uuid,
    p_ator_id uuid,
    p_produto_id uuid,
    p_estoque_lido integer,
    p_saldo_bling integer
)
returns table (desfecho text, estoque_final integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_atual integer;
    v_delta integer;
begin
    if p_organizacao_id is null or p_ator_id is null or p_produto_id is null or p_saldo_bling is null then
        raise exception 'Organizacao, ator, produto e saldo sao obrigatorios.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.membros_organizacao m
         where m.organizacao_id = p_organizacao_id and m.user_id = p_ator_id
    ) then
        raise exception 'Ator nao pertence a organizacao verificada.' using errcode = '42501';
    end if;

    select p.estoque into v_atual
      from public.produtos p
     where p.id = p_produto_id and p.organizacao_id = p_organizacao_id
       for update;
    if not found then
        raise exception 'Produto nao encontrado para a organizacao verificada.' using errcode = 'P0002';
    end if;

    -- Repetição (retry, requisição duplicada): o valor já é o do Bling.
    if v_atual = p_saldo_bling then
        return query select 'ja_alinhado'::text, v_atual;
        return;
    end if;
    -- O estoque mudou depois da leitura (venda manual, outra sincronização):
    -- sobrescrever desfaria esse movimento. Fica para a reconciliação.
    if p_estoque_lido is distinct from v_atual then
        return query select 'divergiu'::text, v_atual;
        return;
    end if;
    if p_saldo_bling < 0 then
        return query select 'saldo_invalido'::text, v_atual;
        return;
    end if;

    v_delta := p_saldo_bling - v_atual;
    update public.produtos
       set estoque = p_saldo_bling
     where id = p_produto_id and organizacao_id = p_organizacao_id;

    insert into public.movimentacao_estoque (user_id, organizacao_id, produto_id, tipo, origem, quantidade)
    values (
        p_ator_id,
        p_organizacao_id,
        p_produto_id,
        case when v_delta > 0 then 'ENTRADA' else 'SAIDA' end,
        'ALINHAMENTO_SITUACAO_BLING',
        abs(v_delta)
    );

    return query select 'alinhado'::text, p_saldo_bling;
end;
$$;

revoke all on function public.alinhar_estoque_ao_saldo_do_bling(uuid, uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.alinhar_estoque_ao_saldo_do_bling(uuid, uuid, uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Eventos de auditoria (projeção SQL de `auditEventCatalog.ts`)
--
-- Metadata: ids técnicos, operação, desfecho e contagens. Nunca nome, CPF/CNPJ,
-- e-mail, telefone, mensagem ou corpo do Bling/Chatwoot.
-- ---------------------------------------------------------------------------
insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('customer.contact_saved', 1, 'customers', 'info', 'user', 1825, null,
     'Contato cadastrado ou atualizado no Bling e espelhado no ORBITA.'),
    ('customer.contact_save_rejected', 1, 'customers', 'info', 'user', 1825, null,
     'O Bling recusou o cadastro ou a atualização do contato; nada foi gravado.'),
    ('customer.contact_save_reconcile_required', 1, 'customers', 'critical', 'user', 1825, null,
     'Gravação do contato sem confirmação do Bling, ou confirmada lá e não espelhada no ORBITA.'),
    ('customer.sac_contacts_registered', 1, 'customers', 'info', 'user', 1825, null,
     'Sincronização do SAC registrou clientes novos a partir de contatos do Chatwoot.'),
    ('order.status_changed', 1, 'orders', 'info', 'user', 1825, null,
     'Situação do pedido alterada no Bling e no ORBITA, com o desfecho do alinhamento de estoque.'),
    ('order.status_change_rejected', 1, 'orders', 'info', 'user', 1825, null,
     'O Bling recusou a mudança de situação do pedido; nada mudou.'),
    ('order.updated', 1, 'orders', 'info', 'user', 1825, null,
     'Pedido editado no Bling.'),
    ('order.deleted', 1, 'orders', 'warning', 'user', 1825, null,
     'Pedido apagado no Bling e no ORBITA.'),
    ('order.reconcile_required', 1, 'orders', 'critical', 'user', 1825, null,
     'Operação de pedido sem confirmação do Bling, ou confirmada lá e não refletida no ORBITA.'),
    ('order.manual_sale_recorded', 1, 'orders', 'info', 'user', 1825, null,
     'Venda manual registrada no Bling e no ORBITA.'),
    ('order.manual_sale_unresolved', 1, 'orders', 'critical', 'user', 1825, null,
     'Venda manual sem desfecho confirmado; tentativa bloqueada até a reconciliação.')
on conflict (nome) do nothing;
