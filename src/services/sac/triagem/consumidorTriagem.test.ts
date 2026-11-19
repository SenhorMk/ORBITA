import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumirTriagensUmaVez,
  type ConclusaoDaTriagem,
  type InicioDaTriagem,
  type PortaDoConsumidorTriagem,
  type TriagemReivindicada,
} from './consumidorTriagem';
import type { ModeloDeTriagem, RespostaDoModelo } from './triagemDoCaso';

const ITEM: TriagemReivindicada = {
  eventoId: '11111111-1111-4111-8111-111111111111', organizacaoId: '22222222-2222-4222-8222-222222222222',
  casoId: '33333333-3333-4333-8333-333333333333', correlationId: 'corr-1', fencingToken: 4,
};
const RUN = '44444444-4444-4444-8444-444444444444';
const TEXTO_PRIVADO = 'Meu pedido 1001 não chegou, estou muito brava';
const TRIAGEM = {
  versao: 1, intencao: 'rastrear_pedido', motivo: 'Pedido atrasado.', confianca: 'alta', numeroDoPedido: '1001',
  resolucaoPedida: 'informacao', entidades: [], informacoesFaltando: [], proximaPergunta: null, precisaDeHumano: false, motivoDoHumano: null,
};

function porta(inicio: InicioDaTriagem, gravado: Awaited<ReturnType<PortaDoConsumidorTriagem['concluir']>> = 'concluida') {
  return {
    liberarLeasesVencidas: vi.fn(async () => 0),
    reivindicar: vi.fn(async () => [ITEM]),
    iniciar: vi.fn<PortaDoConsumidorTriagem['iniciar']>(async () => inicio),
    concluir: vi.fn<PortaDoConsumidorTriagem['concluir']>(async () => gravado),
  };
}

function modelo(resposta: RespostaDoModelo): ModeloDeTriagem & { gerar: ReturnType<typeof vi.fn> } {
  return { provedor: 'teste', modelo: 'm', gerar: vi.fn(async () => resposta) };
}

const opcoes = { workerId: 'w-1', limite: 5, leaseSegundos: 120, limiteDiario: 50, timeoutMs: 1000 };
const iniciada: InicioDaTriagem = { _tag: 'Iniciada', runId: RUN, mensagens: [{ conteudo: TEXTO_PRIVADO, criadaEm: '2026-11-12T10:00:00Z' }] };

afterEach(() => vi.restoreAllMocks());

describe('consumirTriagensUmaVez', () => {
  it('iniciada: chama o modelo e conclui com o token da posse, versão de prompt e schema', async () => {
    const p = porta(iniciada);
    const m = modelo({ _tag: 'Objeto', valor: TRIAGEM, uso: { entrada: 300, saida: 80 } });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const resumo = await consumirTriagensUmaVez(p, m, opcoes);

    expect(resumo).toMatchObject({ reivindicados: 1, concluidas: 1 });
    expect(p.iniciar).toHaveBeenCalledWith(ITEM, expect.objectContaining({
      workerId: 'w-1', limiteDiario: 50, provedor: 'teste', modelo: 'm', versaoPrompt: 'triagem-v1', versaoSchema: 1,
    }));
    const [runId, workerId, token, conclusao] = p.concluir.mock.calls[0] as [string, string, number, ConclusaoDaTriagem];
    expect([runId, workerId, token]).toEqual([RUN, 'w-1', 4]);
    expect(conclusao).toMatchObject({ status: 'concluida', motivo: null, chamouModelo: true, tokensEntrada: 300, tokensSaida: 80, reparos: 0 });
    expect(conclusao.triagem?.intencao).toBe('rastrear_pedido');
  });

  it.each(['obsoleta', 'sem_orcamento', 'posse_perdida', 'caso_inexistente'] as const)('encerrada no início (%s): o modelo não é chamado', async (motivo) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = porta({ _tag: 'Encerrada', motivo });
    const m = modelo({ _tag: 'Timeout' });
    expect(await consumirTriagensUmaVez(p, m, opcoes)).toMatchObject({ encerradas: 1 });
    expect(m.gerar).not.toHaveBeenCalled();
    expect(p.concluir).not.toHaveBeenCalled();
  });

  it('429: conclui como falha, com a espera pedida pelo provedor', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = porta(iniciada, 'falha');
    await consumirTriagensUmaVez(p, modelo({ _tag: 'Limite', repetirEmSegundos: 90 }), opcoes);
    expect(p.concluir.mock.calls[0][3]).toMatchObject({ status: 'falha', motivo: 'limite_do_provedor', repetirEmSegundos: 90, triagem: null });
  });

  it('os logs levam ids, desfecho e uso; nunca o texto da cliente nem o resultado', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await consumirTriagensUmaVez(porta(iniciada), modelo({ _tag: 'Objeto', valor: TRIAGEM, uso: { entrada: 1, saida: 1 } }), opcoes);
    const linhas = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(linhas).toContain('sac.triagem.concluida');
    expect(linhas).toContain('corr-1');
    expect(linhas).not.toContain('brava');
    expect(linhas).not.toContain('Pedido atrasado');
  });

  it('parada pedida: não começa o próximo item', async () => {
    const p = porta(iniciada);
    await consumirTriagensUmaVez(p, modelo({ _tag: 'Timeout' }), { ...opcoes, deveParar: () => true });
    expect(p.iniciar).not.toHaveBeenCalled();
  });
});
