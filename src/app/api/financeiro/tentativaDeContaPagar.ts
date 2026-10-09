import { createHash } from 'node:crypto';

import type { DespesaRequest } from '@/lib/config/despesaContract';
import {
  classificarFalhaDeCriacaoNoBling,
  type EnvioDeCriacaoAoBling,
} from '@/lib/integrations/bling/classificacaoDeFalhaDeCriacao';
import type { BlingProviderFailure } from '@/lib/integrations/bling/pedidoVendaContract';

/**
 * Impressão digital de UMA operação de lançamento: SHA-256 (hex) do pedido de
 * despesa já parseado, com as chaves em ordem e sem a `chaveIdempotencia`.
 *
 * É o que distingue "a mesma operação de novo" (mesma chave, mesmo digest) de
 * "outra operação com uma chave reaproveitada" (mesma chave, digest diferente
 * — conflito). Entra o pedido inteiro, não só o que vai ao Bling: título e
 * fornecedor também são parte do que o usuário pediu, e um campo novo no
 * contrato entra no digest sem ninguém precisar lembrar de incluí-lo.
 *
 * @param despesa - O corpo já validado por `despesaRequestSchema`.
 * @returns 64 caracteres hexadecimais.
 */
export function digestDaDespesa(despesa: DespesaRequest): string {
  const operacao: Record<string, unknown> = { ...despesa };
  delete operacao.chaveIdempotencia;
  const canonica = JSON.stringify(operacao, Object.keys(operacao).sort());
  return createHash('sha256').update(canonica).digest('hex');
}

/** Por que a conta a pagar comprovadamente não foi enviada. */
export type MotivoDeNaoEnvio = 'credencial_indisponivel' | 'contato_nao_resolvido';

/** Por que o resultado de um POST despachado não é conhecido. */
export type MotivoDeIndeterminacao =
  | 'sem_resposta'
  | 'resposta_invalida'
  | 'limite_de_requisicoes'
  | 'erro_do_provedor'
  | 'falha_nao_classificada';

/**
 * O que um envio de `POST /contas/pagar` ou de `POST .../baixar` provou.
 *
 * Só `Confirmada` e `Recusada` são conhecimento sobre o efeito no Bling.
 * `NaoEnviada` é conhecimento sobre a requisição (nenhuma saiu).
 * `Indeterminada` é a ausência de conhecimento — e nunca é tratada como recusa.
 *
 * @template T - O que a confirmação traz (o id da conta, o borderô da baixa).
 */
export type DesfechoDoEnvio<T> =
  | { readonly _tag: 'Confirmada'; readonly valor: T }
  | { readonly _tag: 'NaoEnviada'; readonly motivo: MotivoDeNaoEnvio }
  | { readonly _tag: 'Recusada'; readonly failure: BlingProviderFailure }
  | { readonly _tag: 'Indeterminada'; readonly motivo: MotivoDeIndeterminacao };

function motivoDaIndeterminacao(failure: BlingProviderFailure): MotivoDeIndeterminacao {
  // Status 0: nada legível voltou — prazo, conexão perdida, corpo ilegível.
  if (failure.status === 0) return 'sem_resposta';
  // Sucesso HTTP sem o id: a conta pode existir e não sabemos qual é.
  if (failure.type === 'INVALID_RESPONSE') return 'resposta_invalida';
  if (failure.status === 429) return 'limite_de_requisicoes';
  if (failure.status >= 500) return 'erro_do_provedor';
  return 'falha_nao_classificada';
}

/**
 * Traduz o fato relatado pelo adapter no desfecho da tentativa.
 *
 * A recusa definitiva exige reconhecimento positivo pelo contrato
 * (`classificarFalhaDeCriacaoNoBling`): `error.type` de recusa da requisição e
 * status `4xx`. Timeout, rede, `5xx`, `429`, `2xx` sem id e qualquer caso não
 * previsto são `Indeterminada`.
 *
 * @template T - O que a confirmação traz.
 * @param envio - O que o adapter sabe sobre o POST.
 * @returns O desfecho a gravar.
 */
export function classificarEnvio<T>(envio: EnvioDeCriacaoAoBling<T>): DesfechoDoEnvio<T> {
  if (envio._tag === 'NaoEnviado') return { _tag: 'NaoEnviada', motivo: envio.motivo };

  const { resultado } = envio;
  if (resultado._tag === 'BlingOk') return { _tag: 'Confirmada', valor: resultado.value };
  if (classificarFalhaDeCriacaoNoBling(resultado.failure) === 'Definitiva') {
    return { _tag: 'Recusada', failure: resultado.failure };
  }
  return { _tag: 'Indeterminada', motivo: motivoDaIndeterminacao(resultado.failure) };
}

/**
 * A referência opaca que vai em `numeroDocumento` no `POST /contas/pagar`.
 *
 * Derivada da chave da operação — a mesma chave sempre dá a mesma referência —
 * e curta (20 caracteres): o OpenAPI não declara tamanho máximo para o campo, e
 * nada nela descreve a despesa. A migration 74 impõe o formato e a unicidade
 * por organização.
 *
 * @param chave - A `chaveIdempotencia` (UUID) da operação.
 * @returns `ORB-` seguido de 16 dígitos hexadecimais maiúsculos.
 */
export function referenciaNoBling(chave: string): string {
  return `ORB-${chave.replace(/-/gu, '').slice(0, 16).toUpperCase()}`;
}
