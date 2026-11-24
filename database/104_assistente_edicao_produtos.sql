-- Expand-only. No backfill. Browser roles have no access to proposals or execution.
alter table public.produtos add column if not exists descricao_curta text;

create table public.assistente_edicoes_produtos (
  chave uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references public.organizacoes(id),
  ator_id uuid not null,
  conteudo jsonb not null check (jsonb_typeof(conteudo->'itens') = 'array'
    and jsonb_array_length(conteudo->'itens') between 1 and 20),
  estado text not null default 'pendente' check (estado in ('pendente','executando','concluida')),
  resultados jsonb not null default '[]'::jsonb check (jsonb_typeof(resultados) = 'array'),
  criado_em timestamptz not null default clock_timestamp(),
  iniciado_em timestamptz,
  expira_em timestamptz not null default (clock_timestamp() + interval '10 minutes')
);
create index assistente_edicoes_org_ator on public.assistente_edicoes_produtos(organizacao_id,ator_id,chave);
create index assistente_edicoes_em_execucao on public.assistente_edicoes_produtos(organizacao_id)
  where estado='executando';
alter table public.assistente_edicoes_produtos enable row level security;
revoke all on public.assistente_edicoes_produtos from public,anon,authenticated,service_role;

insert into public.catalogo_eventos_auditoria
  (nome,versao,produtor,severidade,ator_esperado,retention_dias,alerta_regra,descricao)
values ('catalog.assistant_product_edit',1,'catalog','info','user',730,null,
  'Confirmação e resultado de edição de produtos pelo assistente administrativo.')
on conflict (nome) do nothing;

-- A short transaction claims the proposal BEFORE the HTTP call. An interrupted
-- execution remains executing: a replay can read receipts but cannot resend.
create function public.assistente_edicao_produtos(
  p_org uuid,p_ator uuid,p_operacao text,p_chave uuid default null,p_dados jsonb default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v public.assistente_edicoes_produtos;
  item jsonb;
  v_estado text;
begin
  perform 1 from public.organizacoes o where o.id=p_org and o.status='active' for share;
  if not found then raise exception 'Organização indisponível.' using errcode='42501'; end if;
  perform 1 from public.membros_organizacao m where m.organizacao_id=p_org
    and m.user_id=p_ator and m.papel in ('owner','admin') for share;
  if not found then raise exception 'Gestão exigida.' using errcode='42501'; end if;

  if p_operacao='criar' then
    if p_dados is null or jsonb_typeof(p_dados->'itens') is distinct from 'array'
      or jsonb_array_length(p_dados->'itens') not between 1 and 20 then
      raise exception 'Proposta inválida.' using errcode='22023';
    end if;
    for item in select value from jsonb_array_elements(p_dados->'itens') loop
      perform 1 from public.produtos p where p.organizacao_id=p_org
        and p.id=(item->>'produtoId')::uuid and p.bling_id=item->>'blingId' and p.situacao='ativo' for share;
      if not found then raise exception 'Produto fora do escopo.' using errcode='42501'; end if;
      if item->>'campo' not in ('nome','descricao','estoque') or item->'valor' is null then
        raise exception 'Campo inválido.' using errcode='22023';
      end if;
    end loop;
    if (select count(distinct value->>'produtoId') from jsonb_array_elements(p_dados->'itens'))
      <> jsonb_array_length(p_dados->'itens') then
      raise exception 'Produto repetido.' using errcode='22023';
    end if;
    insert into public.assistente_edicoes_produtos(organizacao_id,ator_id,conteudo)
      values(p_org,p_ator,p_dados) returning * into v;
    return v.conteudo || jsonb_build_object('chave',v.chave,'expiraEm',v.expira_em);
  end if;

  -- Serializes overlapping claims within one organization, never across HTTP.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text,104));
  select * into v from public.assistente_edicoes_produtos
    where organizacao_id=p_org and (ator_id=p_ator or p_operacao='reconciliar') and chave=p_chave for update;
  if not found then return jsonb_build_object('estado','negada'); end if;

  -- Only a privileged operator workflow calls this operation, after checking the
  -- ERP and the terminated runtime. Browser confirmation never accepts it.
  if p_operacao='reconciliar' then
    if v.estado <> 'executando' or v.iniciado_em > clock_timestamp()-interval '15 minutes'
      or p_dados->>'confirmacao' is distinct from 'conferido_no_bling_sem_reenvio' then
      raise exception 'Conferência operacional exigida após interrupção.' using errcode='22023';
    end if;
    select v.resultados || coalesce(jsonb_agg(jsonb_build_object('produtoId',i->>'produtoId',
      'nome',i->>'nome','estado','indeterminado')),'[]'::jsonb) into v.resultados
      from jsonb_array_elements(v.conteudo->'itens') i
      where not exists(select 1 from jsonb_array_elements(v.resultados) r where r->>'produtoId'=i->>'produtoId');
    update public.assistente_edicoes_produtos set estado='concluida',resultados=v.resultados where chave=v.chave;
    perform public.registrar_evento_auditoria(p_org,p_ator,'catalog.assistant_product_edit','proposta_produtos',
      v.chave::text,v.chave::text,null,null,jsonb_build_object('etapa','reconciliada_sem_reenvio'));
    return jsonb_build_object('estado','concluida','resultados',v.resultados);
  end if;

  if p_operacao='reivindicar' then
    if v.estado <> 'pendente' then
      return jsonb_build_object('estado',case when v.estado='concluida' then 'concluida' else 'ocupada' end,
        'resultados',v.resultados);
    end if;
    if v.expira_em <= clock_timestamp() then return jsonb_build_object('estado','negada'); end if;
    if exists (
      select 1 from public.assistente_edicoes_produtos outra,
        jsonb_array_elements(outra.conteudo->'itens') oi,
        jsonb_array_elements(v.conteudo->'itens') vi
      where outra.organizacao_id=p_org and outra.estado='executando'
        and oi->>'produtoId'=vi->>'produtoId'
    ) then return jsonb_build_object('estado','negada'); end if;
    for item in select value from jsonb_array_elements(v.conteudo->'itens') loop
      perform 1 from public.produtos p where p.organizacao_id=p_org
        and p.id=(item->>'produtoId')::uuid and p.bling_id=item->>'blingId' and p.situacao='ativo' for share;
      if not found then return jsonb_build_object('estado','negada'); end if;
    end loop;
    update public.assistente_edicoes_produtos set estado='executando',iniciado_em=clock_timestamp() where chave=v.chave;
    perform public.registrar_evento_auditoria(p_org,p_ator,'catalog.assistant_product_edit','proposta_produtos',
      v.chave::text,v.chave::text,null,null,jsonb_build_object('etapa','confirmada','quantidade',jsonb_array_length(v.conteudo->'itens')));
    return jsonb_build_object('estado','executar','proposta',v.conteudo || jsonb_build_object('chave',v.chave,'expiraEm',v.expira_em));
  end if;

  if v.estado <> 'executando' then raise exception 'Proposta não reivindicada.' using errcode='22023'; end if;
  if p_operacao='registrar' then
    v_estado:=p_dados->>'estado';
    if v_estado is null or v_estado not in ('aplicado','recusado','alterado_apos_previa','indeterminado','nao_enviado') then
      raise exception 'Resultado inválido.' using errcode='22023';
    end if;
    select value into item from jsonb_array_elements(v.conteudo->'itens')
      where value->>'produtoId'=p_dados->>'produtoId';
    if item is null then raise exception 'Item ausente.' using errcode='22023'; end if;
    if exists (select 1 from jsonb_array_elements(v.resultados) r where r->>'produtoId'=item->>'produtoId') then
      raise exception 'Item já registrado.' using errcode='22023';
    end if;
    if v_estado='aplicado' then
      update public.produtos p set
        nome=case when item->>'campo'='nome' then item->>'valor' else p.nome end,
        descricao_curta=case when item->>'campo'='descricao' then item->>'valor' else p.descricao_curta end,
        estoque=case when item->>'campo'='estoque' then (item->>'valor')::integer else p.estoque end
        where p.id=(item->>'produtoId')::uuid and p.organizacao_id=p_org
          and p.bling_id=item->>'blingId' and p.situacao='ativo';
      if not found then raise exception 'Espelho indisponível.' using errcode='40001'; end if;
    end if;
    update public.assistente_edicoes_produtos set resultados=resultados || jsonb_build_array(
      jsonb_build_object('produtoId',item->>'produtoId','nome',item->>'nome','estado',v_estado)) where chave=v.chave;
    perform public.registrar_evento_auditoria(p_org,p_ator,'catalog.assistant_product_edit','produto',
      item->>'produtoId',v.chave::text,null,null,jsonb_build_object('etapa','resultado','estado',v_estado,'campo',item->>'campo'));
    return 'null'::jsonb;
  elsif p_operacao='concluir' then
    if jsonb_array_length(v.resultados) <> jsonb_array_length(v.conteudo->'itens') then
      raise exception 'Há itens sem recibo.' using errcode='22023';
    end if;
    update public.assistente_edicoes_produtos set estado='concluida' where chave=v.chave;
    return 'null'::jsonb;
  end if;
  raise exception 'Operação inválida.' using errcode='22023';
end
$$;
revoke all on function public.assistente_edicao_produtos(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.assistente_edicao_produtos(uuid,uuid,text,uuid,jsonb) to service_role;
