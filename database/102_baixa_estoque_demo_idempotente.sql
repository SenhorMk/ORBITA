-- Forward-only. The allowlist starts empty and can only be provisioned by the database operator.
insert into public.catalogo_eventos_auditoria
  (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
  ('inventory.demo_debit_applied', 1, 'catalog', 'info', 'user', 730, null,
   'Baixa confirmada no estoque de demonstração.')
on conflict (nome) do nothing;

create table public.estoque_baixa_demo_produtos (
  organizacao_id uuid not null references public.organizacoes(id),
  produto_id uuid not null references public.produtos(id),
  primary key (organizacao_id, produto_id)
);

create table public.estoque_baixa_demo_comandos (
  organizacao_id uuid not null references public.organizacoes(id),
  chave uuid not null default gen_random_uuid(),
  ator_id uuid not null,
  produto_id uuid not null,
  quantidade integer not null check (quantidade between 1 and 100),
  expira_em timestamptz not null default (clock_timestamp() + interval '5 minutes'),
  resultado jsonb,
  primary key (organizacao_id, chave)
);

alter table public.estoque_baixa_demo_produtos enable row level security;
alter table public.estoque_baixa_demo_comandos enable row level security;
revoke all on public.estoque_baixa_demo_produtos, public.estoque_baixa_demo_comandos
  from public, anon, authenticated, service_role;

-- Hold authorization until commit. The organization lock also fences insertion
-- of integrations referencing this organization by foreign key.
create function public.travar_gestor_baixa_demo(p_org uuid, p_ator uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform 1 from public.organizacoes o where o.id=p_org and o.status='active' for update;
  if not found then raise exception 'Organização indisponível.' using errcode='42501'; end if;
  perform 1 from public.membros_organizacao m
    where m.organizacao_id=p_org and m.user_id=p_ator and m.papel in ('owner','admin') for share;
  if not found then raise exception 'Gestão da organização exigida.' using errcode='42501'; end if;
end
$$;

create function public.travar_produto_baixa_demo(p_org uuid, p_produto uuid)
returns public.produtos language plpgsql set search_path = '' as $$
declare v_produto public.produtos;
begin
  if exists (select 1 from public.conexoes_integracao c where c.organizacao_id=p_org) then
    raise exception 'Organização de demonstração deve estar sem integrações.' using errcode='42501';
  end if;
  select p.* into v_produto from public.produtos p
    join public.estoque_baixa_demo_produtos d on d.organizacao_id=p.organizacao_id and d.produto_id=p.id
    where p.organizacao_id=p_org and p.id=p_produto and p.situacao='ativo' and left(p.bling_id,6)='local-'
    for update of p for share of d;
  if not found then raise exception 'Produto não habilitado para a demonstração.' using errcode='42501'; end if;
  return v_produto;
end
$$;

create function public.propor_baixa_estoque_demo(p_org uuid, p_ator uuid, p_produto uuid, p_quantidade integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_produto public.produtos;
  v_comando public.estoque_baixa_demo_comandos;
begin
  perform public.travar_gestor_baixa_demo(p_org,p_ator);
  if p_quantidade is null or p_quantidade not between 1 and 100 then
    raise exception 'Quantidade inválida.' using errcode='22023';
  end if;
  v_produto := public.travar_produto_baixa_demo(p_org,p_produto);
  if v_produto.estoque is null or v_produto.estoque_reservado is null
      or v_produto.estoque - v_produto.estoque_reservado < p_quantidade then
    raise exception 'Saldo livre insuficiente.' using errcode='23514';
  end if;
  insert into public.estoque_baixa_demo_comandos(organizacao_id,ator_id,produto_id,quantidade)
    values (p_org,p_ator,p_produto,p_quantidade) returning * into v_comando;
  return jsonb_build_object('chave',v_comando.chave,'expiraEm',v_comando.expira_em,
    'produto',v_produto.nome,'quantidade',p_quantidade,
    'saldoDisponivel',v_produto.estoque-v_produto.estoque_reservado);
end
$$;

create function public.confirmar_baixa_estoque_demo(p_org uuid, p_ator uuid, p_chave uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_comando public.estoque_baixa_demo_comandos;
  v_produto public.produtos;
  v_saldo integer;
  v_auditoria uuid;
begin
  perform public.travar_gestor_baixa_demo(p_org,p_ator);
  select * into v_comando from public.estoque_baixa_demo_comandos
    where organizacao_id=p_org and chave=p_chave and ator_id=p_ator for update;
  if not found then raise exception 'Proposta não localizada.' using errcode='P0002'; end if;
  -- Replay precedes expiry. It returns only an already committed receipt.
  if v_comando.resultado is not null then return v_comando.resultado; end if;
  if v_comando.expira_em <= clock_timestamp() then
    raise exception 'Proposta expirada.' using errcode='22023';
  end if;
  v_produto := public.travar_produto_baixa_demo(p_org,v_comando.produto_id);
  if v_produto.estoque is null or v_produto.estoque_reservado is null
      or v_produto.estoque - v_produto.estoque_reservado < v_comando.quantidade then
    raise exception 'Saldo livre insuficiente.' using errcode='23514';
  end if;

  -- Reuse the authorized stock command and its movement inside this transaction.
  select b.estoque_restante into strict v_saldo
    from public.baixar_estoque_organizacao(p_org,v_comando.produto_id,v_comando.quantidade,p_ator) b;
  v_auditoria := public.registrar_evento_auditoria(p_org,p_ator,'inventory.demo_debit_applied','produto',
    v_comando.produto_id::text,p_chave::text,null,null,
    jsonb_build_object('quantidade',v_comando.quantidade,'saldoDisponivel',v_saldo-v_produto.estoque_reservado));
  v_comando.resultado := jsonb_build_object('chave',p_chave,'auditoriaId',v_auditoria,
    'produto',v_produto.nome,'quantidade',v_comando.quantidade,
    'saldoDisponivel',v_saldo-v_produto.estoque_reservado);
  update public.estoque_baixa_demo_comandos set resultado=v_comando.resultado
    where organizacao_id=p_org and chave=p_chave;
  return v_comando.resultado;
end
$$;

revoke all on function public.travar_gestor_baixa_demo(uuid,uuid),
  public.travar_produto_baixa_demo(uuid,uuid),
  public.propor_baixa_estoque_demo(uuid,uuid,uuid,integer),
  public.confirmar_baixa_estoque_demo(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.propor_baixa_estoque_demo(uuid,uuid,uuid,integer),
  public.confirmar_baixa_estoque_demo(uuid,uuid,uuid) to service_role;
