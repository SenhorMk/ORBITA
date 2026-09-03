/**
 * As tentativas de venda manual ainda não resolvidas, lembradas pelo NAVEGADOR
 * (ticket 30, fatia 3 — 4ª e 5ª rodadas de revisão).
 *
 * ## O que isto é, e o que não é
 *
 * A fonte de verdade é o servidor (`tentativas_venda_manual`, migration 59).
 * O que vive aqui é só a memória de QUAL referência usar para retomar uma
 * submissão — porque um `useRef` morre no reload, e uma retentativa com
 * referência nova faria o ledger tratá-la como uma tentativa genuinamente
 * nova, liberando uma segunda criação no Bling.
 *
 * ## Por que a chave é por organização (5ª rodada)
 *
 * A versão anterior guardava UMA referência numa chave global
 * (`orbita:pedidos-manual:tentativa-pendente`). O dano concreto: com uma
 * tentativa indeterminada pendente na organização A, trocar para a
 * organização B e vender lá sobrescrevia o slot — e a âncora da tentativa de A
 * se perdia. Voltando para A, uma retentativa geraria referência NOVA, o
 * ledger a veria como tentativa nova, e o pedido de A (que pode existir de
 * verdade no Bling) seria criado de novo. Escopar por organização isola cada
 * ledger do outro, que é exatamente o recorte do servidor
 * `(organizacao_id, referencia_local)`.
 *
 * ## Por que é uma LISTA, e não um slot
 *
 * Pelo mesmo motivo, um eixo abaixo: dentro da MESMA organização, começar uma
 * venda diferente enquanto uma tentativa segue sem desfecho não pode apagar a
 * âncora da primeira — sem ela, não há como reconciliar aquela tentativa
 * depois (`POST /api/pedidos/manual/reconciliar` precisa da referência). A
 * lista é limitada: o que interessa é não perder as pendências recentes, não
 * guardar histórico.
 *
 * ## Como uma retentativa é reconhecida
 *
 * Pelo FINGERPRINT, não pela posição na lista: reutiliza-se a referência cuja
 * impressão digital bate com a submissão atual. É o que faz duas abas, duas
 * vendas em paralelo, e "mudei a quantidade e reenviei" se comportarem
 * corretamente sem nenhum caso especial — e é a mesma regra que o servidor
 * aplica, do outro lado (`manualOrderFingerprint.ts`).
 *
 * ## Trocar de usuário no mesmo navegador
 *
 * Coberto pelas duas regras acima somadas: outra pessoa só reutiliza uma
 * referência se estiver na MESMA organização E enviando exatamente a MESMA
 * venda — que é, por definição, a mesma operação, e é o caso em que reutilizar
 * é o comportamento certo. Qualquer divergência de conteúdo gera referência
 * nova aqui, e conflito `409` no servidor se ainda assim chegar lá repetida.
 */

/** Uma tentativa que o navegador ainda não viu resolver. */
export interface TentativaPendente {
  /** O UUID que vai no corpo da requisição; o servidor monta `ORBITA-<uuid>`. */
  readonly referencia: string;
  /** SHA-256 da intenção comercial, para reconhecer a MESMA venda. */
  readonly fingerprint: string;
}

/**
 * Teto da lista por organização. Pendências são raras (só sobram quando um
 * desfecho fica indeterminado); mais que isto é acúmulo, não memória útil.
 */
const MAXIMO_DE_PENDENTES = 5;

const PREFIXO = 'orbita:pedidos-manual:tentativa-pendente';

function chaveDaOrganizacao(organizacaoId: string): string {
  return `${PREFIXO}:${organizacaoId}`;
}

function ehTentativaPendente(valor: unknown): valor is TentativaPendente {
  if (!valor || typeof valor !== 'object') return false;
  const candidato = valor as { referencia?: unknown; fingerprint?: unknown };
  return typeof candidato.referencia === 'string'
    && candidato.referencia !== ''
    && typeof candidato.fingerprint === 'string'
    && candidato.fingerprint !== '';
}

/**
 * Lê as pendências da organização.
 *
 * Devolve lista vazia para qualquer problema — `localStorage` indisponível
 * (aba anônima, quota, ambiente sem DOM), JSON corrompido, formato de outra
 * versão. Sem memória local a proteção fica limitada à vida da instância do
 * componente, o que é uma degradação; travar o envio por causa disso seria
 * pior, e o servidor continua sendo quem decide de verdade.
 */
export function lerTentativasPendentes(organizacaoId: string): readonly TentativaPendente[] {
  try {
    const bruto = window.localStorage.getItem(chaveDaOrganizacao(organizacaoId));
    if (!bruto) return [];
    const decodificado: unknown = JSON.parse(bruto);
    if (!Array.isArray(decodificado)) return [];
    return decodificado.filter(ehTentativaPendente);
  } catch {
    return [];
  }
}

/** A pendência cuja venda é EXATAMENTE a da submissão atual, se houver. */
export function acharPendentePorFingerprint(
  organizacaoId: string,
  fingerprint: string,
): TentativaPendente | null {
  return lerTentativasPendentes(organizacaoId).find((t) => t.fingerprint === fingerprint) ?? null;
}

/**
 * Registra (ou atualiza) a pendência, mantendo a mais recente no fim e
 * respeitando o teto.
 */
export function registrarTentativaPendente(organizacaoId: string, tentativa: TentativaPendente): void {
  try {
    const semEsta = lerTentativasPendentes(organizacaoId).filter((t) => t.referencia !== tentativa.referencia);
    const atualizada = [...semEsta, tentativa].slice(-MAXIMO_DE_PENDENTES);
    window.localStorage.setItem(chaveDaOrganizacao(organizacaoId), JSON.stringify(atualizada));
  } catch {
    // idem `lerTentativasPendentes`: sem memória local, sem proteção extra —
    // nunca um motivo para impedir a venda.
  }
}

/**
 * Esquece uma pendência RESOLVIDA.
 *
 * Só deve ser chamada quando o desfecho é conhecido: sucesso do envio, ou uma
 * reconciliação que devolveu `referenciaLiberada: true`. Apagar por outro
 * motivo é remover a âncora de idempotência de uma tentativa que ninguém
 * resolveu — exatamente o que a proteção existe para impedir.
 */
export function esquecerTentativaPendente(organizacaoId: string, referencia: string): void {
  try {
    const restantes = lerTentativasPendentes(organizacaoId).filter((t) => t.referencia !== referencia);
    const chave = chaveDaOrganizacao(organizacaoId);
    if (restantes.length === 0) {
      window.localStorage.removeItem(chave);
      return;
    }
    window.localStorage.setItem(chave, JSON.stringify(restantes));
  } catch {
    // idem
  }
}
