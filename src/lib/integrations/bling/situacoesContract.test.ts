import { describe, expect, it } from 'vitest';

import {
  encontrarModuloDePedidosDeVenda,
  encontrarSituacaoDeCancelamento,
  lerModulos,
  lerSituacoes,
} from './situacoesContract';

/**
 * Ticket 31 — leitura das situações do Bling.
 *
 * As formas usadas aqui vêm do OpenAPI oficial, não de suposição:
 *
 * - `GET /situacoes/modulos` → `data[]` de `SituacoesModuloBaseDTO` +
 *   `SituacoesModuloDTO` = `{ id, nome, descricao, criarSituacoes }`;
 * - `GET /situacoes/modulos/{idModuloSistema}` → `data[]` de `SituacoesDTO` +
 *   `SituacoesDadosDTO` = `{ id, nome, idHerdado?, cor? }`.
 *
 * O exemplo oficial do módulo de vendas é `nome: "Vendas"`,
 * `descricao: "Pedidos de Venda"`.
 */

const MODULOS_REAIS = {
  data: [
    { id: 98765431, nome: 'Compras', descricao: 'Pedidos de Compra', criarSituacoes: true },
    { id: 98765432, nome: 'Vendas', descricao: 'Pedidos de Venda', criarSituacoes: true },
    { id: 98765433, nome: 'Financeiro', descricao: 'Contas a Pagar', criarSituacoes: false },
  ],
};

const SITUACOES_REAIS = {
  data: [
    { id: 9, nome: 'Em aberto', idHerdado: 0, cor: '#E9DC40' },
    { id: 12, nome: 'Atendido', idHerdado: 0, cor: '#4CAF50' },
    { id: 15, nome: 'Cancelado', idHerdado: 0, cor: '#F44336' },
  ],
};

describe('lerModulos', () => {
  it('lê a listagem oficial de módulos', () => {
    expect(lerModulos(MODULOS_REAIS)).toEqual([
      { id: 98765431, nome: 'Compras', descricao: 'Pedidos de Compra' },
      { id: 98765432, nome: 'Vendas', descricao: 'Pedidos de Venda' },
      { id: 98765433, nome: 'Financeiro', descricao: 'Contas a Pagar' },
    ]);
  });

  it('descarta o item malformado sem derrubar os outros', () => {
    // Um módulo novo ou com campo faltando não pode apagar a lista inteira.
    const lido = lerModulos({ data: [{ nome: 'Sem id' }, MODULOS_REAIS.data[1]] });
    expect(lido).toHaveLength(1);
    expect(lido?.[0].id).toBe(98765432);
  });

  it('distingue listagem vazia de corpo em formato inesperado', () => {
    // A distinção é o que permite duas mensagens diferentes ao usuário.
    expect(lerModulos({ data: [] })).toEqual([]);
    expect(lerModulos({ modulos: [] })).toBeNull();
    expect(lerModulos([])).toBeNull();
    expect(lerModulos(undefined)).toBeNull();
    expect(lerModulos('<html>erro</html>')).toBeNull();
  });

  it('lista inteira descartada NÃO vira lista vazia', () => {
    // Se virasse, o ticket 31 se repetiria pelo outro lado: uma lista vazia por
    // engano faz o chamador concluir que a conta não tem o que procura. Havia
    // itens; nenhum foi reconhecido; o formato mudou.
    expect(lerModulos({ data: [{ nome: 'sem id' }, { nome: 'outro sem id' }] })).toBeNull();
    expect(lerSituacoes({ data: [{ situacao: 'Cancelado' }] })).toBeNull();
  });
});

describe('lerSituacoes', () => {
  it('lê a listagem oficial de situações, ignorando os campos extras', () => {
    expect(lerSituacoes(SITUACOES_REAIS)).toEqual([
      { id: 9, nome: 'Em aberto' },
      { id: 12, nome: 'Atendido' },
      { id: 15, nome: 'Cancelado' },
    ]);
  });

  it('descarta situação sem nome utilizável', () => {
    expect(lerSituacoes({ data: [{ id: 1, nome: '' }, { id: 2, nome: 'Cancelado' }] })).toEqual([
      { id: 2, nome: 'Cancelado' },
    ]);
  });

  it('devolve null quando o corpo não é a listagem da v3', () => {
    expect(lerSituacoes({ erro: 'nao autorizado' })).toBeNull();
  });
});

describe('encontrarModuloDePedidosDeVenda', () => {
  it('acha o módulo de vendas pela descrição, e não confunde com compras', () => {
    const modulos = lerModulos(MODULOS_REAIS)!;
    expect(encontrarModuloDePedidosDeVenda(modulos)?.id).toBe(98765432);
  });

  it('não casa com "Pedidos de Compra" quando o de vendas não existe', () => {
    const modulos = lerModulos({ data: [MODULOS_REAIS.data[0]] })!;
    expect(encontrarModuloDePedidosDeVenda(modulos)).toBeNull();
  });

  it('cai no nome quando a descrição não ajuda', () => {
    const modulos = lerModulos({ data: [{ id: 7, nome: 'Vendas', descricao: 'Módulo comercial' }] })!;
    expect(encontrarModuloDePedidosDeVenda(modulos)?.id).toBe(7);
  });

  it('tolera acento e caixa no rótulo, que é digitado por humano', () => {
    const modulos = lerModulos({ data: [{ id: 8, nome: 'VENDAS', descricao: 'PEDIDOS DE VENDA' }] })!;
    expect(encontrarModuloDePedidosDeVenda(modulos)?.id).toBe(8);
  });

  it('devolve null com a lista vazia', () => {
    expect(encontrarModuloDePedidosDeVenda([])).toBeNull();
  });
});

describe('encontrarSituacaoDeCancelamento', () => {
  it('acha "Cancelado"', () => {
    expect(encontrarSituacaoDeCancelamento(lerSituacoes(SITUACOES_REAIS)!)?.id).toBe(15);
  });

  it('aceita a variação feminina, que algumas contas usam', () => {
    expect(encontrarSituacaoDeCancelamento([{ id: 3, nome: 'Cancelada' }])?.id).toBe(3);
  });

  it('devolve null quando a conta realmente não tem a situação', () => {
    expect(encontrarSituacaoDeCancelamento([{ id: 9, nome: 'Em aberto' }])).toBeNull();
  });

  it('não casa por substring: "Não cancelado" não é cancelamento', () => {
    expect(encontrarSituacaoDeCancelamento([{ id: 4, nome: 'Não cancelado' }])).toBeNull();
  });
});
