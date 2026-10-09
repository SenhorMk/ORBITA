import type { ContaPagarPayload, DespesaBlingPort } from '../despesaHandler';
import type { EnvioDeCriacaoAoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import type { FalhaDeOperacaoRemota } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';
import type { CodigoDaSituacaoDaConta } from '@/lib/integrations/bling/situacaoDaContaBling';
import type { BlingPort, ContaPagarDetalhada } from '@/services/blingPort';

/**
 * Bling fake das contas a pagar. Separa o que EXISTE no Bling (`remotas`, e os
 * contadores de POST) do que a resposta diz: é isso que deixa um teste de ACK
 * perdido falhar quando há um segundo POST, e que deixa a reconciliação achar
 * a conta criada por um POST cuja resposta nunca chegou.
 */

type ModoDeCriacao =
  | 'confirma'
  | 'perde-ack' // cria no Bling e a resposta se perde (prazo/conexão)
  | 'timeout-sem-criar' // nada criado, mas também nada voltou
  | 'sem-credencial' // nenhuma requisição sai
  | 'erro-5xx' // o Bling responde 500 — e pode ter criado
  | 'sucesso-sem-id' // cria e responde 2xx sem id
  | 'recusa'; // VALIDATION_ERROR 400

type ModoDeBaixa = 'confirma' | 'perde-ack' | 'ambigua-sem-efeito' | 'sem-credencial' | 'recusa';

/** Como uma leitura ou listagem falha, quando falha. */
export type FalhaDeLeitura = 'timeout' | 'limite' | 'erro-5xx' | 'invalida';

/** Uma falha do Bling: texto vira `VALIDATION_ERROR 400`; uma falha pronta passa como está. */
type FalhaProgramada = string | BlingProviderFailure;

/** Conta a pagar como existe no Bling fake. */
export interface ContaRemotaFake {
  id: string;
  situacao: CodigoDaSituacaoDaConta;
  valor: number;
  vencimento: string;
  contatoId: number;
  dataEmissao: string | null;
  numeroDocumento: string | null;
  saldo: number | null;
  historico: string | null;
  categoriaId: number | null;
  borderos: string[];
}

export interface FakeBling extends DespesaBlingPort, Pick<BlingPort, 'lerContaPagarParaReconciliacao' | 'listarContasPagarParaReconciliacao'> {
  /** Payloads de `POST /contas/pagar` que CHEGARAM ao Bling, criando ou não. */
  readonly posts: ContaPagarPayload[];
  /** Contas criadas por POST do ORBITA. A contraprova principal conta isto. */
  readonly contasCriadasNoBling: () => number;
  /** Baixas que o Bling aplicou. */
  readonly baixadas: Array<{ id: string; portadorId: number; categoriaId: number }>;
  /** `POST .../baixar` que chegaram ao Bling, aplicados ou não. */
  readonly baixasEnviadas: () => number;
  readonly contatosResolvidos: () => number;
  /** O estado do Bling. Contas de terceiros entram por `semear`. */
  readonly remotas: Map<string, ContaRemotaFake>;
  semear(conta: Partial<ContaRemotaFake> & Pick<ContaRemotaFake, 'id' | 'valor' | 'vencimento' | 'contatoId'>): void;
}

function falhaBling(type: string, status: number, message: string) {
  return {
    _tag: 'BlingFailed' as const,
    failure: { _tag: 'BlingProviderFailure' as const, type, status, message, duplicateSale: false },
  };
}

function falhaProgramada(falha: FalhaProgramada) {
  return typeof falha === 'string' ? falhaBling('VALIDATION_ERROR', 400, falha) : { _tag: 'BlingFailed' as const, failure: falha };
}

function falhaRemota(falha: FalhaDeLeitura): FalhaDeOperacaoRemota {
  if (falha === 'limite') return { _tag: 'RemotoLimitado' };
  if (falha === 'timeout') return { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' };
  if (falha === 'erro-5xx') return { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' };
  return { _tag: 'RemotoIndeterminado', causa: 'resposta_invalida' };
}

export function fakeBling(options: {
  modo?: ModoDeCriacao;
  falhaCriar?: FalhaProgramada;
  falhaPortador?: FalhaProgramada;
  baixa?: ModoDeBaixa;
  falhaBaixa?: FalhaProgramada;
  /** Atalho antigo: quitação sem resposta e sem efeito. */
  baixaAmbigua?: boolean;
  falhaContato?: FalhaProgramada;
  falhaDeLeitura?: FalhaDeLeitura;
  falhaDeListagem?: FalhaDeLeitura | 'incompleta';
  /** A conta aparece na listagem e some na leitura por id. */
  someEntreLeituras?: boolean;
  /** Chamado no instante do POST — antes de qualquer resposta. */
  aoReceberPost?: () => void;
  /** Segura a resposta até a promessa resolver (corrida). */
  segurarResposta?: Promise<void>;
} = {}): FakeBling {
  const posts: ContaPagarPayload[] = [];
  const baixadas: Array<{ id: string; portadorId: number; categoriaId: number }> = [];
  const remotas = new Map<string, ContaRemotaFake>();
  let criadas = 0;
  let baixasEnviadas = 0;
  let contatos = 0;
  const modo: ModoDeCriacao = options.falhaCriar ? 'recusa' : options.modo ?? 'confirma';
  const modoDeBaixa: ModoDeBaixa = options.falhaBaixa
    ? 'recusa'
    : options.baixaAmbigua ? 'ambigua-sem-efeito' : options.baixa ?? 'confirma';

  const criarRemota = (payload: ContaPagarPayload): string => {
    criadas++;
    const id = String(88122 + criadas);
    remotas.set(id, {
      id,
      situacao: 1,
      valor: payload.valor,
      vencimento: payload.vencimento,
      contatoId: payload.contatoId,
      dataEmissao: payload.dataEmissao,
      numeroDocumento: payload.numeroDocumento ?? null,
      saldo: payload.valor,
      historico: payload.historico,
      categoriaId: payload.categoriaId ?? null,
      borderos: [],
    });
    return id;
  };

  return {
    posts,
    baixadas,
    remotas,
    contasCriadasNoBling: () => criadas,
    baixasEnviadas: () => baixasEnviadas,
    contatosResolvidos: () => contatos,
    semear(conta) {
      remotas.set(conta.id, {
        situacao: 1, dataEmissao: null, numeroDocumento: null, saldo: conta.valor, historico: null,
        categoriaId: null, borderos: [], ...conta,
      });
    },
    async resolverContatoPadrao() {
      contatos++;
      if (options.falhaContato) return falhaProgramada(options.falhaContato);
      return { _tag: 'BlingOk' as const, value: 7001 };
    },
    async criarContaPagar(payload): Promise<EnvioDeCriacaoAoBling<{ id: string }>> {
      if (modo === 'sem-credencial') return { _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' };
      posts.push(payload);
      options.aoReceberPost?.();
      if (options.segurarResposta) await options.segurarResposta;
      switch (modo) {
        case 'confirma':
          return { _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { id: criarRemota(payload) } } };
        case 'perde-ack':
          criarRemota(payload);
          return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
        case 'timeout-sem-criar':
          return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
        case 'erro-5xx':
          criarRemota(payload);
          return { _tag: 'Despachado', resultado: falhaBling('SERVER_ERROR', 500, 'Erro interno') };
        case 'sucesso-sem-id':
          criarRemota(payload);
          return { _tag: 'Despachado', resultado: falhaBling('INVALID_RESPONSE', 201, 'sem id') };
        case 'recusa':
          return { _tag: 'Despachado', resultado: falhaProgramada(options.falhaCriar ?? 'contato.id inválido') };
      }
    },
    async obterPortadorPadrao() {
      if (options.falhaPortador) return falhaProgramada(options.falhaPortador);
      return { _tag: 'BlingOk' as const, value: 55 };
    },
    async baixarContaPagar(id, payload): Promise<EnvioDeCriacaoAoBling<{ borderoId: string | null }>> {
      if (modoDeBaixa === 'sem-credencial') return { _tag: 'NaoEnviado', motivo: 'credencial_indisponivel' };
      baixasEnviadas++;
      if (modoDeBaixa === 'recusa') return { _tag: 'Despachado', resultado: falhaProgramada(options.falhaBaixa ?? 'Portador inválido') };
      if (modoDeBaixa === 'ambigua-sem-efeito') {
        return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
      }
      const conta = remotas.get(id);
      const borderoId = String(7000 + baixasEnviadas);
      if (conta) {
        conta.situacao = 2;
        conta.saldo = 0;
        conta.borderos.push(borderoId);
      }
      baixadas.push({ id, portadorId: payload.portadorId, categoriaId: payload.categoriaId });
      return modoDeBaixa === 'perde-ack'
        ? { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') }
        : { _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { borderoId } } };
    },
    async lerContaPagarParaReconciliacao(id) {
      if (options.falhaDeLeitura) return falhaRemota(options.falhaDeLeitura);
      if (options.someEntreLeituras) return { _tag: 'RemotoAusente' };
      const conta = remotas.get(id);
      if (!conta) return { _tag: 'RemotoAusente' };
      const copia: ContaPagarDetalhada = { ...conta, borderos: [...conta.borderos] };
      return { _tag: 'RemotoPresente', valor: copia };
    },
    async listarContasPagarParaReconciliacao(filtro) {
      if (options.falhaDeListagem === 'incompleta') return { _tag: 'ListagemIncompleta' };
      if (options.falhaDeListagem) return falhaRemota(options.falhaDeListagem);
      const contas = [...remotas.values()]
        .filter((c) => c.dataEmissao === filtro.dataEmissao && c.vencimento === filtro.dataVencimento
          && (filtro.contatoId === null || c.contatoId === filtro.contatoId))
        .map(({ id, situacao, valor, vencimento, contatoId }) => ({ id, situacao, valor, vencimento, contatoId }));
      return { _tag: 'Listada', contas };
    },
  };
}
