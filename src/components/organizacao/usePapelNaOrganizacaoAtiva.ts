import { useCallback, useEffect, useState } from 'react';

import type { PapelMembro } from '@/lib/organizationContext';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/**
 * Identificação da organização ativa, como o fluxo de organizações a mantém.
 *
 * A **versão da seleção** entra junto de propósito: trocar de organização e
 * voltar para a mesma são seleções diferentes, e só a versão as distingue.
 */
export interface SelecaoDeOrganizacao {
  readonly id: string;
  readonly versao: number;
}

/**
 * Papel do usuário **na organização ativa**, vindo do servidor.
 *
 * Ticket 22, fatia C — a tela decidia quem era dono por conta própria, com
 * quatro fontes que não são autoridade nenhuma:
 *
 * - `app_metadata.role`, o metadado do modelo por usuário, já removido;
 * - o e-mail conter a substring `dono`;
 * - o e-mail ser exatamente `admin@haux.com.br`;
 * - um papel gravado antes em `localStorage`.
 *
 * A autoridade é uma só, e é a mesma dos dois lados: o vínculo persistido,
 * exposto por `GET /api/organizacoes` em `activeOrg.papel`.
 *
 * **Revisão do #66 — o papel é do par (sessão, organização), não da sessão.**
 * A primeira versão chaveava só pela identidade da sessão, e isso bastava para
 * a troca de *usuário*. Não bastava para a troca de *organização*: quem é
 * `owner` em A e `member` em B continuava vendo controles de gestão em B até a
 * resposta chegar — e o inverso, `member` em A e `admin` em B, ficava sem os
 * controles que tem. O servidor negava as operações indevidas, então não havia
 * elevação; a tela é que mentia. É a mesma classe de erro do `localStorage`
 * que este seam veio substituir, só que num eixo a mais.
 *
 * **Falha fechada.** Sem sessão, sem organização ativa, ou com resposta que não
 * dá para ler, o papel é `null` e nenhum controle de gestão aparece. A tela
 * mostrar de menos é incômodo; mostrar de mais é mentira.
 */
export interface PapelNaOrganizacaoAtiva {
  /** Papel na organização ativa confirmada, ou `null` sem vínculo verificado. */
  readonly papel: PapelMembro | null;
  /**
   * Se a tela pode exibir controles de gestão.
   *
   * Espelha `organizationCapabilitiesForRole`: `owner` e `admin` administram,
   * `member` não. Isto é aparência — a autorização de verdade continua no
   * servidor, e a tela não é a última palavra sobre nada.
   */
  readonly podeGerir: boolean;
  /**
   * A organização a que o papel acima se refere, **já confirmada** pelo
   * servidor, ou `null` enquanto não houver confirmação para a seleção atual.
   *
   * É por ela que o startup sabe em qual organização já rodou.
   */
  readonly organizacaoId: string | null;
}

interface PapelResolvido {
  readonly chave: string | null;
  readonly organizacaoId: string | null;
  readonly versao: number;
  readonly papel: PapelMembro | null;
}

const NADA_RESOLVIDO: PapelResolvido = { chave: null, organizacaoId: null, versao: -1, papel: null };

function papelConhecido(valor: unknown): PapelMembro | null {
  return valor === 'owner' || valor === 'admin' || valor === 'member' ? valor : null;
}

/**
 * @param fetchWithAuth - Busca autenticada, com o bearer da sessão.
 * @param chaveDaSessao - Identifica a sessão atual (o e-mail serve), ou `null`
 *   quando não há sessão.
 * @param selecao - A organização ativa que o fluxo de organizações conhece, ou
 *   `null` enquanto ele ainda não se pronunciou — aí vale o que o servidor
 *   responder. Quando ela muda, o papel anterior deixa de valer **na hora**,
 *   antes de qualquer resposta nova.
 */
export function usePapelNaOrganizacaoAtiva(
  fetchWithAuth: AuthenticatedFetch,
  chaveDaSessao: string | null,
  selecao: SelecaoDeOrganizacao | null = null,
): PapelNaOrganizacaoAtiva {
  // O papel guardado carrega **de quem** e **de onde** ele veio. Sem os dois
  // existiria uma janela entre a troca e a resposta do servidor em que a tela
  // mostraria o papel anterior. Um booleano "tem sessão" não bastaria: duas
  // sessões diferentes casariam entre si — e uma só chave de sessão não basta
  // quando o mesmo usuário troca de organização.
  const [resolvido, setResolvido] = useState<PapelResolvido>(NADA_RESOLVIDO);

  const selecaoId = selecao?.id ?? null;
  const selecaoVersao = selecao?.versao ?? null;

  const valeAgora =
    chaveDaSessao !== null &&
    resolvido.chave === chaveDaSessao &&
    (selecaoId === null || (resolvido.organizacaoId === selecaoId && resolvido.versao === selecaoVersao));

  const papel = valeAgora ? resolvido.papel : null;

  /** Lê o papel e a organização ativa; não guarda nada. Falha fechada em nulo. */
  const buscarPapel = useCallback(async (): Promise<Omit<PapelResolvido, 'chave'>> => {
    const vazio = { organizacaoId: null, versao: -1, papel: null };
    try {
      const resposta = await fetchWithAuth('/api/organizacoes');
      if (!resposta.ok) return vazio;
      const corpo = await resposta.json();
      const ativa = corpo?.activeOrg;
      const papelLido = papelConhecido(ativa?.papel);
      if (papelLido === null) return vazio;
      return {
        organizacaoId: typeof ativa?.organizacao?.id === 'string' ? ativa.organizacao.id : null,
        versao: typeof corpo?.selectionVersion === 'number' ? corpo.selectionVersion : -1,
        papel: papelLido,
      };
    } catch {
      return vazio;
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    // Sem sessão não se consulta nada, e nada é gravado: o papel já sai `null`
    // pela comparação acima.
    if (chaveDaSessao === null) return;
    let ativo = true;
    void buscarPapel().then((lido) => {
      // A resposta de uma sessão que já saiu, ou de uma organização que já não
      // é a ativa, não pode ser aplicada. O `ativo` descarta na hora; a chave
      // gravada junto do papel descarta mesmo se algo escapar daqui.
      if (ativo) setResolvido({ chave: chaveDaSessao, ...lido });
    });
    return () => {
      ativo = false;
    };
    // `selecaoId` e `selecaoVersao` entram como dependências porque trocar de
    // organização — ou reselecionar a mesma — exige leitura nova.
  }, [buscarPapel, chaveDaSessao, selecaoId, selecaoVersao]);

  return {
    papel,
    podeGerir: papel === 'owner' || papel === 'admin',
    organizacaoId: valeAgora ? resolvido.organizacaoId : null,
  };
}
