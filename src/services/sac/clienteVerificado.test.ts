import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import {
  confirmarCliente,
  criarConsultaDePedidos,
  lerVerificacao,
  revogarVerificacao,
  VerificacaoIndisponivel,
} from './clienteVerificado';

const ORG = '22222222-2222-4222-8222-222222222222';
const ATOR = '70000000-0000-4000-8000-000000000001';
const CONVERSA = '44444444-4444-4444-8444-444444444444';
const CLIENTE = '55555555-5555-4555-8555-555555555555';
const COMANDO = '66666666-6666-4666-8666-666666666666';
const VINCULO = '77777777-7777-4777-8777-777777777777';
const PEDIDO = '88888888-8888-4888-8888-888888888888';
const ESCOPO = { organizationId: ORG, actorId: ATOR, role: 'member' } as VerifiedOrganizationScope;

type Resposta = { data: unknown; error: { code: string } | null };

/** Cliente que só conhece `rpc`: guarda cada chamada e devolve o que o teste combinou por função. */
function banco(respostas: Record<string, Resposta>) {
  const chamadas: Array<{ funcao: string; parametros: Record<string, unknown> }> = [];
  const cliente = {
    rpc(funcao: string, parametros: Record<string, unknown>) {
      chamadas.push({ funcao, parametros });
      return Promise.resolve(respostas[funcao] ?? { data: null, error: { code: 'PGRST202' } });
    },
  } as unknown as SupabaseClient;
  return { cliente, chamadas };
}

const linhaVerificada = {
  resultado: 'encontrada', estado: 'verificado', cliente_id: CLIENTE, cliente_nome: 'Ana Sintética',
  verificado_em: '2026-11-10T10:00:00+00:00', expira_em: '2026-11-11T10:00:00+00:00', candidatos: 1, consulta_bloqueada: false,
};
const linhaSemProva = {
  resultado: 'encontrada', estado: 'sem_prova', cliente_id: null, cliente_nome: null,
  verificado_em: null, expira_em: null, candidatos: 2, consulta_bloqueada: false,
};
const pedido = { resultado: 'pedido', pedido_id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Pendente', total: 10 };
const vazio = { pedido_id: null, numero: null, data: null, status: null, total: null };

describe('lerVerificacao', () => {
  it('lê pela organização do escopo e devolve estado e candidatos, sem documento inteiro', async () => {
    const { cliente, chamadas } = banco({
      ler_verificacao_cliente_sac: { data: [linhaSemProva], error: null },
      listar_candidatos_cliente_sac: {
        data: [{ cliente_id: CLIENTE, nome: 'Bia Sintética', documento_final: '09' }, { cliente_id: PEDIDO, nome: 'Caio Sintético', documento_final: null }],
        error: null,
      },
    });

    const leitura = await lerVerificacao(cliente, ESCOPO, CONVERSA);

    expect(chamadas.map((c) => c.parametros)).toEqual([
      { p_organizacao_id: ORG, p_conversa_id_local: CONVERSA },
      { p_organizacao_id: ORG, p_conversa_id_local: CONVERSA },
    ]);
    expect(leitura).toEqual({
      _tag: 'Encontrada',
      verificacao: { estado: 'sem_prova', cliente: null, verificadoEm: null, expiraEm: null, totalDeCandidatos: 2, consultaPorNumeroBloqueada: false },
      candidatos: [{ clienteId: CLIENTE, nome: 'Bia Sintética', documentoFinal: '09' }, { clienteId: PEDIDO, nome: 'Caio Sintético', documentoFinal: null }],
    });
  });

  it('sem candidato, não consulta a lista; verificada, traz o cliente', async () => {
    const { cliente, chamadas } = banco({ ler_verificacao_cliente_sac: { data: [{ ...linhaVerificada, candidatos: 0 }], error: null } });

    const leitura = await lerVerificacao(cliente, ESCOPO, CONVERSA);

    expect(chamadas).toHaveLength(1);
    expect(leitura).toMatchObject({
      _tag: 'Encontrada',
      verificacao: { estado: 'verificado', cliente: { id: CLIENTE, nome: 'Ana Sintética' }, expiraEm: '2026-11-11T10:00:00+00:00' },
      candidatos: [],
    });
  });

  it('conversa de outra organização: não encontrada, sem estado padrão', async () => {
    const { cliente } = banco({
      ler_verificacao_cliente_sac: {
        data: [{ resultado: 'conversa_inexistente', estado: null, cliente_id: null, cliente_nome: null, verificado_em: null, expira_em: null, candidatos: null, consulta_bloqueada: null }],
        error: null,
      },
    });
    expect(await lerVerificacao(cliente, ESCOPO, CONVERSA)).toEqual({ _tag: 'ConversaNaoEncontrada' });
  });

  it('erro do banco ou linha fora do contrato: indisponível, nunca "sem prova"', async () => {
    const comErro = banco({ ler_verificacao_cliente_sac: { data: null, error: { code: '57014' } } });
    await expect(lerVerificacao(comErro.cliente, ESCOPO, CONVERSA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);

    const foraDoContrato = banco({ ler_verificacao_cliente_sac: { data: [{ ...linhaVerificada, estado: 'liberado' }], error: null } });
    await expect(lerVerificacao(foraDoContrato.cliente, ESCOPO, CONVERSA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);

    const verificadaSemCliente = banco({ ler_verificacao_cliente_sac: { data: [{ ...linhaVerificada, cliente_id: null }], error: null } });
    await expect(lerVerificacao(verificadaSemCliente.cliente, ESCOPO, CONVERSA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);
  });
});

describe('confirmarCliente e revogarVerificacao', () => {
  it('organização e ator vêm do escopo; o comando só escolhe conversa e cliente', async () => {
    const { cliente, chamadas } = banco({
      confirmar_vinculo_cliente_sac: { data: [{ resultado: 'aplicado', vinculo_id: VINCULO, cliente_id: CLIENTE, expira_em: '2026-11-11T10:00:00+00:00' }], error: null },
    });

    const resultado = await confirmarCliente(cliente, ESCOPO, { conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE });

    expect(chamadas[0]).toEqual({
      funcao: 'confirmar_vinculo_cliente_sac',
      parametros: { p_organizacao_id: ORG, p_ator_id: ATOR, p_conversa_id_local: CONVERSA, p_command_id: COMANDO, p_cliente_id: CLIENTE },
    });
    expect(resultado).toEqual({ _tag: 'Confirmado', duplicado: false, vinculoId: VINCULO, expiraEm: '2026-11-11T10:00:00+00:00' });
  });

  it.each([
    ['existente', { _tag: 'Confirmado', duplicado: true, vinculoId: VINCULO, expiraEm: '2026-11-11T10:00:00+00:00' }],
    ['conflito_comando', { _tag: 'ConflitoDeComando' }],
    ['cliente_inexistente', { _tag: 'ClienteNaoEncontrado' }],
    ['conversa_inexistente', { _tag: 'ConversaNaoEncontrada' }],
    ['sem_vinculo', { _tag: 'SemVinculo' }],
  ])('resultado %s do banco', async (resultado, esperado) => {
    const aplicou = resultado === 'existente';
    const { cliente } = banco({
      confirmar_vinculo_cliente_sac: {
        data: [{ resultado, vinculo_id: aplicou ? VINCULO : null, cliente_id: aplicou ? CLIENTE : null, expira_em: aplicou ? '2026-11-11T10:00:00+00:00' : null }],
        error: null,
      },
    });
    expect(await confirmarCliente(cliente, ESCOPO, { conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE })).toEqual(esperado);
  });

  it('"aplicado" sem prova gravada é resposta fora do contrato, não sucesso', async () => {
    const { cliente } = banco({ confirmar_vinculo_cliente_sac: { data: [{ resultado: 'aplicado', vinculo_id: null, cliente_id: null, expira_em: null }], error: null } });
    await expect(confirmarCliente(cliente, ESCOPO, { conversaId: CONVERSA, commandId: COMANDO, clienteId: CLIENTE }))
      .rejects.toBeInstanceOf(VerificacaoIndisponivel);
  });

  it.each([
    ['aplicado', { _tag: 'Revogada' }],
    ['sem_prova', { _tag: 'SemProva' }],
    ['conversa_inexistente', { _tag: 'ConversaNaoEncontrada' }],
    ['sem_vinculo', { _tag: 'SemVinculo' }],
  ])('revogar: %s', async (resultado, esperado) => {
    const { cliente, chamadas } = banco({ revogar_vinculo_cliente_sac: { data: resultado, error: null } });
    expect(await revogarVerificacao(cliente, ESCOPO, CONVERSA)).toEqual(esperado);
    expect(chamadas[0].parametros).toEqual({ p_organizacao_id: ORG, p_ator_id: ATOR, p_conversa_id_local: CONVERSA });
  });

  it('revogar com resposta desconhecida ou erro: indisponível', async () => {
    const estranho = banco({ revogar_vinculo_cliente_sac: { data: 'feito', error: null } });
    await expect(revogarVerificacao(estranho.cliente, ESCOPO, CONVERSA)).rejects.toBeInstanceOf(VerificacaoIndisponivel);
  });
});

describe('criarConsultaDePedidos: a ferramenta de escopo fechado', () => {
  it('não recebe cliente nem organização: só o número, e o resto vem do escopo', async () => {
    const { cliente, chamadas } = banco({ consultar_pedidos_do_cliente_verificado_sac: { data: [pedido], error: null } });
    const consulta = criarConsultaDePedidos(cliente, ESCOPO, CONVERSA);

    expect(consulta.listar).toHaveLength(0);
    expect(consulta.localizar).toHaveLength(1);
    await consulta.listar();
    await consulta.localizar('1001');

    expect(chamadas.map((c) => c.parametros)).toEqual([
      { p_organizacao_id: ORG, p_conversa_id_local: CONVERSA, p_numero: null },
      { p_organizacao_id: ORG, p_conversa_id_local: CONVERSA, p_numero: '1001' },
    ]);
  });

  it('com prova: só o mínimo de cada pedido', async () => {
    const { cliente } = banco({ consultar_pedidos_do_cliente_verificado_sac: { data: [pedido, { ...pedido, numero: null, total: '20.50' }], error: null } });

    expect(await criarConsultaDePedidos(cliente, ESCOPO, CONVERSA).listar()).toEqual({
      _tag: 'Pedidos',
      pedidos: [
        { id: PEDIDO, numero: '1001', data: '2026-11-08T10:00:00+00:00', status: 'Pendente', total: 10 },
        { id: PEDIDO, numero: null, data: '2026-11-08T10:00:00+00:00', status: 'Pendente', total: 20.5 },
      ],
    });
  });

  it.each([
    ['sem_pedidos', { _tag: 'Pedidos', pedidos: [] }],
    ['sem_prova', { _tag: 'SemProva', proximoPasso: 'encaminhar_para_humano' }],
    ['bloqueada', { _tag: 'Bloqueada', proximoPasso: 'encaminhar_para_humano' }],
    ['nao_encontrado', { _tag: 'NaoEncontrado' }],
    ['conversa_inexistente', { _tag: 'ConversaNaoEncontrada' }],
  ])('resultado %s: nenhum dado de pedido', async (resultado, esperado) => {
    const { cliente } = banco({ consultar_pedidos_do_cliente_verificado_sac: { data: [{ resultado, ...vazio }], error: null } });
    expect(await criarConsultaDePedidos(cliente, ESCOPO, CONVERSA).localizar('9999')).toEqual(esperado);
  });

  it('falha fechado: erro, resposta vazia ou recusa acompanhada de pedido não viram lista', async () => {
    for (const data of [null, [], [{ resultado: 'sem_prova', ...vazio }, pedido], [{ ...pedido, pedido_id: null }], [{ resultado: 'liberado', ...vazio }]]) {
      const { cliente } = banco({ consultar_pedidos_do_cliente_verificado_sac: { data, error: null } });
      await expect(criarConsultaDePedidos(cliente, ESCOPO, CONVERSA).listar()).rejects.toBeInstanceOf(VerificacaoIndisponivel);
    }
    const comErro = banco({ consultar_pedidos_do_cliente_verificado_sac: { data: null, error: { code: '57014' } } });
    await expect(criarConsultaDePedidos(comErro.cliente, ESCOPO, CONVERSA).listar()).rejects.toBeInstanceOf(VerificacaoIndisponivel);
  });
});
