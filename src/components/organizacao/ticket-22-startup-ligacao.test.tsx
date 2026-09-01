// @vitest-environment jsdom
/**
 * Ticket 22 — a **ligação** entre o hook de inicialização e o carregador.
 *
 * Revisão do head `d5a17c0`. `useStartupPorOrganizacao` garante que o carregador
 * **abre** uma vez por organização, e os testes dele provam isso. Nenhum deles
 * dizia nada sobre quantas vezes o `POST /api/startup` sai — que é outra
 * pergunta, e a que importa para o servidor.
 *
 * E a resposta era: quantas o pai quisesse. `onComplete` chegava como função
 * inline de `page.tsx` e estava nas dependências do efeito do `StartupLoader`;
 * toda re-renderização da página criava outra identidade, o efeito reexecutava,
 * e saía mais uma requisição com o carregador já na tela.
 *
 * É a família 1 de novo, e no lugar mais fácil de não olhar: as duas metades
 * estavam certas sozinhas — o hook abre uma vez, o carregador executa quando
 * fica visível —, e a ligação entre elas é que estava errada. Por isso este
 * arquivo monta as duas como `page.tsx` as monta, e conta requisições.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { StartupLoader } from '@/components/StartupLoader';
import { useStartupPorOrganizacao } from './useStartupPorOrganizacao';

afterEach(() => vi.restoreAllMocks());

/** Uma resposta que o teste solta quando quiser. */
function respostaControlada() {
  let soltar: (corpo: unknown) => void = () => {};
  const promessa = new Promise<Response>((resolver) => {
    soltar = (corpo) => resolver({ ok: true, status: 200, json: async () => corpo } as Response);
  });
  return { promessa, soltar: (corpo: unknown) => soltar(corpo) };
}

interface PropsDaPagina {
  readonly podeGerir: boolean;
  readonly organizacaoId: string | null;
  readonly fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  readonly aoConcluir: (organizacaoId: string | null) => void;
}

/**
 * A mesma fiação de `page.tsx`, reduzida ao que importa aqui — e **com os
 * desfechos inline**, que é como a página os passava quando o defeito existia.
 *
 * Passar inline é deliberado, e é o coração deste arquivo. `page.tsx` também
 * passou a estabilizá-los com `useCallback`, e isso é higiene: evita
 * re-renderizar o carregador à toa. Mas se o teste dependesse dessa disciplina
 * do pai, ele não provaria nada sobre o carregador — bastaria alguém voltar a
 * escrever uma função inline, num outro lugar ou num outro dia, para o defeito
 * voltar calado.
 *
 * A propriedade que precisa valer é do componente: **a identidade dos desfechos
 * não é motivo para executar a inicialização de novo.** É ela que estes casos
 * cobram.
 *
 * O botão de ruído provoca re-renderização por estado que nada tem a ver com a
 * inicialização, que é o gatilho real.
 */
function Pagina({ podeGerir, organizacaoId, fetchWithAuth, aoConcluir }: PropsDaPagina) {
  const { mostrarCarregador, encerrar } = useStartupPorOrganizacao(podeGerir, organizacaoId);
  const [ruido, setRuido] = useState(0);

  return (
    <div>
      <button type="button" onClick={() => setRuido((anterior) => anterior + 1)}>
        ruído {ruido}
      </button>
      <StartupLoader
        key={organizacaoId ?? 'sem-organizacao'}
        isVisible={mostrarCarregador}
        onComplete={() => {
          encerrar();
          aoConcluir(organizacaoId);
        }}
        onNeedsAuth={() => {
          encerrar();
        }}
        fetchWithAuth={fetchWithAuth}
      />
    </div>
  );
}

function chamadasDeStartup(espia: ReturnType<typeof vi.fn>): number {
  return espia.mock.calls.filter(([url]) => url === '/api/startup').length;
}

describe('a inicialização sai uma vez por organização — e uma vez só', () => {
  it('re-renderizar o pai com o carregador aberto não dispara outra requisição', async () => {
    const emVooA = respostaControlada();
    const buscar = vi.fn().mockReturnValue(emVooA.promessa);
    const aoConcluir = vi.fn();

    render(
      <Pagina podeGerir organizacaoId="org-a" fetchWithAuth={buscar} aoConcluir={aoConcluir} />,
    );
    await waitFor(() => expect(chamadasDeStartup(buscar)).toBe(1));

    // A requisição de A segue pendente, e o pai re-renderiza três vezes por
    // estado que não tem nada a ver com a inicialização.
    const ruido = screen.getByRole('button', { name: /ruído/i });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        ruido.click();
      });
    }

    expect(chamadasDeStartup(buscar)).toBe(1);
  });

  // O encadeamento inteiro: A pendente, troca para B, e A responde depois.
  it('a resposta tardia de A não conclui nada, e B inicializa exatamente uma vez', async () => {
    const emVooA = respostaControlada();
    const buscar = vi.fn().mockReturnValue(emVooA.promessa);
    const aoConcluir = vi.fn();

    const { rerender } = render(
      <Pagina podeGerir organizacaoId="org-a" fetchWithAuth={buscar} aoConcluir={aoConcluir} />,
    );
    await waitFor(() => expect(chamadasDeStartup(buscar)).toBe(1));

    // A troca: o papel é invalidado antes de B responder, como no fluxo real.
    const emVooB = respostaControlada();
    buscar.mockReturnValue(emVooB.promessa);
    rerender(
      <Pagina podeGerir={false} organizacaoId={null} fetchWithAuth={buscar} aoConcluir={aoConcluir} />,
    );
    rerender(
      <Pagina podeGerir organizacaoId="org-b" fetchWithAuth={buscar} aoConcluir={aoConcluir} />,
    );
    await waitFor(() => expect(chamadasDeStartup(buscar)).toBe(2));

    // Agora A responde, com sucesso, atrasada.
    await act(async () => {
      emVooA.soltar({ success: true });
      await Promise.resolve();
    });

    // Nada de A é aplicado: nem o desfecho, nem o recarregamento do painel.
    expect(aoConcluir).not.toHaveBeenCalled();
    // E B não ganhou requisição extra por causa disso.
    expect(chamadasDeStartup(buscar)).toBe(2);

    // B conclui por conta própria, e é o único que conclui.
    await act(async () => {
      emVooB.soltar({ success: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(aoConcluir).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(aoConcluir).toHaveBeenCalledWith('org-b');
    expect(chamadasDeStartup(buscar)).toBe(2);
  });

  it('o `member` não dispara requisição nenhuma', async () => {
    const buscar = vi.fn().mockReturnValue(respostaControlada().promessa);

    render(
      <Pagina podeGerir={false} organizacaoId="org-a" fetchWithAuth={buscar} aoConcluir={vi.fn()} />,
    );

    await new Promise((resolver) => setTimeout(resolver, 20));
    expect(chamadasDeStartup(buscar)).toBe(0);
  });
});
