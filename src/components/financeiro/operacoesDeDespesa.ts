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

/** As operações contábeis lembradas por esta aba. */
export interface OperacoesDeDespesa {
  /** A chave já associada a este lançamento, ou uma nova — já associada. */
  chavePara(organizacaoId: string | null, impressao: string): string;
  /** Esquece a associação: o navegador conhece um desfecho definitivo. */
  esquecer(organizacaoId: string | null, impressao: string): void;
}

/**
 * Operações guardadas no `storage` dado, com a memória da página como reserva.
 *
 * O `storage` pode recusar leitura ou escrita (aba privada, cota cheia,
 * política do navegador). Nesse caso a memória ainda segura a chave enquanto a
 * página existir — a proteção cai para o nível do `useRef` anterior, sem
 * quebrar o envio.
 *
 * @param storage - Normalmente o `sessionStorage`; `null` quando não existe.
 * @returns As operações desta aba.
 */
export function criarOperacoesDeDespesa(storage: Storage | null): OperacoesDeDespesa {
  const memoria = new Map<string, string>();
  const nome = (organizacaoId: string | null, impressao: string) =>
    `${PREFIXO}.${organizacaoId ?? 'sem-organizacao'}.${impressao}`;

  const ler = (chave: string): string | null => {
    try {
      const guardada = storage?.getItem(chave) ?? null;
      if (guardada !== null && UUID.test(guardada)) return guardada;
    } catch {
      // Storage indisponível: a memória abaixo responde.
    }
    return memoria.get(chave) ?? null;
  };

  return {
    chavePara(organizacaoId, impressao) {
      const chave = nome(organizacaoId, impressao);
      const existente = ler(chave);
      if (existente !== null) return existente;
      const nova = crypto.randomUUID();
      memoria.set(chave, nova);
      try {
        storage?.setItem(chave, nova);
      } catch {
        // Storage indisponível: a associação fica só na memória da página.
      }
      return nova;
    },
    esquecer(organizacaoId, impressao) {
      const chave = nome(organizacaoId, impressao);
      memoria.delete(chave);
      try {
        storage?.removeItem(chave);
      } catch {
        // Storage indisponível: não havia nada guardado nele.
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
