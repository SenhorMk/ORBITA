import { z } from 'zod';

/**
 * Contrato das correções operacionais: excluir contato, excluir lançamento
 * interno e cancelar despesa do Bling.
 *
 * Importado pelos dois lados — a rota monta a resposta com ele e a tela a lê
 * com ele. A tela decide pelo discriminador `resultado` e pelo `motivo`, nunca
 * pelo texto: toda frase exibida sai de `mensagemDaCorrecao`, escrita aqui, e
 * nenhuma vem do banco ou do Bling.
 *
 * | resultado           | HTTP | O que aconteceu                                                     |
 * |---------------------|------|---------------------------------------------------------------------|
 * | `Deleted`           | 200  | removido definitivamente                                            |
 * | `Cancelled`         | 200  | removido do Bling e mantido no histórico como `cancelado`           |
 * | `AlreadyTerminal`   | 200  | já estava `cancelado`/`estornado`; nada foi feito                   |
 * | `Blocked`           | 409  | a regra impede a ação; nada foi tocado (exceção: ver abaixo)       |
 * | `NotFound`          | 404  | não existe nesta organização (inexistente e alheio são iguais)      |
 * | `ProviderRefused`   | 502  | o Bling não removeu; nada mudou no ORBITA                           |
 * | `ReconcileRequired` | 503  | o estado no Bling não pôde ser confirmado; nada local foi concluído |
 * | `InvalidRequest`    | 400  | o pedido não tem a forma esperada                                   |
 * | `Unavailable`       | 503  | a correção não pode rodar agora; nada foi tocado, nem no Bling      |
 *
 * A única exceção ao "nada foi tocado" de `Blocked` é o motivo
 * `preservado_por_historico_apos_remocao_no_bling`: o contato **já saiu** do
 * Bling e só então ganhou histórico no ORBITA, que o preservou. É `Blocked`, e
 * não `ReconcileRequired`, porque repetir não tem o que concluir — e a frase
 * diz o que de fato mudou.
 */

export const MOTIVOS_DE_BLOQUEIO = [
  /** Contato com pedidos, solicitação LGPD, retenção ou uso como fornecedor. */
  'possui_historico',
  /** Já removido do Bling; ganhou histórico no ORBITA depois e foi preservado aqui. */
  'preservado_por_historico_apos_remocao_no_bling',
  /** O título não é uma despesa (`tipo = pagar`). */
  'nao_e_despesa',
  /** O título pertence a um pedido: quem o encerra é o cancelamento do pedido. */
  'vinculado_a_pedido',
  /** Excluir lançamento é só para despesa interna; a do Bling é cancelada. */
  'despesa_do_bling',
  /** Cancelar é só para despesa do Bling; a interna é excluída. */
  'despesa_interna',
  /** Paga no Bling: o estorno automático não é suportado com segurança. */
  'estorno_nao_suportado_com_seguranca',
  /** Parcial, devolvida, devolvida parcialmente ou confirmada no Bling. */
  'situacao_remota_impede_cancelamento',
] as const;

export const MOTIVOS_DE_RECUSA = [
  'recusado_pelo_bling',
  'limite_de_requisicoes',
  /** O Bling não confirmou a exclusão, e a leitura mostrou o recurso ainda lá. */
  'exclusao_nao_confirmada',
] as const;

export const MOTIVOS_DE_RECONCILIACAO = [
  /** Nem a operação nem a leitura provaram o estado no Bling. */
  'estado_remoto_indeterminado',
  /** O Bling confirmou a remoção, mas a gravação local não concluiu. */
  'conclusao_local_pendente',
] as const;

export type MotivoDeBloqueio = (typeof MOTIVOS_DE_BLOQUEIO)[number];
export type MotivoDeRecusa = (typeof MOTIVOS_DE_RECUSA)[number];
export type MotivoDeReconciliacao = (typeof MOTIVOS_DE_RECONCILIACAO)[number];

export const respostaDeCorrecaoSchema = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('Deleted'), removidoDoBling: z.boolean() }),
  z.object({ resultado: z.literal('Cancelled') }),
  z.object({ resultado: z.literal('AlreadyTerminal') }),
  z.object({ resultado: z.literal('Blocked'), motivo: z.enum(MOTIVOS_DE_BLOQUEIO) }),
  z.object({ resultado: z.literal('NotFound') }),
  z.object({ resultado: z.literal('ProviderRefused'), motivo: z.enum(MOTIVOS_DE_RECUSA) }),
  z.object({ resultado: z.literal('ReconcileRequired'), motivo: z.enum(MOTIVOS_DE_RECONCILIACAO) }),
  z.object({ resultado: z.literal('InvalidRequest') }),
  z.object({ resultado: z.literal('Unavailable') }),
]);

export type RespostaDeCorrecao = z.infer<typeof respostaDeCorrecaoSchema>;
export type ResultadoDeCorrecao = RespostaDeCorrecao['resultado'];

export const STATUS_HTTP_DA_CORRECAO: Record<ResultadoDeCorrecao, number> = {
  Deleted: 200,
  Cancelled: 200,
  AlreadyTerminal: 200,
  Blocked: 409,
  NotFound: 404,
  ProviderRefused: 502,
  ReconcileRequired: 503,
  InvalidRequest: 400,
  Unavailable: 503,
};

/**
 * O que a tela recebe quando a resposta não é do contrato: a autorização
 * (401/403/503 de `resolveVerifiedOrganizationScope`) ou uma falha inesperada.
 * Só o status HTTP é usado — o corpo desses casos não é lido.
 */
export type FalhaForaDoContrato = { readonly resultado: 'SemPermissao' | 'SessaoExpirada' | 'FalhaInesperada' };

export type DesfechoDaCorrecao = RespostaDeCorrecao | FalhaForaDoContrato;

/** Lê a resposta HTTP de uma correção sem nunca levar texto de terceiros adiante. */
export function interpretarRespostaDeCorrecao(status: number, corpo: unknown): DesfechoDaCorrecao {
  const lido = respostaDeCorrecaoSchema.safeParse(corpo);
  if (lido.success && STATUS_HTTP_DA_CORRECAO[lido.data.resultado] === status) return lido.data;
  if (status === 401) return { resultado: 'SessaoExpirada' };
  if (status === 403) return { resultado: 'SemPermissao' };
  return { resultado: 'FalhaInesperada' };
}

const MENSAGEM_DE_BLOQUEIO: Record<MotivoDeBloqueio, string> = {
  possui_historico: 'Este contato possui histórico vinculado e não pode ser excluído.',
  preservado_por_historico_apos_remocao_no_bling:
    'O contato já foi removido do Bling, mas passou a possuir histórico no ORBITA e foi preservado localmente.',
  nao_e_despesa: 'Esta ação vale apenas para despesas.',
  vinculado_a_pedido: 'Esta movimentação pertence a um pedido. Ela é encerrada pelo cancelamento do pedido.',
  despesa_do_bling: 'Esta despesa também existe no Bling. Use "Cancelar despesa".',
  despesa_interna: 'Esta despesa existe apenas no ORBITA. Use "Excluir lançamento".',
  estorno_nao_suportado_com_seguranca:
    'Esta despesa já foi paga no Bling. O estorno automático ainda não está disponível com segurança.',
  situacao_remota_impede_cancelamento:
    'A situação desta despesa no Bling (parcial, devolvida ou confirmada) não permite o cancelamento automático.',
};

const MENSAGEM_DE_RECUSA: Record<MotivoDeRecusa, string> = {
  recusado_pelo_bling: 'O Bling recusou a remoção. Nada foi alterado no ORBITA.',
  limite_de_requisicoes: 'O Bling está limitando as requisições agora. Nada foi alterado; tente de novo em instantes.',
  exclusao_nao_confirmada: 'O Bling não confirmou a remoção e o registro continua lá. Nada foi alterado no ORBITA.',
};

const MENSAGEM_DE_RECONCILIACAO: Record<MotivoDeReconciliacao, string> = {
  estado_remoto_indeterminado:
    'Não foi possível confirmar a situação no Bling. Nada foi concluído no ORBITA; tente de novo em instantes.',
  conclusao_local_pendente:
    'A remoção no Bling foi confirmada, mas o ORBITA não concluiu a atualização. Tente de novo para concluir.',
};

/** A frase pública de cada desfecho. Única fonte do texto que a tela mostra. */
export function mensagemDaCorrecao(desfecho: DesfechoDaCorrecao): string {
  switch (desfecho.resultado) {
    case 'Deleted':
      return 'Removido com sucesso.';
    case 'Cancelled':
      return 'Despesa cancelada. Ela continua no histórico e não entra mais nos totais.';
    case 'AlreadyTerminal':
      return 'Esta movimentação já está cancelada ou estornada.';
    case 'Blocked':
      return MENSAGEM_DE_BLOQUEIO[desfecho.motivo];
    case 'NotFound':
      return 'Este registro não existe mais.';
    case 'ProviderRefused':
      return MENSAGEM_DE_RECUSA[desfecho.motivo];
    case 'ReconcileRequired':
      return MENSAGEM_DE_RECONCILIACAO[desfecho.motivo];
    case 'InvalidRequest':
      return 'Não foi possível identificar o registro.';
    case 'Unavailable':
      return 'Esta correção está indisponível no momento. Nada foi alterado no ORBITA nem no Bling; tente de novo mais tarde.';
    case 'SemPermissao':
      return 'Apenas quem administra a organização pode fazer esta correção.';
    case 'SessaoExpirada':
      return 'Sua sessão expirou. Entre de novo para continuar.';
    case 'FalhaInesperada':
      return 'Não foi possível concluir agora. Tente de novo em instantes.';
  }
}
