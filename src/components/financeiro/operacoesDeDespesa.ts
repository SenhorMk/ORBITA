/**
 * Onde o formulário guarda a chave de cada lançamento contábil em curso.
 *
 * A chave precisa sobreviver ao que um `useRef` não sobrevive: a página
 * recarregar depois de o servidor confirmar e a resposta se perder no caminho.
 * Sem isso, o mesmo lançamento voltaria com chave nova e criaria uma segunda
 * conta a pagar no Bling.
 *
 * A associação é `organização + impressão do conteúdo → UUID da operação`, no
 * `sessionStorage`. O conteúdo da despesa não é guardado: só o SHA-256 dele. A
 * organização entra no nome para que um lançamento igual em outra organização
 * seja outra operação. Ela é só um namespace — quem decide a organização é o
 * servidor.
 *
 * **Falha fechada.** Não há reserva em memória: uma chave que só existe na
 * memória da página some no reload, e é exatamente esse o caminho do segundo
 * POST. Sem storage gravável e relido, não há chave — e sem chave o formulário
 * não envia o lançamento contábil.
 */

const PREFIXO = 'orbita.despesa.operacao';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * SHA-256 (hex) do corpo do lançamento, sem a chave.
 *
 * @param corpo - O corpo já montado pelo contrato, serializado.
 * @returns 64 caracteres hexadecimais.
 */
export async function impressaoDoLancamento(corpo: string): Promise<string> {
  const resumo = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(corpo));
  return Array.from(new Uint8Array(resumo), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A chave da operação, ou a prova de que ela não sobreviveria a um reload. */
export type ChaveDaOperacao =
  | { readonly _tag: 'ChavePreservada'; readonly chave: string }
  | { readonly _tag: 'StorageIndisponivel' };

/** As operações contábeis lembradas por esta aba. */
export interface OperacoesDeDespesa {
  /**
   * A chave já guardada para este lançamento, ou uma nova — devolvida só
   * depois de gravada e relida idêntica no storage da aba.
   */
  chavePara(organizacaoId: string | null, impressao: string): ChaveDaOperacao;
  /** Esquece a associação: o navegador conhece um desfecho definitivo. */
  esquecer(organizacaoId: string | null, impressao: string): void;
}

/**
 * Operações guardadas no storage que `obterStorage` devolver.
 *
 * O storage é obtido a cada uso, e não uma vez: se ele estava bloqueado e
 * voltou, a próxima tentativa já funciona, sem recarregar a página.
 *
 * @param obterStorage - Normalmente `sessaoDoNavegador`; devolve `null` quando não há storage.
 * @returns As operações desta aba.
 */
export function criarOperacoesDeDespesa(obterStorage: () => Storage | null): OperacoesDeDespesa {
  const nome = (organizacaoId: string | null, impressao: string) =>
    `${PREFIXO}.${organizacaoId ?? 'sem-organizacao'}.${impressao}`;

  return {
    chavePara(organizacaoId, impressao) {
      const storage = obterStorage();
      if (storage === null) return { _tag: 'StorageIndisponivel' };
      const chave = nome(organizacaoId, impressao);
      try {
        const guardada = storage.getItem(chave);
        if (guardada !== null && UUID.test(guardada)) return { _tag: 'ChavePreservada', chave: guardada };

        const nova = crypto.randomUUID();
        storage.setItem(chave, nova);
        // Reler é a prova: gravar sem erro não garante que o valor ficou.
        if (storage.getItem(chave) !== nova) return { _tag: 'StorageIndisponivel' };
        return { _tag: 'ChavePreservada', chave: nova };
      } catch {
        // Aba privada, cota cheia ou storage bloqueado: sem prova, sem chave.
        return { _tag: 'StorageIndisponivel' };
      }
    },
    esquecer(organizacaoId, impressao) {
      try {
        obterStorage()?.removeItem(nome(organizacaoId, impressao));
      } catch {
        // Falhar aqui é o lado seguro: a associação fica, e o mesmo conteúdo
        // reenviado vira a repetição de uma operação já concluída, sem POST.
      }
    },
  };
}

/** O `sessionStorage` da aba, ou `null` quando o ambiente não o oferece. */
export function sessaoDoNavegador(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Acessar `sessionStorage` lança quando o navegador bloqueia o storage.
    return null;
  }
}
