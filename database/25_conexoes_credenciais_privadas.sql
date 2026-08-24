-- ============================================================================
-- 25_conexoes_credenciais_privadas.sql
-- Ticket 29: Criar conexões e credenciais privadas
-- Infraestrutura de integrações organizacionais com cofre de credenciais criptografado
-- ============================================================================

-- 1. Tabela de Conexões de Integração (Pública para a organização via RLS)
create table if not exists public.conexoes_integracao (
    id              uuid primary key default gen_random_uuid(),
    organizacao_id  uuid not null references public.organizacoes(id) on delete cascade,
    provedor        text not null check (provedor in ('bling', 'chatwoot', 'stripe', 'custom')),
    nome            text not null default 'Principal',
    status          text not null default 'pendente' check (status in ('pendente', 'conectado', 'erro', 'desconectado')),
    metadata        jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Índices para conexões
create index if not exists idx_conexoes_integracao_org
    on public.conexoes_integracao(organizacao_id);

create unique index if not exists uq_conexoes_integracao_org_provedor_nome
    on public.conexoes_integracao(organizacao_id, provedor, nome);

-- 2. Tabela de Credenciais de Integração (Armazenamento Privado e Criptografado)
create table if not exists public.credenciais_integracao (
    id              uuid primary key default gen_random_uuid(),
    conexao_id      uuid not null references public.conexoes_integracao(id) on delete cascade,
    organizacao_id  uuid not null references public.organizacoes(id) on delete cascade,
    chave_versao    text not null default 'v1',
    dados_cifrados  text not null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Índices para credenciais
create index if not exists idx_credenciais_integracao_org
    on public.credenciais_integracao(organizacao_id);

create unique index if not exists uq_credenciais_integracao_conexao
    on public.credenciais_integracao(conexao_id);

-- 3. Triggers de updated_at
drop trigger if exists tg_conexoes_integracao_updated_at on public.conexoes_integracao;
create trigger tg_conexoes_integracao_updated_at
    before update on public.conexoes_integracao
    for each row execute function public.fn_set_updated_at();

drop trigger if exists tg_credenciais_integracao_updated_at on public.credenciais_integracao;
create trigger tg_credenciais_integracao_updated_at
    before update on public.credenciais_integracao
    for each row execute function public.fn_set_updated_at();

-- 4. Trigger de Integridade Organizacional entre Credencial e Conexão
create or replace function public.fn_sync_credenciais_integracao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_conexao_org_id uuid;
begin
    if new.conexao_id is not null then
        select organizacao_id into v_conexao_org_id
        from public.conexoes_integracao
        where id = new.conexao_id;

        if v_conexao_org_id is null then
            raise exception 'Conexao nao encontrada' using errcode = '23503';
        end if;

        if new.organizacao_id is null then
            new.organizacao_id := v_conexao_org_id;
        elsif new.organizacao_id != v_conexao_org_id then
            raise exception 'Credencial pertence a organizacao diferente da conexao' using errcode = '23503';
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_sync_credenciais_integracao on public.credenciais_integracao;
create trigger trg_sync_credenciais_integracao
    before insert or update on public.credenciais_integracao
    for each row execute function public.fn_sync_credenciais_integracao();

-- 5. Concessão de Privilégios Mínimos e Explícitos (ASVS L2)
-- Conexões de integração: Metadados operacionais acessíveis a usuários autenticados via RLS
grant select, insert, update, delete on public.conexoes_integracao to authenticated;
grant all on public.conexoes_integracao to postgres, service_role;

-- Credenciais de integração: ARMAZENAMENTO ESTRITAMENTE PRIVADO (sem acesso Data API / authenticated)
revoke all on public.credenciais_integracao from public, anon, authenticated;
grant all on public.credenciais_integracao to postgres, service_role;

-- 6. Row Level Security (RLS)
alter table public.conexoes_integracao enable row level security;
alter table public.credenciais_integracao enable row level security;

-- Conexões: Membros da organização podem visualizar e gerenciar conexões
drop policy if exists "Acesso a conexoes_integracao por organizacao" on public.conexoes_integracao;
create policy "Acesso a conexoes_integracao por organizacao"
    on public.conexoes_integracao
    for all
    to authenticated
    using (public.usuario_pertence_a_organizacao(organizacao_id))
    with check (public.usuario_pertence_a_organizacao(organizacao_id));

-- Credenciais: FAIL-CLOSED para clientes
-- Nenhuma política criada para anon/authenticated.
-- Apenas chamadas autenticadas server-side via service_role conseguem consultar ou modificar.
