/**
 * A organização que o cliente **acreditava** estar ativa quando começou a
 * operação.
 *
 * Nunca é autoridade: a organização continua saindo da sessão verificada, e um
 * id vindo do cliente jamais amplia o que ele pode fazer. Ele só serve para
 * **recusar**.
 *
 * O caso que ele fecha: o proprietário abre Integrações na organização A,
 * digita o Client Secret, e troca para B antes de a requisição chegar. O
 * servidor resolveria a organização ativa no instante do POST — B — e gravaria
 * as chaves de A no cofre de B. Nenhuma checagem de sessão pega isso, porque a
 * sessão está perfeitamente válida nas duas pontas; o que diverge é a
 * intenção, e só o cliente sabe qual era.
 *
 * A tela já invalida leitura, formulário e segredos na troca (o padrão de
 * seleção carimbada do Ticket 06). Isto é a outra metade: a resposta atrasada
 * não aparece em B, e a escrita atrasada não acontece em B.
 */

/** `true` quando o cliente declarou uma organização e ela não é a ativa. */
export function organizacaoEsperadaDivergente(
  esperada: string | null | undefined,
  organizacaoAtiva: string,
): boolean {
  const declarada = typeof esperada === 'string' ? esperada.trim() : '';
  // Sem declaração não há divergência a apurar. O cliente do ORBITA sempre
  // declara; um cliente que não declare continua sujeito a toda a autorização
  // normal, e apenas não ganha esta proteção extra.
  return declarada.length > 0 && declarada !== organizacaoAtiva;
}

/** A mensagem única desta recusa, para as duas rotas dizerem a mesma coisa. */
export const ORGANIZACAO_ESPERADA_DIVERGENTE =
  'A organização ativa mudou desde que esta operação começou. Nada foi gravado. Refaça na organização correta.';
