import { useCallback, useEffect, useRef, useState } from 'react';

import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';

/**
 * Uma leitura que só vale **na seleção de organização que a pediu**.
 *
 * É o mesmo desenho de `useLeituraDeOrganizacoes` (carimbo de sessão) e de
 * `usePapelNaOrganizacaoAtiva` (carimbo de sessão + organização + versão),
 * pela mesma razão: um dado que não diz de onde veio não tem como ser
 * invalidado na hora certa. Aqui ele existe uma vez porque membros e convites
 * precisam exatamente do mesmo mecanismo — duas cópias dele divergiriam, e o
 * eixo em que elas divergiriam é justamente o que não pode falhar.
 *
 * O carimbo aparece nos dois lugares, e é preciso os dois:
 *
 * - **gravado no estado**, impede que a leitura da organização A seja *exibida*
 *   sob o contexto de B;
 * - **comparado dentro da resposta**, impede que uma resposta atrasada de A
 *   seja *gravada* depois da troca — inclusive por cima da leitura boa de B,
 *   que sumiria da tela sem nunca ter sido substituída por nada visível.
 *
 * ## Por que a versão entra na chave, e o `organizacao_id` não basta
 *
 * A → B → A é a sequência que separa as duas coisas. Comparando só o id, a
 * resposta atrasada da *primeira* visita a A chegaria durante a *segunda* e
 * seria aceita: mesma organização, chave igual. Mas ela é de antes da troca, e
 * entre as duas visitas alguém pode ter entrado, saído ou mudado de papel — o
 * que ela mostraria é o passado apresentado como presente. A versão da seleção
 * é o que distingue uma nova seleção da mesma organização, e é por isso que
 * `SelecaoDeOrganizacao` a carrega desde a revisão do #66.
 *
 * ## Sessão não entra na chave, e não precisa
 *
 * A seleção vem de `useOrganizationsList`, que já não expõe `activeOrg` fora
 * da sessão que o leu. No logout a seleção vira `null`, e com ela somem dados,
 * erro e carregamento — sem ninguém precisar limpar nada. É o lifecycle que já
 * existe, e não um segundo.
 */
interface LeituraCarimbada<T> {
  readonly chave: string;
  readonly dados: T;
}

/** Um erro e a seleção a que ele pertence. */
interface ErroCarimbado {
  readonly chave: string;
  readonly valor: string;
}

/** O que uma leitura por organização expõe para a tela. */
export interface LeituraPorOrganizacao<T> {
  /** Os dados da seleção atual, ou `null` se ainda não há leitura válida para ela. */
  readonly dados: T | null;
  /** Há seleção, ainda não há leitura dela, e nada falhou. */
  readonly carregando: boolean;
  /** A falha da leitura desta seleção, se houve. */
  readonly erro: string | null;
  /** Relê a seleção atual. Sem seleção, não faz nada. */
  readonly recarregar: () => Promise<void>;
}

/**
 * @param selecao - A organização ativa confirmada e a versão que a selecionou,
 *   ou `null` enquanto não houver seleção (inclusive sem sessão).
 * @param ler - A leitura em si, para uma organização. **Deve lançar** quando
 *   falhar: é o que permite distinguir vazio verdadeiro de falha de leitura.
 * @param mensagemDeFalha - O que dizer quando a leitura lança sem mensagem útil.
 */
export function useLeituraPorOrganizacao<T>(
  selecao: SelecaoDeOrganizacao | null,
  ler: (organizacaoId: string) => Promise<T>,
  mensagemDeFalha: string,
): LeituraPorOrganizacao<T> {
  const [leitura, setLeitura] = useState<LeituraCarimbada<T> | null>(null);
  const [erro, setErro] = useState<ErroCarimbado | null>(null);

  // Os campos entram desmontados de propósito: o objeto `selecao` é recriado a
  // cada render do chamador, e é o par (id, versão) que identifica a seleção.
  const selecaoId = selecao?.id ?? null;
  const selecaoVersao = selecao?.versao ?? null;
  const chave = selecaoId === null ? null : `${selecaoId}:${selecaoVersao}`;
  const chaveAtualRef = useRef(chave);

  const lerNaSelecao = useCallback(async () => {
    if (selecaoId === null) return;
    const chaveDaLeitura = `${selecaoId}:${selecaoVersao}`;
    try {
      const dados = await ler(selecaoId);
      if (chaveAtualRef.current !== chaveDaLeitura) return;
      setErro(null);
      setLeitura({ chave: chaveDaLeitura, dados });
    } catch (causa) {
      if (chaveAtualRef.current !== chaveDaLeitura) return;
      const detalhe = causa instanceof Error ? causa.message.trim() : '';
      setErro({ chave: chaveDaLeitura, valor: detalhe || mensagemDeFalha });
    }
  }, [ler, mensagemDeFalha, selecaoId, selecaoVersao]);

  useEffect(() => {
    // A referência é atualizada ANTES de disparar: é ela que a resposta
    // consulta para saber se ainda pode gravar.
    chaveAtualRef.current = chave;
    // Disparada e esquecida, no mesmo formato de `useLeituraDeOrganizacoes`:
    // nada é gravado durante o efeito, só depois da resposta do servidor.
    void (async () => {
      await lerNaSelecao();
    })();
  }, [chave, lerNaSelecao]);

  const valeAgora = chave !== null && leitura !== null && leitura.chave === chave;
  const erroDaSelecao = chave !== null && erro !== null && erro.chave === chave ? erro.valor : null;

  return {
    dados: valeAgora ? leitura.dados : null,
    carregando: chave !== null && !valeAgora && erroDaSelecao === null,
    erro: erroDaSelecao,
    recarregar: lerNaSelecao,
  };
}
