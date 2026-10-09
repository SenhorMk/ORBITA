import type {
  ContaPagarPayload,
  DespesaBlingPort,
  DespesaDependencies,
  DespesaStorePort,
  GravacaoDeTentativa,
  IntencaoDeContaPagar,
} from '../despesaHandler';
import type { EnvioDeCriacaoAoBling } from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/**
 * Fakes da rota de despesa, compartilhados pelos testes do handler e pelo
 * teste do formulário que atravessa até o handler real.
 */

// Bling fake. Separa o que ACONTECEU no Bling (`contasCriadasNoBling`) do que a
// resposta diz — é isso que deixa um teste de ACK perdido falhar com dois POSTs.

type ModoDeCriacao =
  | 'confirma'
  | 'perde-ack' // cria no Bling e a resposta se perde (prazo/conexão)
  | 'timeout-sem-criar' // nada criado, mas também nada voltou
  | 'sem-credencial' // nenhuma requisição sai
  | 'erro-5xx' // o Bling responde 500 — e pode ter criado
  | 'sucesso-sem-id' // cria e responde 2xx sem id
  | 'recusa'; // VALIDATION_ERROR 400

export interface FakeBling extends DespesaBlingPort {
  /** Payloads que CHEGARAM ao Bling, criando ou não. */
  readonly posts: ContaPagarPayload[];
  /** Contas que EXISTEM no Bling. A contraprova principal conta isto. */
  readonly contasCriadasNoBling: () => number;
  readonly baixadas: Array<{ id: string; portadorId: number; categoriaId: number }>;
  /** Quantas vezes o fornecedor padrão foi procurado no Bling. */
  readonly contatosResolvidos: () => number;
}

/** Uma falha do Bling: texto vira `VALIDATION_ERROR 400`; uma falha pronta passa como está. */
type FalhaProgramada = string | BlingProviderFailure;

function falhaBling(type: string, status: number, message: string) {
  return {
    _tag: 'BlingFailed' as const,
    failure: { _tag: 'BlingProviderFailure' as const, type, status, message, duplicateSale: false },
  };
}

function falhaProgramada(falha: FalhaProgramada) {
  return typeof falha === 'string' ? falhaBling('VALIDATION_ERROR', 400, falha) : { _tag: 'BlingFailed' as const, failure: falha };
}

export function fakeBling(options: {
  modo?: ModoDeCriacao;
  falhaCriar?: FalhaProgramada;
  falhaPortador?: FalhaProgramada;
  falhaBaixa?: FalhaProgramada;
  baixaAmbigua?: boolean;
  falhaContato?: FalhaProgramada;
  /** Chamado no instante do POST — antes de qualquer resposta. */
  aoReceberPost?: () => void;
  /** Segura a resposta até a promessa resolver (corrida). */
  segurarResposta?: Promise<void>;
} = {}): FakeBling {
  const posts: ContaPagarPayload[] = [];
  const baixadas: Array<{ id: string; portadorId: number; categoriaId: number }> = [];
  let criadas = 0;
  let contatos = 0;
  const modo: ModoDeCriacao = options.falhaCriar ? 'recusa' : options.modo ?? 'confirma';

  return {
    posts,
    baixadas,
    contasCriadasNoBling: () => criadas,
    contatosResolvidos: () => contatos,
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
          criadas++;
          return { _tag: 'Despachado', resultado: { _tag: 'BlingOk', value: { id: String(88122 + criadas) } } };
        case 'perde-ack':
          criadas++;
          return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
        case 'timeout-sem-criar':
          return { _tag: 'Despachado', resultado: falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado') };
        case 'erro-5xx':
          criadas++;
          return { _tag: 'Despachado', resultado: falhaBling('SERVER_ERROR', 500, 'Erro interno') };
        case 'sucesso-sem-id':
          criadas++;
          return { _tag: 'Despachado', resultado: falhaBling('INVALID_RESPONSE', 201, 'sem id') };
        case 'recusa':
          return { _tag: 'Despachado', resultado: falhaProgramada(options.falhaCriar ?? 'contato.id inválido') };
      }
    },
    async obterPortadorPadrao() {
      if (options.falhaPortador) return falhaProgramada(options.falhaPortador);
      return { _tag: 'BlingOk' as const, value: 55 };
    },
    async baixarContaPagar(id, payload) {
      if (options.baixaAmbigua) return falhaBling('UNKNOWN_ERROR', 0, 'prazo esgotado');
      if (options.falhaBaixa) return falhaProgramada(options.falhaBaixa);
      baixadas.push({ id, portadorId: payload.portadorId, categoriaId: payload.categoriaId });
      return { _tag: 'BlingOk' as const, value: undefined };
    },
  };
}

// Store em memória com as MESMAS regras da migration 73: chave por
// organização, digest, pendência idêntica (em_voo/indeterminada) e CAS por
// estado+época. A própria migration é provada no pgTAP e na corrida real.

type EstadoTentativa = 'em_voo' | 'nao_enviada' | 'confirmada' | 'recusada' | 'indeterminada';

interface TentativaFake {
  readonly id: string;
  readonly org: string;
  readonly chave: string;
  readonly digest: string;
  estado: EstadoTentativa;
  epoca: number;
  blingContaId: string | null;
  tituloId: string | null;
  contatoBlingId: number | null;
  motivo: string | null;
}

export interface FakeStore extends DespesaStorePort {
  readonly salvos: Array<Record<string, unknown>>;
  readonly tentativas: TentativaFake[];
  tentativa(org: string, chave: string): TentativaFake | undefined;
}

export function fakeStore(options: {
  categoriaBlingId?: number | null;
  erro?: Error;
  /** Quantas gravações de título falham antes de voltar a funcionar. */
  falhasDeTitulo?: number;
  reivindicacaoIndisponivel?: boolean;
  concluirFalha?: boolean;
} = {}): FakeStore {
  const salvos: Array<Record<string, unknown>> = [];
  const tentativas: TentativaFake[] = [];
  let falhasDeTitulo = options.falhasDeTitulo ?? 0;
  let seq = 0;

  const pendente = (org: string, digest: string) =>
    tentativas.find((t) => t.org === org && t.digest === digest && (t.estado === 'em_voo' || t.estado === 'indeterminada'));

  return {
    salvos,
    tentativas,
    tentativa: (org, chave) => tentativas.find((t) => t.org === org && t.chave === chave),
    async resolverCategoriaBling() {
      return options.categoriaBlingId === undefined ? 900 : options.categoriaBlingId;
    },
    async salvarTitulo(_scope, titulo) {
      if (options.erro) throw options.erro;
      if (falhasDeTitulo > 0) {
        falhasDeTitulo--;
        throw new Error('conexão perdida');
      }
      salvos.push({ ...titulo });
      return { id: `titulo-${salvos.length}`, blingId: titulo.blingId, situacao: titulo.situacao };
    },
    async reivindicarTentativa(s, intencao: IntencaoDeContaPagar) {
      if (options.reivindicacaoIndisponivel) return { _tag: 'TentativaIndisponivel' as const };
      const org = s.organizationId;
      const existente = tentativas.find((t) => t.org === org && t.chave === intencao.chave);
      if (!existente) {
        const outra = pendente(org, intencao.digest);
        if (outra) return { _tag: 'PendenciaIdentica' as const, chavePendente: outra.chave };
        const nova: TentativaFake = {
          id: `tentativa-${++seq}`, org, chave: intencao.chave, digest: intencao.digest, estado: 'em_voo', epoca: 1,
          blingContaId: null, tituloId: null, contatoBlingId: intencao.contatoBlingId, motivo: null,
        };
        tentativas.push(nova);
        return { _tag: 'TentativaPropria' as const, tentativaId: nova.id, epoca: 1 };
      }
      if (existente.digest !== intencao.digest) return { _tag: 'ConflitoDeConteudo' as const };
      if (existente.estado === 'nao_enviada') {
        const outra = pendente(org, intencao.digest);
        if (outra) return { _tag: 'PendenciaIdentica' as const, chavePendente: outra.chave };
        existente.estado = 'em_voo';
        existente.epoca++;
        return { _tag: 'TentativaPropria' as const, tentativaId: existente.id, epoca: existente.epoca };
      }
      return {
        _tag: 'TentativaRepetida' as const,
        tentativaId: existente.id,
        estado: existente.estado,
        blingContaId: existente.blingContaId,
        tituloId: existente.tituloId,
        contatoBlingId: existente.contatoBlingId,
      };
    },
    async concluirTentativa(s, { tentativaId, epoca }, desfecho): Promise<GravacaoDeTentativa> {
      if (options.concluirFalha) return 'NaoGravado';
      const t = tentativas.find((x) => x.id === tentativaId && x.org === s.organizationId);
      if (!t || t.estado !== 'em_voo' || t.epoca !== epoca) return 'NaoGravado';
      t.estado = desfecho.estado;
      if (desfecho.estado === 'confirmada') t.blingContaId = desfecho.blingContaId;
      else t.motivo = desfecho.motivo;
      if (desfecho.contatoBlingId !== null) t.contatoBlingId = desfecho.contatoBlingId;
      return 'Gravado';
    },
    async vincularTitulo(s, tentativaId, tituloId): Promise<GravacaoDeTentativa> {
      const t = tentativas.find((x) => x.id === tentativaId && x.org === s.organizationId);
      if (!t || t.estado !== 'confirmada' || t.tituloId !== null) return 'NaoGravado';
      t.tituloId = tituloId;
      return 'Gravado';
    },
  };
}

/**
 * Dependências da rota com os fakes acima.
 *
 * @param scope - O escopo verificado que a autorização devolve.
 * @param overrides - Portas a substituir.
 * @returns As dependências do handler.
 */
export function depsDeTeste(
  scope: VerifiedOrganizationScope,
  overrides: Partial<DespesaDependencies> = {},
): DespesaDependencies {
  return {
    auth: { async authorize() { return { _tag: 'Authorized', scope }; } },
    bling: fakeBling(),
    store: fakeStore(),
    hoje: () => '2026-08-29',
    ...overrides,
  };
}
