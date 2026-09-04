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

select plan(69);

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
    has_function_privilege('authenticated', 'public.concluir_tentativa_venda_manual(uuid,uuid,text,uuid,text,text)', 'EXECUTE'),
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

select throws_ok(
    format($q$delete from public.intervencoes_venda_manual where id = %L$q$, (select id from intervencao)),
    '42501',
    null,
    '66. o registro de intervenção não pode ser apagado'
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

select * from finish();
rollback;
