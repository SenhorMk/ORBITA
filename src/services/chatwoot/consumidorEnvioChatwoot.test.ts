import { describe, expect, it } from 'vitest';

import type { ChatwootApiResult, ChatwootMessage } from './chatwootPort';
import {
  consumirEnviosUmaVez,
  type EnvioReivindicado,
  type MensagemDoRecibo,
  type PortaDoConsumidorEnvio,
  type PosseDoEnvio,
  type ResolucaoDoCanal,
} from './consumidorEnvioChatwoot';
import type { DesfechoDoDespacho } from '../outbox/desfechoDoEfeito';

/**
 * O consumidor de envio contra uma porta em memória que imita a máquina de
 * estados da outbox: só `pending` é reivindicável, `in_flight` só sai pelo
 * desfecho ou pelo reaper, e o reaper leva `in_flight` vencido a `unknown`.
 * Conta cada POST ao Chatwoot: a prova é que nenhum desfecho incerto gera um
 * segundo POST. O mesmo protocolo é provado em Postgres real no pgTAP e na
 * prova integrada.
 */

type Status = 'pending' | 'processing' | 'in_flight' | 'sent' | 'failed_transient' | 'dead_letter' | 'unknown';

interface Evento { status: Status; token: number; vencida: boolean }

const ENVIO: EnvioReivindicado = {
  eventoId: 'evt-1',
  organizacaoId: 'org-a',
  conexaoId: 'conexao-a1',
  envioId: 'envio-1',
  atorId: 'ator-1',
  conversaIdExterno: 50,
  conteudo: 'olá',
  correlationId: null,
  fencingToken: 0,
};

class PortaEmMemoria implements PortaDoConsumidorEnvio {
  readonly eventos = new Map<string, Evento>([['evt-1', { status: 'pending', token: 0, vencida: false }]]);
  readonly posts: Array<{ conversa: number; conteudo: string }> = [];
  readonly conclusoes: Array<{ desfecho: DesfechoDoDespacho; mensagem: MensagemDoRecibo | null }> = [];
  resposta: () => Promise<ChatwootApiResult<ChatwootMessage>> = async () =>
    ({ _tag: 'ChatwootSuccess', data: { id: 9001, sender: { id: 7, name: 'Agente', type: 'user' }, created_at: '2026-11-05T12:00:00Z' } });
  canal: () => Promise<ResolucaoDoCanal> = async () => ({
    _tag: 'Canal',
    canal: {
      sendMessage: async (conversa, conteudo) => {
        this.posts.push({ conversa, conteudo });
        return this.resposta();
      },
    },
  });
  iniciarRecusa = false;
  concluirFalha = false;
  concluirSemPosse = false;

  async liberarLeasesVencidas() {
    let n = 0;
    for (const evento of this.eventos.values()) {
      if (!evento.vencida) continue;
      if (evento.status === 'in_flight') { evento.status = 'unknown'; n++; }
      if (evento.status === 'processing') { evento.status = 'failed_transient'; n++; }
    }
    return n;
  }

  async reivindicar() {
    const lote: EnvioReivindicado[] = [];
    for (const [id, evento] of this.eventos) {
      if (evento.status !== 'pending' && evento.status !== 'failed_transient') continue;
      evento.status = 'processing';
      evento.token++;
      lote.push({ ...ENVIO, eventoId: id, fencingToken: evento.token });
    }
    return lote;
  }

  async resolverCanal() {
    return this.canal();
  }

  async iniciarDespacho(posse: PosseDoEnvio) {
    const evento = this.eventos.get(posse.eventoId)!;
    if (this.iniciarRecusa || evento.status !== 'processing' || evento.token !== posse.fencingToken) return false;
    evento.status = 'in_flight';
    return true;
  }

  async concluir(posse: PosseDoEnvio, desfecho: DesfechoDoDespacho, mensagem: MensagemDoRecibo | null) {
    if (this.concluirFalha) throw new Error('banco caiu');
    const evento = this.eventos.get(posse.eventoId)!;
    if (this.concluirSemPosse || evento.token !== posse.fencingToken) return null;
    this.conclusoes.push({ desfecho, mensagem });
    const status: Status = desfecho._tag === 'Confirmado' ? 'sent'
      : desfecho._tag === 'Recusado' ? 'dead_letter'
        : desfecho._tag === 'NaoEnviado' ? 'failed_transient' : 'unknown';
    evento.status = status;
    return status;
  }
}

const opcoes = { workerId: 'w-1', limite: 10, leaseSegundos: 60, criadosDesde: '2026-11-05T00:00:00Z' };

describe('consumidor de envio do Chatwoot (MSG-008)', () => {
  it('confirma só com recibo, uma vez, e leva remetente e horário do recibo sem o conteúdo', async () => {
    const porta = new PortaEmMemoria();
    const resumo = await consumirEnviosUmaVez(porta, opcoes);

    expect(porta.posts).toEqual([{ conversa: 50, conteudo: 'olá' }]);
    expect(resumo).toMatchObject({ reivindicados: 1, enviados: 1 });
    expect(porta.conclusoes).toEqual([{
      desfecho: { _tag: 'Confirmado', recibo: '9001', resposta: { id: 9001 } },
      mensagem: { remetenteNome: 'Agente', remetenteId: 7, remetenteTipo: 'user', criadaEm: '2026-11-05T12:00:00Z' },
    }]);
    expect(await consumirEnviosUmaVez(porta, opcoes)).toMatchObject({ reivindicados: 0 });
    expect(porta.posts).toHaveLength(1);
  });

  const ambiguos: Array<[string, ChatwootApiResult<ChatwootMessage>, string]> = [
    ['timeout (3)', { _tag: 'ChatwootFailed', reason: 'timeout', retryable: true }, 'timeout'],
    ['ACK perdido (4)', { _tag: 'ChatwootFailed', reason: 'network', retryable: true }, 'ack_perdido'],
    ['2xx inválido (5)', { _tag: 'ChatwootFailed', reason: 'invalid-response', retryable: false }, 'resposta_invalida'],
    ['429 sem prova (6)', { _tag: 'ChatwootFailed', reason: 'rate-limited', retryable: true }, 'limite_sem_prova'],
    ['5xx (7)', { _tag: 'ChatwootFailed', reason: 'http', status: 503, retryable: true }, 'erro_do_provedor'],
  ];
  it.each(ambiguos)('%s: unknown, sem mensagem espelhada e sem segundo POST', async (_caso, resposta, motivo) => {
    const porta = new PortaEmMemoria();
    porta.resposta = async () => resposta;
    const resumo = await consumirEnviosUmaVez(porta, opcoes);

    expect(resumo).toMatchObject({ desconhecidos: 1, enviados: 0 });
    expect(porta.conclusoes).toEqual([{ desfecho: expect.objectContaining({ _tag: 'Desconhecido', motivo }), mensagem: null }]);
    await consumirEnviosUmaVez(porta, opcoes);
    expect(porta.posts).toHaveLength(1);
  });

  it('exceção do adapter depois do despacho: unknown, nunca repetível', async () => {
    const porta = new PortaEmMemoria();
    porta.resposta = async () => { throw new Error('socket hang up'); };
    await consumirEnviosUmaVez(porta, opcoes);
    await consumirEnviosUmaVez(porta, opcoes);

    expect(porta.conclusoes[0]!.desfecho).toMatchObject({ _tag: 'Desconhecido', motivo: 'falha_apos_despacho' });
    expect(porta.posts).toHaveLength(1);
  });

  it.each([
    ['recusa definitiva 4xx (2)', 422, 'permanent', 'http_422'],
    ['credencial recusada', 401, 'auth_expired', 'http_401'],
  ])('%s: dead_letter, sem mensagem e sem retry', async (_caso, status, categoria, codigo) => {
    const porta = new PortaEmMemoria();
    porta.resposta = async () => ({ _tag: 'ChatwootFailed', reason: 'http', status, retryable: false });
    const resumo = await consumirEnviosUmaVez(porta, opcoes);
    await consumirEnviosUmaVez(porta, opcoes);

    expect(resumo.recusados).toBe(1);
    expect(porta.conclusoes[0]!.desfecho).toMatchObject({ _tag: 'Recusado', categoria, codigo });
    expect(porta.posts).toHaveLength(1);
  });

  it('sucesso remoto e queda antes de gravar o recibo (10): fica em voo, o reaper leva a unknown, e não há segundo POST', async () => {
    const porta = new PortaEmMemoria();
    porta.concluirFalha = true;
    const primeira = await consumirEnviosUmaVez(porta, opcoes);
    expect(primeira.semDesfechoGravado).toBe(1);
    expect(porta.eventos.get('evt-1')!.status).toBe('in_flight');

    porta.concluirFalha = false;
    porta.eventos.get('evt-1')!.vencida = true;
    const retomada = await consumirEnviosUmaVez(porta, opcoes);

    expect(retomada).toMatchObject({ reaped: 1, reivindicados: 0 });
    expect(porta.eventos.get('evt-1')!.status).toBe('unknown');
    expect(porta.posts).toHaveLength(1);
  });

  it('posse perdida antes da rede (fencing): nenhum POST', async () => {
    const porta = new PortaEmMemoria();
    porta.iniciarRecusa = true;
    const resumo = await consumirEnviosUmaVez(porta, opcoes);

    expect(resumo.semPosse).toBe(1);
    expect(porta.posts).toHaveLength(0);
  });

  it('recibo chega com a lease vencida (CAS recusa): nada é afirmado e nada é repetido', async () => {
    const porta = new PortaEmMemoria();
    porta.concluirSemPosse = true;
    const resumo = await consumirEnviosUmaVez(porta, opcoes);
    await consumirEnviosUmaVez(porta, opcoes);

    expect(resumo).toMatchObject({ semPosse: 1, enviados: 0 });
    expect(porta.posts).toHaveLength(1);
  });

  it.each([
    ['autor sem vínculo com a organização', { _tag: 'SemVinculo' } as const, 'autor_sem_vinculo'],
    ['conexão desligada ou sem credencial', { _tag: 'NaoConfigurado' } as const, 'nao_configurado'],
  ])('%s: recusa antes do despacho, sem POST', async (_caso, resolucao, codigo) => {
    const porta = new PortaEmMemoria();
    porta.canal = async () => resolucao;
    const resumo = await consumirEnviosUmaVez(porta, opcoes);

    expect(resumo.recusados).toBe(1);
    expect(porta.conclusoes[0]!.desfecho).toMatchObject({ _tag: 'Recusado', codigo });
    expect(porta.posts).toHaveLength(0);
  });

  it('falha ao ler vínculo ou credencial (1, antes do envio): volta à fila com prova de que nada saiu', async () => {
    const porta = new PortaEmMemoria();
    porta.canal = async () => { throw new Error('banco fora'); };
    const resumo = await consumirEnviosUmaVez(porta, opcoes);

    expect(resumo.repetiveis).toBe(1);
    expect(porta.conclusoes[0]!.desfecho).toMatchObject({ _tag: 'NaoEnviado', prova: 'transporte_nao_iniciado' });
    expect(porta.posts).toHaveLength(0);
  });

  it('parada entre envios: o envio em curso termina e o resto do lote não é despachado', async () => {
    const porta = new PortaEmMemoria();
    porta.eventos.set('evt-2', { status: 'pending', token: 0, vencida: false });
    let parar = false;
    porta.resposta = async () => {
      parar = true;
      return { _tag: 'ChatwootSuccess', data: { id: 9001 } };
    };
    await consumirEnviosUmaVez(porta, { ...opcoes, deveParar: () => parar });

    expect(porta.posts).toHaveLength(1);
    expect(porta.eventos.get('evt-2')!.status).toBe('processing');
  });
});
