// @vitest-environment jsdom
/**
 * Revisão do #66 — a inicialização era global, e o papel só conhecia a sessão.
 *
 * Os dois defeitos se somavam. `hasStartedUp` era um booleano por visita: quem
 * inicializava em A e trocava para B nunca via a inicialização de B, porque o
 * estado de A continuava valendo. E, como o papel também não sabia de qual
 * organização era, o disparo podia acontecer com o papel errado.
 *
 * O registro passou a ser "já iniciou **onde**". Estes testes exercitam as duas
 * regras: só administra inicializa, e no máximo uma vez por organização
 * confirmada.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useStartupPorOrganizacao } from './useStartupPorOrganizacao';

interface Props {
  podeGerir: boolean;
  organizacaoId: string | null;
}

function renderizar(inicial: Props) {
  return renderHook(
    ({ podeGerir, organizacaoId }: Props) => useStartupPorOrganizacao(podeGerir, organizacaoId),
    { initialProps: inicial },
  );
}

describe('useStartupPorOrganizacao', () => {
  it('inicializa quem administra uma organização confirmada', async () => {
    const { result } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });

    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));
  });

  it('não inicializa o `member`', async () => {
    const { result } = renderizar({ podeGerir: false, organizacaoId: 'org-a' });

    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));
    // Espera de verdade: se fosse disparar, seria no próximo tique.
    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });

  // Sem confirmação do servidor não existe organização para inicializar. É o
  // que impede o disparo com o papel de outra organização, durante a troca.
  it('não inicializa enquanto a organização não está confirmada', async () => {
    const { result } = renderizar({ podeGerir: true, organizacaoId: null });

    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });

  it('não reabre a inicialização da mesma organização depois de encerrada', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    result.current.encerrar();
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));

    // Nova renderização com a mesma organização não é motivo para refazer o
    // trabalho: ele já foi feito nesta visita.
    rerender({ podeGerir: true, organizacaoId: 'org-a' });
    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });

  // O defeito, dito por extenso: A já inicializou, e B nunca inicializava.
  it('owner em A → owner em B: inicializa em B, mesmo já tendo inicializado em A', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    result.current.encerrar();
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));

    rerender({ podeGerir: true, organizacaoId: 'org-b' });

    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));
  });

  // Durante a troca o papel de A é invalidado antes de B responder, então a
  // sequência real passa por `(false, null)` — e nada dispara em B.
  it('owner em A → member em B: não inicializa em B', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    result.current.encerrar();
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));

    // A troca: papel invalidado, depois confirmado como `member` em B.
    rerender({ podeGerir: false, organizacaoId: null });
    rerender({ podeGerir: false, organizacaoId: 'org-b' });

    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });

  it('volta a inicializar A? Não: uma vez por organização, na mesma visita', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));
    result.current.encerrar();
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));

    rerender({ podeGerir: true, organizacaoId: 'org-b' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));
    result.current.encerrar();
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));

    rerender({ podeGerir: true, organizacaoId: 'org-a' });
    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });
});

/**
 * A corrida de verdade — revisão do head `2d1795a`.
 *
 * Os casos acima encerravam o carregador **antes** de trocar de organização, e
 * por isso nunca exercitaram o que acontece com uma inicialização **em curso**.
 * É essa a situação real: a pessoa troca de organização com o carregador de A
 * ainda na tela.
 */
describe('useStartupPorOrganizacao — troca com a inicialização em curso', () => {
  it('A → B com o carregador de A aberto: ele some no mesmo quadro', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    // Sem encerrar: a inicialização de A está em curso.
    rerender({ podeGerir: true, organizacaoId: 'org-b' });

    // Sem esperar coisa alguma: o carregador de A não fica sobre a tela de B.
    expect(result.current.mostrarCarregador).toBe(false);
  });

  it('A → B com o carregador de A aberto: B inicializa por conta própria', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    rerender({ podeGerir: true, organizacaoId: 'org-b' });

    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));
  });

  // O desfecho de A chega depois da troca. Fechar o carregador de B por causa
  // dele é a mesma classe de erro do papel: um resultado de outro contexto
  // decidindo a tela atual — e aqui ele ainda dispararia o que vem depois do
  // fechamento.
  it('o desfecho tardio de A não encerra o carregador de B', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    // Guarda o encerrar que A entregou, antes da troca.
    const encerrarDeA = result.current.encerrar;

    rerender({ podeGerir: true, organizacaoId: 'org-b' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    // A responde agora, com o encerrar que era dele.
    encerrarDeA();

    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(true);
  });

  it('perder a capacidade com o carregador aberto fecha na hora', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    // O papel foi revogado no servidor e a tela releu: mesma organização, sem
    // capacidade. O carregador de uma ação de gestão não pode continuar.
    rerender({ podeGerir: false, organizacaoId: 'org-a' });

    expect(result.current.mostrarCarregador).toBe(false);
  });

  // Durante a troca o papel é invalidado antes de a organização nova responder,
  // então a sequência real passa por `(false, null)`.
  it('a janela da troca, com o carregador aberto, não deixa nada na tela', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    rerender({ podeGerir: false, organizacaoId: null });
    expect(result.current.mostrarCarregador).toBe(false);

    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });

  // Interromper a inicialização de A trocando de organização não a marca como
  // "por fazer de novo": ela já disparou nesta visita.
  it('voltar para A depois de interromper não reabre o carregador de A', async () => {
    const { result, rerender } = renderizar({ podeGerir: true, organizacaoId: 'org-a' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));

    rerender({ podeGerir: true, organizacaoId: 'org-b' });
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(true));
    result.current.encerrar();
    await waitFor(() => expect(result.current.mostrarCarregador).toBe(false));

    rerender({ podeGerir: true, organizacaoId: 'org-a' });

    await new Promise((resolver) => setTimeout(resolver, 10));
    expect(result.current.mostrarCarregador).toBe(false);
  });
});
