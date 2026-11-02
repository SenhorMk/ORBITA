/**
 * Conexão desligada: `conexoes_integracao.status = 'desconectado'`.
 *
 * É a alavanca de contenção do PRE-008 ("pausar a conexão afetada"): enquanto
 * a linha estiver assim, nenhum caminho produz efeito novo por ela — webhook do
 * Chatwoot ou do Bling, envio, sincronização ou renovação de token. O mapping,
 * as credenciais e o histórico ficam onde estão.
 *
 * Só o servidor muda o status. Desde a migration 84 o navegador não escreve na
 * tabela; antes dela, o PATCH direto pelo PostgREST era a única forma de
 * "desligar" e também de "religar" sem passar pela API. Religar é refazer a
 * conexão pela API autorizada (`POST /api/<provedor>/connect`, e o OAuth no
 * Bling), que exige `organization:manage`.
 */
export const STATUS_CONEXAO_DESLIGADA = 'desconectado';

/** `true` quando o status lido do banco é o de conexão desligada. */
export function conexaoDesligada(status: unknown): boolean {
  return status === STATUS_CONEXAO_DESLIGADA;
}
