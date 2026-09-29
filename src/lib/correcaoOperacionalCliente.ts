import {
  interpretarRespostaDeCorrecao,
  type DesfechoDaCorrecao,
} from '@/lib/config/correcaoOperacionalContract';

type BuscaAutenticada = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * Chama uma rota de correção operacional e devolve **sempre** um desfecho do
 * contrato. Rede caída, corpo ilegível ou status fora do contrato viram
 * `FalhaInesperada` — nunca uma exceção e nunca o texto de quem respondeu.
 */
export async function executarCorrecao(
  buscar: BuscaAutenticada,
  url: string,
  corpo?: unknown,
): Promise<DesfechoDaCorrecao> {
  try {
    const resposta = await buscar(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    let lido: unknown = null;
    try {
      lido = await resposta.json();
    } catch {
      lido = null;
    }
    return interpretarRespostaDeCorrecao(resposta.status, lido);
  } catch {
    return { resultado: 'FalhaInesperada' };
  }
}

/** A URL da exclusão de contato. O corpo leva só o id local. */
export function excluirContato(buscar: BuscaAutenticada, clienteId: string): Promise<DesfechoDaCorrecao> {
  return executarCorrecao(buscar, '/api/clientes/delete', { id: clienteId });
}

export function excluirLancamento(buscar: BuscaAutenticada, tituloId: string): Promise<DesfechoDaCorrecao> {
  return executarCorrecao(buscar, `/api/financeiro/titulos/${encodeURIComponent(tituloId)}/exclusao`);
}

export function cancelarDespesa(buscar: BuscaAutenticada, tituloId: string): Promise<DesfechoDaCorrecao> {
  return executarCorrecao(buscar, `/api/financeiro/titulos/${encodeURIComponent(tituloId)}/cancelamento`);
}
