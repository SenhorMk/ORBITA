-- 63_convite_nominal_identidade_e_papel_preservado.sql
-- Forward-only. Ticket 06 — Organização & Membros.
--
-- ---------------------------------------------------------------------------
-- OS DOIS DEFEITOS
-- ---------------------------------------------------------------------------
-- `aceitar_convite_organizacao` nasceu em `21_convites_papeis_capacidades.sql`
-- e foi redefinida em `49_entitlement_reserva_atomica_ordering.sql`, que lhe
-- deu o lock por organização e a reserva atômica de vaga. Nenhuma das duas
-- versões faz o que o produto diz que o convite é.
--
-- 1. **O convite é nominal no papel e ao portador na prática.**
--    `criar_convite_organizacao` grava `lower(trim(email))` e a tela pede o
--    e-mail de quem se quer convidar. A aceitação nunca olha esse e-mail:
--    checa só que existe `auth.uid()`. Quem quer que segure o token entra —
--    com o papel que estava reservado para outra pessoa. O token viaja por
--    WhatsApp e e-mail, encaminhado por gente que não sabe que ele é uma
--    credencial; um convite de `admin` vazado é uma promoção de estranho.
--
-- 2. **O convite promove e REBAIXA quem já é membro.**
--    O `on conflict (organizacao_id, user_id) do update set papel` sobrescreve
--    o vínculo existente pelo papel do convite. Um convite de `member` criado
--    para um endereço que já pertence ao **owner** o rebaixa a `member` — e o
--    owner rebaixado não pode mais se promover de volta, nem revogar ninguém.
--    A organização fica sem dono. Um convite é um convite: ele faz entrar quem
--    está de fora, e não é o mecanismo de mudar o papel de quem já está dentro.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTA MIGRATION FAZ
-- ---------------------------------------------------------------------------
-- Redefine a função com duas mudanças, e só elas. Tudo o mais da versão 49 é
-- preservado literalmente: `security definer`, `search_path = public`, o
-- `for update` sobre a linha do convite, o `pg_advisory_xact_lock` por
-- organização, o status de ciclo de vida, o limite do plano recomputado dentro
-- do lock, o uso único e os `grant`s.
--
-- **A identidade vem do servidor.** O e-mail comparado é o de `auth.users` na
-- linha de `auth.uid()` — o registro do provedor de identidade, não um campo
-- que o cliente mande. Os dois lados normalizam igual (`lower(trim())`), que é
-- exatamente o que a criação já grava. Sem e-mail no registro, recusa: uma
-- identidade que o servidor não sabe nomear não corresponde a convite nenhum.
--
-- **A recusa por identidade não deixa rastro.** Ela vem antes da marcação de
-- expirado e antes do lock, então a conta errada não consome o convite, não
-- muda membership, não reserva vaga e não altera o status de nada. O convite
-- continua exatamente como estava, à espera de quem foi convidado.
--
-- **Quem já é membro mantém o papel.** O `do update set papel` vira
-- `do nothing`. O convite válido continua sendo consumido — é o contrato do
-- Ticket 06: a pessoa aceitou, o convite acabou —, mas nenhuma membership é
-- criada, nenhum papel muda e nenhuma vaga nova é reservada. O caminho da
-- reserva de entitlement já era condicional a `v_ja_membro`, e continua.
--
-- Nada muda em RLS, em políticas, em tabelas ou em colunas: esta migration
-- redefine uma função e mais nada.
--
-- REINTRODUZIR OS DEFEITOS: apague o bloco de identidade, e a conta errada
-- volta a entrar; troque `do nothing` por `do update set papel`, e o owner
-- volta a ser rebaixável por um convite de `member`. O pgTAP
-- `convite_nominal_identidade.test.sql` falha nos dois casos.
-- ---------------------------------------------------------------------------

create or replace function public.aceitar_convite_organizacao(
    p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid;
    v_user_email text;
    v_convite record;
    v_org_status text;
    v_limite_membros int;
    v_uso_atual int;
    v_ja_membro boolean;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Usuario nao autenticado para aceitar convite' using errcode = '42501';
    end if;

    -- Buscar e travar o registro do convite para garantir uso estritamente único
    select * into v_convite
    from public.convites_organizacao
    where token = p_token
    for update;

    if not found then
        raise exception 'Convite nao encontrado' using errcode = 'P0002';
    end if;

    if v_convite.status <> 'pending' then
        raise exception 'Convite ja utilizado ou revogado' using errcode = '22000';
    end if;

    -- O convite e nominal. A identidade e a do registro do provedor para
    -- auth.uid(), nunca um e-mail vindo do cliente, e a normalizacao e a mesma
    -- que criar_convite_organizacao aplica ao gravar.
    --
    -- Esta checagem vem ANTES de qualquer escrita de propósito: a conta errada
    -- nao pode consumir o convite, marcar expiracao, mudar membership nem
    -- reservar vaga. Recusar sem efeito e parte do contrato.
    select u.email into v_user_email
    from auth.users u
    where u.id = v_user_id;

    if v_user_email is null
       or lower(trim(v_user_email)) is distinct from lower(trim(v_convite.email)) then
        raise exception 'Convite pertence a outro destinatario' using errcode = '42501';
    end if;

    -- ACHADO, PRESERVADO: este `update` nunca chega a valer. O `raise` abaixo
    -- aborta a (sub)transacao e leva a marcacao com ele, entao o convite
    -- expirado continua `pending` no banco. E assim desde a migration 21, e a
    -- 63 nao muda: o que o contrato do Ticket 06 exige — que o convite expirado
    -- falhe e NAO seja consumido — esta garantido de qualquer forma, e mexer
    -- nisso pediria decidir onde a expiracao passa a ser gravada (job, leitura
    -- ou aceite), que e escopo proprio. O pgTAP
    -- `convite_nominal_identidade.test.sql` afirma o comportamento REAL, para
    -- ninguem concluir do codigo o que o banco nao faz.
    if v_convite.expires_at < now() then
        update public.convites_organizacao
        set status = 'expired'
        where id = v_convite.id;

        raise exception 'Convite expirado' using errcode = '22000';
    end if;

    -- Serializa concorrencia por organizacao+recurso: duas aceitacoes de
    -- convites distintos disputando o ultimo slot de membro nao podem ambas
    -- passar a checagem de limite. O lock e liberado apenas ao fim da
    -- transacao (commit/rollback), garantindo exclusao mutua real.
    perform pg_advisory_xact_lock(hashtextextended(v_convite.organizacao_id::text || ':membros', 0));

    select status into v_org_status
    from public.organizacoes
    where id = v_convite.organizacao_id;

    if v_org_status is null then
        raise exception 'Organizacao do convite nao encontrada' using errcode = 'P0002';
    end if;

    if v_org_status in ('suspended', 'pending_deletion', 'deleted') then
        raise exception 'Operacao bloqueada: organizacao com status %', v_org_status using errcode = 'ORB01';
    end if;

    select exists (
        select 1 from public.membros_organizacao
        where organizacao_id = v_convite.organizacao_id and user_id = v_user_id
    ) into v_ja_membro;

    if not v_ja_membro then
        select coalesce((a.limites_customizados->>'limite_membros')::int, p.limite_membros)
          into v_limite_membros
          from public.assinaturas_organizacao a
          join public.planos p on p.id = a.plano_id
         where a.organizacao_id = v_convite.organizacao_id;

        if v_limite_membros is null then
            select limite_membros into v_limite_membros
            from public.planos where slug = 'starter';
        end if;

        select count(*) into v_uso_atual
        from public.membros_organizacao
        where organizacao_id = v_convite.organizacao_id;

        if v_uso_atual >= v_limite_membros then
            raise exception 'Limite de membros do plano atingido (%/%)', v_uso_atual, v_limite_membros
                using errcode = 'ORB02';
        end if;
    end if;

    -- Membership com o papel pre-determinado pelo convite, APENAS para quem
    -- ainda nao e membro. Quem ja e membro mantem integralmente o papel que
    -- tem: um convite nao promove nem rebaixa ninguem, e e por isso que o
    -- owner nao pode ser derrubado por um convite de 'member'.
    insert into public.membros_organizacao (
        organizacao_id,
        user_id,
        papel
    ) values (
        v_convite.organizacao_id,
        v_user_id,
        v_convite.papel
    )
    on conflict (organizacao_id, user_id)
    do nothing;

    -- Marcar convite como aceito
    update public.convites_organizacao
    set status = 'accepted',
        accepted_at = now()
    where id = v_convite.id;

    return v_convite.organizacao_id;
end;
$$;

revoke all on function public.aceitar_convite_organizacao(text) from public, anon;
grant execute on function public.aceitar_convite_organizacao(text) to authenticated, service_role;
