-- estado_de_sincronizacao_da_foto_com_bling.test.sql
-- Migration 72, contra o schema canônico completo: `imagem_bling_sync_path`
-- (estado confirmado no Bling) preso ao prefixo da própria linha, o
-- compare-and-set que impede uma resposta atrasada de marcar outra foto, e os
-- eventos de auditoria da sincronização.

begin;

select plan(12);

insert into auth.users (id, email)
values ('72000000-0000-4000-8000-000000000001', 'owner-t72@orbita.test');

insert into public.organizacoes (id, nome, slug, status) values
    ('72100000-0000-4000-8000-000000000001', 'Org A T72', 'org-a-t72', 'active'),
    ('72100000-0000-4000-8000-000000000002', 'Org B T72', 'org-b-t72', 'active');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('72100000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'owner');

insert into public.produtos (id, organizacao_id, user_id, bling_id, nome, imagem_storage_path)
values ('72200000-0000-4000-8000-00000000000a', '72100000-0000-4000-8000-000000000001',
        '72000000-0000-4000-8000-000000000001', '72001', 'Produto T72',
        '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png');

select has_column('public', 'produtos', 'imagem_bling_sync_path', '1. produtos.imagem_bling_sync_path existe');
select col_type_is('public', 'produtos', 'imagem_bling_sync_path', 'text', '2. o estado confirmado é só o caminho (texto)');
select col_is_null('public', 'produtos', 'imagem_bling_sync_path', '3. nulo = nada confirmado no Bling');

select throws_ok(
    $$update public.produtos
         set imagem_bling_sync_path = '72100000-0000-4000-8000-000000000002/72200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
       where id = '72200000-0000-4000-8000-00000000000a'$$,
    '23514', null,
    '4. caminho confirmado com a organização de outro tenant é recusado'
);

select throws_ok(
    $$update public.produtos
         set imagem_bling_sync_path = 'https://proj.supabase.co/storage/v1/object/sign/produto-imagens/x.png?token=abc'
       where id = '72200000-0000-4000-8000-00000000000a'$$,
    '23514', null,
    '5. URL assinada nunca é persistida como estado confirmado'
);

-- 6. A sincronização da foto A termina depois de o usuário trocar para B: o
-- compare-and-set condicionado a A não encontra a linha.
update public.produtos
   set imagem_storage_path = '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png'
 where id = '72200000-0000-4000-8000-00000000000a';

update public.produtos
   set imagem_bling_sync_path = '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'
 where id = '72200000-0000-4000-8000-00000000000a'
   and organizacao_id = '72100000-0000-4000-8000-000000000001'
   and imagem_storage_path = '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png';

select is(
    (select imagem_bling_sync_path from public.produtos where id = '72200000-0000-4000-8000-00000000000a'),
    null,
    '6. resposta atrasada da foto A não marca a foto B como sincronizada'
);

-- 7. A sincronização de B marca B.
update public.produtos
   set imagem_bling_sync_path = imagem_storage_path
 where id = '72200000-0000-4000-8000-00000000000a'
   and organizacao_id = '72100000-0000-4000-8000-000000000001'
   and imagem_storage_path = '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png';

select is(
    (select imagem_bling_sync_path = imagem_storage_path from public.produtos where id = '72200000-0000-4000-8000-00000000000a'),
    true,
    '7. a sincronização da foto atual marca o estado confirmado'
);

-- 8. A sincronização Bling -> ORBITA regrava o espelho sem tocar a foto nem a confirmação.
update public.produtos set imagem_url = 'https://bling/nova.jpg', nome = 'Produto T72 (Bling)'
 where id = '72200000-0000-4000-8000-00000000000a';

select is(
    (select imagem_bling_sync_path from public.produtos where id = '72200000-0000-4000-8000-00000000000a'),
    '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png',
    '8. regravar imagem_url não toca o estado confirmado'
);

-- 9. Remoção de foto ainda não confirmada: o desejado vai a null e o confirmado
-- guarda a foto que o Bling pode exibir, na mesma instrução (remoção pendente).
update public.produtos
   set imagem_storage_path = null,
       imagem_bling_sync_path = '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png'
 where id = '72200000-0000-4000-8000-00000000000a'
   and organizacao_id = '72100000-0000-4000-8000-000000000001'
   and imagem_storage_path = '72100000-0000-4000-8000-000000000001/72200000-0000-4000-8000-00000000000a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png';

select is(
    (select imagem_storage_path is null and imagem_bling_sync_path is not null
       from public.produtos where id = '72200000-0000-4000-8000-00000000000a'),
    true,
    '9. remoção pendente no Bling é um estado válido (desejado nulo, confirmado preso à linha)'
);

select is(
    (select count(*)::int from public.catalogo_eventos_auditoria
      where nome in ('catalog.product_image_bling_sync_pending', 'catalog.product_image_bling_synced', 'catalog.product_image_bling_sync_failed')
        and produtor = 'catalog' and ator_esperado = 'user' and retention_dias = 730),
    3,
    '10. os três eventos da sincronização estão no catálogo SQL'
);

select is(
    (select severidade from public.catalogo_eventos_auditoria where nome = 'catalog.product_image_bling_sync_failed'),
    'warning',
    '11. falha de sincronização é warning'
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';

select ok(
    public.registrar_evento_auditoria(
        '72100000-0000-4000-8000-000000000001'::uuid,
        '72000000-0000-4000-8000-000000000001'::uuid,
        'catalog.product_image_bling_synced',
        'produto',
        '72200000-0000-4000-8000-00000000000a',
        'corr_t72',
        null,
        null,
        '{"produto_id": "72200000-0000-4000-8000-00000000000a", "operacao": "adicionar", "havia_sincronizacao_anterior": false, "resultado": "sincronizada"}'::jsonb
    ) is not null,
    '12. a RPC de auditoria grava o evento novo para um ator membro'
);

reset role;

select * from finish();
rollback;
