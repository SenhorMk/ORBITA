import { useCallback, useEffect, useState } from 'react';

/** Carregador de inicialização e o encerramento dele. */
export interface StartupPorOrganizacao {
  /** Se o carregador de inicialização deve estar na tela agora. */
  readonly mostrarCarregador: boolean;
  /**
   * Encerra o carregador **da organização atual**.
   *
   * Uma chamada que chega de uma organização que já não é a ativa não faz nada.
   */
  readonly encerrar: () => void;
}

/**
 * Inicialização **por organização confirmada**, e só para quem administra.
 *
 * Revisão do #66 — antes isto era um booleano global (`hasStartedUp`) ao lado
 * de um papel que só conhecia a sessão. Os dois defeitos se somavam: quem
 * iniciava em A e trocava para B nunca via a inicialização de B, porque o
 * estado de A continuava valendo. O registro não é "já iniciou", é "já iniciou
 * **onde**".
 *
 * Revisão do head `2d1795a` — a primeira correção ainda tratava o carregador
 * como um booleano solto. Ele abria ligado a nada, então:
 *
 * - trocar de organização com a inicialização de A **em curso** deixava o
 *   carregador de A na tela, agora sobre a organização B;
 * - perder a capacidade no meio não o fechava;
 * - e o encerramento não tinha dono: um desfecho tardio de A fechava o
 *   carregador de B, e disparava o recarregamento do painel de B.
 *
 * Agora o carregador **carrega a organização que o abriu**. Ele só aparece
 * enquanto essa organização for a ativa e a capacidade continuar valendo — as
 * duas checagens são derivadas, então a invalidação é imediata, sem esperar
 * efeito nenhum. E `encerrar` só encerra o que é da organização atual.
 *
 * Duas regras, e nenhuma delas é sobre a sessão:
 *
 * - só inicializa quem administra — `member` não dispara nada;
 * - inicializa **no máximo uma vez por organização ativa confirmada**, e
 *   confirmada quer dizer que o servidor já respondeu o papel para ela.
 *
 * Sair e voltar para a mesma organização na mesma visita não reinicializa: o
 * trabalho já foi feito, e refazê-lo seria ruído, não correção.
 *
 * @param podeGerir - Se o papel confirmado administra a organização.
 * @param organizacaoId - A organização já confirmada pelo servidor, ou `null`
 *   enquanto não houver confirmação — e `null` nunca inicializa nada.
 */
export function useStartupPorOrganizacao(
  podeGerir: boolean,
  organizacaoId: string | null,
): StartupPorOrganizacao {
  /** A organização cujo carregador está aberto, ou `null` se não há nenhum. */
  const [carregadorDe, setCarregadorDe] = useState<string | null>(null);
  const [jaIniciadas, setJaIniciadas] = useState<ReadonlySet<string>>(() => new Set());

  // Derivado, e não guardado: trocar de organização ou perder a capacidade
  // apaga o carregador **no mesmo quadro**, sem depender de efeito nenhum.
  const mostrarCarregador = podeGerir && organizacaoId !== null && carregadorDe === organizacaoId;

  useEffect(() => {
    // O desenho com `setTimeout` vem da regra `set-state-in-effect` do lint: o
    // efeito agenda, e não escreve estado no mesmo passo em que roda.
    const timer = setTimeout(() => {
      if (!podeGerir || organizacaoId === null) {
        // Nada a inicializar, e o que estava aberto foi abandonado.
        setCarregadorDe(null);
        return;
      }
      if (jaIniciadas.has(organizacaoId)) {
        // Já inicializou aqui nesta visita. Um carregador de outra organização
        // que tenha sobrado é descartado; o desta, se aberto, permanece.
        setCarregadorDe((atual) => (atual === organizacaoId ? atual : null));
        return;
      }
      setCarregadorDe(organizacaoId);
      setJaIniciadas((anteriores) => new Set(anteriores).add(organizacaoId));
    }, 0);
    return () => clearTimeout(timer);
  }, [podeGerir, organizacaoId, jaIniciadas]);

  const encerrar = useCallback(() => {
    // Só encerra o carregador desta organização. Um desfecho que chega de uma
    // organização anterior não pode fechar o carregador da atual — nem disparar
    // o que vem depois do fechamento.
    setCarregadorDe((atual) => (atual === organizacaoId ? null : atual));
  }, [organizacaoId]);

  return { mostrarCarregador, encerrar };
}
