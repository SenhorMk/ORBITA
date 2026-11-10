/**
 * Se a automação responde conversas (MSG-009 → MSG-013/MSG-014).
 *
 * Ainda não existe resposta automática no ORBITA: não há configuração,
 * worker nem modelo ligado para nenhuma organização. Enquanto isso, o estado
 * `AI` do controle quer dizer "ninguém responde", e devolver uma conversa à
 * automação a deixaria abandonada. Esta é a única fonte que a rota e a tela
 * consultam antes de oferecer ou aceitar a devolução; quando a automação
 * existir, a verificação por organização entra aqui, no servidor.
 */
export function automacaoDoAtendimentoAtiva(): boolean {
  return false;
}
