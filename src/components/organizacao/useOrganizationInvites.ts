import { useCallback, useEffect, useRef, useState } from 'react';
import type { Convite, ConviteCriado, ResultadoDoAceite } from './types';
import type { AuthenticatedFetch } from './useOrganizationPanel';
import { chaveDaSelecao, daSelecao, useLeituraPorOrganizacao } from './useLeituraPorOrganizacao';
import type { SelecaoDeOrganizacao } from './usePapelNaOrganizacaoAtiva';

/** A frase que a tela mostra quando a leitura de convites falha sem detalhe útil. */
const FALHA_AO_LER = 'Não foi possível carregar os convites';

/**
 * Cria, lista e aceita convites de organização
 * (`/api/organizacoes/[id]/convites`, `/api/convites/aceitar`).
 *
 * ## O mesmo carimbo dos membros, e o código do convite
 *
 * A lista de convites segue a regra de `useOrganizationMembers`: a leitura é
 * carimbada pela organização (`useLeituraPorOrganizacao`), para que convites
 * de A nunca apareçam sob B, e uma leitura que falha lança em vez de dizer
 * "nenhum convite" — um convite pendente que some da lista é um convite que
 * ninguém revoga nem acompanha.
 *
 * **O convite é nominal e a entrega é manual, então o código volta para a
 * tela.** `POST .../convites` devolve `{ id, token }`, e sem o token a pessoa
 * que criou o convite não tem o que enviar (por WhatsApp, por exemplo).
 * `handleInvite` devolve o convite criado — e ele fica onde nasceu, no estado
 * de React de quem pediu: nunca em `localStorage`, nunca em log.
 *
 * ## As ações também carregam de quem são
 *
 * Não basta carimbar as leituras: um convite criado em A cuja resposta só
 * chegasse depois da troca publicaria, sob B, um token que pertence a A. Cada
 * estado de ação tem o escopo que lhe cabe:
 *
 * - **criação** — carimbada pela seleção (organização e versão). O erro só vale
 *   na seleção que o produziu, e a resposta que chega fora dela é descartada;
 * - **`criacaoEmVoo`** — o token é irrecuperável, então descartá-lo em silêncio
 *   seria perder um convite que o servidor de fato criou. Enquanto a criação
 *   está em voo a tela **impede a troca de organização**, e a resposta não tem
 *   como chegar sob outro contexto. É a solução mínima que satisfaz as duas
 *   metades: nunca aparecer como do tenant novo, nunca sumir;
 * - **aceite** — carimbado pela **sessão**, e não pela organização. Quem aceita
 *   um convite pode não ter organização nenhuma (é o caso principal); carimbar
 *   por seleção deixaria o erro invisível justamente aí. O que ele não pode
 *   atravessar é a troca de identidade.
 *
 * @param selecao - A organização ativa confirmada e a versão que a selecionou.
 * @param sessao - Quem está logado (o e-mail serve), ou `null` sem sessão.
 * @param onAccepted - Chamado depois de um aceite bem-sucedido, para que o
 *   contexto canônico e a lista de organizações sejam relidos do servidor.
 */
export function useOrganizationInvites(
  fetchWithAuth: AuthenticatedFetch,
  selecao: SelecaoDeOrganizacao | null,
  sessao: string | null,
  onAccepted: () => void,
) {
  const [erroDeAcao, setErroDeAcao] = useState<{ chave: string; valor: string } | null>(null);
  const [erroDeAceite, setErroDeAceite] = useState<{ chave: string; valor: string } | null>(null);
  const [criacaoEmVoo, setCriacaoEmVoo] = useState(false);

  const chave = chaveDaSelecao(selecao);
  // A referência é o que a resposta consulta para saber se ainda pode gravar.
  // Ela é atualizada em efeito, e não durante o render, pelo mesmo motivo de
  // `useOrganizationsList`: escrever ref no render é escrever fora do momento em
  // que o React garante ordem. As respostas chegam bem depois dos efeitos.
  const chaveAtualRef = useRef(chave);
  useEffect(() => { chaveAtualRef.current = chave; }, [chave]);

  const sessaoAtualRef = useRef(sessao);
  useEffect(() => { sessaoAtualRef.current = sessao; }, [sessao]);

  const ler = useCallback(
    async (organizacaoId: string): Promise<readonly Convite[]> => {
      const response = await fetchWithAuth(`/api/organizacoes/${organizacaoId}/convites`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? FALHA_AO_LER);
      return body?.convites ?? [];
    },
    [fetchWithAuth],
  );

  const { dados, carregando, erro, recarregar } = useLeituraPorOrganizacao(selecao, ler, FALHA_AO_LER);

  /**
   * Cria o convite e devolve o código para a tela mostrar.
   *
   * @returns O convite criado, ou `null` se a criação falhou — aí a falha está
   *   em `erroDeAcao`.
   */
  const handleInvite = useCallback(
    async (email: string, papel: 'admin' | 'member'): Promise<ConviteCriado | null> => {
      if (selecao === null) return null;
      const daAcao = `${selecao.id}:${selecao.versao}`;
      setErroDeAcao(null);
      setCriacaoEmVoo(true);
      try {
        const response = await fetchWithAuth(`/api/organizacoes/${selecao.id}/convites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, papel }),
        });
        const body = await response.json().catch(() => null);

        // A troca de organização fica bloqueada enquanto isto está em voo, então
        // esta guarda não deveria disparar. Ela existe porque "não deveria" não
        // é uma garantia: se algum caminho futuro soltar o bloqueio, o token de
        // A não pode ser apresentado sob B — some, e o convite continua na lista
        // de A, que é onde ele está.
        if (chaveAtualRef.current !== daAcao) return null;

        if (!response.ok) {
          setErroDeAcao({ chave: daAcao, valor: body?.error ?? 'Falha ao criar convite' });
          return null;
        }
        await recarregar();
        const criado = body?.convite;
        if (typeof criado?.token !== 'string' || typeof criado?.id !== 'string') {
          // O convite existe no servidor, mas sem o código não há o que
          // entregar. Dizer "criado com sucesso" mandaria a pessoa procurar um
          // código que a tela não tem.
          setErroDeAcao({
            chave: daAcao,
            valor: 'O convite foi criado, mas o código não voltou. Recarregue e verifique a lista.',
          });
          return null;
        }
        return { id: criado.id, token: criado.token, email, papel, organizacaoId: selecao.id };
      } finally {
        setCriacaoEmVoo(false);
      }
    },
    [fetchWithAuth, recarregar, selecao],
  );

  const handleAcceptInvite = useCallback(
    async (token: string): Promise<ResultadoDoAceite> => {
      if (sessao === null) return { aceito: false };
      setErroDeAceite(null);
      const response = await fetchWithAuth('/api/convites/aceitar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await response.json().catch(() => null);

      // A resposta de um aceite feito por outra identidade não vale para esta.
      if (sessaoAtualRef.current !== sessao) return { aceito: false };

      if (!response.ok) {
        setErroDeAceite({ chave: sessao, valor: body?.error ?? 'Falha ao aceitar convite' });
        return { aceito: false };
      }
      // O convite foi consumido. Recarregar é sempre certo: mesmo no caso em
      // que o servidor não conseguiu resolver o contexto, a organização nova
      // está entre as do usuário, e é assim que a tela a encontra.
      onAccepted();
      return {
        aceito: true,
        contexto: body?.contexto === 'nao_resolvido' || body?.contexto === 'selecao_anterior_preservada'
          ? body.contexto
          : 'organizacao_ativada',
        aviso: typeof body?.aviso === 'string' ? body.aviso : undefined,
      };
    },
    [fetchWithAuth, onAccepted, sessao],
  );

  return {
    convites: dados,
    carregando,
    erroDeLeitura: erro,
    erroDeAcao: daSelecao(chave, erroDeAcao),
    erroDeAceite: daSelecao(sessao, erroDeAceite),
    criacaoEmVoo,
    recarregar,
    handleInvite,
    handleAcceptInvite,
  };
}
