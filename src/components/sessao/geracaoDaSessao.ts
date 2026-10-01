'use client';

import { useCallback, useState } from 'react';

/**
 * A **instância** da sessão na tela, e não só a identidade.
 *
 * Sair e entrar de novo com a mesma conta produz o mesmo e-mail, a mesma
 * organização e — como a versão da seleção vem do servidor — a mesma versão.
 * Um carimbo feito só disso não distingue a sessão nova da anterior, e o que
 * foi aberto antes do logout voltaria a valer depois do login.
 *
 * A geração é um contador em memória que avança **na própria escrita** da
 * sessão, por atualização funcional: toda entrada (ausente → presente), toda
 * saída (presente → ausente) e toda troca de conta. Não depende de algum
 * render observar a transição — logout e login no mesmo lote avançam duas
 * vezes. Revalidar a MESMA sessão (restauração no carregamento, renovação do
 * token) não avança: não é uma instância nova.
 *
 * Não carrega token nem vai ao servidor; é só o que torna inelegível, em
 * memória, tudo o que foi carimbado por uma sessão anterior.
 */
export function mudouDeInstancia(
  anterior: { readonly email: string } | null,
  nova: { readonly email: string } | null,
): boolean {
  if (anterior === null || nova === null) return anterior !== nova;
  return anterior.email !== nova.email;
}

export function useSessaoComGeracao<T extends { readonly email: string }>(inicial: () => T | null) {
  const [estado, setEstado] = useState(() => ({ sessao: inicial(), geracao: 0 }));

  const definirSessao = useCallback((nova: T | null) => {
    setEstado((anterior) => ({
      sessao: nova,
      geracao: anterior.geracao + (mudouDeInstancia(anterior.sessao, nova) ? 1 : 0),
    }));
  }, []);

  return { sessao: estado.sessao, geracao: estado.geracao, definirSessao };
}

/**
 * O carimbo das leituras da tela: instância da sessão, identidade e seleção de
 * organização com a versão. `null` sem sessão — aí não se lê nada.
 *
 * Uma função só, usada pela página e pelos testes, para que o carimbo testado
 * seja o carimbo da tela.
 */
export function escopoDaLeitura(
  sessao: { readonly geracao: number; readonly identidade: string | null },
  selecao: { readonly id: string; readonly versao: number | string } | null,
): string | null {
  if (sessao.identidade === null) return null;
  const organizacao = selecao ? `${selecao.id}:${selecao.versao}` : 'sem-organizacao';
  return `${sessao.identidade}|sessao-${sessao.geracao}|${organizacao}`;
}
