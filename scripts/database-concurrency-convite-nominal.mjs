import { observarBloqueioNoPostgres } from './database-concurrency.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Ticket 06 — atomicidade do aceite de convite, contra Postgres real.
 *
 * `aceitar_convite_organizacao` (migration 63, sobre a reserva atômica da 49)
 * faz duas afirmações de exclusão mútua, e o pgTAP não consegue provar nenhuma
 * das duas: ele chama a função **uma vez por vez**, e uma função chamada uma
 * vez por vez nunca revela se ela seria segura chamada duas vezes ao mesmo
 * tempo. As duas afirmações são:
 *
 * 1. **A vaga do plano é reservada, não conferida.** Dois convites distintos,
 *    para duas pessoas distintas, disputando o último slot: a contagem é
 *    recomputada *dentro* de `pg_advisory_xact_lock(org || ':membros')`, então
 *    a segunda a chegar vê o membro que a primeira acabou de inserir. Sem o
 *    lock, as duas leriam `1 < 2` e as duas entrariam — o TOCTOU que a
 *    migration 49 existe para fechar.
 *
 * 2. **O convite é de uso único.** Duas aceitações do MESMO token disputam o
 *    `for update` sobre a linha do convite. A segunda, ao destravar, relê a
 *    linha já commitada e encontra `status = 'accepted'`.
 *
 * ## Por que a barreira é observada no banco, e não cronometrada
 *
 * Este módulo reusa `observarBloqueioNoPostgres` de `database-concurrency.mjs`
 * pela razão descrita lá: disparar duas promises juntas e ver que a segunda
 * "ainda não resolveu" prova apenas que ela não resolveu, e não que ela chegou
 * ao Postgres e está presa. A prova vem de `pg_stat_activity` marcando a
 * conexão B com `wait_event_type = 'Lock'` enquanto A segura a transação
 * aberta. Se essa marca não aparecer dentro do orçamento, o ensaio REPROVA em
 * vez de seguir supondo que houve sobreposição.
 */

const ORG_SLOT_ID = 'c6000000-0000-4000-8000-000000000001';
const ORG_UNICO_ID = 'c6000000-0000-4000-8000-000000000002';
const OWNER_ID = 'c6000000-0000-4000-8000-00000000000a';
const CONVIDADO_A_ID = 'c6000000-0000-4000-8000-00000000000b';
const CONVIDADO_B_ID = 'c6000000-0000-4000-8000-00000000000c';
const CONVIDADO_C_ID = 'c6000000-0000-4000-8000-00000000000d';

const EMAIL_OWNER = 'owner-convite-t06@orbita.test';
const EMAIL_A = 'convidado-a-t06@orbita.test';
const EMAIL_B = 'convidado-b-t06@orbita.test';
const EMAIL_C = 'convidado-c-t06@orbita.test';

const TOKEN_A = 'token-t06-slot-aaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-t06-slot-bbbbbbbbbbbbbbbbbbbb';
const TOKEN_UNICO = 'token-t06-uso-unico-cccccccccccccccc';

/** Quanto tempo o ensaio espera pela marca de bloqueio no `pg_stat_activity`. */
const JANELA_DE_OBSERVACAO_MS = 3000;

/**
 * Semeia duas organizações do plano starter com o limite de membros apertado
 * para 2 (owner + 1), e os convites de cada cenário.
 *
 * O limite entra por `limites_customizados` — o mesmo caminho que
 * `entitlement_reserva_concorrente.test.sql` usa — para que a disputa pelo
 * último slot precise de um único membro extra em vez de vários.
 *
 * @param {import('pg').Client} client - Conexão administrativa para o seed.
 * @returns {Promise<void>}
 */
async function semear(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1,$2),($3,$4),($5,$6),($7,$8)
     on conflict (id) do nothing`,
    [OWNER_ID, EMAIL_OWNER, CONVIDADO_A_ID, EMAIL_A, CONVIDADO_B_ID, EMAIL_B, CONVIDADO_C_ID, EMAIL_C],
  );

  for (const [id, slug] of [[ORG_SLOT_ID, 'org-t06-slot'], [ORG_UNICO_ID, 'org-t06-uso-unico']]) {
    await client.query(
      `insert into public.organizacoes (id, nome, slug) values ($1, $2, $2)
       on conflict (id) do nothing`,
      [id, slug],
    );
    await client.query(
      `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
       on conflict (organizacao_id, user_id) do nothing`,
      [id, OWNER_ID],
    );
    // A assinatura é criada por `criar_organizacao_atomica`; estas orgs nascem
    // do INSERT direto, então o vínculo com o plano entra aqui.
    await client.query(
      `insert into public.assinaturas_organizacao (organizacao_id, plano_id, status, limites_customizados)
       select $1, p.id, 'active', jsonb_build_object('limite_membros', 2)
       from public.planos p where p.slug = 'starter'
       on conflict (organizacao_id) do update set limites_customizados = excluded.limites_customizados`,
      [id],
    );
  }

  // Os dois convites da disputa pelo slot (A e B, na mesma organização), e o
  // convite de uso único (C, que aceita duas vezes ao mesmo tempo).
  await client.query(
    `insert into public.convites_organizacao (organizacao_id, email, papel, token, created_by)
     values ($1,$2,'member',$3,$8), ($1,$4,'member',$5,$8), ($6,$7,'member',$9,$8)
     on conflict (token) do nothing`,
    [ORG_SLOT_ID, EMAIL_A, TOKEN_A, EMAIL_B, TOKEN_B, ORG_UNICO_ID, EMAIL_C, OWNER_ID, TOKEN_UNICO],
  );
}

/**
 * Chama o aceite como um usuário autenticado específico, sem lançar.
 *
 * `auth.uid()` resolve por `request.jwt.claim.sub`, e é assim que o pgTAP deste
 * repositório já encena identidade. O `set` é de sessão (não `local`) porque a
 * conexão do ensaio é dedicada a um ator só.
 *
 * @param {import('pg').Client} client - Conexão do ator.
 * @param {string} userId - Sujeito do JWT encenado.
 * @param {string} token - Token do convite.
 * @returns {Promise<{ readonly ok: boolean, readonly organizacaoId?: string, readonly code?: string }>} Resultado tagueado da chamada.
 */
async function aceitar(client, userId, token) {
  try {
    await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
    const { rows } = await client.query('select public.aceitar_convite_organizacao($1) as org', [token]);
    return { ok: true, organizacaoId: rows[0]?.org };
  } catch (causa) {
    return { ok: false, code: causa?.code ?? 'unknown' };
  }
}

/**
 * A barreira determinística, uma vez só.
 *
 * As duas exclusões mútuas deste módulo têm a MESMA coreografia — A abre
 * transação e chama, B chama e trava, o Postgres confirma o travamento, A
 * commita, B destrava e reavalia. Escrevê-la duas vezes seria duas chances de
 * escrevê-la errado, e o passo que se erra é sempre o mesmo: seguir adiante
 * sem ter provado que houve sobreposição. Aqui esse passo é obrigatório.
 *
 * @param {object} contexto - Conexões, chamadas e prefixo de diagnóstico.
 * @param {() => Promise<{ readonly ok: boolean, readonly code?: string }>} contexto.primeira - A chamada de A, dentro da transação aberta.
 * @param {() => Promise<{ readonly ok: boolean, readonly code?: string }>} contexto.segunda - A chamada de B, que deve travar.
 * @param {string} contexto.prefixo - Prefixo dos `_tag` de falha do cenário.
 * @param {string} contexto.codigoDaPerdedora - O SQLSTATE com que B tem de perder.
 * @param {string} contexto.porQueBPerde - Por que B perde, para o diagnóstico de "as duas venceram".
 * @param {number} contexto.timeoutMs - Orçamento de observação do bloqueio.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Os dois resultados e o wait_event observado, ou falha tagueada.
 */
async function corridaComBarreira({
  admin, clientA, clientB, primeira, segunda, prefixo, codigoDaPerdedora, porQueBPerde, timeoutMs,
}) {
  await clientA.query('BEGIN');
  const resultadoA = await primeira();
  if (!resultadoA.ok) {
    await clientA.query('ROLLBACK');
    return err(
      `${prefixo}PrimeiraChamadaFalhou`,
      'A primeira chamada, sozinha na transação aberta, deveria suceder; falhou antes de existir concorrência',
      { resultadoA },
    );
  }

  const pidDeB = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;
  const promiseB = segunda();

  const observacao = await observarBloqueioNoPostgres(admin, pidDeB, { timeoutMs });
  if (!observacao.observado) {
    await clientA.query('ROLLBACK').catch(() => {});
    const resultadoB = await promiseB;
    return err(
      `${prefixo}NaoBloqueou`,
      'pg_stat_activity nunca marcou B esperando um Lock enquanto A segurava a transação aberta: '
        + 'a sobreposição real não foi observada no banco',
      { pidDeB, timeoutMs, resultadoB },
    );
  }

  await clientA.query('COMMIT');
  const resultadoB = await promiseB;

  // A asserção que define uma exclusão mútua: B perde, e perde pela razão que o
  // mecanismo promete. "As duas venceram" e "a segunda falhou por outro motivo"
  // são dois defeitos diferentes, e nenhum dos dois pode passar por prova. Ela
  // mora aqui porque é idêntica nos dois cenários — só o SQLSTATE muda.
  if (resultadoB.ok) {
    return err(`${prefixo}DuasVencedoras`, porQueBPerde, { resultadoA, resultadoB });
  }
  if (resultadoB.code !== codigoDaPerdedora) {
    return err(
      `${prefixo}FalhaErrada`,
      `A perdedora deveria falhar com ${codigoDaPerdedora}, não com ${resultadoB.code}`,
      { resultadoB },
    );
  }

  return ok(Object.freeze({ resultadoA, resultadoB, waitEvent: observacao.waitEvent }));
}

/**
 * Cenário 1: duas pessoas diferentes, dois convites válidos, um slot.
 *
 * @param {object} clientes - Conexões já conectadas.
 * @param {number} timeoutMs - Orçamento de observação do bloqueio.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
async function ensaiarUltimoSlot(clientes, timeoutMs) {
  const corrida = await corridaComBarreira({
    ...clientes,
    primeira: () => aceitar(clientes.clientA, CONVIDADO_A_ID, TOKEN_A),
    segunda: () => aceitar(clientes.clientB, CONVIDADO_B_ID, TOKEN_B),
    prefixo: 'ConviteSlot',
    codigoDaPerdedora: 'ORB02',
    porQueBPerde: 'O slot já era de A quando B recomputou a contagem dentro do lock, então B tinha de ser '
      + 'recusada por ORB02 — mas B também venceu, e o limite do plano foi furado',
    timeoutMs,
  });
  if (corrida._tag === 'err') return corrida;
  const { resultadoB, waitEvent } = corrida.value;

  const { rows } = await clientes.admin.query(
    `select (select count(*)::int from public.membros_organizacao where organizacao_id = $1) as membros,
            (select status from public.convites_organizacao where token = $2) as status_a,
            (select status from public.convites_organizacao where token = $3) as status_b`,
    [ORG_SLOT_ID, TOKEN_A, TOKEN_B],
  );
  const [estado] = rows;

  if (estado.membros !== 2) {
    return err(
      'ConviteSlotContagemFurada',
      `A organização deveria terminar com exatamente 2 membros (owner + A); terminou com ${estado.membros}`,
      { estado },
    );
  }
  if (estado.status_b !== 'pending') {
    return err(
      'ConviteSlotConsumidoNaRecusa',
      `O convite de B foi recusado e não pode ter sido consumido; ficou "${estado.status_b}"`,
      { estado },
    );
  }

  return ok(Object.freeze({
    bloqueioObservadoNoPostgres: waitEvent,
    perdedoraCode: resultadoB.code,
    membrosFinais: estado.membros,
    statusDoConviteAceito: estado.status_a,
    statusDoConviteRecusado: estado.status_b,
  }));
}

/**
 * Cenário 2: a mesma pessoa, o mesmo token, duas vezes ao mesmo tempo.
 *
 * @param {object} clientes - Conexões já conectadas.
 * @param {number} timeoutMs - Orçamento de observação do bloqueio.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
async function ensaiarUsoUnico(clientes, timeoutMs) {
  const corrida = await corridaComBarreira({
    ...clientes,
    primeira: () => aceitar(clientes.clientA, CONVIDADO_C_ID, TOKEN_UNICO),
    segunda: () => aceitar(clientes.clientB, CONVIDADO_C_ID, TOKEN_UNICO),
    prefixo: 'ConviteUnico',
    codigoDaPerdedora: '22000',
    porQueBPerde: 'O mesmo token foi aceito duas vezes: a segunda tinha de encontrar o convite já '
      + 'consumido (22000), e o uso único não sobreviveu à concorrência',
    timeoutMs,
  });
  if (corrida._tag === 'err') return corrida;
  const { resultadoB, waitEvent } = corrida.value;

  const { rows } = await clientes.admin.query(
    `select (select count(*)::int from public.membros_organizacao
               where organizacao_id = $1 and user_id = $2) as memberships,
            (select count(*)::int from public.membros_organizacao where organizacao_id = $1) as membros`,
    [ORG_UNICO_ID, CONVIDADO_C_ID],
  );
  const [estado] = rows;

  if (estado.memberships !== 1 || estado.membros !== 2) {
    return err(
      'ConviteUnicoMembershipDuplicada',
      `Esperava uma única membership para C e 2 membros na organização; encontrou ${estado.memberships} e ${estado.membros}`,
      { estado },
    );
  }

  return ok(Object.freeze({
    bloqueioObservadoNoPostgres: waitEvent,
    segundaTentativaCode: resultadoB.code,
    membershipsDoConvidado: estado.memberships,
    membrosFinais: estado.membros,
  }));
}

/**
 * Prova as duas exclusões mútuas do aceite de convite contra Postgres real.
 *
 * @param {object} [options] - Fábrica de clientes e janela de observação injetáveis para teste.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência dos dois cenários ou falha tagueada.
 */
export async function runConviteNominalRaceRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-convite-nominal'),
  timeoutDeObservacaoMs = JANELA_DE_OBSERVACAO_MS,
} = {}) {
  const admin = createClient();
  const clientA = createClient();
  const clientB = createClient();
  try {
    await admin.connect();
    await semear(admin);
    await clientA.connect();
    await clientB.connect();

    const clientes = { admin, clientA, clientB };

    const slot = await ensaiarUltimoSlot(clientes, timeoutDeObservacaoMs);
    if (slot._tag === 'err') return slot;

    const unico = await ensaiarUsoUnico(clientes, timeoutDeObservacaoMs);
    if (unico._tag === 'err') return unico;

    return ok(Object.freeze({ ...slot.value, usoUnico: unico.value }));
  } catch (causa) {
    await clientA.query('ROLLBACK').catch(() => {});
    return err(
      'ConviteNominalRaceIndisponivel',
      'O ensaio de concorrência do aceite de convite não pôde ser executado no laboratório local',
      {},
      causa instanceof Error ? causa.message : String(causa),
    );
  } finally {
    await admin.end().catch(() => {});
    await clientA.end().catch(() => {});
    await clientB.end().catch(() => {});
  }
}
