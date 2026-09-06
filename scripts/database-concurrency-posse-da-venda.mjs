import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';

/**
 * Ticket 30 — 9ª rodada de revisão. B1, B2 e B4 numa prova só.
 *
 * ## O defeito
 *
 * O fencing da 8ª rodada protegia o LEDGER: um executor que perdeu a posse não
 * conseguia mais gravar o desfecho da tentativa. Não protegia a VENDA. A
 * gravação de pedido/itens/estoque/financeiro não olhava para a posse, e a
 * conclusão do ledger era uma chamada SEPARADA, depois. A sequência que isso
 * permitia:
 *
 *   1. o handler A possui a época 1 e já criou o pedido no Bling;
 *   2. A pausa antes de persistir;
 *   3. a reconciliação toma posse (época 2);
 *   4. ela vê pedido remoto e nenhuma venda local;
 *   5. CANCELA o pedido no Bling;
 *   6. encerra a tentativa;
 *   7. A retoma e grava a venda.
 *
 * Resultado: uma venda "completa" no ORBITA — com baixa de estoque e título
 * financeiro — apontando para um pedido que já não existe mais no ERP. E, na
 * outra ponta (B4), mesmo com a posse certa a venda commitava e o ledger podia
 * não commitar, produzindo `201` sem garantia de idempotência durável.
 *
 * ## A prova
 *
 * Não é uma corrida por lock: é ORDEM. O rehearsal encena a sequência acima
 * passo a passo contra PostgreSQL real e verifica, no fim, se a venda existe.
 *
 * - **`esperado: 'sem-posse'`** — reproduz o defeito chamando
 *   `registrar_venda_manual` direto, como o código fazia: o zumbi grava.
 * - **`esperado: 'com-posse'`** — prova a correção: `registrar_venda_manual_com_posse`
 *   recusa com `55P03`, e NADA foi gravado — nem pedido, nem item, nem baixa
 *   de estoque, nem título financeiro. E o controle positivo mostra que, com a
 *   posse certa, venda e ledger caem JUNTOS (B4).
 */

const ORG_ID = 'f0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'f0000000-0000-4000-8000-000000000002';
const CLIENTE_ID = 'f0000000-0000-4000-8000-000000000003';
const PRODUTO_ID = 'f0000000-0000-4000-8000-000000000004';
const REFERENCIA_ZUMBI = 'ORBITA-posse-zumbi';
const REFERENCIA_FELIZ = 'ORBITA-posse-feliz';
const BLING_PEDIDO_ZUMBI = '88888888881';
const BLING_PEDIDO_FELIZ = '88888888882';
const FINGERPRINT_ZUMBI = 'fingerprint-posse-zumbi';
const FINGERPRINT_FELIZ = 'fingerprint-posse-feliz';
const VALORES = 'valores-posse';
const ESTOQUE_INICIAL = 9;

async function seed(client) {
  await client.query(
    `insert into auth.users (id, email) values ($1, 'owner-posse-t30@orbita.test') on conflict (id) do nothing`,
    [OWNER_ID],
  );
  await client.query(
    `insert into public.organizacoes (id, nome, slug) values ($1, 'Org Posse T30', 'org-posse-t30')
     on conflict (id) do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into public.membros_organizacao (organizacao_id, user_id, papel) values ($1, $2, 'owner')
     on conflict (organizacao_id, user_id) do nothing`,
    [ORG_ID, OWNER_ID],
  );
  await client.query(
    `insert into public.clientes (id, user_id, organizacao_id, bling_id, nome)
     values ($1, $2, $3, '321', 'Cliente Posse') on conflict (id) do nothing`,
    [CLIENTE_ID, OWNER_ID, ORG_ID],
  );
  await client.query(
    `insert into public.produtos (id, user_id, organizacao_id, bling_id, nome, preco, estoque)
     values ($1, $2, $3, '654', 'Produto Posse', 10.00, $4) on conflict (id) do nothing`,
    [PRODUTO_ID, OWNER_ID, ORG_ID, ESTOQUE_INICIAL],
  );
}

const ITENS = JSON.stringify([{ produto_id: PRODUTO_ID, quantidade: 1, valor_unitario: 10.0 }]);

async function reivindicar(client, referencia, fingerprint) {
  const { rows } = await client.query(
    `select * from public.reivindicar_tentativa_venda_manual($1, $2, $3, $4)`,
    [ORG_ID, referencia, fingerprint, VALORES],
  );
  return rows[0];
}

/** Executa e devolve o desfecho observável, sem lançar. */
async function tentar(client, sql, params) {
  try {
    const { rows } = await client.query(sql, params);
    return { ok: true, rows };
  } catch (cause) {
    return { ok: false, code: cause?.code, message: cause?.message };
  }
}

/** O que sobrou no banco depois da tentativa do zumbi. */
async function efeitosDaVenda(client, blingPedidoId) {
  const { rows } = await client.query(
    `select
       (select count(*) from public.pedidos p
         where p.organizacao_id = $1 and p.bling_id = $2)::int as pedidos,
       (select count(*) from public.itens_pedido i
          join public.pedidos p on p.id = i.pedido_id
         where p.organizacao_id = $1 and p.bling_id = $2)::int as itens,
       (select count(*) from public.titulos_financeiros t
         where t.organizacao_id = $1 and t.descricao like '%' || $2 || '%')::int as titulos,
       (select estoque from public.produtos where id = $3)::int as estoque`,
    [ORG_ID, blingPedidoId, PRODUTO_ID],
  );
  return rows[0];
}

/**
 * @param {object} [options] - Fábrica de cliente e expectativa.
 * @param {'com-posse' | 'sem-posse'} [options.esperado] - O que se espera observar.
 * @returns {Promise<{ readonly _tag: 'ok', readonly value: Readonly<Record<string, unknown>> } | { readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }>} Evidência ou falha tagueada.
 */
export async function runPosseDaVendaRehearsal({
  createClient = () => createLocalDatabaseClient('orbita-database-concurrency-posse'),
  esperado = 'com-posse',
} = {}) {
  const client = createClient();
  try {
    await client.connect();
    await seed(client);

    // ---- 1. O handler A reivindica e vira dono (época 1). ----
    const original = await reivindicar(client, REFERENCIA_ZUMBI, FINGERPRINT_ZUMBI);
    if (!original.tentativa_id) {
      return err('PosseReivindicacaoFalhou', 'A reivindicação original deveria ter sido autorizada', { original });
    }
    const epocaDoOriginal = original.epoca;

    // ---- 2/3. A pausa; a reconciliação toma a posse (época 2). ----
    const { rows: assumidas } = await client.query(
      `select public.assumir_tentativa_para_reconciliacao($1, $2, $3, 'em_andamento') as epoca`,
      [ORG_ID, original.tentativa_id, epocaDoOriginal],
    );
    const epocaDaReconciliacao = assumidas[0].epoca;

    // ---- 4/5/6. Ela cancelou o pedido no Bling e encerrou a tentativa. ----
    await client.query(
      `select public.concluir_tentativa_venda_manual($1, $2, 'falhou', null, null, null, $3)`,
      [ORG_ID, original.tentativa_id, epocaDaReconciliacao],
    );

    // ---- 7. O EXECUTOR CERCADO RETOMA e tenta gravar a venda. ----
    const escritaDoZumbi = esperado === 'sem-posse'
      // O caminho antigo: a gravação não sabia nada sobre posse.
      ? await tentar(
        client,
        `select public.registrar_venda_manual($1,$2,$3,$4,$4,10.00,0,0,'Dinheiro',null,current_date,$5::jsonb) as pedido_id`,
        [ORG_ID, OWNER_ID, CLIENTE_ID, BLING_PEDIDO_ZUMBI, ITENS],
      )
      : await tentar(
        client,
        `select public.registrar_venda_manual_com_posse($1,$2,$3,$4,$4,10.00,0,0,'Dinheiro',null,current_date,$5::jsonb,$6,$7) as pedido_id`,
        [ORG_ID, OWNER_ID, CLIENTE_ID, BLING_PEDIDO_ZUMBI, ITENS, original.tentativa_id, epocaDoOriginal],
      );

    const efeitos = await efeitosDaVenda(client, BLING_PEDIDO_ZUMBI);

    if (esperado === 'sem-posse') {
      if (!escritaDoZumbi.ok || efeitos.pedidos !== 1) {
        return err(
          'PosseDefeitoNaoReproduzido',
          'Esperava reproduzir o executor cercado gravando a venda depois de perder a posse, e não reproduziu',
          { escritaDoZumbi, efeitos },
        );
      }
      return ok(Object.freeze({
        defeitoReproduzido: true,
        vendaDoZumbiGravada: true,
        estoqueBaixadoPeloZumbi: ESTOQUE_INICIAL - efeitos.estoque,
        titulosDoZumbi: efeitos.titulos,
      }));
    }

    // ---- Com posse: a gravação TEM de ser recusada, e NADA pode sobrar. ----
    if (escritaDoZumbi.ok) {
      return err('PosseZumbiGravou', 'O executor cercado conseguiu gravar a venda depois de perder a posse', {
        escritaDoZumbi, efeitos,
      });
    }
    if (escritaDoZumbi.code !== '55P03') {
      return err(
        'PosseCodigoErrado',
        `A recusa deveria ser 55P03 (tomada por outro executor); veio ${String(escritaDoZumbi.code)}`,
        { escritaDoZumbi },
      );
    }
    if (efeitos.pedidos !== 0 || efeitos.itens !== 0 || efeitos.titulos !== 0 || efeitos.estoque !== ESTOQUE_INICIAL) {
      return err(
        'PosseEfeitoResidual',
        'A recusa deixou efeito comercial para trás — a atomicidade da venda com a posse não vale',
        { efeitos, estoqueEsperado: ESTOQUE_INICIAL },
      );
    }

    // ---- CONTROLE POSITIVO (B4): com a posse certa, venda e ledger caem JUNTOS. ----
    const feliz = await reivindicar(client, REFERENCIA_FELIZ, FINGERPRINT_FELIZ);
    if (!feliz.tentativa_id) {
      return err('PosseCaminhoFelizBloqueado', 'A tentativa do controle positivo deveria abrir', { feliz });
    }
    const gravacaoFeliz = await tentar(
      client,
      `select public.registrar_venda_manual_com_posse($1,$2,$3,$4,$4,10.00,0,0,'Dinheiro',null,current_date,$5::jsonb,$6,$7) as pedido_id`,
      [ORG_ID, OWNER_ID, CLIENTE_ID, BLING_PEDIDO_FELIZ, ITENS, feliz.tentativa_id, feliz.epoca],
    );
    if (!gravacaoFeliz.ok) {
      return err('PosseCaminhoFelizRecusado', 'Com a posse vigente, a gravação deveria ter sido aceita', { gravacaoFeliz });
    }
    const { rows: ledger } = await client.query(
      `select estado, pedido_id from public.tentativas_venda_manual where id = $1`,
      [feliz.tentativa_id],
    );
    if (ledger[0].estado !== 'concluida' || ledger[0].pedido_id === null) {
      return err(
        'PosseLedgerNaoConcluiuJunto',
        'A venda commitou sem o ledger concluir na MESMA transação — o falso sucesso do B4 continua possível',
        { ledger: ledger[0] },
      );
    }

    return ok(Object.freeze({
      epocaDoOriginal,
      epocaDepoisDaTomada: epocaDaReconciliacao,
      gravacaoDoZumbiRecusadaCom: escritaDoZumbi.code,
      pedidosDoZumbi: efeitos.pedidos,
      estoquePreservado: efeitos.estoque,
      ledgerConcluidoNaMesmaTransacao: ledger[0].estado,
    }));
  } catch (cause) {
    return err('PosseRehearsalFailed', 'Falha inesperada no rehearsal de posse da venda', {}, cause);
  } finally {
    try {
      await client.end();
    } catch {
      // Encerramento de conexão de teste; nada a fazer se já caiu.
    }
  }
}
