import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLocalDatabaseClient } from './local-database-client.mjs';

const criarCliente = () => createLocalDatabaseClient('baixa-demo-test');
const propor = async (db, org, ator, produto, qtd = 1) => (await db.query(
  'select public.propor_baixa_estoque_demo($1,$2,$3,$4) resposta', [org, ator, produto, qtd],
)).rows[0].resposta;
const confirmar = async (db, org, ator, chave) => (await db.query(
  'select public.confirmar_baixa_estoque_demo($1,$2,$3) resposta', [org, ator, chave],
)).rows[0].resposta;
const recusa = (promessa, codigo) => assert.rejects(promessa, { code: codigo });

async function fixture(db) {
  const [org, outra, dono, gestor, membro, produto, outroProduto] = Array.from({ length: 7 }, randomUUID);
  await db.query("insert into auth.users(id,email) select id,id||'@example.test' from unnest($1::uuid[]) id", [[dono,gestor,membro]]);
  await db.query("insert into public.organizacoes(id,nome,slug,status) select id,'Teste baixa',id::text,'active' from unnest($1::uuid[]) id", [[org,outra]]);
  await db.query("insert into public.membros_organizacao(organizacao_id,user_id,papel) values ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$2,'owner')",
    [org,dono,gestor,membro,outra]);
  await db.query("insert into public.produtos(id,organizacao_id,user_id,bling_id,nome,estoque,estoque_reservado) values ($1,$2,$3,$4,'Demo',8,2),($5,$6,$3,$7,'Outro',8,2)",
    [produto,org,dono,'local-'+produto,outroProduto,outra,'local-'+outroProduto]);
  await db.query('insert into public.estoque_baixa_demo_produtos values ($1,$2)',[org,produto]);
  return { org, outra, dono, gestor, membro, produto, outroProduto };
}

async function confirmarEmPar(a,b,org,dono,chave) {
  const { rows: [{ pid }] } = await b.query('select pg_backend_pid() pid');
  await a.query('begin');
  let concorrente;
  try {
    const primeiro = await confirmar(a,org,dono,chave);
    concorrente = confirmar(b,org,dono,chave);
    // Verify that the second backend actually contends before releasing locks.
    let bloqueada = false;
    for (let i = 0; i < 100 && !bloqueada; i++) {
      await a.query('select pg_stat_clear_snapshot()');
      const estado = await a.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
      bloqueada = estado.rows[0]?.wait_event_type === 'Lock';
      if (!bloqueada) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(bloqueada, 'a segunda confirmação aguardou um lock real');
    await a.query('commit');
    assert.deepEqual(await concorrente, primeiro);
    return primeiro;
  } catch (erro) {
    await a.query('rollback');
    await concorrente?.catch(() => {});
    throw erro;
  }
}

export async function testarBaixaDemo({ criar = criarCliente } = {}) {
  const a = criar(), b = criar();
  try {
    await a.connect(); await b.connect();
    for (const db of [a,b]) {
      await db.query("set statement_timeout='5s'; set request.jwt.claim.role='service_role'");
    }
    const { org, outra, dono, gestor, membro, produto, outroProduto } = await fixture(a);
    const p = await propor(a,org,dono,produto);
    await recusa(confirmar(b,outra,dono,p.chave),'P0002');
    await recusa(confirmar(b,org,gestor,p.chave),'P0002');
    await recusa(confirmar(b,org,membro,p.chave),'42501');
    await recusa(propor(a,org,membro,produto),'42501');
    await recusa(propor(a,org,dono,outroProduto),'42501');
    await recusa(propor(a,org,dono,produto,0),'22023');

    const recibo = await confirmarEmPar(a,b,org,dono,p.chave);
    assert.equal(recibo.saldoDisponivel,5);
    assert.deepEqual(await confirmar(b,org,dono,p.chave),recibo);
    const auditoria = await a.query("select actor_id, correlation_id from public.eventos_auditoria_sistema where id=$1 and acao='inventory.demo_debit_applied'",[recibo.auditoriaId]);
    assert.deepEqual(auditoria.rows,[{actor_id:dono,correlation_id:p.chave}]);

    const p2 = await propor(a,org,dono,produto);
    // Simulate a lost response after commit. The caller receives a timeout, not the receipt.
    await assert.rejects(async () => {
      await confirmar(a,org,dono,p2.chave);
      throw new Error('timeout após commit');
    }, /timeout após commit/);
    assert.equal((await confirmar(b,org,dono,p2.chave)).saldoDisponivel,4);

    const reservado = await propor(a,org,dono,produto);
    await a.query('update public.produtos set estoque_reservado=estoque where id=$1',[produto]);
    await recusa(confirmar(b,org,dono,reservado.chave),'23514');
    await a.query('update public.produtos set estoque_reservado=2 where id=$1',[produto]);

    const vencida = await propor(a,org,dono,produto);
    await a.query("update public.estoque_baixa_demo_comandos set expira_em=clock_timestamp()-interval '1 second' where organizacao_id=$1 and chave=$2",[org,vencida.chave]);
    await recusa(confirmar(b,org,dono,vencida.chave),'22023');
    const revogada = await propor(a,org,gestor,produto);
    await a.query("update public.membros_organizacao set papel='member' where organizacao_id=$1 and user_id=$2",[org,gestor]);
    await recusa(confirmar(b,org,gestor,revogada.chave),'42501');

    const integrada = await propor(a,org,dono,produto);
    await a.query("insert into public.conexoes_integracao(organizacao_id,provedor,nome,status) values($1,'bling','Fixture sem credencial','conectado')",[org]);
    await recusa(confirmar(b,org,dono,integrada.chave),'42501');
    const totais = await a.query(`select p.estoque,
      (select count(*)::int from public.movimentacao_estoque m where m.produto_id=p.id and m.user_id=$2) movimentos,
      (select count(*)::int from public.eventos_auditoria_sistema e where e.organizacao_id=$3 and e.acao='inventory.demo_debit_applied') auditorias,
      (select count(*)::int from public.outbox_eventos o where o.organizacao_id=$3) envios
      from public.produtos p where p.id=$1`,[produto,dono,org]);
    assert.deepEqual(totais.rows,[{estoque:6,movimentos:2,auditorias:2,envios:0}]);
    console.log('[baixa-demo] concorrência, replay pós-timeout, saldo, escopo, autorização, prazo e auditoria verificados');
  } finally {
    await Promise.allSettled([a.end(),b.end()]);
  }
}
