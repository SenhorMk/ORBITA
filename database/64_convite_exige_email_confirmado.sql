-- 64_convite_exige_email_confirmado.sql
-- Forward-only. Ticket 06 — fatia final, achado da revisão externa da PR #84.
--
-- ---------------------------------------------------------------------------
-- A LACUNA
-- ---------------------------------------------------------------------------
-- A migration 63 fechou o convite ao portador: a aceitação passou a comparar o
-- e-mail do convite com o e-mail do registro de `auth.uid()`, e não com um
-- e-mail vindo do cliente. Só que ela leu **apenas** `auth.users.email`.
--
-- O contrato do Ticket 06 diz outra coisa: "somente uma conta autenticada cujo
-- email **verificado** corresponda ao email do convite pode aceitá-lo". Um
-- endereço que existe na linha do usuário não é um endereço provado. Enquanto a
-- confirmação não acontece, `auth.users.email` é o que a pessoa **digitou** no
-- cadastro — ninguém demonstrou possuir aquela caixa.
--
-- O buraco que isso abre é direto: quem souber o e-mail de um convite pendente
-- cria uma conta com esse endereço, não confirma nada, e aceita o convite. O
-- convite nominal volta a valer para quem apenas *afirma* ser o destinatário.
-- É a mesma classe de defeito da 63, um passo adiante: lá a identidade não era
-- checada, aqui ela é checada contra uma afirmação não verificada.
--
-- ---------------------------------------------------------------------------
-- O CAMPO CANÔNICO, E POR QUE É ESTE
-- ---------------------------------------------------------------------------
-- `auth.users.email_confirmed_at`. Conferido no schema real do Staging em
-- 2026-09-09: coluna `timestamptz`, `is_generated = NEVER`, escrita pelo GoTrue
-- quando a confirmação acontece (e no ato do cadastro quando o projeto não
-- exige confirmação — os 6 usuários do Staging estão todos confirmados, então
-- esta migration não tranca ninguém que hoje entra).
--
-- **Não** se usa `confirmed_at`: ela é `GENERATED ALWAYS AS
-- (LEAST(email_confirmed_at, phone_confirmed_at))`, ou seja, fica preenchida
-- também por confirmação de **telefone**. Um convite nominal é por e-mail;
-- aceitar por prova de telefone seria aceitar por prova de outra coisa.
--
-- Nota para quem for mexer nos testes: o `auth.users` do laboratório descartável
-- **não** tem esta coluna. `supabase db start` sobe só o Postgres, as migrations
-- do GoTrue não rodam, e o que sobra é o esqueleto da imagem base. Quem precisa
-- executar esta função no laboratório acrescenta a coluna no próprio harness —
-- ver `supabase/tests/database/convite_nominal_identidade.test.sql`. Uma
-- migration deste repositório não altera o schema `auth`, que não é dele.
--
-- ---------------------------------------------------------------------------
-- O QUE MUDA, E O QUE NÃO MUDA
-- ---------------------------------------------------------------------------
-- Uma condição a mais no bloco de identidade da 63, e nada além disso. Ela vem
-- no mesmo lugar — **antes de qualquer escrita** —, então a conta com o e-mail
-- certo mas não confirmado é recusada sem consumir o convite, sem mudar status,
-- sem criar membership, sem reservar vaga e sem tocar em papel nenhum.
--
-- A recusa tem mensagem própria para o log interno do servidor
-- (`registrarFalhaInterna`) poder dizer o que houve. A resposta HTTP continua
-- sendo a mesma frase única para toda recusa: a rota não vira oráculo sobre
-- quem existe, quem confirmou e qual token vale (CWE-209, Ticket 20).
--
-- Preservado literalmente da 63/49: `security definer`, `search_path = public`,
-- o `for update` sobre a linha do convite, o `pg_advisory_xact_lock` por
-- organização, o status de ciclo de vida (ORB01), o limite do plano recomputado
-- dentro do lock (ORB02), o uso único, o `on conflict do nothing` que preserva
-- o papel de quem já é membro, e os `grant`s. Nenhuma tabela, coluna, política
-- ou permissão muda: esta migration redefine uma função e mais nada.
--
-- REINTRODUZIR O DEFEITO: apague a condição `email_confirmed_at is null`. O
-- pgTAP `convite_nominal_identidade.test.sql` falha no caso (b).
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
    v_identidade record;
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
    -- auth.uid(), nunca um e-mail vindo do cliente.
    --
    -- Este bloco inteiro vem ANTES de qualquer escrita de propósito: nenhuma
    -- das recusas abaixo pode consumir o convite, marcar expiracao, mudar
    -- membership ou reservar vaga. Recusar sem efeito e parte do contrato.
    select u.email, u.email_confirmed_at into v_identidade
    from auth.users u
    where u.id = v_user_id;

    if v_identidade.email is null then
        raise exception 'Identidade sem e-mail no registro nao aceita convite nominal' using errcode = '42501';
    end if;

    -- O e-mail precisa estar PROVADO, e nao apenas declarado: sem confirmacao,
    -- `auth.users.email` e o endereco que a pessoa digitou no cadastro, e
    -- qualquer um pode digitar o endereco de um convite pendente.
    if v_identidade.email_confirmed_at is null then
        raise exception 'E-mail da identidade ainda nao foi confirmado' using errcode = '42501';
    end if;

    -- A normalizacao e a mesma que criar_convite_organizacao aplica ao gravar.
    if lower(trim(v_identidade.email)) is distinct from lower(trim(v_convite.email)) then
        raise exception 'Convite pertence a outro destinatario' using errcode = '42501';
    end if;

    -- ACHADO, PRESERVADO: este `update` nunca chega a valer. O `raise` abaixo
    -- aborta a (sub)transacao e leva a marcacao com ele, entao o convite
    -- expirado continua `pending` no banco. E assim desde a migration 21, e a
    -- 64 nao muda: o que o contrato do Ticket 06 exige — que o convite expirado
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
