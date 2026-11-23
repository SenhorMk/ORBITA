-- MSG-015 candidata. Ordem proposta 106 após #165. Aplicar somente no laboratório.
begin;
set local lock_timeout = '5s';

create table public.sac_compatibilidade_produtos (
    organizacao_id uuid not null references public.organizacoes on delete cascade,
    produto_id uuid not null references public.produtos on delete cascade,
    familia text not null check (char_length(btrim(familia)) between 1 and 80),
    variante text not null check (char_length(btrim(variante)) between 1 and 80),
    revisao text not null check (char_length(btrim(revisao)) between 1 and 80),
    valida_ate timestamptz not null,
    primary key (organizacao_id, produto_id)
);
create index sac_compatibilidade_grupo_idx on public.sac_compatibilidade_produtos
    (organizacao_id, familia, variante, revisao, produto_id);

create table public.sac_politicas_resolucao (
    organizacao_id uuid not null references public.organizacoes on delete cascade,
    tipo text not null check (tipo in ('troca','devolucao')),
    motivo text not null check (motivo in ('avaria','defeito','arrependimento','outro')),
    revisao text not null check (char_length(btrim(revisao)) between 1 and 80),
    valida_ate timestamptz not null,
    publicacao_id uuid unique,
    fonte text,
    conteudo text,
    referencia text,
    conteudo_sha256 text,
    aprovada_por uuid,
    publicada_em timestamptz,
    primary key (organizacao_id, tipo, motivo, revisao),
    constraint sac_politica_publicacao_formal check (
        (publicacao_id is null and num_nonnulls(fonte,conteudo,referencia,conteudo_sha256,aprovada_por,publicada_em) = 0)
        or (
            publicacao_id is not null and aprovada_por is not null and publicada_em is not null
            and publicada_em < valida_ate
            and fonte is not null and char_length(btrim(fonte)) between 1 and 300
            and conteudo_sha256 is not null and conteudo_sha256 ~ '^[0-9a-f]{64}$'
            and num_nonnulls(conteudo,referencia) = 1
            and (
                (conteudo is not null and char_length(btrim(conteudo)) between 1 and 12000
                 and conteudo_sha256 = encode(sha256(convert_to(conteudo,'UTF8')),'hex'))
                or (referencia is not null and char_length(referencia) <= 2048 and referencia ~ '^https://[^[:space:]]+$')
            )
        )
    )
);
create index sac_politicas_publicadas_idx on public.sac_politicas_resolucao
    (organizacao_id,tipo,motivo,publicada_em desc,publicacao_id desc) where publicacao_id is not null;

create table public.sac_propostas_resolucao (
    organizacao_id uuid not null,
    caso_id uuid not null,
    versao integer not null check (versao > 0),
    digest text not null check (digest ~ '^[0-9a-f]{64}$'),
    entrada jsonb not null check (jsonb_typeof(entrada) = 'object'),
    fatos jsonb not null check (jsonb_typeof(fatos) = 'object'),
    estado text not null default 'rascunho' check (estado in ('rascunho','aprovada','rejeitada')),
    criada_por uuid not null,
    criada_em timestamptz not null,
    expira_em timestamptz not null check (expira_em > criada_em),
    decidida_por uuid,
    decidida_em timestamptz,
    primary key (organizacao_id, caso_id, versao),
    foreign key (organizacao_id, caso_id) references public.sac_cases(organizacao_id,id) on delete cascade,
    check ((estado = 'rascunho' and decidida_por is null and decidida_em is null)
        or (estado <> 'rascunho' and decidida_por is not null and decidida_em is not null))
);

create table public.sac_operacoes_proposta (
    organizacao_id uuid not null references public.organizacoes on delete cascade,
    operacao_id uuid not null,
    ator_id uuid not null,
    assinatura text not null check (assinatura ~ '^[0-9a-f]{64}$'),
    caso_id uuid not null,
    versao integer not null,
    recibo jsonb not null,
    primary key (organizacao_id, operacao_id),
    foreign key (organizacao_id, caso_id, versao)
        references public.sac_propostas_resolucao(organizacao_id,caso_id,versao) on delete cascade
);
create index sac_operacoes_proposta_versao_idx on public.sac_operacoes_proposta (organizacao_id, caso_id, versao);

alter table public.sac_compatibilidade_produtos enable row level security;
alter table public.sac_politicas_resolucao enable row level security;
alter table public.sac_propostas_resolucao enable row level security;
alter table public.sac_operacoes_proposta enable row level security;
revoke all on public.sac_compatibilidade_produtos, public.sac_politicas_resolucao,
    public.sac_propostas_resolucao, public.sac_operacoes_proposta from public, anon, authenticated, service_role;



insert into public.catalogo_eventos_auditoria
    (nome, versao, produtor, severidade, ator_esperado, retention_dias, alerta_regra, descricao)
values
    ('sac.policy_published', 1, 'sac', 'warning', 'user', 1825, null, 'Política D7 formalmente aprovada e publicada.'),
    ('sac.proposal_created', 1, 'sac', 'info', 'user', 1825, null, 'Rascunho de resolução criado.'),
    ('sac.proposal_edited', 1, 'sac', 'info', 'user', 1825, null, 'Nova versão do rascunho de resolução.'),
    ('sac.proposal_approved', 1, 'sac', 'warning', 'user', 1825, null, 'Aprovação humana de versão de proposta.'),
    ('sac.proposal_rejected', 1, 'sac', 'info', 'user', 1825, null, 'Rejeição humana de versão de proposta.');

-- O ator vem do JWT. A publicação é explícita e auditada no mesmo commit.
-- Uma referência externa exige SHA-256 verificado pelo publicador autorizado.
create function public.sac_publicar_politica_resolucao(
    p_org uuid, p_tipo text, p_motivo text, p_revisao text, p_valida_ate timestamptz,
    p_fonte text, p_conteudo text, p_referencia text, p_sha256 text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
    v_ator uuid := auth.uid();
    v_id uuid := gen_random_uuid();
    v_agora timestamptz;
    v_digest text;
begin
    perform 1 from public.membros_organizacao m
      join public.organizacoes o on o.id = m.organizacao_id and o.status = 'active'
     where m.organizacao_id = p_org and m.user_id = v_ator and m.papel in ('owner','admin')
     for share of m,o;
    if not found then raise exception 'Publicação D7 exige gestão na organização.' using errcode = '42501'; end if;

    if num_nonnulls(p_conteudo,p_referencia) <> 1 or p_fonte is null or btrim(p_fonte) = ''
       or p_valida_ate is null then
        raise exception 'Publicação D7 exige fonte, documento ou referência verificável e vigência.' using errcode = '22023';
    end if;
    v_digest := case when p_conteudo is not null then encode(sha256(convert_to(p_conteudo,'UTF8')),'hex')
                     else p_sha256 end;

    perform pg_advisory_xact_lock(hashtextextended(
        'sac-d7:' || p_org::text || ':' || coalesce(p_tipo,'') || ':' || coalesce(p_motivo,''),0));
    v_agora := clock_timestamp();
    insert into public.sac_politicas_resolucao (
        organizacao_id,tipo,motivo,revisao,valida_ate,publicacao_id,
        fonte,conteudo,referencia,conteudo_sha256,aprovada_por,publicada_em
    ) values (
        p_org,p_tipo,p_motivo,btrim(p_revisao),p_valida_ate,v_id,
        btrim(p_fonte),p_conteudo,p_referencia,v_digest,v_ator,v_agora
    )
    on conflict (organizacao_id,tipo,motivo,revisao) do update set
        valida_ate = excluded.valida_ate,publicacao_id = excluded.publicacao_id,fonte = excluded.fonte,
        conteudo = excluded.conteudo,referencia = excluded.referencia,conteudo_sha256 = excluded.conteudo_sha256,
        aprovada_por = excluded.aprovada_por,publicada_em = excluded.publicada_em
    where sac_politicas_resolucao.publicacao_id is null;
    if not found then raise exception 'A revisão D7 publicada é imutável.' using errcode = '23505'; end if;

    insert into public.eventos_auditoria_sistema (organizacao_id,actor_id,acao,recurso,recurso_id,metadata)
    values (p_org,v_ator,'sac.policy_published','sac_politica_resolucao',v_id::text,
        jsonb_build_object('tipo',p_tipo,'motivo',p_motivo,'revisao',btrim(p_revisao),'sha256',v_digest));
    return v_id;
end;
$$;
revoke all on function public.sac_publicar_politica_resolucao(uuid,text,text,text,timestamptz,text,text,text,text)
    from public,anon,authenticated,service_role;
grant execute on function public.sac_publicar_politica_resolucao(uuid,text,text,text,timestamptz,text,text,text,text)
    to authenticated;

create function public.sac_sincronizacao_proposta(p_org uuid, p_entidade text, p_agora timestamptz)
returns timestamptz language plpgsql security invoker set search_path = ''
as $$
declare
    v_sync timestamptz;
    v_status text;
    v_job timestamptz;
begin
    select s.last_synced_at into v_sync from public.sync_state s
     where s.organizacao_id = p_org and s.entidade = p_entidade for share;
    select j.status, coalesce(j.completed_at,j.updated_at) into v_status,v_job from public.sync_jobs j
     where j.organizacao_id = p_org and j.status in ('completed','failed')
     order by j.created_at desc limit 1 for share;
    if v_sync between p_agora - interval '24 hours' and p_agora
        and not coalesce(v_status = 'failed' and v_job > v_sync,false) then return v_sync; end if;
    return null;
end;
$$;
create function public.sac_fatos_proposta(
    p_org uuid, p_conversa uuid, p_entrada jsonb, p_agora timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_prova public.sac_vinculos_cliente;
    v_pedido public.pedidos;
    v_item public.itens_pedido;
    v_alternativa public.produtos;
    v_original public.produtos;
    v_perfil public.sac_compatibilidade_produtos;
    v_perfil_alt public.sac_compatibilidade_produtos;
    v_politica public.sac_politicas_resolucao;
    v_pedido_sync timestamptz;
    v_produto_sync timestamptz;
    v_quantidade integer := (p_entrada->>'quantidade')::integer;
    v_tipo text := p_entrada->>'tipo';
    v_pendencias text[] := array[]::text[];
begin
    v_prova := public.sac_vinculo_vigente(p_org, p_conversa);
    if v_prova.id is not null then
        perform 1 from public.sac_vinculos_cliente v
         join public.clientes c on c.id = v.cliente_id and c.organizacao_id = v.organizacao_id
         where v.id = v_prova.id and v.revogado_em is null and v.expira_em > p_agora
           and c.anonimizado_em is null for share of v, c;
        if not found then v_prova := null; end if;
    end if;
    if v_prova.id is null then
        v_pendencias := array_append(v_pendencias,'confirmar_cliente');
    elsif p_entrada ? 'pedidoId' then
        select p.* into v_pedido from public.pedidos p
         where p.organizacao_id = p_org and p.cliente_id = v_prova.cliente_id
           and p.id = (p_entrada->>'pedidoId')::uuid for share;
        if not found then return null; end if;
    end if;

    if not (p_entrada ? 'pedidoId') then v_pendencias := array_append(v_pendencias,'pedido'); end if;
    if not (p_entrada ? 'itemId') then v_pendencias := array_append(v_pendencias,'item'); end if;
    if v_quantidade is null then v_pendencias := array_append(v_pendencias,'quantidade'); end if;
    if not (p_entrada ? 'motivo') then v_pendencias := array_append(v_pendencias,'motivo'); end if;

    if v_pedido.id is not null then
        v_pedido_sync := public.sac_sincronizacao_proposta(p_org,'pedidos',p_agora);
        if v_pedido_sync is null then
            v_pendencias := array_append(v_pendencias,'frescor');
        end if;
        if p_entrada ? 'itemId' then
            select i.* into v_item from public.itens_pedido i
             where i.organizacao_id = p_org and i.pedido_id = v_pedido.id and i.id = (p_entrada->>'itemId')::uuid
             for share;
            if not found then return null; end if;
            if v_quantidade > v_item.quantidade then
                v_pendencias := array_append(v_pendencias,'quantidade_excede_item');
            end if;
        end if;
    end if;

    if v_tipo is not null and p_entrada ? 'motivo' then
        -- A mesma trava de publicação impede aprovar com uma revisão superada durante a decisão.
        perform pg_advisory_xact_lock(hashtextextended(
            'sac-d7:' || p_org::text || ':' || v_tipo || ':' || (p_entrada->>'motivo'),0));
    end if;
    select pol.* into v_politica from public.sac_politicas_resolucao pol
     where pol.organizacao_id = p_org and pol.tipo = v_tipo and pol.motivo = p_entrada->>'motivo'
       and pol.publicacao_id is not null and pol.aprovada_por is not null and pol.publicada_em <= clock_timestamp()
       and pol.fonte is not null and pol.conteudo_sha256 is not null
     order by pol.publicada_em desc,pol.publicacao_id desc limit 1 for share;
    if v_politica.publicacao_id is null or v_politica.valida_ate <= clock_timestamp() then
        v_pendencias := array_append(v_pendencias,'politica');
        v_politica := null;
    end if;

    if v_tipo = 'troca' then
        select a.* into v_alternativa from public.produtos a
         where a.organizacao_id = p_org and a.id = (p_entrada->>'substitutoId')::uuid for share;
        select o.* into v_original from public.produtos o
         where o.organizacao_id = p_org and o.id = v_item.produto_id for share;
        select c.* into v_perfil from public.sac_compatibilidade_produtos c
         where c.organizacao_id = p_org and c.produto_id = v_original.id and c.valida_ate > p_agora for share;
        select c.* into v_perfil_alt from public.sac_compatibilidade_produtos c
         where c.organizacao_id = p_org and c.produto_id = v_alternativa.id and c.valida_ate > p_agora for share;
        if v_perfil.produto_id is null or v_perfil_alt.produto_id is null or
            (v_perfil.familia, v_perfil.variante, v_perfil.revisao) is distinct from
            (v_perfil_alt.familia, v_perfil_alt.variante, v_perfil_alt.revisao)
            or v_alternativa.id = v_original.id then
            v_pendencias := array_append(v_pendencias,'compatibilidade');
        end if;
        v_produto_sync := public.sac_sincronizacao_proposta(p_org,'produtos',p_agora);
        if v_produto_sync is null then
            v_pendencias := array_append(v_pendencias,'frescor_catalogo');
        end if;
        if v_alternativa.id is not null and (v_alternativa.situacao <> 'ativo'
            or v_alternativa.estoque - v_alternativa.estoque_reservado < v_quantidade
            or v_alternativa.preco not between 0 and 10000000) then
            v_pendencias := array_append(v_pendencias,'substituto_indisponivel');
        end if;
    end if;

    return jsonb_build_object(
        'pendencias',to_jsonb(v_pendencias),
        'provaId',v_prova.id,
        'pedidoSincronizadoEm',v_pedido_sync,
        'catalogoSincronizadoEm',v_produto_sync,
        'politica',v_politica.revisao,
        'politicaPublicacaoId',v_politica.publicacao_id,
        'politicaSHA256',v_politica.conteudo_sha256,
        'politicaValidaAte',v_politica.valida_ate,
        'compatibilidade', case when v_tipo <> 'troca' or 'compatibilidade' = any(v_pendencias) then null else
            jsonb_build_array(v_perfil.familia,v_perfil.variante,v_perfil.revisao,v_perfil.valida_ate,v_perfil_alt.valida_ate) end,
        'precoPedidoCentavos',case when not ('frescor' = any(v_pendencias)) then (v_item.valor_unitario * 100)::bigint end,
        'quantidadeComprada',v_item.quantidade,
        'precoSubstitutoCentavos',case when not (v_pendencias && array['compatibilidade','frescor_catalogo','substituto_indisponivel'])
            then (v_alternativa.preco * 100)::bigint end,
        'estoqueSubstituto',case when not (v_pendencias && array['compatibilidade','frescor_catalogo','substituto_indisponivel'])
            then v_alternativa.estoque - v_alternativa.estoque_reservado end
    );
end;
$$;

create function public.sac_proposta_resolucao(
    p_org uuid, p_ator uuid, p_conversa uuid, p_acao text, p_operacao uuid,
    p_versao integer, p_digest text, p_entrada jsonb, p_correlacao text
) returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
    v_caso uuid;
    v_papel text;
    v_atual public.sac_propostas_resolucao;
    v_operacao public.sac_operacoes_proposta;
    v_fatos jsonb;
    v_recibo jsonb;
    v_agora timestamptz;
    v_validade timestamptz;
    v_assinatura text;
    v_versao integer;
    v_evento text;
begin
    select m.papel into v_papel from public.membros_organizacao m
     where m.organizacao_id = p_org and m.user_id = p_ator for share;
    if v_papel is null or (p_acao in ('aprovar','rejeitar') and v_papel not in ('owner','admin')) then
        return jsonb_build_object('estado','sem_permissao');
    end if;
    if p_conversa is null or coalesce(p_acao,'') not in ('ler','criar','editar','aprovar','rejeitar')
       or (p_acao <> 'ler' and p_operacao is null)
       or (p_acao in ('editar','aprovar','rejeitar') and (coalesce(p_versao,0) < 1 or coalesce(p_digest,'') !~ '^[0-9a-f]{64}$'))
       or (p_acao not in ('criar','editar') and p_entrada is not null) then
        return jsonb_build_object('estado','entrada_invalida');
    end if;
    if p_acao in ('criar','editar') then
        if jsonb_typeof(p_entrada) is distinct from 'object' then return jsonb_build_object('estado','entrada_invalida'); end if;
        if (p_entrada - array['tipo','pedidoId','itemId','quantidade','motivo','substitutoId']) <> '{}'::jsonb
            or coalesce(p_entrada->>'tipo','') not in ('troca','devolucao')
            or (p_entrada ? 'motivo' and coalesce(p_entrada->>'motivo','') not in ('avaria','defeito','arrependimento','outro'))
            or (p_entrada ? 'quantidade' and (jsonb_typeof(p_entrada->'quantidade') <> 'number' or coalesce(p_entrada->>'quantidade','') !~ '^([1-9][0-9]{0,3}|10000)$'))
            or (p_entrada ? 'itemId' and not (p_entrada ? 'pedidoId'))
            or (p_entrada->>'tipo' = 'devolucao' and p_entrada ? 'substitutoId')
            or exists(select 1 from jsonb_each(p_entrada) e where e.key in ('pedidoId','itemId','substitutoId')
                   and (jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')) then
            return jsonb_build_object('estado','entrada_invalida');
        end if;
    end if;

    if p_acao <> 'ler' then
        perform pg_advisory_xact_lock(hashtextextended('sac-proposta:' || p_org::text || ':' || p_operacao::text,0));
        v_assinatura := encode(sha256(convert_to(
            jsonb_build_array(p_conversa,p_acao,p_versao,p_digest,p_entrada)::text,'UTF8')),'hex');
        select o.* into v_operacao from public.sac_operacoes_proposta o
         where o.organizacao_id = p_org and o.operacao_id = p_operacao;
        if found then
            if v_operacao.ator_id <> p_ator or v_operacao.assinatura <> v_assinatura then
                return jsonb_build_object('estado','operacao_divergente');
            end if;
            -- Recibo enxuto. A leitura atual do caso exige autorização e prova próprias.
            return v_operacao.recibo;
        end if;
    end if;

    select s.id into v_caso from public.sac_cases s
     where s.organizacao_id = p_org and s.conversa_id_local = p_conversa
       and s.phase not in ('RESOLVED','CLOSED','CANCELLED') for update;
    if not found then return jsonb_build_object('estado','nao_encontrado'); end if;

    select v.* into v_atual from public.sac_propostas_resolucao v
     where v.organizacao_id = p_org and v.caso_id = v_caso order by v.versao desc limit 1;
    v_agora := clock_timestamp();
    if p_acao = 'ler' then
        if v_atual.versao is null then return jsonb_build_object('estado','sem_proposta'); end if;
        v_fatos := public.sac_fatos_proposta(p_org,p_conversa,v_atual.entrada,v_agora);
        return jsonb_build_object('estado','ok','casoId',v_caso,'versao',v_atual.versao,'digest',v_atual.digest,
            'situacao',case when v_atual.estado = 'rascunho' and v_atual.expira_em <= v_agora then 'vencida' else v_atual.estado end,
            'entrada',case when v_fatos is null or v_fatos->>'provaId' is null
                or v_fatos->>'provaId' is distinct from v_atual.fatos->>'provaId'
                then v_atual.entrada - array['pedidoId','itemId','substitutoId'] else v_atual.entrada end,
            'pendencias',coalesce(v_fatos->'pendencias','["confirmar_cliente"]'::jsonb),
            'podeAprovar',v_papel in ('owner','admin') and v_atual.estado = 'rascunho' and v_atual.expira_em > v_agora
                and v_fatos is not null and v_atual.fatos = v_fatos and v_fatos->'pendencias' = '[]'::jsonb,
            'podeRejeitar',v_papel in ('owner','admin') and v_atual.estado = 'rascunho' and v_atual.expira_em > v_agora,
            'fatosAlterados',v_fatos is distinct from v_atual.fatos,
            'expiraEm',v_atual.expira_em);
    end if;

    if p_acao = 'criar' then
        if v_atual.versao is not null then return jsonb_build_object('estado','conflito'); end if;
    elsif v_atual.versao is distinct from p_versao or v_atual.digest is distinct from p_digest then
        return jsonb_build_object('estado','conflito');
    end if;

    if p_acao in ('criar','editar') then
        v_fatos := public.sac_fatos_proposta(p_org,p_conversa,p_entrada,v_agora);
        if v_fatos is null or (p_entrada ? 'pedidoId' and v_fatos->>'provaId' is null) then
            return jsonb_build_object('estado','referencia_sem_prova');
        end if;
        v_versao := coalesce(v_atual.versao,0) + 1;
        v_validade := v_agora + interval '24 hours';
        insert into public.sac_propostas_resolucao
            (organizacao_id,caso_id,versao,digest,entrada,fatos,criada_por,criada_em,expira_em)
        values (p_org,v_caso,v_versao,encode(sha256(convert_to(
            jsonb_build_array(p_org,v_caso,v_versao,extract(epoch from v_validade),p_entrada,v_fatos)::text,'UTF8')),'hex'),
            p_entrada,v_fatos,p_ator,v_agora,v_validade)
        returning * into v_atual;
        v_evento := case p_acao when 'criar' then 'sac.proposal_created' else 'sac.proposal_edited' end;
    else
        if v_atual.estado <> 'rascunho' then return jsonb_build_object('estado','ja_decidida'); end if;
        if v_atual.expira_em <= v_agora then return jsonb_build_object('estado','vencida'); end if;
        if p_acao = 'aprovar' then
            v_fatos := public.sac_fatos_proposta(p_org,p_conversa,v_atual.entrada,v_agora);
            if v_fatos is distinct from v_atual.fatos then return jsonb_build_object('estado','fatos_alterados'); end if;
            if v_fatos->'pendencias' <> '[]'::jsonb then
                return jsonb_build_object('estado','bloqueada','pendencias',v_fatos->'pendencias');
            end if;
        end if;
        update public.sac_propostas_resolucao v set
            estado = case p_acao when 'aprovar' then 'aprovada' else 'rejeitada' end,
            decidida_por = p_ator, decidida_em = v_agora
         where v.organizacao_id = p_org and v.caso_id = v_caso and v.versao = p_versao
           and v.digest = p_digest and v.estado = 'rascunho'
         returning * into v_atual;
        if not found then return jsonb_build_object('estado','conflito'); end if;
        v_evento := case p_acao when 'aprovar' then 'sac.proposal_approved' else 'sac.proposal_rejected' end;
    end if;

    v_recibo := jsonb_build_object('estado','ok','casoId',v_caso,'versao',v_atual.versao,
        'digest',v_atual.digest,'situacao',v_atual.estado);
    insert into public.sac_operacoes_proposta (organizacao_id,operacao_id,ator_id,assinatura,caso_id,versao,recibo)
    values (p_org,p_operacao,p_ator,v_assinatura,v_caso,v_atual.versao,v_recibo);
    perform public.registrar_evento_auditoria(p_org,p_ator,v_evento,'sac_proposta_resolucao',v_caso::text,
        p_correlacao,null,null,jsonb_build_object('versao',v_atual.versao,'digest',v_atual.digest,
            'operacao_id',p_operacao,'situacao',v_atual.estado));
    return v_recibo;
end;
$$;

revoke all on function public.sac_fatos_proposta(uuid,uuid,jsonb,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.sac_proposta_resolucao(uuid,uuid,uuid,text,uuid,integer,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.sac_proposta_resolucao(uuid,uuid,uuid,text,uuid,integer,text,jsonb,text) to service_role;

create function public.sac_fatos_ranking(
    p_org uuid, p_ator uuid, p_conversa uuid, p_pedido uuid, p_item uuid
) returns jsonb
language plpgsql security definer set search_path = '' set timezone = 'UTC'
as $$
declare
    v_agora timestamptz := clock_timestamp();
    v_prova public.sac_vinculos_cliente;
    v_item public.itens_pedido;
    v_perfil public.sac_compatibilidade_produtos;
    v_pedido_sync timestamptz;
    v_produto_sync timestamptz;
    v_candidatos jsonb;
begin
    perform 1 from public.membros_organizacao m where m.organizacao_id = p_org and m.user_id = p_ator for share;
    if not found then return null; end if;
    v_prova := public.sac_vinculo_vigente(p_org,p_conversa);
    if v_prova.id is null then return null; end if;
    select i.* into v_item from public.itens_pedido i
     join public.pedidos p on p.id = i.pedido_id and p.organizacao_id = i.organizacao_id
     where i.organizacao_id = p_org and p.cliente_id = v_prova.cliente_id and p.id = p_pedido and i.id = p_item;
    if not found or v_item.valor_unitario not between 0 and 10000000 then return null; end if;
    v_pedido_sync := public.sac_sincronizacao_proposta(p_org,'pedidos',v_agora);
    v_produto_sync := public.sac_sincronizacao_proposta(p_org,'produtos',v_agora);
    select c.* into v_perfil from public.sac_compatibilidade_produtos c
     join public.produtos p on p.id = c.produto_id and p.organizacao_id = c.organizacao_id
     where c.organizacao_id = p_org and c.produto_id = v_item.produto_id and c.valida_ate > v_agora;

    select coalesce(jsonb_agg(x.candidato order by x.id),'[]'::jsonb) into v_candidatos from (
        select p.id, jsonb_build_object('organizacaoId',p_org,'produtoId',p.id,'nome',p.nome,'situacao',p.situacao,
            'disponivel',greatest(0,p.estoque - p.estoque_reservado),'moeda','BRL',
            'precoCentavos',case when p.preco between 0 and 10000000 then (p.preco * 100)::bigint end,
            'precoSincronizadoEm',v_produto_sync,'estoqueSincronizadoEm',v_produto_sync,
            'compatibilidade',jsonb_build_object('familia',c.familia,'variante',c.variante,'versao',c.revisao)) as candidato
          from public.sac_compatibilidade_produtos c
          join public.produtos p on p.id = c.produto_id and p.organizacao_id = c.organizacao_id
         where c.organizacao_id = p_org and c.valida_ate > v_agora and p.id <> v_item.produto_id
           and (c.familia,c.variante,c.revisao) = (v_perfil.familia,v_perfil.variante,v_perfil.revisao)
         order by p.id limit 501
    ) x;
    return jsonb_build_object('organizacaoId',p_org,'conversaId',p_conversa,'pedidoId',p_pedido,'itemId',p_item,
        'provaValidaAte',v_prova.expira_em,'original',jsonb_build_object('produtoId',v_item.produto_id,
            'quantidade',v_item.quantidade,'precoCentavos',(v_item.valor_unitario * 100)::bigint,'moeda','BRL',
            'pedidoSincronizadoEm',v_pedido_sync,'compatibilidade',case when v_perfil.produto_id is not null then
                jsonb_build_object('familia',v_perfil.familia,'variante',v_perfil.variante,'versao',v_perfil.revisao) end),
        'candidatos',v_candidatos);
end;
$$;

revoke all on function public.sac_sincronizacao_proposta(uuid,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.sac_fatos_ranking(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.sac_fatos_ranking(uuid,uuid,uuid,uuid,uuid) to service_role;

commit;
