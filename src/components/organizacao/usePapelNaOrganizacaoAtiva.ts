import { useCallback, useEffect, useState } from 'react';

import type { PapelMembro } from '@/lib/organizationContext';
import type { AuthenticatedFetch } from './useOrganizationPanel';

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
 * As três primeiras davam aparência de proprietário a quem não é, e a quarta
 * sobrevivia a qualquer mudança de vínculo. Nenhuma delas conversava com
 * `membros_organizacao` — que é o que o servidor usa para autorizar de verdade.
 *
 * A autoridade é uma só, e é a mesma dos dois lados: o vínculo persistido,
 * exposto por `GET /api/organizacoes` em `activeOrg.papel`. A tela apenas
 * reflete o que o servidor já decidiu.
 *
 * **Falha fechada.** Sem sessão, sem organização ativa, ou com resposta que não
 * dá para ler, o papel é `null` e nenhum controle de gestão aparece. A tela
 * mostrar de menos é incômodo; mostrar de mais é mentira.
 */
export interface PapelNaOrganizacaoAtiva {
  /** Papel na organização ativa, ou `null` quando não há vínculo verificado. */
  readonly papel: PapelMembro | null;
  /**
   * Se a tela pode exibir controles de gestão.
   *
   * Espelha `organizationCapabilitiesForRole`: `owner` e `admin` administram,
   * `member` não. Isto é aparência — a autorização de verdade continua no
   * servidor, e a tela não é a última palavra sobre nada.
   */
  readonly podeGerir: boolean;
  /** Há sessão, e a resposta do servidor para ela ainda não chegou. */
  readonly carregando: boolean;
  readonly recarregar: () => Promise<void>;
}

/**
 * @param fetchWithAuth - Busca autenticada, com o bearer da sessão.
 * @param chaveDaSessao - Identifica a sessão atual (o e-mail serve), ou `null`
 *   quando não há sessão. É por ela que um papel de outra sessão é descartado.
 */
export function usePapelNaOrganizacaoAtiva(
  fetchWithAuth: AuthenticatedFetch,
  chaveDaSessao: string | null,
): PapelNaOrganizacaoAtiva {
  // O papel guardado carrega **de qual sessão** ele veio. Sem isso existiria uma
  // janela entre a troca de usuário e a resposta do servidor em que a tela ainda
  // mostraria o papel do usuário anterior — a mesma classe de erro do
  // `localStorage` que este seam veio substituir. Um booleano "tem sessão" não
  // bastaria: duas sessões diferentes casariam entre si.
  const [resolvido, setResolvido] = useState<{ chave: string | null; papel: PapelMembro | null }>({
    chave: null,
    papel: null,
  });

  const valeParaEstaSessao = chaveDaSessao !== null && resolvido.chave === chaveDaSessao;
  const papel = valeParaEstaSessao ? resolvido.papel : null;

  /** Lê o papel e devolve; não guarda nada. Falha fechada em `null`. */
  const buscarPapel = useCallback(async (): Promise<PapelMembro | null> => {
    try {
      const resposta = await fetchWithAuth('/api/organizacoes');
      if (!resposta.ok) return null;
      const corpo = await resposta.json();
      const papelAtivo = corpo?.activeOrg?.papel;
      return papelAtivo === 'owner' || papelAtivo === 'admin' || papelAtivo === 'member'
        ? papelAtivo
        : null;
    } catch {
      return null;
    }
  }, [fetchWithAuth]);

  useEffect(() => {
    // Sem sessão não se consulta nada, e nada é gravado: o papel já sai `null`
    // pela comparação de chave acima.
    if (chaveDaSessao === null) return;
    let ativo = true;
    void buscarPapel().then((papelLido) => {
      // A resposta de uma sessão que já saiu não pode ser aplicada.
      if (ativo) setResolvido({ chave: chaveDaSessao, papel: papelLido });
    });
    return () => {
      ativo = false;
    };
  }, [buscarPapel, chaveDaSessao]);

  const recarregar = useCallback(async () => {
    if (chaveDaSessao === null) return;
    setResolvido({ chave: chaveDaSessao, papel: await buscarPapel() });
  }, [buscarPapel, chaveDaSessao]);

  return {
    papel,
    podeGerir: papel === 'owner' || papel === 'admin',
    // Há sessão e ainda não há resposta para ela. `podeGerir` já é `false` nesse
    // intervalo, então nada de gestão aparece antes da confirmação.
    carregando: chaveDaSessao !== null && !valeParaEstaSessao,
    recarregar,
  };
}
