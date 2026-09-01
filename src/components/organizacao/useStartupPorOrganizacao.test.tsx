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
