import type { DespesaRequest } from '@/lib/config/despesaContract';
import { logger } from '@/lib/observability/logger';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import type { DespesaDependencies } from './despesaHandler';
import { mensagemPublicaDaFalhaDoBling } from './mensagemPublicaDoBling';
import { classificarEnvio } from './tentativaDeContaPagar';

/** O que a quitação deixou: se a conta ficou paga, e o que dizer ao usuário. */
export interface ResultadoDaQuitacao {
  readonly quitada: boolean;
  readonly avisos: readonly string[];
}

const AVISO_DE_PENDENCIA = 'Confira em "Operações pendentes" antes de quitar de novo.';

/**
 * Quita a conta recém-criada — só na requisição que confirmou a criação.
 *
 * `POST /contas/pagar/{id}/baixar` não é idempotente: a intenção de baixa é
 * reivindicada ANTES do POST (migration 74), e só quem a reivindicou envia. Uma
 * intenção que já existe nunca envia de novo; uma baixa sem confirmação fica
 * `indeterminada` e só a reconciliação, lendo a conta, a resolve.
 *
 * @param scope - Organização e ator verificados.
 * @param conta - A tentativa confirmada e a conta remota que ela criou.
 * @param body - O pedido de despesa.
 * @param categoriaBlingId - A categoria no Bling, exigida pela quitação.
 * @param deps - Portas da rota.
 * @returns Se a conta ficou paga, e os avisos.
 */
export async function quitar(
  scope: VerifiedOrganizationScope,
  conta: { readonly ref: string; readonly tentativaId: string; readonly blingContaId: string },
  body: DespesaRequest,
  categoriaBlingId: number | null,
  deps: DespesaDependencies,
): Promise<ResultadoDaQuitacao> {
  const { blingContaId } = conta;
  if (!categoriaBlingId) {
    return {
      quitada: false,
      avisos: [`A despesa ${blingContaId} foi lançada no Bling, mas não pôde ser quitada: a quitação exige uma categoria sincronizada com o Bling.`],
    };
  }

  const portador = await deps.bling.obterPortadorPadrao();
  if (portador._tag === 'BlingFailed') {
    return {
      quitada: false,
      avisos: [`A despesa ${blingContaId} foi lançada no Bling, mas continua em aberto lá: a conta financeira para quitar não foi obtida. ${mensagemPublicaDaFalhaDoBling(portador.failure, 'obter a conta financeira')}`],
    };
  }

  const hoje = deps.hoje();
  const reivindicada = await deps.store.reivindicarBaixa(scope, {
    tentativaId: conta.tentativaId,
    blingContaId,
    dataBaixa: hoje,
  });
  if (reivindicada._tag !== 'BaixaPropria') {
    // Sem a intenção gravada (ou com uma já existente), a quitação não sai.
    return {
      quitada: reivindicada._tag === 'BaixaRepetida' && reivindicada.estado === 'confirmada',
      avisos: [`A despesa ${blingContaId} foi lançada no Bling, e a quitação não foi enviada nesta requisição. ${AVISO_DE_PENDENCIA}`],
    };
  }

  const envio = await deps.bling.baixarContaPagar(blingContaId, {
    data: hoje,
    historico: body.descricao,
    portadorId: portador.value,
    categoriaId: categoriaBlingId,
  });
  const desfecho = classificarEnvio(envio);
  const baixa = { baixaId: reivindicada.baixaId, epoca: reivindicada.epoca };

  const gravacao = await deps.store.concluirBaixa(scope, baixa, desfecho._tag === 'Confirmada'
    ? { estado: 'confirmada', borderoId: desfecho.valor.borderoId }
    : desfecho._tag === 'NaoEnviada'
      ? { estado: 'nao_enviada', motivo: desfecho.motivo }
      : desfecho._tag === 'Recusada'
        ? { estado: 'recusada', motivo: 'recusa_definitiva' }
        : { estado: 'indeterminada', motivo: desfecho.motivo });
  logger[desfecho._tag === 'Confirmada' && gravacao === 'Gravado' ? 'info' : 'warn']('financeiro.baixa.desfecho', {
    subsystem: 'app',
    organizacaoId: scope.organizationId,
    actorId: scope.actorId,
    operacao: conta.ref,
    desfecho: desfecho._tag,
    gravacao,
  });

  switch (desfecho._tag) {
    case 'Confirmada':
      // Paga no Bling, mesmo que a gravação local tenha falhado: o título conta
      // o que o ERP tem. A baixa sem desfecho gravado fica `em_voo` e bloqueada.
      return { quitada: true, avisos: [] };
    case 'NaoEnviada':
      return {
        quitada: false,
        avisos: [`A despesa ${blingContaId} foi lançada no Bling, mas a quitação não foi enviada: a conexão com o Bling não está disponível. Ela continua em aberto no ERP.`],
      };
    case 'Recusada':
      return {
        quitada: false,
        avisos: [`A despesa ${blingContaId} foi lançada no Bling, mas a quitação falhou: ${mensagemPublicaDaFalhaDoBling(desfecho.failure, 'quitar a conta a pagar')} Ela continua em aberto no ERP.`],
      };
    case 'Indeterminada':
      return {
        quitada: false,
        avisos: [`A despesa ${blingContaId} foi lançada no Bling, mas a quitação não foi confirmada. ${AVISO_DE_PENDENCIA}`],
      };
  }
}
