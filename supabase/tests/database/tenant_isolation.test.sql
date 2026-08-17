begin;

select plan(7);

create schema lab_fixture;

create table lab_fixture.tenants (
    id uuid primary key,
    name text not null
);

create table lab_fixture.memberships (
    tenant_id uuid not null references lab_fixture.tenants(id),
    user_id uuid not null references auth.users(id),
    role text not null check (role in ('owner', 'collaborator')),
    primary key (tenant_id, user_id)
);

create table lab_fixture.documents (
    id uuid primary key,
    tenant_id uuid not null references lab_fixture.tenants(id),
    title text not null
);

insert into auth.users (id, email)
values
    ('10000000-0000-4000-8000-000000000001', 'owner-a@orbita.test'),
    ('10000000-0000-4000-8000-000000000002', 'owner-b@orbita.test'),
    ('10000000-0000-4000-8000-000000000003', 'collaborator-a@orbita.test'),
    ('10000000-0000-4000-8000-000000000004', 'external@orbita.test');

insert into lab_fixture.tenants (id, name)
values
    ('20000000-0000-4000-8000-000000000001', 'Tenant A'),
    ('20000000-0000-4000-8000-000000000002', 'Tenant B');

insert into lab_fixture.memberships (tenant_id, user_id, role)
values
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner'),
    ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'owner'),
    ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'collaborator');

insert into lab_fixture.documents (id, tenant_id, title)
values
    ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Tenant A private document'),
    ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Tenant B private document');

alter table lab_fixture.documents enable row level security;

create policy tenant_members_can_read_documents
on lab_fixture.documents
for select
to authenticated
using (
    exists (
        select 1
        from lab_fixture.memberships
        where memberships.tenant_id = documents.tenant_id
          and memberships.user_id = (select auth.uid())
    )
);

grant usage on schema lab_fixture to anon, authenticated, service_role;
grant select on lab_fixture.memberships to authenticated;
grant select on lab_fixture.documents to anon, authenticated, service_role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
select is(
    (select count(*) from lab_fixture.documents where tenant_id = '20000000-0000-4000-8000-000000000001'),
    1::bigint,
    'tenant A owner can read tenant A data'
);
select is(
    (select count(*) from lab_fixture.documents where tenant_id = '20000000-0000-4000-8000-000000000002'),
    0::bigint,
    'tenant A owner cannot read tenant B data'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000003';
select is(
    (select count(*) from lab_fixture.documents),
    1::bigint,
    'tenant A collaborator can read tenant A data'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000004';
select is(
    (select count(*) from lab_fixture.documents),
    0::bigint,
    'external authenticated user cannot read tenant data'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-4000-8000-000000000002';
select is(
    (select count(*) from lab_fixture.documents),
    1::bigint,
    'tenant B owner can read only tenant B data'
);
reset role;

set local role anon;
select is(
    (select count(*) from lab_fixture.documents),
    0::bigint,
    'anonymous user cannot read tenant data'
);
reset role;

set local role service_role;
select is(
    (select count(*) from lab_fixture.documents),
    2::bigint,
    'privileged service role can exercise the unfiltered database path'
);
reset role;

select * from finish();
rollback;
