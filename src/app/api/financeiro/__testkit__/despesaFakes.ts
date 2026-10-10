import type {
  DespesaDependencies,
  DespesaStorePort,
  GravacaoDeTentativa,
  IntencaoDeContaPagar,
  ReivindicacaoDeBaixa,
} from '../despesaHandler';
import type {
  OperacaoRegistrada,
  OperacoesStorePort,
  QuitacaoDaOperacaoDependencies,
  ReconciliacaoDependencies,
} from '../reconciliacaoDaOperacao';
import { pendenciaDaOperacao, type MotivoDeRevisaoManual } from '../reconciliacaoDeContaPagar';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { fakeBling, type FakeBling } from './blingContasPagarFake';

/**
 * Store em memória com as MESMAS regras das migrations 73 e 74: chave por
 * organização, digest, pendência idêntica, CAS por estado+época, baixa só de
 * conta confirmada, recibo antes da transição e a decisão da reconciliação
 * (`confirmada`/`ja_confirmada`/`divergente`). As migrations em si são provadas
 * no pgTAP e na corrida contra Postgres real.
 */

type Estado = 'em_voo' | 'nao_enviada' | 'confirmada' | 'recusada' | 'indeterminada';

interface TentativaFake {
  readonly id: string;
  readonly org: string;
  readonly chave: string;
  readonly digest: string;
  readonly valor: number;
  readonly dataVencimento: string;
  dataEmissao: string;
  readonly numeroDocumento: string | null;
  readonly quitacaoSolicitada: boolean;
  estado: Estado;
  epoca: number;
  blingContaId: string | null;
  tituloId: string | null;
  contatoBlingId: number | null;
  motivo: string | null;
}

interface BaixaFake {
  readonly id: string;
  readonly org: string;
  readonly tentativaId: string;
  readonly blingContaId: string;
  dataBaixa: string;
  estado: Estado;
  epoca: number;
  borderoId: string | null;
  motivo: string | null;
}

interface ReciboFake {
  readonly org: string;
  readonly tentativaId: string;
  readonly alvo: 'criacao' | 'baixa';
  readonly resultado: 'confirmada' | 'ja_confirmada' | 'revisao_manual' | 'divergente';
  readonly motivo: MotivoDeRevisaoManual | null;
  readonly blingContaId: string | null;
  readonly atorId: string;
  readonly metodo: string;
  readonly borderoId: string | null;
  readonly em: string;
}

export interface FakeStore extends DespesaStorePort {
  readonly salvos: Array<Record<string, unknown> & { id: string }>;
  readonly tentativas: TentativaFake[];
  readonly baixas: BaixaFake[];
  readonly recibos: ReciboFake[];
  tentativa(org: string, chave: string): TentativaFake | undefined;
  /** A porta de operações da reconciliação, sobre o mesmo estado. */
  operacoes(): OperacoesStorePort;
}

export function fakeStore(options: {
  categoriaBlingId?: number | null;
  erro?: Error;
  /** Quantas gravações de título falham antes de voltar a funcionar. */
  falhasDeTitulo?: number;
  reivindicacaoIndisponivel?: boolean;
  concluirFalha?: boolean;
  /** Simula a queda antes do commit da reconciliação: nada é gravado. */
  registroDeReconciliacaoFalha?: boolean;
  /** Quantos vínculos título↔tentativa falham antes de voltar a funcionar. */
  falhasDeVinculo?: number;
  /** Quantas marcações de título pago falham antes de voltar a funcionar. */
  falhasDeTituloPago?: number;
} = {}): FakeStore {
  const salvos: Array<Record<string, unknown> & { id: string }> = [];
  const tentativas: TentativaFake[] = [];
  const baixas: BaixaFake[] = [];
  const recibos: ReciboFake[] = [];
  let falhasDeTitulo = options.falhasDeTitulo ?? 0;
  let falhasDeVinculo = options.falhasDeVinculo ?? 0;
  let falhasDeTituloPago = options.falhasDeTituloPago ?? 0;
  let seq = 0;

  const pendente = (org: string, digest: string) =>
    tentativas.find((t) => t.org === org && t.digest === digest && (t.estado === 'em_voo' || t.estado === 'indeterminada'));

  const projetar = (t: TentativaFake): OperacaoRegistrada => {
    const baixa = baixas.find((b) => b.tentativaId === t.id) ?? null;
    const recibo = [...recibos].reverse().find((r) => r.tentativaId === t.id) ?? null;
    return {
      tentativaId: t.id, ref: t.chave, estado: t.estado, valor: t.valor, dataVencimento: t.dataVencimento,
      dataEmissao: t.dataEmissao, contatoBlingId: t.contatoBlingId, numeroDocumento: t.numeroDocumento, quitacaoSolicitada: t.quitacaoSolicitada,
      blingContaId: t.blingContaId, tituloId: t.tituloId,
      tituloSituacao: t.tituloId === null ? null : String(salvos.find((x) => x.id === t.tituloId)?.situacao ?? ''),
      baixa: baixa
        ? { id: baixa.id, estado: baixa.estado, blingContaId: baixa.blingContaId, dataBaixa: baixa.dataBaixa }
        : null,
      ultimaReconciliacao: recibo
        ? { alvo: recibo.alvo, resultado: recibo.resultado, motivo: recibo.motivo, em: recibo.em }
        : null,
    };
  };

  const operacoes: OperacoesStorePort = {
    async lerOperacao(s, ref) {
      const t = tentativas.find((x) => x.org === s.organizationId && x.chave === ref);
      return t ? { _tag: 'Encontrada', operacao: projetar(t) } : { _tag: 'NaoEncontrada' };
    },
    async listarPendentes(s) {
      const operacoesDaOrg = tentativas.filter((t) => t.org === s.organizationId).map(projetar);
      return { _tag: 'Listadas', operacoes: operacoesDaOrg.filter((o) => pendenciaDaOperacao(o) !== null) };
    },
    async registrarReconciliacao(s, registro) {
      if (options.registroDeReconciliacaoFalha) return { _tag: 'Indisponivel' };
      const t = tentativas.find((x) => x.org === s.organizationId && x.chave === registro.ref);
      if (!t) return { _tag: 'Indisponivel' };
      const conta = registro.prova._tag === 'Comprovada' ? registro.prova.conta : null;
      const motivo = registro.prova._tag === 'RevisaoManual' ? registro.prova.motivo : null;
      const alvo = registro.alvo;
      const b = alvo === 'baixa' ? baixas.find((x) => x.tentativaId === t.id) : undefined;
      if (alvo === 'baixa' && !b) return { _tag: 'Indisponivel' };
      const estadoAtual = alvo === 'criacao' ? t.estado : (b?.estado ?? 'em_voo');
      const idAtual = alvo === 'criacao' ? t.blingContaId : (b?.blingContaId ?? null);

      let resultado: ReciboFake['resultado'];
      let motivoGravado = motivo;
      const deOutra = alvo === 'criacao' && conta !== null
        && tentativas.some((x) => x.org === s.organizationId && x.id !== t.id && x.blingContaId === conta.id);
      if (conta === null) resultado = 'revisao_manual';
      else if (deOutra) {
        resultado = 'divergente';
        motivoGravado = 'conta_de_outra_operacao';
      } else if (alvo === 'baixa' && conta.id !== idAtual) resultado = 'divergente';
      else if (estadoAtual === 'em_voo' || estadoAtual === 'indeterminada') resultado = 'confirmada';
      else if (estadoAtual === 'confirmada' && idAtual === conta.id) resultado = 'ja_confirmada';
      else resultado = 'divergente';

      const borderoId = registro.prova._tag === 'Comprovada' ? registro.prova.borderoId : null;
      recibos.push({ org: s.organizationId, tentativaId: t.id, alvo, resultado, motivo: motivoGravado,
        blingContaId: conta?.id ?? null, atorId: s.actorId, metodo: registro.metodo, borderoId,
        em: new Date(recibos.length * 1000).toISOString() });
      if (resultado === 'confirmada' && conta) {
        if (alvo === 'criacao') {
          t.estado = 'confirmada';
          t.blingContaId = conta.id;
        } else if (b) {
          b.estado = 'confirmada';
          b.borderoId = borderoId ?? b.borderoId;
        }
      }
      return { _tag: 'Registrada', resultado, motivo: motivoGravado };
    },
    async categoriaLocalPorBlingId() {
      return null;
    },
    async marcarTituloPago(s, tituloId): Promise<GravacaoDeTentativa> {
      if (falhasDeTituloPago > 0) {
        falhasDeTituloPago--;
        return 'NaoGravado';
      }
      const titulo = salvos.find((x) => x.id === tituloId && x.situacao === 'aberto');
      if (!titulo) return 'NaoGravado';
      titulo.situacao = 'pago';
      return 'Gravado';
    },
  };

  return {
    salvos,
    tentativas,
    baixas,
    recibos,
    tentativa: (org, chave) => tentativas.find((t) => t.org === org && t.chave === chave),
    operacoes: () => operacoes,
    async resolverCategoriaBling() {
      return options.categoriaBlingId === undefined ? 900 : options.categoriaBlingId;
    },
    async salvarTitulo(_scope, titulo) {
      if (options.erro) throw options.erro;
      if (falhasDeTitulo > 0) {
        falhasDeTitulo--;
        throw new Error('conexão perdida');
      }
      // Upsert por conta remota, como `upsertTitulo` (organização + bling_id).
      const existente = titulo.blingId === null ? undefined : salvos.find((x) => x.blingId === titulo.blingId);
      if (existente) {
        Object.assign(existente, titulo);
        return { id: existente.id, blingId: titulo.blingId, situacao: titulo.situacao };
      }
      const id = `titulo-${salvos.length + 1}`;
      salvos.push({ ...titulo, id });
      return { id, blingId: titulo.blingId, situacao: titulo.situacao };
    },
    async reivindicarTentativa(s, intencao: IntencaoDeContaPagar) {
      if (options.reivindicacaoIndisponivel) return { _tag: 'TentativaIndisponivel' as const };
      const org = s.organizationId;
      const existente = tentativas.find((t) => t.org === org && t.chave === intencao.chave);
      if (!existente) {
        const outra = pendente(org, intencao.digest);
        if (outra) return { _tag: 'PendenciaIdentica' as const, chavePendente: outra.chave };
        const nova: TentativaFake = {
          id: `tentativa-${++seq}`, org, chave: intencao.chave, digest: intencao.digest, valor: intencao.valor,
          dataVencimento: intencao.dataVencimento, dataEmissao: intencao.dataEmissao,
          numeroDocumento: intencao.numeroDocumento, quitacaoSolicitada: intencao.quitacaoSolicitada,
          estado: 'em_voo', epoca: 1,
          blingContaId: null, tituloId: null, contatoBlingId: intencao.contatoBlingId, motivo: null,
        };
        tentativas.push(nova);
        return { _tag: 'TentativaPropria' as const, tentativaId: nova.id, epoca: 1, numeroDocumento: nova.numeroDocumento };
      }
      if (existente.digest !== intencao.digest) return { _tag: 'ConflitoDeConteudo' as const };
      if (existente.estado === 'nao_enviada') {
        const outra = pendente(org, intencao.digest);
        if (outra) return { _tag: 'PendenciaIdentica' as const, chavePendente: outra.chave };
        existente.estado = 'em_voo';
        existente.epoca++;
        existente.dataEmissao = intencao.dataEmissao;
        return {
          _tag: 'TentativaPropria' as const, tentativaId: existente.id, epoca: existente.epoca,
          numeroDocumento: existente.numeroDocumento,
        };
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
      if (falhasDeVinculo > 0) {
        falhasDeVinculo--;
        return 'NaoGravado';
      }
      const t = tentativas.find((x) => x.id === tentativaId && x.org === s.organizationId);
      if (!t || t.estado !== 'confirmada' || t.tituloId !== null) return 'NaoGravado';
      t.tituloId = tituloId;
      return 'Gravado';
    },
    async reivindicarBaixa(s, baixa): Promise<ReivindicacaoDeBaixa> {
      const t = tentativas.find((x) => x.id === baixa.tentativaId && x.org === s.organizationId);
      // O gatilho da migration 74 recusa a baixa de conta não confirmada.
      if (!t || t.estado !== 'confirmada' || t.blingContaId !== baixa.blingContaId) return { _tag: 'BaixaIndisponivel' };
      const existente = baixas.find((b) => b.tentativaId === t.id);
      if (!existente) {
        const nova: BaixaFake = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, org: s.organizationId,
          tentativaId: t.id, blingContaId: baixa.blingContaId, dataBaixa: baixa.dataBaixa,
          estado: 'em_voo', epoca: 1, borderoId: null, motivo: null };
        baixas.push(nova);
        return { _tag: 'BaixaPropria', baixaId: nova.id, epoca: 1 };
      }
      if (existente.estado === 'nao_enviada') {
        existente.estado = 'em_voo';
        existente.epoca++;
        existente.dataBaixa = baixa.dataBaixa;
        return { _tag: 'BaixaPropria', baixaId: existente.id, epoca: existente.epoca };
      }
      return { _tag: 'BaixaRepetida', estado: existente.estado };
    },
    async concluirBaixa(s, { baixaId, epoca }, desfecho): Promise<GravacaoDeTentativa> {
      const b = baixas.find((x) => x.id === baixaId && x.org === s.organizationId);
      if (!b || b.estado !== 'em_voo' || b.epoca !== epoca) return 'NaoGravado';
      b.estado = desfecho.estado;
      if (desfecho.estado === 'confirmada') b.borderoId = desfecho.borderoId;
      else b.motivo = desfecho.motivo;
      return 'Gravado';
    },
  };
}

/**
 * Dependências da rota de despesa com os fakes.
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

/**
 * Dependências da reconciliação sobre o MESMO Bling e o MESMO store da rota de
 * despesa — é o que permite a jornada inteira num teste.
 *
 * @param bling - O Bling fake.
 * @param store - O store fake.
 * @returns As dependências da reconciliação.
 */
export function reconciliacaoDeTeste(bling: FakeBling, store: FakeStore): ReconciliacaoDependencies {
  return { operacoes: store.operacoes(), titulos: store, bling: () => bling };
}

/**
 * Dependências da quitação explícita, com escrita no MESMO Bling fake.
 *
 * @param bling - O Bling fake.
 * @param store - O store fake.
 * @param hoje - O relógio.
 * @returns As dependências da quitação.
 */
export function quitacaoDeTeste(bling: FakeBling, store: FakeStore, hoje = '2026-08-29'): QuitacaoDaOperacaoDependencies {
  return { ...reconciliacaoDeTeste(bling, store), escrita: () => ({ bling, store, hoje: () => hoje }) };
}
