import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLocalDatabaseClient } from './local-database-client.mjs';
import { err, ok } from './script-result.mjs';
import { novaOrganizacao } from './database-concurrency-consumidor-inbox-apoio.mjs';

const db = nome => createLocalDatabaseClient(nome, {});
const admin = db('msg015-admin');
const a = db('msg015-a');
const b = db('msg015-b');
const comando = 'select public.sac_proposta_resolucao($1,$2,$3,$4,$5,$6,$7,$8,$9) as resultado';
let ator;

async function operar(client, f, acao, alvo, entrada, chave = randomUUID()) {
  const { rows: [r] } = await client.query(comando, [f.org, ator, f.conversa, acao,
    acao === 'ler' ? null : chave, alvo?.versao ?? null, alvo?.digest ?? null, entrada ?? null, 'msg015-teste']);
  return r.resultado;
}

async function publicar(org, revisao = 'D7-SINTETICA-v1') {
  await admin.query('begin');
  try {
    await admin.query('set local role authenticated');
    await admin.query("select set_config('request.jwt.claim.sub',$1,true)",[ator]);
    const {rows:[r]} = await admin.query(
      "select public.sac_publicar_politica_resolucao($1,'troca','avaria',$2,now()+interval '1 day','LABORATÓRIO SINTÉTICO',$3,null,null) as id",
      [org,revisao,'Política sintética exclusiva para teste sem efeitos comerciais.']);
    await admin.query('commit');
    return r.id;
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

async function montar({publicada = true} = {}) {
  const key = randomUUID().slice(0,8);
  const {org, conexao} = await novaOrganizacao(admin, 'MSG015-' + key);
  const [contato, conversa, cliente, pedidoId, original, substitutoId, itemId] = Array.from({length:7}, randomUUID);
  const [contatoExterno, conversaExterna] = Array.from({length:2}, () => randomInt(1_000_000_000, 2_000_000_000));
  await admin.query("insert into public.membros_organizacao (organizacao_id,user_id,papel) values ($1,$2,'owner')",[org,ator]);
  await admin.query("insert into public.clientes (id,organizacao_id,user_id,bling_id,nome) values ($1,$2,$3,$4,'Cliente Sintético')",[cliente,org,ator,key]);
  await admin.query("insert into public.produtos (id,organizacao_id,user_id,bling_id,nome,preco,estoque) values ($1,$2,$3,$4,'Original Sintético',49.90,8),($5,$2,$3,$4||'-alt','Alternativa Sintética',54.90,8)",[original,org,ator,key,substitutoId]);
  await admin.query("insert into public.pedidos (id,organizacao_id,user_id,bling_id,numero,data,cliente_id,total,status) values ($1,$2,$3,$4,'15001',now(),$5,99.80,'Enviado')",[pedidoId,org,ator,key,cliente]);
  await admin.query("insert into public.itens_pedido (id,organizacao_id,user_id,pedido_id,produto_id,produto_nome,quantidade,valor_unitario) values ($1,$2,$3,$4,$5,'Original Sintético',2,49.90)",[itemId,org,ator,pedidoId,original]);
  await admin.query("insert into public.chatwoot_contacts (id,id_externo,id_local,organizacao_id,conexao_id,name) values ($1,$1::int::text,$2,$3,$4,'Cliente Sintético')",[contatoExterno,contato,org,conexao]);
  await admin.query("insert into public.chatwoot_conversations (id,id_externo,id_local,organizacao_id,conexao_id,contact_id,contato_id_local,status,inbox_id,channel) values ($1,$1::int::text,$2,$3,$4,$5,$6,'open',1,'Channel::Api')",[conversaExterna,conversa,org,conexao,contatoExterno,contato]);
  await admin.query('insert into public.sac_cases (organizacao_id,conversa_id_local) values ($1,$2)',[org,conversa]);
  await admin.query("insert into public.sync_state (user_id,entidade,last_synced_at,organizacao_id) select $1,unnest(array['pedidos','produtos']),now(),$2",[ator,org]);
  const prova = await a.query('select resultado from public.confirmar_vinculo_cliente_sac($1,$2,$3,$4,$5)',[org,ator,conversa,randomUUID(),cliente]);
  assert.equal(prova.rows[0]?.resultado,'aplicado');
  if (publicada) await publicar(org);
  await admin.query("insert into public.sac_compatibilidade_produtos select $1,unnest(array[$2::uuid,$3::uuid]),'camiseta','M','sintetica-v1',now()+interval '1 day'",[org,original,substitutoId]);
  return {org,conversa,entrada:{tipo:'troca',pedidoId,itemId,quantidade:1,motivo:'avaria',substitutoId}};
}

async function criar(f) {
  const r = await operar(a,f,'criar',null,f.entrada);
  assert.equal(r.estado,'ok',JSON.stringify(r));
  return r;
}

async function comercial(f) {
  const {rows:[snapshot]} = await admin.query(`
    select (select jsonb_agg(to_jsonb(p) order by p.id) from public.pedidos p where p.organizacao_id=$1) as pedidos,
           (select jsonb_agg(to_jsonb(p) order by p.id) from public.produtos p where p.organizacao_id=$1) as produtos,
           (select count(*)::int from public.movimentacao_estoque where organizacao_id=$1) as movimentos,
           (select count(*)::int from public.titulos_financeiros where organizacao_id=$1) as titulos,
           (select count(*)::int from public.outbox_eventos where organizacao_id=$1) as outbox,
           (select count(*)::int from public.documentos_fiscais where organizacao_id=$1) as notas`,[f.org]);
  return snapshot;
}

async function verificarBloqueio() {
  for (let tentativa = 0; tentativa < 100; tentativa++) {
    const {rows:[lock]} = await admin.query(
      'select $1::int = any(pg_blocking_pids($2::int)) as bloqueada',[a.processID,b.processID]);
    if (lock.bloqueada) return;
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.fail('A segunda sessão não foi bloqueada pela primeira no PostgreSQL.');
}

async function concorrencia(segundo) {
  const f = await montar();
  const antes = await comercial(f);
  const v = await criar(f);
  const chave = randomUUID();
  await a.query('begin');
  let pendente;
  try {
    const aprovado = await operar(a,f,'aprovar',v,null,chave);
    assert.equal(aprovado.situacao,'aprovada',JSON.stringify(aprovado));
    pendente = operar(b,f,segundo,v);
    await verificarBloqueio();
    await a.query('commit');
    assert.equal((await pendente).estado,'ja_decidida');
    assert.deepEqual(await operar(b,f,'aprovar',v,null,chave),aprovado);
    assert.equal((await operar(b,f,'rejeitar',v,null,chave)).estado,'operacao_divergente');
  } catch (error) {
    await a.query('rollback');
    await Promise.allSettled([pendente]);
    throw error;
  }
  const {rows} = await admin.query("select acao,count(*)::int as total from public.eventos_auditoria_sistema where organizacao_id=$1 and acao like 'sac.proposal_%' group by acao order by acao",[f.org]);
  assert.deepEqual(rows,[{acao:'sac.proposal_approved',total:1},{acao:'sac.proposal_created',total:1}]);
  assert.deepEqual(await comercial(f),antes);
  return {f,v,antes};
}

async function guardas({f,v,antes}) {
  const v2 = await operar(a,f,'editar',v,f.entrada);
  assert.equal(v2.versao,2);
  assert.notEqual(v2.digest,v.digest);
  assert.equal(v2.situacao,'rascunho');
  assert.equal((await operar(a,f,'aprovar',v)).estado,'conflito');
  assert.equal((await operar(a,f,'aprovar',{...v2,digest:'a'.repeat(64)})).estado,'conflito');
  assert.equal((await operar(a,f,'ler')).podeAprovar,true);
  await admin.query("update public.membros_organizacao set papel='member' where organizacao_id=$1 and user_id=$2",[f.org,ator]);
  assert.equal((await operar(a,f,'aprovar',v2)).estado,'sem_permissao');
  await admin.query("update public.membros_organizacao set papel='owner' where organizacao_id=$1 and user_id=$2",[f.org,ator]);
  assert.equal((await operar(a,f,'rejeitar',v2)).situacao,'rejeitada');
  const v3 = await operar(a,f,'editar',v2,f.entrada);
  await admin.query("update public.sac_propostas_resolucao set criada_em=now()-interval '2 days', expira_em=now()-interval '1 day' where organizacao_id=$1 and versao=3",[f.org]);
  assert.equal((await operar(a,f,'aprovar',v3)).estado,'vencida');
  assert.deepEqual(await comercial(f),antes);
}

async function dadosAlterados() {
  const f = await montar();
  const outro = await montar();
  let v = await criar(f);
  for (const sql of [
    'update public.produtos set preco=55 where id=$1',
    'update public.produtos set estoque=6 where id=$1',
    "update public.sac_compatibilidade_produtos set revisao='v2' where produto_id=$1",
  ]) {
    await admin.query(sql,[f.entrada.substitutoId]);
    assert.equal((await operar(a,f,'aprovar',v)).estado,'fatos_alterados');
    v = await operar(a,f,'editar',v,f.entrada);
    assert.equal(v.estado,'ok');
  }
  assert.deepEqual(await operar(a,f,'aprovar',v),{estado:'bloqueada',pendencias:['compatibilidade']});
  await admin.query('delete from public.sac_politicas_resolucao where organizacao_id=$1',[f.org]);
  v = await operar(a,f,'editar',v,f.entrada);
  assert.deepEqual(await operar(a,f,'aprovar',v),{estado:'bloqueada',pendencias:['politica','compatibilidade']});
  assert.equal((await operar(a,{...outro,conversa:f.conversa},'ler')).estado,'nao_encontrado');
  assert.equal((await operar(a,outro,'criar',null,f.entrada)).estado,'referencia_sem_prova');
  const fora = await operar(a,outro,'criar',null,{...outro.entrada,substitutoId:f.entrada.substitutoId});
  assert.equal((await operar(a,outro,'aprovar',fora)).estado,'bloqueada');
  return {f,outro};
}

async function politicaFormal() {
  const f = await montar({publicada:false});
  await admin.query(
    "insert into public.sac_politicas_resolucao (organizacao_id,tipo,motivo,revisao,valida_ate) values ($1,'troca','avaria','D7-SINTETICA-v1',now()+interval '1 day')",
    [f.org]);
  const v = await criar(f);
  assert.deepEqual(await operar(a,f,'aprovar',v),{estado:'bloqueada',pendencias:['politica']});
  assert.equal((await operar(a,f,'ler')).podeAprovar,false);
  await assert.rejects(
    () => a.query("update public.sac_politicas_resolucao set publicada_em=now() where organizacao_id=$1",[f.org]),
    {code:'42501'});
  await admin.query("update public.membros_organizacao set papel='member' where organizacao_id=$1 and user_id=$2",[f.org,ator]);
  await assert.rejects(() => publicar(f.org),{code:'42501'});
  await admin.query("update public.membros_organizacao set papel='owner' where organizacao_id=$1 and user_id=$2",[f.org,ator]);
  const antes = await comercial(f);
  const publicacao = await publicar(f.org);
  await assert.rejects(() => publicar(f.org),{code:'23505'});
  const {rows:[evento]} = await admin.query(
    "select actor_id,metadata from public.eventos_auditoria_sistema where organizacao_id=$1 and acao='sac.policy_published' and recurso_id=$2",
    [f.org,publicacao]);
  assert.equal(evento.actor_id,ator);
  assert.match(evento.metadata.sha256,/^[a-f0-9]{64}$/u);
  assert.equal((await operar(a,f,'aprovar',v)).estado,'fatos_alterados');
  const v2 = await operar(a,f,'editar',v,f.entrada);
  assert.equal((await operar(a,f,'aprovar',v2)).situacao,'aprovada');
  assert.deepEqual(await comercial(f),antes);

  const semAprovacao = await montar({publicada:false});
  await admin.query(
    "insert into public.sac_politicas_resolucao (organizacao_id,tipo,motivo,revisao,valida_ate) values ($1,'troca','avaria','D7-SINTETICA-v1',now()+interval '1 day')",
    [semAprovacao.org]);
  const rascunho = await criar(semAprovacao);
  await contraprova(
    "if v_politica.publicacao_id is null or v_politica.valida_ate <= clock_timestamp() then",
    'if false then',
    async () => assert.deepEqual(await operar(admin,semAprovacao,'aprovar',rascunho),{estado:'bloqueada',pendencias:['politica']}),
    'sac_fatos_proposta');
}

async function fonteDoRanking(f, outra) {
  const consultar = async org => {
    const {rows:[r]} = await a.query('select public.sac_fatos_ranking($1,$2,$3,$4,$5) as fatos',
      [org,ator,f.conversa,f.entrada.pedidoId,f.entrada.itemId]);
    return r.fatos;
  };
  assert.equal(await consultar(outra.org),null);
  assert.deepEqual((await consultar(f.org)).candidatos.map(c => c.produtoId),[f.entrada.substitutoId]);
  await admin.query("update public.sync_state set last_synced_at=now()-interval '25 hours' where organizacao_id=$1 and entidade='produtos'",[f.org]);
  assert.equal((await consultar(f.org)).candidatos[0].estoqueSincronizadoEm,null);
  await admin.query("update public.sac_compatibilidade_produtos set valida_ate=now()-interval '1 minute' where produto_id=$1",[f.entrada.substitutoId]);
  assert.deepEqual((await consultar(f.org)).candidatos,[]);
}

async function contraprova(procurar, substituicao, rodar, funcao = 'sac_proposta_resolucao') {
  const fonte = readFileSync('database/103_propostas_resolucao_sac.sql','utf8');
  const inicio = fonte.indexOf('create function public.' + funcao + '(');
  const original = fonte.slice(inicio,fonte.indexOf('$$;',inicio)+3);
  assert.ok(original.includes(procurar));
  await admin.query('begin');
  try {
    await admin.query(original.replace(procurar,substituicao).replace('create function','create or replace function'));
    await admin.query("set local request.jwt.claim.role='service_role'");
    await assert.rejects(rodar,{name:'AssertionError'});
  } finally {
    await admin.query('rollback');
  }
}

/** Executado somente depois de subir o laboratório descartável e aplicar o ledger canônico. */
export async function runPropostasSacRaceRehearsal() {
  try {
    await Promise.all([admin.connect(),a.connect(),b.connect()]);
    ator = randomUUID();
    await admin.query('insert into auth.users (id,email) values ($1,$2)',[ator,'msg015-' + ator + '@orbita.test']);
    for (const client of [a,b]) {
      await client.query('set role service_role');
      await client.query("set request.jwt.claim.role='service_role'");
      await client.query("set statement_timeout='10s'");
    }
    const {rows:[privilegio]} = await admin.query("select has_function_privilege('authenticated','public.sac_proposta_resolucao(uuid,uuid,uuid,text,uuid,integer,text,jsonb,text)','execute') as acesso");
    assert.equal(privilegio.acesso,false);
    await guardas(await concorrencia('aprovar'));
    await concorrencia('rejeitar');
    const {f,outro} = await dadosAlterados();
    await fonteDoRanking(await montar(),outro);
    await politicaFormal();
    await contraprova('v_atual.versao is distinct from p_versao or v_atual.digest is distinct from p_digest','false',
      async () => assert.equal((await operar(admin,f,'editar',{versao:99,digest:'a'.repeat(64)},f.entrada)).estado,'conflito'));
    await contraprova('s.organizacao_id = p_org and s.conversa_id_local = p_conversa','s.conversa_id_local = p_conversa',
      async () => assert.equal((await operar(admin,{...outro,conversa:f.conversa},'ler')).estado,'nao_encontrado'));
    return ok({relato:'MSG-015: concorrência, CAS, autorização, replay, fatos e ausência de efeitos verificados; três contraprovas detectadas, incluindo política D7 sem aprovação formal.'});
  } catch (error) {
    return err('PropostasSacRehearsalFailed',error.message,{},error);
  } finally {
    await Promise.allSettled([admin.end(),a.end(),b.end()]);
  }
}
