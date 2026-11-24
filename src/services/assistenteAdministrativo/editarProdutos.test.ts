import { describe, expect, it } from 'vitest';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { criarEdicaoDeProdutos, type PortasDeEdicao } from './editarProdutos';

const scope = { organizationId: 'org-a', actorId: 'ator-a', role: 'admin' } as VerifiedOrganizationScope;
const produto = { id: '11111111-1111-4111-8111-111111111111', blingId: '123', nome: 'Rapé A', codigo: 'RAP-1' };
const ok = <T>(valor: T) => ({ _tag: 'ok' as const, valor });

function ambiente() {
  let proposta: Awaited<ReturnType<PortasDeEdicao['guardar']>> | undefined;
  let reivindicada = false;
  const envios: unknown[] = [];
  const resultados: unknown[] = [];
  const portas: PortasDeEdicao = {
    buscar: async () => ok([produto]),
    ler: async () => ok({ nome: 'Rapé A', descricao: 'Descrição anterior', estoque: 12 }),
    deposito: async () => ok({ id: 7, nome: 'Geral' }),
    guardar: async (_scope, conteudo) => {
      proposta = ok({ ...conteudo, chave: '22222222-2222-4222-8222-222222222222', expiraEm: '2026-11-24T01:05:00Z' });
      return proposta;
    },
    reivindicar: async () => {
      if (!proposta || proposta._tag !== 'ok') return ok({ estado: 'negada' });
      if (reivindicada) return ok({ estado: 'ocupada', resultados: [] });
      reivindicada = true;
      return ok({ estado: 'executar', proposta: proposta.valor });
    },
    alterar: async item => { envios.push(item); return { _tag: 'EscritaAceita' }; },
    registrar: async (_scope, _chave, resultado) => { resultados.push(resultado); return ok(null); },
    concluir: async () => ok(null),
    agora: () => Date.parse('2026-11-24T01:00:00Z'),
  };
  return { portas, envios, resultados, servico: criarEdicaoDeProdutos(portas) };
}

describe('edição pelo assistente: proposta → confirmação → resultado', () => {
  it('não confunde adicionar unidades com definir o saldo, mesmo se o modelo interpretar errado', async () => {
    const a = ambiente();
    const resposta = await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'um', por: 'sku', referencia: 'RAP-1', campo: 'estoque', valor: 5,
    }, 'Adicione 5 ao estoque do RAP-1');
    expect(resposta.proposta).toBeUndefined();
    expect(a.envios).toEqual([]);
  });
  it('a prévia não escreve no Bling; confirmar define o saldo absoluto e persiste o recibo', async () => {
    const a = ambiente();
    const previa = await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'todos', por: 'nome', referencia: 'Rapé', campo: 'estoque', valor: 5,
    }, 'Deixe todos os rapés com estoque de 5');
    expect(previa.proposta?.itens).toMatchObject([{ anterior: 12, valor: 5, campo: 'estoque' }]);
    expect(a.envios).toEqual([]);
    const resultado = await a.servico.confirmar(scope, previa.proposta!.chave);
    expect(resultado.resultados).toMatchObject([{ estado: 'aplicado', produtoId: produto.id }]);
    expect(a.envios).toHaveLength(1);
    expect(a.resultados).toHaveLength(1);
  });

  it('duas confirmações concorrentes enviam o comando apenas uma vez', async () => {
    const a = ambiente();
    const previa = await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'um', por: 'sku', referencia: 'RAP-1', campo: 'nome', valor: 'Rapé Novo',
    }, 'Renomeie RAP-1 para Rapé Novo');
    const respostas = await Promise.all([
      a.servico.confirmar(scope, previa.proposta!.chave), a.servico.confirmar(scope, previa.proposta!.chave),
    ]);
    expect(a.envios).toHaveLength(1);
    expect(respostas.some(r => r.mensagem.includes('já foi iniciada'))).toBe(true);
  });

  it('usuário sem gestão não prepara nem confirma uma escrita', async () => {
    const a = ambiente();
    const membro = { ...scope, role: 'member' } as VerifiedOrganizationScope;
    expect((await a.servico.propor(membro, {
      acao: 'editar_produtos', selecao: 'um', por: 'nome', referencia: 'Rapé', campo: 'estoque', valor: 5,
    }, 'Deixe o estoque do Rapé em 5')).proposta).toBeUndefined();
    await a.servico.confirmar(membro, '22222222-2222-4222-8222-222222222222');
    expect(a.envios).toEqual([]);
  });

  it('uma seleção ambígua ou maior que o limite não cria um lote parcial', async () => {
    const a = ambiente();
    a.portas.buscar = async () => ok([produto, { ...produto, id: '33333333-3333-4333-8333-333333333333' }]);
    const pedido = { acao: 'editar_produtos', selecao: 'um', por: 'nome', referencia: 'Rapé', campo: 'estoque', valor: 5 } as const;
    expect((await a.servico.propor(scope, pedido, 'Defina o Rapé em 5')).proposta).toBeUndefined();
    a.portas.buscar = async () => ok(Array.from({ length: 21 }, (_, i) => ({ ...produto, id: String(i) })));
    expect((await a.servico.propor(scope, { ...pedido, selecao: 'todos' }, 'Defina todos os rapés em 5')).mensagem).toContain('mais de 20');
    expect(a.envios).toEqual([]);
  });

  it('não aceita texto ou abrangência inventados pelo modelo', async () => {
    const a = ambiente();
    expect((await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'todos', por: 'nome', referencia: 'Rapé', campo: 'nome', valor: 'Invenção',
    }, 'Renomeie o Rapé para Outro')).proposta).toBeUndefined();
    expect((await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'todos', por: 'nome', referencia: 'Rapé', campo: 'estoque', valor: 5,
    }, 'Deixe o estoque do Rapé em 5')).proposta).toBeUndefined();
  });

  it('o novo texto da descrição é literal, e mudança remota após prévia impede a escrita', async () => {
    const a = ambiente();
    const previa = await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'um', por: 'sku', referencia: 'RAP-1', campo: 'descricao', valor: 'Nova descrição.',
    }, 'Troque a descrição do RAP-1 para Nova descrição.');
    expect(previa.proposta?.itens[0]).toMatchObject({ anterior: 'Descrição anterior', valor: 'Nova descrição.' });
    a.portas.ler = async () => ok({ nome: 'Rapé A', descricao: 'Editado por outra pessoa', estoque: 12 });
    expect((await a.servico.confirmar(scope, previa.proposta!.chave)).resultados).toMatchObject([{ estado: 'alterado_apos_previa' }]);
    expect(a.envios).toEqual([]);
  });

  it('falha parcial distingue aceite, recusa e resultado desconhecido sem reenviar', async () => {
    const a = ambiente();
    a.portas.buscar = async () => ok([produto,
      { ...produto, id: '33333333-3333-4333-8333-333333333333', blingId: '124' },
      { ...produto, id: '44444444-4444-4444-8444-444444444444', blingId: '125' }]);
    const previa = await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'todos', por: 'nome', referencia: 'Rapé', campo: 'estoque', valor: 0,
    }, 'Defina o estoque de todos os rapés em 0');
    a.portas.alterar = async item => {
      a.envios.push(item);
      return item.blingId === '123' ? { _tag: 'EscritaAceita' }
        : item.blingId === '124' ? { _tag: 'RemotoRecusou', status: 400 }
          : { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' };
    };
    expect((await a.servico.confirmar(scope, previa.proposta!.chave)).resultados?.map(r => r.estado))
      .toEqual(['aplicado', 'recusado', 'indeterminado']);
    await a.servico.confirmar(scope, previa.proposta!.chave);
    expect(a.envios).toHaveLength(3);
  });

  it('interrompe o lote quando não consegue registrar o último envio', async () => {
    const a = ambiente();
    const previa = await a.servico.propor(scope, {
      acao: 'editar_produtos', selecao: 'um', por: 'sku', referencia: 'RAP-1', campo: 'estoque', valor: 5,
    }, 'Deixe RAP-1 com estoque de 5');
    a.portas.registrar = async () => ({ _tag: 'indisponivel' });
    expect((await a.servico.confirmar(scope, previa.proposta!.chave)).mensagem).toContain('conferência');
    await a.servico.confirmar(scope, previa.proposta!.chave);
    expect(a.envios).toHaveLength(1);
  });

  it('não escolhe entre depósitos nem usa uma seleção de depósito que mudou', async () => {
    const a = ambiente();
    const pedido = { acao: 'editar_produtos', selecao: 'um', por: 'sku', referencia: 'RAP-1', campo: 'estoque', valor: 5 } as const;
    const previa = await a.servico.propor(scope, pedido, 'Deixe RAP-1 com estoque de 5');
    a.portas.deposito = async () => ok(null);
    expect((await a.servico.confirmar(scope, previa.proposta!.chave)).resultados).toMatchObject([{ estado: 'nao_enviado' }]);
    expect((await a.servico.propor(scope, pedido, 'Deixe RAP-1 com estoque de 5')).proposta).toBeUndefined();
    expect(a.envios).toEqual([]);
  });
});
