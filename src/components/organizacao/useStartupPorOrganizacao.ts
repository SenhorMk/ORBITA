import { useCallback, useEffect, useState } from 'react';

/** Carregador de inicialização e o encerramento dele. */
export interface StartupPorOrganizacao {
  /** Se o carregador de inicialização deve estar na tela agora. */
  readonly mostrarCarregador: boolean;
  /** Encerra o carregador. Não reabre a inicialização daquela organização. */
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
  const [mostrarCarregador, setMostrarCarregador] = useState(false);
  const [jaIniciadas, setJaIniciadas] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!podeGerir || organizacaoId === null) return;
    if (jaIniciadas.has(organizacaoId)) return;

    // O desenho com `setTimeout` vem da regra `set-state-in-effect` do lint: o
    // efeito agenda, e não escreve estado no mesmo passo em que roda.
    const timer = setTimeout(() => {
      setMostrarCarregador(true);
      setJaIniciadas((anteriores) => new Set(anteriores).add(organizacaoId));
    }, 0);
    return () => clearTimeout(timer);
  }, [podeGerir, organizacaoId, jaIniciadas]);

  const encerrar = useCallback(() => setMostrarCarregador(false), []);

  return { mostrarCarregador, encerrar };
}
