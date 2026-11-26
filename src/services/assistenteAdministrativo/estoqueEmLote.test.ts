import { describe, expect, it } from 'vitest';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import { criarEdicaoDeProdutos, type PortasDeEdicao } from './editarProdutos';
import { conferirPedidoDeLote, proporEstoqueEmLote } from './estoqueEmLote';
import type { PedidoEstoqueEmLote } from './estoqueEmLoteContract';

const scope = { organizationId: 'org-a', actorId: 'ator-a', role: 'admin' } as VerifiedOrganizationScope;
const cravo15 = { id: '55555555-5555-4555-8555-555555555555', blingId: '515', nome: 'Rapé 15ml Nome:Cravo', codigo: 'HX-RAP-15-CRAVO', categoria: null };
const cravo20 = { id: '66666666-6666-4666-8666-666666666666', blingId: '520', nome: 'Rapé 20ml Nome:Cravo', codigo: 'HX-RAP-20-CRAVO', categoria: null };
const cacau = { id: '77777777-7777-4777-8777-777777777777', blingId: '530', nome: 'Rapé 15ml Nome:Cacau', codigo: 'HX-RAP-15-CACAU', categoria: null };
const tepi = { id: '88888888-8888-4888-8888-888888888888', blingId: '540', nome: 'Tepi de Bambu', codigo: 'HX-TEPI-01', categoria: null };
const catalogo = [cravo15, cravo20, cacau, tepi];
const saldos: Record<string, number> = { 515: 4, 520: 9, 530: 2, 540: 10 };
const ok = <T>(valor: T) => ({ _tag: 'ok' as const, valor });

function ambiente() {
  let proposta: Awaited<ReturnType<PortasDeEdicao['guardar']>> | undefined;
  const envios: unknown[] = [];
  const portas: PortasDeEdicao = {
    buscar: async () => ok([]),
    catalogo: async () => ok(catalogo),
    porIds: async () => ok([]),
    ler: async id => ok({ nome: catalogo.find(p => p.blingId === id)!.nome, descricao: '', estoque: saldos[id] }),
    deposito: async () => ok({ id: 7, nome: 'Geral' }),
    guardar: async (_scope, conteudo) => {
      proposta = ok({ ...conteudo, chave: '22222222-2222-4222-8222-222222222222', expiraEm: '2026-11-26T01:05:00Z' });
      return proposta;
    },
    reivindicar: async () => proposta?._tag === 'ok' ? ok({ estado: 'executar' as const, proposta: proposta.valor }) : ok({ estado: 'negada' as const }),
    alterar: async item => { envios.push(item); return { _tag: 'EscritaAceita' }; },
    registrar: async () => ok(null),
    concluir: async () => ok(null),
    agora: () => Date.parse('2026-11-26T01:00:00Z'),
  };
  return { portas, envios };
}

const lote = (...itens: PedidoEstoqueEmLote['itens']): PedidoEstoqueEmLote => ({ acao: 'estoque_em_lote', itens });

describe('estoque em lote: vários produtos, valores diferentes, uma prévia', () => {
  it('quantidades diferentes por produto, absolutas e relativas, viram uma única prévia com o saldo final', async () => {
    const a = ambiente();
    const pergunta = 'Chegaram 5 tepis, adiciona 3 no HX-RAP-15-CACAU e deixa o rapé 20ml cravo em 12';
    const resposta = await proporEstoqueEmLote(a.portas, scope, lote(
      { referencia: 'tepi', operacao: 'somar', quantidade: 5 },
      { referencia: 'HX-RAP-15-CACAU', operacao: 'somar', quantidade: 3 },
      { referencia: 'rapé 20ml cravo', operacao: 'definir', quantidade: 12 },
    ), pergunta);
    expect(resposta.proposta?.itens).toMatchObject([
      { produtoId: tepi.id, campo: 'estoque', anterior: 10, valor: 15 },
      { produtoId: cacau.id, campo: 'estoque', anterior: 2, valor: 5 },
      { produtoId: cravo20.id, campo: 'estoque', anterior: 9, valor: 12 },
    ]);
    expect(resposta.proposta?.deposito).toEqual({ id: 7, nome: 'Geral' });
    expect(a.envios).toEqual([]);
  });

  it('confirmar grava o saldo final absoluto de cada produto, e só depois da confirmação', async () => {
    const a = ambiente();
    const previa = await proporEstoqueEmLote(a.portas, scope, lote(
      { referencia: 'tepi', operacao: 'subtrair', quantidade: 3 },
      { referencia: 'cacau', operacao: 'somar', quantidade: 1 },
    ), 'Tira 3 do tepi e soma 1 no cacau');
    const resultado = await criarEdicaoDeProdutos(a.portas).confirmar(scope, previa.proposta!.chave);
    expect(resultado.resultados?.map(r => r.estado)).toEqual(['aplicado', 'aplicado']);
    expect(a.envios).toMatchObject([{ blingId: '540', valor: 7 }, { blingId: '530', valor: 3 }]);
  });

  it('uma referência ambígua ou desconhecida não gera prévia parcial e diz quais itens resolver', async () => {
    const a = ambiente();
    const resposta = await proporEstoqueEmLote(a.portas, scope, lote(
      { referencia: 'tepi', operacao: 'somar', quantidade: 5 },
      { referencia: 'cravo', operacao: 'somar', quantidade: 2 },
      { referencia: 'bicicleta', operacao: 'somar', quantidade: 1 },
    ), 'Adiciona 5 no tepi, 2 no cravo e 1 na bicicleta');
    expect(resposta.proposta).toBeUndefined();
    expect(resposta.detalhes?.find(d => d.includes('cravo'))).toMatch(/HX-RAP-15-CRAVO.*HX-RAP-20-CRAVO/u);
    expect(resposta.detalhes?.join('\n')).toContain('bicicleta');
    expect(resposta.detalhes?.join('\n')).not.toContain('tepi');
    expect(a.envios).toEqual([]);
  });

  it('retirar mais do que o saldo não gera prévia', async () => {
    const a = ambiente();
    const resposta = await proporEstoqueEmLote(a.portas, scope, lote(
      { referencia: 'cacau', operacao: 'subtrair', quantidade: 5 },
    ), 'Retira 5 do cacau');
    expect(resposta.proposta).toBeUndefined();
    expect(resposta.detalhes?.join(' ')).toContain('negativo');
  });

  it('duas referências para o mesmo produto não viram dois envios', async () => {
    const a = ambiente();
    const resposta = await proporEstoqueEmLote(a.portas, scope, lote(
      { referencia: 'tepi', operacao: 'somar', quantidade: 5 },
      { referencia: 'HX-TEPI-01', operacao: 'somar', quantidade: 2 },
    ), 'Soma 5 no tepi e 2 no HX-TEPI-01');
    expect(resposta.proposta).toBeUndefined();
    expect(resposta.mensagem).toContain('mais de uma vez');
  });

  it('sem gestão, sem depósito único ou com Bling indisponível não há prévia', async () => {
    const a = ambiente();
    const pedido = lote({ referencia: 'tepi', operacao: 'somar', quantidade: 5 });
    const membro = { ...scope, role: 'member' } as VerifiedOrganizationScope;
    expect((await proporEstoqueEmLote(a.portas, membro, pedido, 'Adiciona 5 no tepi')).proposta).toBeUndefined();
    a.portas.deposito = async () => ok(null);
    expect((await proporEstoqueEmLote(a.portas, scope, pedido, 'Adiciona 5 no tepi')).proposta).toBeUndefined();
    a.portas.deposito = async () => ok({ id: 7, nome: 'Geral' });
    a.portas.ler = async () => ({ _tag: 'indisponivel' });
    expect((await proporEstoqueEmLote(a.portas, scope, pedido, 'Adiciona 5 no tepi')).proposta).toBeUndefined();
  });
});

describe('estoque em lote: o modelo não inventa produto, número nem operação', () => {
  it.each([
    ['referência que não está no pedido', lote({ referencia: 'menta', operacao: 'somar', quantidade: 5 }), 'Adiciona 5 no tepi'],
    ['quantidade que não está no pedido', lote({ referencia: 'tepi', operacao: 'somar', quantidade: 50 }), 'Adiciona 5 no tepi'],
    ['somar sem nenhum verbo de entrada', lote({ referencia: 'tepi', operacao: 'somar', quantidade: 5 }), 'Deixa o tepi em 5'],
    ['subtrair sem nenhum verbo de saída', lote({ referencia: 'tepi', operacao: 'subtrair', quantidade: 5 }), 'Adiciona 5 no tepi'],
    ['definir quando o pedido só fala em somar', lote({ referencia: 'tepi', operacao: 'definir', quantidade: 5 }), 'Aumenta 5 no tepi'],
    ['somar quando só há “por favor” e um saldo final', lote({ referencia: 'tepi', operacao: 'somar', quantidade: 5 }), 'Por favor, deixa o tepi em 5'],
  ])('%s é recusado', (_caso, pedido, pergunta) => {
    expect(conferirPedidoDeLote(pedido, pergunta)).not.toBeNull();
  });

  it('o produto pode vir de uma pergunta anterior; quantidade e operação só da pergunta atual', () => {
    const anteriores = ['Quanto tem do tepi?'];
    expect(conferirPedidoDeLote(lote({ referencia: 'tepi', operacao: 'somar', quantidade: 5 }), 'Adiciona 5 nele', anteriores)).toBeNull();
    expect(conferirPedidoDeLote(lote({ referencia: 'tepi', operacao: 'somar', quantidade: 5 }), 'E no cacau também', ['Adiciona 5 no tepi'])).not.toBeNull();
    expect(conferirPedidoDeLote(lote({ referencia: 'tepi', operacao: 'somar', quantidade: 3 }), 'Deixa ele em 3', ['Adiciona 5 no tepi'])).not.toBeNull();
  });

  it.each([
    [lote({ referencia: 'rapé cravo 15ml', operacao: 'definir', quantidade: 10 }), 'Coloca 10 de estoque no rapé de cravo 15ml'],
    [lote({ referencia: 'tepi', operacao: 'somar', quantidade: 5 }), 'Coloca mais 5 tepis'],
    [lote({ referencia: 'tepi', operacao: 'subtrair', quantidade: 2 }), 'Vendi 2 tepis'],
    [lote({ referencia: 'tepi', operacao: 'definir', quantidade: 0 }), 'Zera o tepi'],
    [lote({ referencia: 'tepi', operacao: 'definir', quantidade: 10 }), 'Atualiza o tepi pra 10'],
    [lote(
      { referencia: 'cravo 15ml', operacao: 'somar', quantidade: 3 },
      { referencia: 'cacau', operacao: 'somar', quantidade: 3 },
    ), 'Adiciona 3 nos rapés cravo 15ml e cacau'],
  ])('aceita %j para "%s"', (pedido, pergunta) => {
    expect(conferirPedidoDeLote(pedido, pergunta)).toBeNull();
  });
});
