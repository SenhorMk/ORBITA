import type { EscritaRemota, LeituraRemota, ProdutoRemoto } from '@/lib/integrations/bling/operacaoRemotaContract';
import { estadoDaFotoNoBling, type EstadoDaFotoNoBling } from '@/lib/config/produtoImagemContract';
import { registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ProdutoComFoto } from '@/repositories/produtoImagemRepository';

/**
 * Converge as imagens do produto vinculado no Bling para a foto do ORBITA.
 *
 * ## Regra de produto
 *
 * Enquanto o ORBITA nunca recebeu foto para o produto, as imagens do Bling são
 * do Bling e ficam intocadas (`sem_foto`: nada a fazer). Ao primeiro upload, o
 * ORBITA passa a ser dono do conjunto de imagens daquele produto no Bling:
 *
 * - foto desejada existe → o Bling termina com **exatamente uma** imagem, ela;
 * - foto desejada é `null` (remoção) → o Bling termina **sem** imagens.
 *
 * ## Por que "limpar e importar"
 *
 * Provado na conta Bling em 2026-10-02: `imagensURL` não vazio **acrescenta**
 * (com deduplicação), `imagensURL: []` **apaga tudo**, e não há remoção de uma
 * imagem só. Então a convergência é sempre a mesma sequência, e repeti-la é
 * idempotente — o estado final observável é idêntico:
 *
 * 1. `PATCH imagensURL: []` e leitura até confirmar zero imagens;
 * 2. com foto: URL assinada temporária do objeto atual, `PATCH imagensURL: [url]`
 *    e leitura até confirmar exatamente uma (o Bling copia o arquivo; a URL
 *    pode expirar depois);
 * 3. só então `imagem_bling_sync_path = desejado`, por compare-and-set
 *    condicionado ao desejado que esta execução começou a refletir.
 *
 * O processamento do Bling é assíncrono; cada espera tem prazo dentro de um
 * orçamento total. Esgotou, a foto local fica e o estado continua pendente.
 *
 * ## O que não se finge
 *
 * Banco e Bling não têm transação comum. Se o Bling foi limpo e a importação
 * falhou, o ORBITA mantém a foto nova, o marcador não muda e a próxima
 * tentativa repete a convergência inteira. Nada é desfeito localmente.
 */

/** O que a sincronização precisa do Bling. `BlingClient` satisfaz. */
export interface FotoNoBlingPort {
  consultarProduto(id: string): Promise<LeituraRemota<ProdutoRemoto>>;
  limparImagensDoProduto(id: string): Promise<EscritaRemota>;
  importarImagemDoProduto(id: string, url: string): Promise<EscritaRemota>;
}

export type OperacaoDaFoto = 'adicionar' | 'trocar' | 'remover';
export type EtapaDaSincronizacao = 'limpar' | 'confirmar_vazio' | 'assinar' | 'importar' | 'confirmar_importacao';
export type MotivoDaFalha =
  | 'recusado'
  | 'limitado'
  | 'indeterminado'
  | 'prazo_esgotado'
  | 'produto_ausente_no_bling'
  | 'quantidade_inesperada'
  | 'armazenamento_indisponivel';

export type EventoDaSincronizacao = {
  readonly acao:
    | 'catalog.product_image_bling_synced'
    | 'catalog.product_image_bling_sync_failed'
    | 'catalog.product_image_bling_sync_pending';
  readonly recurso: 'produto';
  readonly recursoId: string;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | boolean>>;
};

export interface SincronizacaoDaFotoDeps {
  readonly carregar: (scope: VerifiedOrganizationScope, produtoId: string) => Promise<ProdutoComFoto | null>;
  /** Compare-and-set: marca `desejado` como confirmado só se ainda for o desejado. */
  readonly confirmar: (scope: VerifiedOrganizationScope, produtoId: string, desejado: string | null) => Promise<boolean>;
  readonly bling: (scope: VerifiedOrganizationScope) => FotoNoBlingPort;
  /** URL assinada temporária para o Bling importar o objeto. `null` = Storage indisponível. Nunca persistida. */
  readonly assinarImportacao: (caminho: string) => Promise<string | null>;
  readonly auditar: (scope: VerifiedOrganizationScope, evento: EventoDaSincronizacao) => Promise<void>;
  readonly esperar: (ms: number) => Promise<void>;
  readonly agora: () => number;
  /** Teto da sincronização inteira — as duas esperas assíncronas incluídas. */
  readonly orcamentoMs: number;
  /** Intervalo entre leituras de confirmação. */
  readonly intervaloMs: number;
}

export type DesfechoDaSincronizacao =
  | { readonly _tag: 'NaoEncontrado' }
  /** O ORBITA nunca adotou a imagem deste produto: o Bling não é tocado. */
  | { readonly _tag: 'SemFoto' }
  | { readonly _tag: 'Sincronizada'; readonly jaEstava: boolean }
  | { readonly _tag: 'SemVinculo' }
  /** O Bling convergiu para um desejado que já mudou: nada é marcado. */
  | { readonly _tag: 'Obsoleta' }
  | { readonly _tag: 'Falhou'; readonly etapa: EtapaDaSincronizacao; readonly motivo: MotivoDaFalha };

/** O estado da tela correspondente a cada desfecho. */
export function estadoAposSincronizacao(desfecho: DesfechoDaSincronizacao): EstadoDaFotoNoBling {
  switch (desfecho._tag) {
    case 'SemFoto':
      return 'sem_foto';
    case 'Sincronizada':
      return 'sincronizada';
    case 'SemVinculo':
      return 'sem_vinculo';
    default:
      return 'pendente';
  }
}

function motivoDa(falha: Exclude<EscritaRemota | LeituraRemota<ProdutoRemoto>, { _tag: 'EscritaAceita' | 'RemotoPresente' }>): MotivoDaFalha {
  switch (falha._tag) {
    case 'RemotoAusente':
      return 'produto_ausente_no_bling';
    case 'RemotoRecusou':
      return 'recusado';
    case 'RemotoLimitado':
      return 'limitado';
    case 'RemotoIndeterminado':
      return 'indeterminado';
  }
}

/**
 * Lê o produto até a quantidade de imagens ser `alvo`, sem passar do prazo.
 *
 * Limite e indeterminado na leitura são transitórios aqui (o processamento é
 * assíncrono de qualquer jeito); recusa e produto ausente encerram.
 */
async function aguardarImagens(
  deps: SincronizacaoDaFotoDeps,
  porta: FotoNoBlingPort,
  blingId: string,
  alvo: number,
  prazoFinal: number,
): Promise<MotivoDaFalha | null> {
  let ultima: number | null = null;
  for (;;) {
    const leitura = await porta.consultarProduto(blingId);
    if (leitura._tag === 'RemotoPresente') {
      if (leitura.valor.imagens === alvo) return null;
      ultima = leitura.valor.imagens;
    } else if (leitura._tag === 'RemotoAusente' || leitura._tag === 'RemotoRecusou') {
      return motivoDa(leitura);
    }
    if (deps.agora() + deps.intervaloMs > prazoFinal) {
      // Esperando "exatamente uma" e vendo mais: alguém acrescentou imagem no
      // meio. Esperando o vazio, imagem sobrando é só a limpeza ainda não
      // processada — prazo.
      return alvo > 0 && ultima !== null && ultima > alvo ? 'quantidade_inesperada' : 'prazo_esgotado';
    }
    await deps.esperar(deps.intervaloMs);
  }
}

async function auditarSemInterromper(
  deps: SincronizacaoDaFotoDeps,
  scope: VerifiedOrganizationScope,
  evento: EventoDaSincronizacao,
): Promise<void> {
  try {
    await deps.auditar(scope, evento);
  } catch (erro: unknown) {
    registrarFalhaInterna(`produtos.imagem.bling.auditoria.${evento.acao}`, erro, { organizacaoId: scope.organizationId });
  }
}

/** Limpa, confirma vazio e, com foto, importa e confirma exatamente uma. `null` = convergiu. */
async function convergir(
  deps: SincronizacaoDaFotoDeps,
  porta: FotoNoBlingPort,
  blingId: string,
  desejado: string | null,
): Promise<{ readonly etapa: EtapaDaSincronizacao; readonly motivo: MotivoDaFalha } | null> {
  const prazoFinal = deps.agora() + deps.orcamentoMs;

  const limpeza = await porta.limparImagensDoProduto(blingId);
  if (limpeza._tag !== 'EscritaAceita') return { etapa: 'limpar', motivo: motivoDa(limpeza) };
  const vazio = await aguardarImagens(deps, porta, blingId, 0, prazoFinal);
  if (vazio !== null) return { etapa: 'confirmar_vazio', motivo: vazio };
  if (desejado === null) return null;

  const url = await deps.assinarImportacao(desejado);
  if (url === null) return { etapa: 'assinar', motivo: 'armazenamento_indisponivel' };
  const importacao = await porta.importarImagemDoProduto(blingId, url);
  if (importacao._tag !== 'EscritaAceita') return { etapa: 'importar', motivo: motivoDa(importacao) };
  const uma = await aguardarImagens(deps, porta, blingId, 1, prazoFinal);
  return uma === null ? null : { etapa: 'confirmar_importacao', motivo: uma };
}

/**
 * Sincroniza a foto atual do produto com o Bling. Idempotente: pode ser
 * chamada logo depois de confirmar, trocar ou remover a foto, e de novo pelo
 * botão "Tentar sincronizar novamente" — sem novo upload, porque o objeto já
 * está no bucket.
 */
export async function sincronizarFotoComBling(
  scope: VerifiedOrganizationScope,
  produtoId: string,
  correlationId: string,
  deps: SincronizacaoDaFotoDeps,
): Promise<DesfechoDaSincronizacao> {
  const produto = await deps.carregar(scope, produtoId);
  if (!produto) return { _tag: 'NaoEncontrado' };

  const desejado = produto.imagemStoragePath;
  const confirmado = produto.imagemBlingSyncPath;
  const estado = estadoDaFotoNoBling({ blingId: produto.blingId, desejado, confirmado });
  if (estado === 'sem_foto') return { _tag: 'SemFoto' };
  if (estado === 'sincronizada') return { _tag: 'Sincronizada', jaEstava: true };

  const operacao: OperacaoDaFoto = desejado === null ? 'remover' : confirmado === null ? 'adicionar' : 'trocar';
  const base = { recurso: 'produto' as const, recursoId: produto.id, correlationId };
  const metadataBase = { produto_id: produto.id, operacao, havia_sincronizacao_anterior: confirmado !== null };

  if (produto.blingId === null) {
    await auditarSemInterromper(deps, scope, {
      ...base, acao: 'catalog.product_image_bling_sync_pending', metadata: { ...metadataBase, motivo: 'sem_vinculo' },
    });
    return { _tag: 'SemVinculo' };
  }

  const falha = await convergir(deps, deps.bling(scope), produto.blingId, desejado);
  if (falha !== null) {
    await auditarSemInterromper(deps, scope, {
      ...base, acao: 'catalog.product_image_bling_sync_failed', metadata: { ...metadataBase, etapa: falha.etapa, motivo: falha.motivo },
    });
    return { _tag: 'Falhou', ...falha };
  }

  // O Bling convergiu para `desejado`. Só vale se ele ainda for o desejado.
  if (!(await deps.confirmar(scope, produto.id, desejado))) return { _tag: 'Obsoleta' };

  await auditarSemInterromper(deps, scope, {
    ...base, acao: 'catalog.product_image_bling_synced', metadata: { ...metadataBase, resultado: 'sincronizada' },
  });
  return { _tag: 'Sincronizada', jaEstava: false };
}
