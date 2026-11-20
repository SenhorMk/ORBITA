import { blingFailure, type BlingCallResult } from '@/lib/integrations/bling/pedidoVendaContract';
import { logger, sanitizeErrorForLog } from '@/lib/observability/logger';

/**
 * SQLSTATE: exatamente cinco caracteres alfanuméricos maiúsculos (`42501`,
 * `23505`, `PGRST201`… — este último não passa, e é o ponto).
 *
 * O `code` do erro é texto que vem de fora. Sem validar, ele próprio seria um
 * canal para empurrar conteúdo arbitrário para dentro do log estruturado.
 */
const CODIGO_SQLSTATE = /^[0-9A-Z]{5}$/u;

/** Código técnico do erro, apenas se for um SQLSTATE reconhecível. */
function codigoTecnicoValidado(erro: unknown): string | undefined {
  const bruto = (erro as { code?: unknown } | null | undefined)?.code;
  return typeof bruto === 'string' && CODIGO_SQLSTATE.test(bruto) ? bruto : undefined;
}

/**
 * Registra a falha no servidor sem carregar nada que não possa ser lido depois.
 *
 * Deliberadamente **não** registra `message`, `details` nem `hint`. Numa
 * violação de unicidade o Postgres coloca valores de linha dentro deles
 * (`Key (email)=(...) already exists`), ou seja, dado de cliente — e
 * `descreverErro` sozinho não resolve isso, porque o trabalho dele é tornar o
 * erro legível, não decidir o que pode sair daqui.
 *
 * O que fica: qual operação falhou, em qual organização, a classe do erro e o
 * SQLSTATE. É o suficiente para saber onde olhar.
 */
export function registrarFalhaInterna(erro: unknown, organizacaoId: string | undefined): void {
  logger.error('Falha ao atualizar situação do pedido', {
    subsystem: 'app',
    operacao: 'pedidos.status.atualizar',
    organizacaoId,
    erro: sanitizeErrorForLog(erro).name,
    codigo: codigoTecnicoValidado(erro),
  });
}

/** Exceção ao falar com o Bling (rede, timeout) é desfecho desconhecido, nunca 500 genérico. */
export async function semExcecao<T>(chamada: () => Promise<BlingCallResult<T>>): Promise<BlingCallResult<T>> {
  try {
    return await chamada();
  } catch (erro: unknown) {
    return blingFailure('UNKNOWN_ERROR', 0, sanitizeErrorForLog(erro).name);
  }
}
