import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { RetratoDoPedidoSchema } from '@/lib/integrations/contratoDoRetrato';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { VerificacaoIndisponivel } from './clienteVerificado';
import { lerRetratoDoPedido, montarRetrato } from './retratoDoPedido';

const ORG = '22222222-2222-4222-8222-222222222222';
const ATOR = '70000000-0000-4000-8000-000000000001';
const CONVERSA = '44444444-4444-4444-8444-444444444444';
const PEDIDO = '88888888-8888-4888-8888-888888888888';
const PRODUTO = '99999999-9999-4999-8999-999999999991';
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ESCOPO = { organizationId: ORG, actorId: ATOR, role: 'member' } as VerifiedOrganizationScope;

const AGORA = new Date('2026-11-12T12:00:00Z');
const HA_UMA_HORA = '2026-11-12T11:00:00+00:00';
const HA_TRES_DIAS = '2026-11-09T12:00:00+00:00';

function item(campos: Record<string, unknown> = {}) {
  return {
    item_id: ITEM, produto_id: PRODUTO, nome: 'Camiseta Sintética', codigo: 'CAM-01', quantidade: 2, valor_unitario: 49.9,
    produto_situacao: 'ativo', estoque: 10, estoque_reservado: 3, produto_atualizado_em: HA_UMA_HORA, ...campos,
  };
}

function linha(campos: Record<string, unknown> = {}) {
  return {
    resultado: 'retrato',
    pedido: {
      pedido_id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Em Processamento', total: 99.8,
      frete: 0, desconto: null, forma_pagamento: 'Pix', atualizado_em: HA_UMA_HORA,
    },
    itens: [item()],
    total_de_itens: 1,
    titulo: { situacao: 'pago', situacao_bling: 2, valor: 99.8, vencimento: '2026-11-08', pago_em: '2026-11-08', atualizado_em: HA_UMA_HORA },
    sincronizacao: {
      pedidos: HA_UMA_HORA, produtos: HA_UMA_HORA, financeiro: HA_UMA_HORA,
      ultimo_job: { status: 'completed', em: HA_UMA_HORA },
    },
    ...campos,
  };
}

const montar = (campos: Record<string, unknown> = {}) => montarRetrato(linha(campos) as Parameters<typeof montarRetrato>[0], AGORA);

describe('montarRetrato: o retrato respeita o contrato', () => {
  it('pedido recente e pago: tudo atual, rastreio desconhecido', () => {
    const retrato = montar();
    expect(RetratoDoPedidoSchema.parse(retrato)).toEqual(retrato);
    expect(retrato.pagamento).toMatchObject({ situacao: 'pago', vencido: false, valor: 99.8 });
    expect(retrato.rastreio).toEqual({ situacao: 'desconhecido', motivo: 'sem_fonte' });
    expect(retrato.frescor.pedido).toEqual({ situacao: 'atual', sincronizadoEm: HA_UMA_HORA, motivo: null });
    expect(retrato.itens[0].estoque).toEqual({ situacao: 'disponivel', disponivel: 7 });
  });
});

describe('estoque: disponível é saldo menos reservas', () => {
  it('reservas cobrindo o saldo: indisponível com zero, nunca negativo', () => {
    expect(montar({ itens: [item({ estoque: 3, estoque_reservado: 3 })] }).itens[0].estoque).toEqual({ situacao: 'indisponivel', disponivel: 0 });
    expect(montar({ itens: [item({ estoque: 2, estoque_reservado: 5 })] }).itens[0].estoque).toEqual({ situacao: 'indisponivel', disponivel: 0 });
  });

  it('produto arquivado ou inativo: sem quantidade para vender', () => {
    expect(montar({ itens: [item({ produto_situacao: 'arquivado' })] }).itens[0].estoque).toEqual({ situacao: 'arquivado', disponivel: null });
    expect(montar({ itens: [item({ produto_situacao: 'inativo' })] }).itens[0].estoque).toEqual({ situacao: 'inativo', disponivel: null });
  });

  it('item órfão: estoque desconhecido, não zero', () => {
    const orfao = montar({ itens: [item({ produto_id: null, produto_situacao: null, estoque: null, estoque_reservado: null, produto_atualizado_em: null })] });
    expect(orfao.itens[0]).toMatchObject({ produtoId: null, nome: 'Camiseta Sintética', estoque: { situacao: 'desconhecido', disponivel: null } });
  });
});

describe('pagamento: só o título a receber do pedido prova alguma coisa', () => {
  it('sem título: desconhecido, mesmo com forma de pagamento informada', () => {
    expect(montar({ titulo: null }).pagamento).toEqual({ situacao: 'desconhecido', vencido: false, valor: null, vencimento: null, pagoEm: null });
  });

  it('código do Bling manda: 3 é parcial, 4 e 6 são devolução, 7 não prova pagamento', () => {
    const com = (situacao: string, codigo: number | null) =>
      montar({ titulo: { situacao, situacao_bling: codigo, valor: 99.8, vencimento: '2026-11-20', pago_em: null, atualizado_em: HA_UMA_HORA } }).pagamento.situacao;
    expect(com('aberto', 3)).toBe('parcial');
    expect(com('aberto', 4)).toBe('devolvido');
    expect(com('aberto', 6)).toBe('devolvido');
    expect(com('aberto', 7)).toBe('desconhecido');
    expect(com('aberto', 1)).toBe('em_aberto');
    expect(com('cancelado', 5)).toBe('cancelado');
    expect(com('pago', null)).toBe('pago');
    expect(com('estornado', null)).toBe('devolvido');
  });

  it('título em aberto com vencimento passado: vencido', () => {
    const pagamento = montar({ titulo: { situacao: 'aberto', situacao_bling: 1, valor: 99.8, vencimento: '2026-11-01', pago_em: null, atualizado_em: HA_UMA_HORA } }).pagamento;
    expect(pagamento).toMatchObject({ situacao: 'em_aberto', vencido: true });
  });

  it('vence hoje em Brasília: às 22h locais (já amanhã em UTC) ainda não está vencido', () => {
    const titulo = { situacao: 'aberto', situacao_bling: 1, valor: 99.8, vencimento: '2026-11-12', pago_em: null, atualizado_em: HA_UMA_HORA };
    const pagamento = montarRetrato(linha({ titulo }) as Parameters<typeof montarRetrato>[0], new Date('2026-11-13T01:00:00Z')).pagamento;
    expect(pagamento.vencido).toBe(false);
  });
});

describe('frescor: dado velho é dito velho', () => {
  it('sincronização com mais de 24 horas: desatualizado por antiguidade', () => {
    const retrato = montar({ sincronizacao: { pedidos: HA_TRES_DIAS, produtos: HA_TRES_DIAS, financeiro: HA_TRES_DIAS, ultimo_job: { status: 'completed', em: HA_TRES_DIAS } } });
    expect(retrato.frescor.pedido).toEqual({ situacao: 'desatualizado', sincronizadoEm: HA_TRES_DIAS, motivo: 'antiga' });
    expect(retrato.frescor.estoque.motivo).toBe('antiga');
    expect(retrato.frescor.pagamento.motivo).toBe('antiga');
  });

  it('Bling indisponível: última sincronização falhou depois da última boa', () => {
    const retrato = montar({ sincronizacao: { pedidos: HA_TRES_DIAS, produtos: HA_TRES_DIAS, financeiro: HA_UMA_HORA, ultimo_job: { status: 'failed', em: HA_UMA_HORA } } });
    expect(retrato.frescor.pedido).toEqual({ situacao: 'desatualizado', sincronizadoEm: HA_TRES_DIAS, motivo: 'ultima_sincronizacao_falhou' });
    expect(retrato.frescor.estoque.motivo).toBe('ultima_sincronizacao_falhou');
    expect(retrato.frescor.pagamento.situacao).toBe('atual');
  });

  it('nunca sincronizado: desconhecido', () => {
    const retrato = montar({ sincronizacao: { pedidos: null, produtos: null, financeiro: null, ultimo_job: null } });
    expect(retrato.frescor.pedido).toEqual({ situacao: 'desconhecido', sincronizadoEm: null, motivo: 'sem_sincronizacao' });
  });
});

describe('cardinalidade', () => {
  it('mais de 50 itens: devolve os 50 e conta os omitidos', () => {
    const itens = Array.from({ length: 50 }, (_, n) => item({ item_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}` }));
    const retrato = montar({ itens, total_de_itens: 73 });
    expect(retrato.itens).toHaveLength(50);
    expect(retrato.itensOmitidos).toBe(23);
  });
});

type Resposta = { data: unknown; error: { code: string } | null };

/** Cliente que só conhece `rpc`; qualquer outro acesso (tabela, insert, update) quebra o teste. */
function banco(resposta: Resposta) {
  const chamadas: Array<{ funcao: string; parametros: Record<string, unknown> }> = [];
  const cliente = new Proxy({
    rpc(funcao: string, parametros: Record<string, unknown>) {
      chamadas.push({ funcao, parametros });
      return Promise.resolve(resposta);
    },
  }, {
    get(alvo, chave) {
      if (chave === 'rpc') return alvo.rpc;
      throw new Error(`acesso inesperado ao banco: ${String(chave)}`);
    },
  }) as unknown as SupabaseClient;
  return { cliente, chamadas };
}

describe('lerRetratoDoPedido: a fronteira com o banco', () => {
  it('chama só a função de leitura, com a organização do escopo e nenhum cliente', async () => {
    const { cliente, chamadas } = banco({ data: linha(), error: null });
    const resultado = await lerRetratoDoPedido(cliente, ESCOPO, CONVERSA, PEDIDO, AGORA);
    expect(resultado._tag).toBe('Retrato');
    expect(chamadas).toEqual([{
      funcao: 'retrato_do_pedido_verificado_sac',
      parametros: { p_organizacao_id: ORG, p_conversa_id_local: CONVERSA, p_pedido_id: PEDIDO },
    }]);
  });

  it('recusas do banco viram resultados tipados', async () => {
    for (const [resultado, tag] of [['sem_prova', 'SemProva'], ['nao_encontrado', 'NaoEncontrado'], ['conversa_inexistente', 'ConversaNaoEncontrada']] as const) {
      const { cliente } = banco({ data: { resultado }, error: null });
      expect((await lerRetratoDoPedido(cliente, ESCOPO, CONVERSA, PEDIDO, AGORA))._tag).toBe(tag);
    }
  });

  it('erro do banco: indisponível, nunca retrato vazio', async () => {
    const { cliente } = banco({ data: null, error: { code: '57014' } });
    await expect(lerRetratoDoPedido(cliente, ESCOPO, CONVERSA, PEDIDO, AGORA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);
  });

  it('resposta com CPF ou endereço: recusada inteira, nada vaza', async () => {
    const comCpf = linha({ pedido: { ...linha().pedido, cpf_cnpj: '123.456.789-09' } });
    const comEndereco = linha({ endereco: 'Rua Sintética, 1' });
    for (const data of [comCpf, comEndereco]) {
      const { cliente } = banco({ data, error: null });
      await expect(lerRetratoDoPedido(cliente, ESCOPO, CONVERSA, PEDIDO, AGORA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);
    }
  });

  it('quantidade ou total fora do formato: indisponível, não zero', async () => {
    const { cliente } = banco({ data: linha({ itens: [item({ estoque: 'muito' })] }), error: null });
    await expect(lerRetratoDoPedido(cliente, ESCOPO, CONVERSA, PEDIDO, AGORA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);
  });
});
