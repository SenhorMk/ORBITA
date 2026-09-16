/**
 * Contratos da RECONCILIAÇÃO da venda manual — posse, ledger, intervenção e a
 * saída da ambiguidade.
 *
 * Separado de `ports.ts` pela mesma fronteira que já separa
 * `dependenciasDeReconciliacao.ts` de `dependencias.ts`: aqui vive só o que a
 * conferência usa, e nada do caminho normal da venda. `ports.ts` reexporta
 * tudo, então quem consome a porta continua importando de um lugar só.
 */
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

/**
 * Desfecho de uma escrita no ledger de tentativas.
 *
 * É um valor, e não `void`, porque uma resposta de sucesso (`201`, ou
 * `referenciaLiberada: true` na reconciliação) não pode ser emitida sem o
 * estado durável correspondente — e para isso quem chama precisa **saber** se
 * a escrita aconteceu.
 */
export type RegistroDeDesfecho =
  | { readonly _tag: 'DesfechoGravado' }
  | { readonly _tag: 'DesfechoNaoGravado'; readonly causa: unknown };

/** Resposta de `confirmarPosse`: ainda sou dono desta tentativa? */
export type PosseDaTentativa =
  | { readonly _tag: 'PosseVigente' }
  /** Alguém tomou a posse: quem chama não inicia efeito novo. */
  | { readonly _tag: 'PossePerdida' }
  /** Não deu para perguntar. Falha fechada: também não inicia efeito. */
  | { readonly _tag: 'PosseIndeterminada'; readonly causa: unknown };

/** O que a resolução de uma intervenção ambígua devolve. */
export type ResolucaoDeAmbiguidade =
  | { readonly _tag: 'AmbiguidadeResolvida'; readonly resolucaoId: string }
  /** Não há intervenção ambígua pendente para esta tentativa. */
  | { readonly _tag: 'SemAmbiguidadePendente' }
  /** Outro operador resolveu primeiro. */
  | { readonly _tag: 'AmbiguidadeJaResolvida' }
  /** A tentativa mudou de dono entre a leitura e a decisão. */
  | { readonly _tag: 'ResolucaoSemPosse' }
  | { readonly _tag: 'ResolucaoIndisponivel'; readonly causa: unknown };

/**
 * O que a pessoa afirma ter observado no ERP ao resolver uma ambiguidade.
 * Nunca inferido pelo sistema, e nunca obtido repetindo o PATCH.
 */
export type DecisaoDeAmbiguidade = 'cancelado' | 'nao-cancelado';

/** Resultado de tentar tomar a posse de uma tentativa. */
export type TomadaDePosse =
  | { readonly _tag: 'PosseTomada'; readonly epoca: number }
  /** Outro executor tomou a posse primeiro, ou a tentativa mudou. */
  | { readonly _tag: 'PosseNegada' }
  | { readonly _tag: 'PosseIndisponivel'; readonly causa: unknown };

export interface ResolucaoDeIntervencaoAmbigua {
  readonly scope: VerifiedOrganizationScope;
  readonly tentativaId: string;
  readonly decisao: DecisaoDeAmbiguidade;
  /** O que a pessoa observou no ERP. Obrigatória: decisão sem lastro não é decisão. */
  readonly evidencia: string;
  readonly epocaEsperada: number;
}

export interface FinalizacaoDeIntervencao {
  readonly scope: VerifiedOrganizationScope;
  readonly intervencaoId: string;
  readonly tentativaId: string;
  readonly resultadoIntervencao: 'confirmada' | 'falhou' | 'ambigua';
  readonly estadoTentativa: 'concluida' | 'indeterminada' | 'falhou';
  readonly blingPedidoId: string | null;
  readonly detalhe: string | null;
  readonly epocaEsperada: number | null;
}

/**
 * `NaoPersistiu` é a diferença entre "deu certo" e "o efeito externo
 * aconteceu e não conseguimos registrar" — e é por ele que a resposta deixa de
 * dizer que a referência foi liberada quando ela não foi.
 */
export type FinalizacaoResultado =
  | { readonly _tag: 'Persistiu' }
  | { readonly _tag: 'NaoPersistiu'; readonly causa: unknown };

/** O que a reivindicação de intervenção devolve. */
export type ReivindicacaoDeIntervencao =
  | { readonly _tag: 'IntervencaoReivindicada'; readonly intervencaoId: string }
  /** Já existe uma intervenção sem desfecho (ou ambígua) para esta tentativa: nada foi executado. */
  | { readonly _tag: 'IntervencaoJaEmAndamento' }
  | { readonly _tag: 'IntervencaoIndisponivel'; readonly causa: unknown };
