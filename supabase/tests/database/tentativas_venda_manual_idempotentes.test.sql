-- tentativas_venda_manual_idempotentes.test.sql
-- Ticket 30, fatia 3, migration 59 — endurecida nas 3ª, 4ª, 5ª e 6ª rodadas.
--
-- Prova a reivindicação atômica que fecha o gap de retentativa: sem isto,
-- uma retentativa (humana, de proxy, de navegador) depois de um estado
-- indeterminado geraria uma referência nova e criaria um SEGUNDO pedido
-- real no Bling — trocando "compensação destrutiva" por "duplicação
-- externa".
--
-- **5ª rodada de revisão**, duas fatias novas provadas aqui:
--
-- 1. **A chave sozinha não basta.** Reconhecer a referência responde "já vi
--    este UUID?", não "esta é a MESMA operação?". As asserções 8-15, 18 e
--    23-24 provam a regra: mesma referência + fingerprint diferente é
--    CONFLITO — nunca executa, nunca reabre, e nunca devolve o desfecho da
--    outra operação.
-- 2. **Isolamento multi-tenant.** A migration introduziu uma tabela e RPCs
--    `security definer` que decidem se uma escrita externa no ERP pode
--    acontecer. As asserções 25-41 provam identidade por
--    `(organizacao_id, referencia_local)`, impossibilidade de concluir
--    tentativa alheia, GRANTs, `search_path` fixo e RLS.
--
-- **6ª rodada de revisão:** as asserções 42-46 fecham o caso do PREÇO. O
-- fingerprint cobre o que o cliente pediu; ele não cobre o que a venda vale,
-- porque preço e total são derivados no servidor. Uma tentativa `falhou`
-- reaberta depois de o preço mudar reexecutaria a venda por outro valor sem
-- ninguém confirmar o valor novo — agora é recusada.
--
-- REINTRODUZIR O DEFEITO: troque o `\ir` da migration 59 por nada. As
-- asserções todas falham — a função nem existe. Para provar só a fatia do
-- fingerprint, remova o ramo `if v_existente.fingerprint is distinct from
-- p_fingerprint` da função: 8-15, 18 e 23-24 falham. Para a fatia dos
-- valores, remova o ramo `if v_existente.valores_fingerprint is distinct
-- from p_valores_fingerprint`: 43 e 45 falham.

begin;

create table public.clientes (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    nome    text not null
);

-- Esqueleto: só a coluna que `tentativas_venda_manual.pedido_id` referencia.
-- Este teste não afirma nada sobre `pedidos` em si.
create table public.pedidos (
    id uuid primary key default gen_random_uuid()
);

insert into auth.users (id, email)
values ('59000000-0000-4000-8000-000000000001', 'owner-t59@orbita.test'),
       ('59000000-0000-4000-8000-000000000002', 'owner-b-t59@orbita.test');

\ir ../../../database/20_organizacao_membership_ativa.sql
\ir ../../../database/21_convites_papeis_capacidades.sql
\ir ../../../database/59_tentativas_venda_manual_idempotentes.sql

insert into public.organizacoes (id, nome, slug)
values ('59100000-0000-4000-8000-000000000001', 'Org T59 A', 'org-t59-a'),
       ('59100000-0000-4000-8000-000000000002', 'Org T59 B', 'org-t59-b');

insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ('59100000-0000-4000-8000-000000000001', '59000000-0000-4000-8000-000000000001', 'owner'),
       ('59100000-0000-4000-8000-000000000002', '59000000-0000-4000-8000-000000000002', 'owner');

select plan(111);

-- ----------------------------------------------------------------------------
-- 1-4. Primeira reivindicação: tentativa nova.
-- ----------------------------------------------------------------------------
create temp table primeira as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a', 'fingerprint-venda-1', 'valores-iguais'
);

select is((select estado from primeira), 'em_andamento', '1. primeira reivindicação: estado em_andamento');
select is((select is_duplicate from primeira), false, '2. primeira reivindicação: não é duplicata');
select isnt((select tentativa_id from primeira), null, '3. primeira reivindicação: devolve um id');
select is((select fingerprint_conflitante from primeira), false, '4. primeira reivindicação: sem conflito de conteúdo');

-- ----------------------------------------------------------------------------
-- 5-7. Reivindicar a MESMA referência com o MESMO conteúdo: é retentativa.
--      Devolve o mesmo desfecho — é isso que barra a retentativa concorrente
--      sem chamar o Bling de novo (handler reage com 409, sem side effect).
-- ----------------------------------------------------------------------------
create temp table segunda_em_andamento as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a', 'fingerprint-venda-1', 'valores-iguais'
);

select is((select estado from segunda_em_andamento), 'em_andamento', '5. segunda reivindicação, mesmo conteúdo: continua em_andamento');
select is((select is_duplicate from segunda_em_andamento), true, '6. segunda reivindicação: É duplicata — não insere linha nova');
select is((select fingerprint_conflitante from segunda_em_andamento), false, '7. segunda reivindicação: mesmo conteúdo, então não é conflito');

-- ----------------------------------------------------------------------------
-- 8-15. CONFLITO DE CONTEÚDO (5ª rodada). A MESMA referência reenviada para
--       uma venda DIFERENTE não é retentativa. Não pode executar, não pode
--       devolver o desfecho da outra operação, e não pode alterar nada.
-- ----------------------------------------------------------------------------
create temp table conflito as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a', 'fingerprint-venda-OUTRA', 'valores-iguais'
);

select is((select fingerprint_conflitante from conflito), true, '8. mesma chave + conteúdo diferente: sinaliza conflito');
select is((select is_duplicate from conflito), true, '9. …a chave de fato já estava em uso');
select is((select tentativa_id from conflito), null, '10. …e NÃO devolve o id da tentativa alheia');
select is((select pedido_id from conflito), null, '11. …nem o pedido da outra operação');
select is((select estado from conflito), null, '12. …nem o estado dela — o resultado da outra operação não é desta');

select is(
    (select estado from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001' and referencia_local = 'referencia-a'),
    'em_andamento',
    '13. o conflito NÃO altera o estado gravado da tentativa original'
);
select is(
    (select fingerprint from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001' and referencia_local = 'referencia-a'),
    'fingerprint-venda-1',
    '14. …nem sobrescreve o fingerprint dela com o da submissão conflitante'
);
select is(
    (select count(*) from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001' and referencia_local = 'referencia-a'),
    1::bigint,
    '15. …e não cria uma segunda linha para a mesma chave'
);

-- ----------------------------------------------------------------------------
-- 16-18. Conclui como indeterminada. A PRÓXIMA reivindicação com a mesma
--        referência tem de devolver esse estado — é o que impede a
--        retentativa de chamar o Bling. Com conteúdo diferente, continua
--        sendo conflito: um estado terminal não libera a chave para OUTRA
--        venda.
-- ----------------------------------------------------------------------------
select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from primeira), 'indeterminada', null, '918273'
);

create temp table terceira_indeterminada as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a', 'fingerprint-venda-1', 'valores-iguais'
);

select is((select estado from terceira_indeterminada), 'indeterminada', '16. terceira reivindicação: encontra o estado indeterminada gravado');
select is((select bling_pedido_id from terceira_indeterminada), '918273', '17. …com o bling_pedido_id preservado, para a mensagem poder citá-lo');

create temp table indeterminada_com_outro_conteudo as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-a', 'fingerprint-venda-OUTRA', 'valores-iguais'
);

select is(
    (select fingerprint_conflitante from indeterminada_com_outro_conteudo),
    true,
    '18. tentativa INDETERMINADA + conteúdo diferente: conflito, nunca o resultado anterior'
);

-- ----------------------------------------------------------------------------
-- 19-20. Uma referência DIFERENTE não é afetada pela primeira.
-- ----------------------------------------------------------------------------
create temp table referencia_b as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-b', 'fingerprint-venda-2', 'valores-iguais'
);

select is((select estado from referencia_b), 'em_andamento', '19. referência diferente: tentativa nova, não vê a indeterminada da referência-a');
select is((select is_duplicate from referencia_b), false, '20. …não é duplicata');

-- ----------------------------------------------------------------------------
-- 21-24. Uma tentativa que FALHOU definitivamente é REABERTA — nada ficou
--        pendente no Bling numa falha definitiva com compensação confirmada,
--        então é seguro retentar com a MESMA referência. Mas só para a MESMA
--        venda: reabrir para outro conteúdo seria a chave de idempotência
--        autorizando uma operação que ela não identifica.
-- ----------------------------------------------------------------------------
select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from referencia_b), 'falhou', null, null
);

create temp table reaberta_apos_falha as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-b', 'fingerprint-venda-2', 'valores-iguais'
);

select is((select estado from reaberta_apos_falha), 'em_andamento', '21. referência que falhou é reaberta como em_andamento, não bloqueada para sempre');
select is((select is_duplicate from reaberta_apos_falha), false, '22. …e a reabertura conta como tentativa nova, não duplicata');

select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from referencia_b), 'falhou', null, null
);

create temp table falhou_com_outro_conteudo as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-b', 'fingerprint-venda-COMPLETAMENTE-OUTRA', 'valores-iguais'
);

select is(
    (select fingerprint_conflitante from falhou_com_outro_conteudo),
    true,
    '23. tentativa FALHOU + conteúdo diferente: conflito, não reabre a chave para outra venda'
);
select is(
    (select estado from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001' and referencia_local = 'referencia-b'),
    'falhou',
    '24. …e a tentativa continua falhou, não foi reaberta pelo conflito'
);

-- ----------------------------------------------------------------------------
-- 25-28. MULTI-TENANT (5ª rodada): a identidade é (organizacao_id,
--        referencia_local), não referencia_local sozinha. Duas organizações
--        podem usar a MESMA referência sem colidir e sem se enxergar.
-- ----------------------------------------------------------------------------
create temp table org_b_mesma_referencia as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000002', 'referencia-a', 'fingerprint-da-org-b', 'valores-iguais'
);

select is((select estado from org_b_mesma_referencia), 'em_andamento', '25. org B usando a MESMA referencia_local: tentativa nova');
select is((select is_duplicate from org_b_mesma_referencia), false, '26. …não é duplicata — a chave de outra organização não é a mesma chave');
select isnt(
    (select tentativa_id from org_b_mesma_referencia),
    (select tentativa_id from primeira),
    '27. …e é uma tentativa distinta da de org A com a mesma referência'
);
select is(
    (select count(*) from public.tentativas_venda_manual where referencia_local = 'referencia-a'),
    2::bigint,
    '28. duas linhas com a mesma referencia_local, uma por organização'
);

-- ----------------------------------------------------------------------------
-- 29-31. Concluir uma tentativa ALHEIA é impossível, mesmo com o id em mãos.
--        `concluir_tentativa_venda_manual` é `security definer` (ignora RLS
--        por construção), então o predicado de organização dentro dela é a
--        única barreira que resta — e é o que estas asserções fixam.
-- ----------------------------------------------------------------------------
select throws_ok(
    format(
        $$select public.concluir_tentativa_venda_manual(%L, %L, 'concluida', null, '111')$$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from org_b_mesma_referencia)
    ),
    'P0002',
    null,
    '29. org A não consegue concluir a tentativa de org B, nem com o id correto'
);

select is(
    (select estado from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000002' and referencia_local = 'referencia-a'),
    'em_andamento',
    '30. …e a tentativa de org B fica intacta depois da tentativa de invasão'
);

select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000002', (select tentativa_id from org_b_mesma_referencia), 'concluida', null, '222'
);

select is(
    (select estado from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000002' and referencia_local = 'referencia-a'),
    'concluida',
    '31. a própria organização conclui a sua tentativa normalmente'
);

-- ----------------------------------------------------------------------------
-- 32-38. Superfície de privilégio das duas RPCs e da tabela.
-- ----------------------------------------------------------------------------
select is(
    has_function_privilege('authenticated', 'public.reivindicar_tentativa_venda_manual(uuid,text,text,text)', 'EXECUTE'),
    false,
    '32. authenticated NÃO executa a reivindicação — só a service role, pelo servidor'
);
select is(
    has_function_privilege('authenticated', 'public.concluir_tentativa_venda_manual(uuid,uuid,text,uuid,text,text,integer)', 'EXECUTE'),
    false,
    '33. authenticated NÃO executa a conclusão'
);
select is(
    has_table_privilege('anon', 'public.tentativas_venda_manual', 'SELECT'),
    false,
    '34. anon não lê a tabela de tentativas'
);
select is(
    (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'reivindicar_tentativa_venda_manual'),
    true,
    '35. reivindicar é security definer'
);
select is(
    (select p.proconfig::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'reivindicar_tentativa_venda_manual'),
    '{search_path=public}',
    '36. …com search_path fixado, não herdado do chamador'
);
select is(
    (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'concluir_tentativa_venda_manual'),
    true,
    '37. concluir é security definer'
);
select is(
    (select p.proconfig::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'concluir_tentativa_venda_manual'),
    '{search_path=public}',
    '38. …com search_path fixado'
);

-- ----------------------------------------------------------------------------
-- 39-41. RLS na tabela: um membro de uma organização não enxerga as
--        tentativas da outra, mesmo com SELECT concedido a `authenticated`.
-- ----------------------------------------------------------------------------
select is(
    (select relrowsecurity from pg_class where oid = 'public.tentativas_venda_manual'::regclass),
    true,
    '39. row level security habilitada na tabela'
);

set local role authenticated;
set local request.jwt.claim.sub = '59000000-0000-4000-8000-000000000001';

select is(
    (select count(*) from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000002'),
    0::bigint,
    '40. membro da org A não enxerga NENHUMA tentativa da org B via RLS'
);
select is(
    (select count(*) from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001'),
    2::bigint,
    '41. …e continua enxergando as duas da própria organização'
);

reset role;

-- ----------------------------------------------------------------------------
-- 42-46. VALORES RESOLVIDOS (6ª rodada). A venda pedida é a mesma, mas os
--        preços do cadastro mudaram entre as tentativas. Uma tentativa
--        `falhou` NÃO pode reabrir em silêncio executando o valor novo: quem
--        confirmou a venda confirmou um total.
-- ----------------------------------------------------------------------------
create temp table valores_nova as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-valores', 'fingerprint-venda-V', 'valores-de-ontem'
);
select is((select is_duplicate from valores_nova), false, '42. tentativa nova com snapshot de valores: criada normalmente');

select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from valores_nova), 'falhou', null, null
);

create temp table valores_mudaram as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-valores', 'fingerprint-venda-V', 'valores-de-HOJE'
);

select is((select valores_divergentes from valores_mudaram), true, '43. mesma venda, preços diferentes: sinaliza divergência de valores');
select is((select fingerprint_conflitante from valores_mudaram), false, '44. …e NÃO é conflito de conteúdo — o que o cliente pediu não mudou');
select is(
    (select estado from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001' and referencia_local = 'referencia-valores'),
    'falhou',
    '45. …a tentativa continua falhou: não foi reaberta pelo preço novo'
);

create temp table valores_iguais_reabre as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-valores', 'fingerprint-venda-V', 'valores-de-ontem'
);
select is((select estado from valores_iguais_reabre), 'em_andamento', '46. com os MESMOS valores, a reabertura continua funcionando');

-- ----------------------------------------------------------------------------
-- 47-52. PENDÊNCIA IDÊNTICA (6ª rodada). Uma referência NOVA para uma venda
--        que já tem outra tentativa sem desfecho é recusada: não dá para
--        saber se é a mesma venda tentada de novo (navegador sem memória,
--        outro dispositivo) ou uma segunda venda legitimamente idêntica —
--        e as duas leituras erradas causam dano. É o que torna a proteção
--        independente do `localStorage`.
-- ----------------------------------------------------------------------------
create temp table pendente_original as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-pendente-1', 'fingerprint-repetido', 'valores-iguais'
);
select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from pendente_original), 'indeterminada', null, '55555'
);

create temp table nova_referencia_mesma_venda as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-pendente-2', 'fingerprint-repetido', 'valores-iguais'
);

select is(
    (select referencia_pendente from nova_referencia_mesma_venda),
    'referencia-pendente-1',
    '47. referência NOVA para venda com pendência idêntica: devolve a referência pendente'
);
select is((select tentativa_id from nova_referencia_mesma_venda), null, '48. …não abre tentativa nova');
select is(
    (select count(*) from public.tentativas_venda_manual
      where organizacao_id = '59100000-0000-4000-8000-000000000001' and referencia_local = 'referencia-pendente-2'),
    0::bigint,
    '49. …e não deixa linha órfã no ledger'
);

-- Resolvida a pendência, a mesma venda pode ser aberta de novo: é o que
-- permite uma segunda venda legitimamente idêntica depois da conferência.
select public.concluir_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from pendente_original), 'concluida', null, '55555'
);

create temp table depois_de_resolver as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'referencia-pendente-3', 'fingerprint-repetido', 'valores-iguais'
);

select is((select referencia_pendente from depois_de_resolver), null, '50. resolvida a pendência, a mesma venda abre normalmente');
select is((select estado from depois_de_resolver), 'em_andamento', '51. …como tentativa nova');

-- A pendência de OUTRA organização não bloqueia esta.
create temp table pendencia_de_outra_org as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000002', 'referencia-pendente-9', 'fingerprint-repetido', 'valores-iguais'
);
select is(
    (select referencia_pendente from pendencia_de_outra_org),
    null,
    '52. a pendência de outra organização não bloqueia: o recorte é por organização'
);

-- ----------------------------------------------------------------------------
-- 53-58. EXCLUSÃO MÚTUA DE PENDÊNCIA (7ª rodada), agora imposta pelo BANCO.
--        A guarda da 6ª rodada era inserir-consultar-apagar, que não vale sob
--        concorrência: em READ COMMITTED cada transação não enxerga a linha
--        não commitada da outra. O índice único PARCIAL substitui isso.
-- ----------------------------------------------------------------------------
select has_index(
    'public', 'tentativas_venda_manual', 'uq_tentativas_venda_manual_pendencia_por_fingerprint',
    '53. existe índice único parcial de pendência por fingerprint'
);
select is(
    (select indisunique from pg_index where indexrelid = 'public.uq_tentativas_venda_manual_pendencia_por_fingerprint'::regclass),
    true,
    '54. …e ele é ÚNICO, não apenas um índice de busca'
);
select isnt(
    (select indpred from pg_index where indexrelid = 'public.uq_tentativas_venda_manual_pendencia_por_fingerprint'::regclass),
    null,
    '55. …e é PARCIAL — é o predicado que libera a venda idêntica depois de resolvida'
);

create temp table exclusao_primeira as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'exclusao-ref-1', 'fingerprint-exclusao', 'valores-exclusao'
);
select isnt((select tentativa_id from exclusao_primeira), null, '56. primeira referência do fingerprint: autorizada');

-- A inserção direta de uma segunda pendência para o mesmo fingerprint é
-- recusada pelo próprio banco, sem depender de nenhuma função.
select throws_ok(
    $q$insert into public.tentativas_venda_manual (organizacao_id, referencia_local, fingerprint, valores_fingerprint, estado)
       values ('59100000-0000-4000-8000-000000000001', 'invasora-direta', 'fingerprint-exclusao', 'valores-exclusao', 'em_andamento')$q$,
    '23505',
    null,
    '57. o banco recusa uma SEGUNDA pendência para o mesmo fingerprint, mesmo por INSERT direto'
);

create temp table exclusao_segunda as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'exclusao-ref-2', 'fingerprint-exclusao', 'valores-exclusao'
);
select is(
    (select referencia_pendente from exclusao_segunda),
    'exclusao-ref-1',
    '58. referência DIFERENTE, mesma venda: recusada apontando a pendência'
);

-- ----------------------------------------------------------------------------
-- 59-62. CAS em `concluir` (7ª rodada). Idade não é sincronização: quem chega
--        depois e opina sobre tentativa alheia precisa provar que o estado não
--        mudou entre ler e decidir.
-- ----------------------------------------------------------------------------
select lives_ok(
    format(
        $q$select public.concluir_tentativa_venda_manual(%L, %L, 'indeterminada', null, null, 'em_andamento')$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from exclusao_primeira)
    ),
    '59. CAS com o estado esperado correto: escreve'
);
select throws_ok(
    format(
        $q$select public.concluir_tentativa_venda_manual(%L, %L, 'falhou', null, null, 'em_andamento')$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from exclusao_primeira)
    ),
    '40001',
    null,
    '60. CAS com estado esperado DESATUALIZADO: recusa em vez de sobrescrever'
);
select is(
    (select estado from public.tentativas_venda_manual where id = (select tentativa_id from exclusao_primeira)),
    'indeterminada',
    '61. …e o estado permanece o que era, não o que a escrita perdida queria'
);
select lives_ok(
    format(
        $q$select public.concluir_tentativa_venda_manual(%L, %L, 'falhou', null, null)$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from exclusao_primeira)
    ),
    '62. sem estado esperado, a escrita é incondicional — é o caminho de quem PRODUZIU o efeito'
);

-- ----------------------------------------------------------------------------
-- 63-69. INTERVENÇÕES: auditoria imutável + claim de concorrência (7ª rodada).
-- ----------------------------------------------------------------------------
create temp table intervencao as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001',
    (select tentativa_id from exclusao_primeira),
    'cancelar-no-bling',
    '59000000-0000-4000-8000-000000000001',
    '918273'
) as id;

select isnt((select id from intervencao), null, '63. a intervenção é reivindicada e devolve um id');
select is(
    (select ator_id from public.intervencoes_venda_manual where id = (select id from intervencao)),
    '59000000-0000-4000-8000-000000000001'::uuid,
    '64. …com o ator verificado registrado'
);

select throws_ok(
    format(
        $q$select public.reivindicar_intervencao_venda_manual(%L, %L, 'cancelar-no-bling', %L, '918273')$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from exclusao_primeira),
        '59000000-0000-4000-8000-000000000001'
    ),
    '55006',
    null,
    '65. uma SEGUNDA intervenção em voo para a mesma tentativa é recusada — o claim'
);

-- 8ª rodada: DELETE deixou de ser bloqueado. Medido contra Postgres real, o
-- bloqueio travava o ciclo de vida inteiro — apagar a tentativa E apagar a
-- ORGANIZAÇÃO falhavam com 42501, porque o cascade batia no gatilho. A
-- imutabilidade que importa (não reescrever o que o registro afirma) segue
-- valendo, e é o que a asserção 67 fixa.
select is(
    (select count(*) from pg_trigger t
      where t.tgrelid = 'public.intervencoes_venda_manual'::regclass
        and not t.tgisinternal and (t.tgtype::int & 8) <> 0),
    0::bigint,
    '66. o registro NÃO tem gatilho de DELETE travando o ciclo de vida'
);
select throws_ok(
    format($q$update public.intervencoes_venda_manual set ator_id = gen_random_uuid() where id = %L$q$, (select id from intervencao)),
    '42501',
    null,
    '67. …nem ter reescrito o que afirma sobre a solicitação'
);

select lives_ok(
    format(
        $q$select public.encerrar_intervencao_venda_manual(%L, %L, 'confirmada', 'cancelado no Bling')$q$,
        '59100000-0000-4000-8000-000000000001', (select id from intervencao)
    ),
    '68. o desfecho pode ser gravado uma vez'
);
select throws_ok(
    format(
        $q$select public.encerrar_intervencao_venda_manual(%L, %L, 'falhou', 'tentando reescrever')$q$,
        '59100000-0000-4000-8000-000000000001', (select id from intervencao)
    ),
    'P0002',
    null,
    '69. …e não pode ser reescrito depois'
);

-- ----------------------------------------------------------------------------
-- 70-77. FENCING POR ÉPOCA (8ª rodada). CAS unilateral protegia só um sentido:
--        handler conclui, reconciliação perde. O inverso — reconciliação vence,
--        libera o fingerprint, e o handler antigo retoma e grava
--        incondicionalmente — ficava aberto. Reproduzido contra Postgres real
--        em `scripts/database-concurrency-fencing.mjs` (modo `sem-fencing`).
-- ----------------------------------------------------------------------------
create temp table fenc as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'fenc-ref-1', 'fingerprint-fenc', 'valores-fenc'
);

select is((select epoca from fenc), 1, '70. a reivindicação devolve a época vigente');

-- A reconciliação toma a posse: a época avança.
create temp table posse as
select public.assumir_tentativa_para_reconciliacao(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from fenc), 1, 'em_andamento'
) as epoca;

select is((select epoca from posse), 2, '71. tomar a posse avança a época');

-- O executor ANTERIOR, com a época velha, deixa de poder escrever.
select throws_ok(
    format(
        $q$select public.concluir_tentativa_venda_manual(%L, %L, 'concluida', null, '111', null, 1)$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from fenc)
    ),
    '55P03',
    null,
    '72. o executor cercado NÃO consegue concluir — nem sucesso, nem falha'
);

-- Tomar a posse duas vezes com a mesma época também é recusado: só um dono.
select throws_ok(
    format(
        $q$select public.assumir_tentativa_para_reconciliacao(%L, %L, 1, 'em_andamento')$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from fenc)
    ),
    '55P03',
    null,
    '73. quem chega com a época velha não toma a posse de novo'
);

-- E o novo dono escreve normalmente.
select lives_ok(
    format(
        $q$select public.concluir_tentativa_venda_manual(%L, %L, 'falhou', null, null, null, 2)$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from fenc)
    ),
    '74. o dono vigente escreve normalmente'
);

select is(
    (select estado from public.tentativas_venda_manual where id = (select tentativa_id from fenc)),
    'falhou',
    '75. …e o estado é o do dono vigente, não o do executor cercado'
);

-- Reabrir uma tentativa também troca de dono: a época avança de novo.
create temp table reaberta_fenc as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'fenc-ref-1', 'fingerprint-fenc', 'valores-fenc'
);
select is((select epoca from reaberta_fenc), 3, '76. reabrir avança a época — é um dono novo');

select throws_ok(
    format(
        $q$select public.concluir_tentativa_venda_manual(%L, %L, 'concluida', null, null, null, 2)$q$,
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from fenc)
    ),
    '55P03',
    null,
    '77. …e o dono da rodada anterior fica cercado por sua vez'
);

-- ----------------------------------------------------------------------------
-- 78-81. INTERVENÇÃO AMBÍGUA não libera o claim (8ª rodada). O índice anterior
--        cobria só `resultado is null`; gravar `ambigua` liberava outra
--        intervenção para repetir a mutação sobre o mesmo pedido.
-- ----------------------------------------------------------------------------
create temp table tent_amb as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'amb-ref-1', 'fingerprint-amb', 'valores-amb'
);

create temp table interv_amb as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_amb),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '777'
) as id;

select lives_ok(
    format(
        $q$select public.encerrar_intervencao_venda_manual(%L, %L, 'ambigua', 'ACK perdido')$q$,
        '59100000-0000-4000-8000-000000000001', (select id from interv_amb)
    ),
    '78. a intervenção pode ser encerrada como ambígua'
);

select throws_ok(
    format(
        $q$select public.reivindicar_intervencao_venda_manual(%L, %L, 'cancelar-no-bling', %L, '777')$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_amb),
        '59000000-0000-4000-8000-000000000001'
    ),
    '55006',
    null,
    '79. uma intervenção AMBÍGUA continua bloqueando o claim — nada de repetir a mutação'
);

-- Já `falhou` (recusa provada, nada mudou no ERP) libera para tentar de novo.
create temp table tent_falha as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'falha-ref-1', 'fingerprint-falha', 'valores-falha'
);
create temp table interv_falha as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_falha),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '888'
) as id;
select public.encerrar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select id from interv_falha), 'falhou', 'recusado pelo contrato'
);

select lives_ok(
    format(
        $q$select public.reivindicar_intervencao_venda_manual(%L, %L, 'cancelar-no-bling', %L, '888')$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_falha),
        '59000000-0000-4000-8000-000000000001'
    ),
    '80. uma recusa PROVADA (`falhou`) libera o claim: nada mudou no ERP'
);

select is(
    (select count(*) from public.intervencoes_venda_manual
      where tentativa_id = (select tentativa_id from tent_falha)),
    2::bigint,
    '81. …e as duas intervenções ficam registradas, não sobrescritas'
);

-- ----------------------------------------------------------------------------
-- 82-85. FINALIZAÇÃO ATÔMICA (8ª rodada). Depois de um efeito externo
--        confirmado, tentativa e intervenção fecham na MESMA transação — ou
--        as duas valem, ou nenhuma vale.
-- ----------------------------------------------------------------------------
create temp table tent_fin as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'fin-ref-1', 'fingerprint-fin', 'valores-fin'
);
create temp table interv_fin as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_fin),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '999'
) as id;

select lives_ok(
    format(
        $q$select public.finalizar_intervencao_e_tentativa(%L, %L, %L, 'confirmada', 'falhou', '999', null, 1)$q$,
        '59100000-0000-4000-8000-000000000001',
        (select id from interv_fin),
        (select tentativa_id from tent_fin)
    ),
    '82. finaliza tentativa e intervenção juntas'
);
select is(
    (select estado from public.tentativas_venda_manual where id = (select tentativa_id from tent_fin)),
    'falhou',
    '83. …a tentativa fechou'
);
select is(
    (select resultado from public.intervencoes_venda_manual where id = (select id from interv_fin)),
    'confirmada',
    '84. …e a auditoria fechou junto'
);

-- Época errada: a transação inteira é recusada, e NADA fica gravado pela metade.
create temp table tent_fin2 as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'fin-ref-2', 'fingerprint-fin2', 'valores-fin2'
);
create temp table interv_fin2 as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_fin2),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '1000'
) as id;

select throws_ok(
    format(
        $q$select public.finalizar_intervencao_e_tentativa(%L, %L, %L, 'confirmada', 'falhou', '1000', null, 99)$q$,
        '59100000-0000-4000-8000-000000000001',
        (select id from interv_fin2),
        (select tentativa_id from tent_fin2)
    ),
    '55P03',
    null,
    '85. com época errada, a finalização inteira é recusada — nada pela metade'
);

-- ----------------------------------------------------------------------------
-- 86-89. AUDITORIA × CICLO DE VIDA (8ª rodada). Medido: a versão anterior
--        bloqueava com `42501` tanto apagar a tentativa quanto apagar a
--        ORGANIZAÇÃO — um log "imutável" que travava o lifecycle inteiro.
-- ----------------------------------------------------------------------------
select is(
    (select count(*) from pg_trigger t
      where t.tgrelid = 'public.intervencoes_venda_manual'::regclass
        and not t.tgisinternal
        and (t.tgtype::int & 8) <> 0),
    0::bigint,
    '86. não há mais gatilho de DELETE bloqueando o ciclo de vida'
);

select is(
    (select confdeltype from pg_constraint
      where conrelid = 'public.intervencoes_venda_manual'::regclass
        and confrelid = 'public.tentativas_venda_manual'::regclass),
    'n',
    '87. `tentativa_id` é ON DELETE SET NULL: o rastro sobrevive à tentativa'
);

select lives_ok(
    format($q$delete from public.tentativas_venda_manual where id = %L$q$, (select tentativa_id from tent_fin)),
    '88. apagar a tentativa é permitido…'
);
select is(
    (select count(*) from public.intervencoes_venda_manual where id = (select id from interv_fin)),
    1::bigint,
    '89. …e o registro de intervenção continua lá, com a referência preservada'
);


-- ----------------------------------------------------------------------------
-- 90-91. B6 (9ª rodada) — TOMAR POSSE EXIGE ESTADO **E** ÉPOCA.
--
-- Conferir só a época aceitava este entrelaçamento: a rota lê `em_andamento`
-- na época N; o handler conclui a tentativa, ainda na época N; a reconciliação
-- assume com N e passa a agir sobre uma tentativa que já tem desfecho. A época
-- não registra que o ESTADO andou.
--
-- REINTRODUZIR O DEFEITO: remova `and estado = p_estado_esperado` do UPDATE em
-- `assumir_tentativa_para_reconciliacao`. A asserção 90 falha.
-- ----------------------------------------------------------------------------
create temp table tent_cas as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'cas-ref-1', 'fingerprint-cas', 'valores-cas'
);

select throws_ok(
    format(
        $q$select public.assumir_tentativa_para_reconciliacao(%L, %L, 1, 'indeterminada')$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_cas)
    ),
    '55P03',
    null,
    '90. época certa mas estado esperado errado: a posse NÃO é tomada'
);

select is(
    (select public.assumir_tentativa_para_reconciliacao(
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_cas), 1, 'em_andamento'
    )),
    2,
    '91. estado e época corretos: a posse é tomada e a época avança'
);

-- ----------------------------------------------------------------------------
-- 92-95. B7 (9ª rodada) — O BYPASS DO `SET NULL` É ESTRITO.
--
-- O caminho especial que deixa `tentativa_id → NULL` passar existe para o
-- ciclo de vida (apagar a tentativa, apagar a organização). A 8ª rodada
-- comparava só PARTE dos campos, então um UPDATE podia desvincular a tentativa
-- E, na mesma instrução, reescrever `bling_pedido_id`, `solicitada_em`,
-- `concluida_em` ou `created_at` — reescrevendo história por dentro do bypass.
--
-- REINTRODUZIR O DEFEITO: volte o ramo do `set null` a comparar só
-- `id/organizacao_id/referencia_local/acao/ator_id/resultado/detalhe`. As
-- asserções 92-94 falham.
-- ----------------------------------------------------------------------------
create temp table tent_b7 as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'b7-ref-1', 'fingerprint-b7', 'valores-b7'
);
create temp table interv_b7 as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_b7),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '2000'
) as id;

select throws_ok(
    format(
        $q$update public.intervencoes_venda_manual set tentativa_id = null, bling_pedido_id = '9999' where id = %L$q$,
        (select id from interv_b7)
    ),
    '42501',
    null,
    '92. desvincular a tentativa NÃO pode carregar um bling_pedido_id novo'
);

select throws_ok(
    format(
        $q$update public.intervencoes_venda_manual set tentativa_id = null, solicitada_em = now() + interval '1 day' where id = %L$q$,
        (select id from interv_b7)
    ),
    '42501',
    null,
    '93. …nem reescrever quando a intervenção foi solicitada'
);

select throws_ok(
    format(
        $q$update public.intervencoes_venda_manual set tentativa_id = null, created_at = now() + interval '1 day', concluida_em = now() where id = %L$q$,
        (select id from interv_b7)
    ),
    '42501',
    null,
    '94. …nem `created_at`/`concluida_em`'
);

select lives_ok(
    format($q$update public.intervencoes_venda_manual set tentativa_id = null where id = %L$q$, (select id from interv_b7)),
    '95. o desvínculo puro — que é o que o `on delete set null` faz — continua passando'
);

-- ----------------------------------------------------------------------------
-- 96-105. B3 (9ª rodada) — A AMBIGUIDADE DEIXA DE SER UM BECO SEM SAÍDA.
--
-- Uma intervenção `ambigua` bloqueia o claim de propósito (a mutação no ERP
-- pode ter acontecido). Antes desta rodada, NADA a desbloqueava: a tentativa
-- ficava presa para sempre. A saída é uma decisão humana registrada, sem
-- repetir o PATCH, e APPEND-ONLY: o fato original não é reescrito.
--
-- REINTRODUZIR O DEFEITO: volte o predicado do índice a
-- `resultado is null or resultado = 'ambigua'`. A asserção 99 falha.
-- ----------------------------------------------------------------------------
create temp table tent_b3 as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'b3-ref-1', 'fingerprint-b3', 'valores-amb'
);
create temp table interv_b3 as
select public.reivindicar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_b3),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '3000'
) as id;

select public.encerrar_intervencao_venda_manual(
    '59100000-0000-4000-8000-000000000001', (select id from interv_b3), 'ambigua', 'ACK do PATCH nao chegou'
);

select throws_ok(
    format(
        $q$select public.reivindicar_intervencao_venda_manual(%L, %L, 'cancelar-no-bling', %L, '3000')$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_b3),
        '59000000-0000-4000-8000-000000000001'
    ),
    '55006',
    null,
    '96. enquanto a ambiguidade não é resolvida, nenhum novo cancelamento é reivindicado'
);

select throws_ok(
    format(
        $q$select public.resolver_intervencao_ambigua(%L, %L, %L, 'cancelado', '   ', 1)$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_b3),
        '59000000-0000-4000-8000-000000000001'
    ),
    '22023',
    null,
    '97. resolver sem evidência é recusado — decisão sem lastro não é decisão'
);

select throws_ok(
    format(
        $q$select public.resolver_intervencao_ambigua(%L, %L, %L, 'cancelado', 'Conferido no ERP', 1)$q$,
        '59100000-0000-4000-8000-000000000002',
        (select tentativa_id from tent_b3),
        '59000000-0000-4000-8000-000000000002'
    ),
    'P0002',
    null,
    '98. a organização B não enxerga — muito menos resolve — a ambiguidade da organização A'
);

create temp table resolucao_b3 as
select public.resolver_intervencao_ambigua(
    '59100000-0000-4000-8000-000000000001',
    (select tentativa_id from tent_b3),
    '59000000-0000-4000-8000-000000000002',
    'cancelado',
    'Pedido 3000 aparece como Cancelado no Bling.',
    1
) as id;

select is(
    (select count(*) from public.intervencoes_venda_manual
      where tentativa_id = (select tentativa_id from tent_b3)),
    2::bigint,
    '99. a resolução é uma LINHA NOVA: append-only, não reescrita'
);

select is(
    (select resultado || '|' || ator_id::text || '|' || detalhe
       from public.intervencoes_venda_manual where id = (select id from interv_b3)),
    'ambigua|59000000-0000-4000-8000-000000000001|ACK do PATCH nao chegou',
    '100. o fato histórico original continua exatamente como foi gravado'
);

select is(
    (select ator_id from public.intervencoes_venda_manual where id = (select id from resolucao_b3)),
    '59000000-0000-4000-8000-000000000002'::uuid,
    '101. …e a decisão nova registra o ator que a tomou, não o original'
);

select is(
    (select estado from public.tentativas_venda_manual where id = (select tentativa_id from tent_b3)),
    'falhou',
    '102. decidido `cancelado`: nada ficou pendente no ERP, e a referência é liberada'
);

select lives_ok(
    format(
        $q$select public.reivindicar_intervencao_venda_manual(%L, %L, 'cancelar-no-bling', %L, '3000')$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_b3),
        '59000000-0000-4000-8000-000000000001'
    ),
    '103. resolvida a ambiguidade, o claim volta a poder ser reivindicado'
);

select throws_ok(
    format(
        $q$update public.intervencoes_venda_manual set resolucao_id = %L where id = %L$q$,
        (select id from interv_b7),
        (select id from interv_b3)
    ),
    '42501',
    null,
    '104. a resolução não pode ser reapontada depois de registrada'
);

select throws_ok(
    format(
        $q$select public.resolver_intervencao_ambigua(%L, %L, %L, 'cancelado', 'Conferido de novo', 1)$q$,
        '59100000-0000-4000-8000-000000000001',
        (select tentativa_id from tent_b3),
        '59000000-0000-4000-8000-000000000001'
    ),
    'P0002',
    null,
    '105. resolver duas vezes não sobrescreve a primeira decisão'
);

-- ----------------------------------------------------------------------------
-- 106-109. As funções novas seguem a mesma disciplina das antigas: sem
--          execução para papéis do cliente, `search_path` fixo, e a posse
--          respondida pela época vigente.
-- ----------------------------------------------------------------------------
select ok(
    not has_function_privilege('authenticated', 'public.confirmar_posse_da_tentativa(uuid,uuid,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.registrar_venda_manual_com_posse(uuid,uuid,uuid,text,text,numeric,numeric,numeric,text,text,date,jsonb,uuid,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.resolver_intervencao_ambigua(uuid,uuid,uuid,text,text,integer)', 'EXECUTE'),
    '106. nenhuma das funções novas é executável por `authenticated`'
);

select is(
    (select count(*) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('confirmar_posse_da_tentativa', 'registrar_venda_manual_com_posse', 'resolver_intervencao_ambigua')
        and 'search_path=public' = any(coalesce(p.proconfig, array[]::text[]))),
    3::bigint,
    '107. …e as três fixam `search_path`, como toda função `security definer` daqui'
);

create temp table tent_posse as
select * from public.reivindicar_tentativa_venda_manual(
    '59100000-0000-4000-8000-000000000001', 'posse-ref-1', 'fingerprint-posse', 'valores-posse'
);

select is(
    (select public.confirmar_posse_da_tentativa(
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_posse), 1
    )),
    true,
    '108. a época vigente confirma a posse'
);

select is(
    (select public.confirmar_posse_da_tentativa(
        '59100000-0000-4000-8000-000000000001', (select tentativa_id from tent_posse), 99
    )),
    false,
    '109. uma época antiga não confirma — e é isso que barra o efeito externo do zumbi'
);


-- ----------------------------------------------------------------------------
-- 110-111. CICLO DE VIDA DEPOIS DA RESOLUÇÃO (10ª rodada de revisão).
--
-- `resolucao_id` é uma FK AUTORREFERENTE, e o gatilho de imutabilidade proíbe
-- reapontá-la. A pergunta que isso levanta é de CICLO DE VIDA: apagar a
-- organização remove as duas linhas — o fato ambíguo e a resolução — e nada
-- garante, à primeira vista, que a referência entre elas não trave o caminho.
--
-- Medido: não trava. O `on delete cascade` da organização remove as duas
-- linhas juntas, sem disparar o `set null` da FK autorreferente, então o
-- gatilho não chega a ser consultado. A asserção existe para MANTER isso —
-- é o mesmo tipo de impasse que a 8ª rodada mediu quando o gatilho bloqueava
-- `DELETE` e travava o encerramento de um tenant inteiro.
--
-- Esta é uma asserção de REGRESSÃO de ciclo de vida, não a prova de um defeito
-- que existiu: ela fixa um comportamento medido para que uma mudança futura no
-- gatilho ou na FK não volte a travar o encerramento de um tenant.
-- ----------------------------------------------------------------------------
create temp table org_ciclo as select '59100000-0000-4000-8000-000000000003'::uuid as id;

insert into public.organizacoes (id, nome, slug)
values ((select id from org_ciclo), 'Org T59 Ciclo', 'org-t59-ciclo');
insert into public.membros_organizacao (organizacao_id, user_id, papel)
values ((select id from org_ciclo), '59000000-0000-4000-8000-000000000001', 'owner');

create temp table tent_ciclo as
select * from public.reivindicar_tentativa_venda_manual(
    (select id from org_ciclo), 'ciclo-ref-1', 'fingerprint-ciclo', 'valores-ciclo'
);
create temp table interv_ciclo as
select public.reivindicar_intervencao_venda_manual(
    (select id from org_ciclo), (select tentativa_id from tent_ciclo),
    'cancelar-no-bling', '59000000-0000-4000-8000-000000000001', '4000'
) as id;

select public.encerrar_intervencao_venda_manual(
    (select id from org_ciclo), (select id from interv_ciclo), 'ambigua', 'ACK do PATCH nao chegou'
);
select public.resolver_intervencao_ambigua(
    (select id from org_ciclo),
    (select tentativa_id from tent_ciclo),
    '59000000-0000-4000-8000-000000000001',
    'cancelado',
    'Pedido 4000 aparece como Cancelado no Bling.',
    1
);

select lives_ok(
    format($q$delete from public.organizacoes where id = %L$q$, (select id from org_ciclo)),
    '110. apagar a organização depois de resolver a ambiguidade não trava no gatilho'
);

select is(
    (select count(*) from public.intervencoes_venda_manual where organizacao_id = (select id from org_ciclo)),
    0::bigint,
    '111. …e as duas linhas — o fato ambíguo e a resolução — foram embora com o tenant'
);

select * from finish();
rollback;
