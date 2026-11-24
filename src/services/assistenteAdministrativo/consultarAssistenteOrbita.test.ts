import { describe, expect, it, vi } from 'vitest';

import { consultarAssistente } from './consultarAssistenteOrbita';
import { ferramentaAssistente } from './contratoAssistenteOrbita';

const hoje = '2026-11-23';
const venda = { id: 'p1', numero: '15001', bling_id: '98765', status: 'Enviado', data: hoje, total: 75, cliente_id: null };
const item = { id: 'i1', produto_id: 'produto', produto_nome: 'Camiseta', quantidade: 2, valor_unitario: 19.9 };

function dependencias() {
  return {
    leituras: {
      vendasNoPeriodo: vi.fn().mockResolvedValue([venda, { ...venda, id: 'p2', status: 'Cancelado', total: 70 }]),
      itensDasVendas: vi.fn().mockResolvedValue([item, item]),
      pedido: vi.fn().mockResolvedValue([venda]),
      estoqueBaixo: vi.fn().mockResolvedValue([]),
    },
    estoque: vi.fn().mockResolvedValue([{ nome: 'Camiseta', codigo: 'DEMO-BANCA', estoque: 8, estoque_reservado: 2 }]),
    detalheBling: vi.fn().mockResolvedValue({ id: 98765, transporte: { volumes: [{ codigoRastreamento: 'BR12345' }] } }),
  };
}

describe('ferramentas de consulta do Assistente ORBITA', () => {
  it('calcula vendas e ticket médio excluindo cancelamentos, com data final inclusiva', async () => {
    const deps = dependencias();
    const resposta = await consultarAssistente({ acao: 'vendas_do_periodo', periodo: { tipo: 'datas', inicio: '2026-11-01', fim: hoje } }, 'vendas do mês', hoje, deps);
    expect(deps.leituras.vendasNoPeriodo).toHaveBeenCalledWith('2026-11-01', '2026-11-24');
    expect(resposta.mensagem).toMatch(/1 pedido ativo.*75,00/);
    expect(resposta.detalhes?.join(' ')).not.toContain('Cancelado');
  });

  it('calcula 30 dias inclusivos no servidor', async () => {
    const deps = dependencias();
    await consultarAssistente({ acao: 'vendas_do_periodo', periodo: { tipo: 'dias', dias: 30 } }, 'últimos 30 dias', hoje, deps);
    expect(deps.leituras.vendasNoPeriodo).toHaveBeenCalledWith('2026-10-25', '2026-11-24');
  });

  it('consulta somente itens dos pedidos ativos, sem contar uma linha duas vezes', async () => {
    const deps = dependencias();
    const resposta = await consultarAssistente({ acao: 'produtos_mais_vendidos', periodo: { tipo: 'datas', inicio: '2026-11-01', fim: hoje }, ordenar: 'quantidade' }, 'mais vendidos', hoje, deps);
    expect(deps.leituras.itensDasVendas).toHaveBeenCalledWith(['p1']);
    expect(resposta.detalhes?.join()).toMatch(/Camiseta.*2 un.*39,80/);
  });

  it('reaproveita a leitura de estoque e não aceita uma referência inventada', async () => {
    const deps = dependencias();
    const ferramenta = { acao: 'consultar_estoque', referencia: 'DEMO-BANCA' } as const;
    const resposta = await consultarAssistente(ferramenta, 'estoque do DEMO-BANCA', hoje, deps);
    expect(resposta.mensagem).toContain('6 unidades disponíveis');
    deps.estoque.mockClear();
    const semReferencia = await consultarAssistente(ferramenta, 'quanto restou?', hoje, deps);
    expect(semReferencia.mensagem).toMatch(/Informe/);
    expect(deps.estoque).not.toHaveBeenCalled();
  });

  it('resolve número comercial para ID externo e limita a busca remota à organização', async () => {
    const deps = dependencias();
    const ferramenta = { acao: 'consultar_rastreamento', referencia: '15001', por: 'numero' } as const;
    const resposta = await consultarAssistente(ferramenta, 'rastreio do pedido 15001', hoje, deps);
    expect(deps.leituras.pedido).toHaveBeenCalledWith('15001', 'numero');
    expect(deps.detalheBling).toHaveBeenCalledWith('98765');
    expect(resposta.detalhes).toEqual(['BR12345']);
  });

  it('distingue ambiguidade, indisponibilidade e ausência de rastreio', async () => {
    const deps = dependencias();
    const ferramenta = { acao: 'consultar_rastreamento', referencia: '15001', por: 'numero' } as const;
    deps.leituras.pedido.mockResolvedValueOnce([venda, venda]);
    expect((await consultarAssistente(ferramenta, 'rastreio 15001', hoje, deps)).mensagem).toMatch(/mais de um/);
    expect(deps.detalheBling).not.toHaveBeenCalled();
    deps.detalheBling.mockRejectedValueOnce(new Error('falha de rede'));
    expect((await consultarAssistente(ferramenta, 'rastreio 15001', hoje, deps)).mensagem).toMatch(/indisponível/);
    deps.detalheBling.mockResolvedValueOnce({ id: 98765 });
    expect((await consultarAssistente(ferramenta, 'rastreio 15001', hoje, deps)).mensagem).toMatch(/não informou código/);
  });

  it('separa ausência de dados de um erro e não inventa ranking de procura', async () => {
    const deps = dependencias();
    deps.leituras.vendasNoPeriodo.mockResolvedValueOnce([]);
    const resposta = await consultarAssistente({ acao: 'vendas_do_periodo', periodo: { tipo: 'datas', inicio: hoje, fim: hoje } }, 'vendas de hoje', hoje, deps);
    expect(resposta.mensagem).toContain('Nenhum pedido ativo');
    expect((await consultarAssistente({ acao: 'sem_fonte_procura' }, 'mais procurados', hoje, deps)).mensagem)
      .toContain('não tem uma fonte');
  });

  it('recupera somente os itens necessários quando o espelho local está vazio', async () => {
    const deps = dependencias();
    deps.leituras.itensDasVendas.mockResolvedValueOnce([]);
    deps.detalheBling.mockResolvedValueOnce({
      id: 98765, contato: { numeroDocumento: 'dado indevido' },
      itens: [{ descricao: 'Item no Bling', quantidade: 2 }],
    });
    const resposta = await consultarAssistente(
      { acao: 'consultar_pedido', referencia: '15001', por: 'numero' },
      'pedido 15001', hoje, deps,
    );
    expect(resposta.detalhes?.join(' ')).toContain('Item no Bling · 2 un.');
    expect(JSON.stringify(resposta)).not.toContain('dado indevido');
  });

  it('rejeita datas futuras, escritas e ações com parâmetros extras', async () => {
    const deps = dependencias();
    const resposta = await consultarAssistente({ acao: 'vendas_do_periodo', periodo: { tipo: 'datas', inicio: hoje, fim: '2026-11-24' } }, 'vendas', hoje, deps);
    expect(resposta.mensagem).toContain('até hoje');
    expect(deps.leituras.vendasNoPeriodo).not.toHaveBeenCalled();
    expect(ferramentaAssistente.safeParse({ acao: 'alterar_estoque', quantidade: 1 }).success).toBe(false);
    expect(ferramentaAssistente.safeParse({ acao: 'consultar_estoque', referencia: 'Camiseta', loja: 'B' }).success).toBe(false);
  });
});

describe('mensagens de orientação do Assistente ORBITA', () => {
  it('esclarecer explica como pedir alteração com valor final (resposta de "aumente em 3")', async () => {
    const r = await consultarAssistente({ acao: 'esclarecer' }, 'Aumente em 3 o estoque do SKU X', hoje, dependencias());
    expect(r.mensagem).toContain('diga o valor final');
    expect(r.mensagem).toContain('informe o saldo final');
    expect(r.mensagem).toContain('Para consultar');
  });

  it('fora do escopo não diz mais que toda alteração é só pelo painel', async () => {
    const r = await consultarAssistente({ acao: 'fora_do_escopo' }, 'Exclua o pedido 1', hoje, dependencias());
    expect(r.mensagem).toContain('preparar alterações de estoque, nome ou descrição');
    expect(r.mensagem).toContain('Para outras alterações, use o painel correspondente');
  });
});
