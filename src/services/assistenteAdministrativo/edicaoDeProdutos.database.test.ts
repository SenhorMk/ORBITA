import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { propostaEdicao } from './edicaoDeProdutosContract';

// Explicit opt-in; fixed loopback port belongs to the disposable task container.
describe.skipIf(process.env.ORBITA_TEST_EDICAO_LOCAL !== 'true')('RPC real do banco descartável', () => {
  const config = { host: '127.0.0.1', port: 55404, database: 'postgres', user: 'postgres', password: 'postgres' };
  const a = new pg.Client(config);
  const b = new pg.Client(config);
  const org = randomUUID();
  const ator = randomUUID();
  const produtoId = randomUUID();
  let chave = '';

  beforeAll(async () => {
    await Promise.all([a.connect(), b.connect()]);
    await Promise.all([a.query("set request.jwt.claim.role='service_role'"), b.query("set request.jwt.claim.role='service_role'")]);
    await a.query('insert into auth.users(id,email) values($1,$2)', [ator, ator + '@orbita.test']);
    await a.query("insert into public.organizacoes(id,nome,slug,status) values($1,'Teste RPC',$2,'active')", [org, org]);
    await a.query("insert into public.membros_organizacao(organizacao_id,user_id,papel) values($1,$2,'owner')", [org, ator]);
    await a.query("insert into public.produtos(id,user_id,organizacao_id,bling_id,nome,preco,estoque,situacao) values($1,$2,$3,'123','Rapé A',20,12,'ativo')", [produtoId, ator, org]);
  });
  afterAll(async () => { await Promise.all([a.end(), b.end()]); });

  it('o JSON de timestamptz devolvido pelo Postgres passa no parser usado pelo adaptador', async () => {
    const conteudo = { itens: [{ produtoId, blingId: '123', nome: 'Rapé A', codigo: null, campo: 'estoque', anterior: 12, valor: 5 }], deposito: { id: 7, nome: 'Geral' } };
    const resultado = await a.query('select public.assistente_edicao_produtos($1,$2,$3,null,$4) valor', [org, ator, 'criar', conteudo]);
    const parsed = propostaEdicao.safeParse(resultado.rows[0].valor);
    expect(parsed.success).toBe(true);
    if (parsed.success) chave = parsed.data.chave;
    expect(chave).not.toBe('');
  });

  it('duas conexões concorrentes recebem uma única autorização de execução', async () => {
    const resultados = await Promise.all([a, b].map(client => client.query(
      'select public.assistente_edicao_produtos($1,$2,$3,$4) valor', [org, ator, 'reivindicar', chave],
    )));
    expect(resultados.map(r => r.rows[0].valor.estado).sort()).toEqual(['executar', 'ocupada']);
    const executor = resultados.find(r => r.rows[0].valor.estado === 'executar')!;
    expect(propostaEdicao.safeParse(executor.rows[0].valor.proposta).success).toBe(true);
    await a.query('select public.assistente_edicao_produtos($1,$2,$3,$4,$5)', [org, ator, 'registrar', chave,
      { produtoId, nome: 'Rapé A', estado: 'aplicado' }]);
    await a.query('select public.assistente_edicao_produtos($1,$2,$3,$4)', [org, ator, 'concluir', chave]);
    const replay = await b.query('select public.assistente_edicao_produtos($1,$2,$3,$4) valor', [org, ator, 'reivindicar', chave]);
    expect(replay.rows[0].valor).toMatchObject({ estado: 'concluida', resultados: [{ produtoId, estado: 'aplicado' }] });
  });
});
