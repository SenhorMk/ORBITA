/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Rail, type TabType } from './Rail';

const SESSAO = { email: 'operadora@exemplo.com', name: 'Operadora Orbita' };

/** Os oito destinos que a banca percorre, na ordem do rail. */
const DESTINOS_APRESENTADOS: ReadonlyArray<{ rotulo: string; aba: TabType }> = [
  { rotulo: 'Visão Geral', aba: 'dashboard' },
  { rotulo: 'Vendas & Pedidos', aba: 'sales' },
  { rotulo: 'Estoque & Produtos', aba: 'inventory' },
  { rotulo: 'Clientes & Contatos', aba: 'contacts' },
  { rotulo: 'Controle Financeiro', aba: 'finance' },
  { rotulo: 'SAC / Atendimento', aba: 'sac' },
  { rotulo: 'Organização & Membros', aba: 'organization' },
  { rotulo: 'Integrações (Bling / Chatwoot)', aba: 'integrations' },
];

function montar(activeTab: TabType = 'dashboard') {
  const setActiveTab = vi.fn();
  render(
    <Rail activeTab={activeTab} setActiveTab={setActiveTab} session={SESSAO} onLogout={vi.fn()} />,
  );
  return { setActiveTab };
}

describe('Rail', () => {
  it('apresenta os oito destinos da jornada, cada um com o nome acessível pelo qual a jornada o encontra', () => {
    montar();

    for (const { rotulo } of DESTINOS_APRESENTADOS) {
      expect(screen.getByRole('button', { name: rotulo })).toBeTruthy();
    }
  });

  it('não apresenta Plano & Faturamento como destino', () => {
    montar();

    // Ticket 09: o destino sai da navegação **apresentada**, e só dela. O
    // `TabType` continua tendo `billing`, o painel continua montado no shell, e
    // Stripe/assinatura/entitlement seguem intactos — nada aqui remove
    // autorização de ninguém. Se algum dia o plano voltar a ser demonstrado,
    // tire `billing` de `DESTINOS_NAO_APRESENTADOS` e este teste é o que avisa.
    expect(screen.queryByRole('button', { name: 'Plano & Faturamento' })).toBeNull();
  });

  it('cada destino apresentado leva à sua própria aba', async () => {
    const usuaria = userEvent.setup();
    const { setActiveTab } = montar();

    for (const { rotulo, aba } of DESTINOS_APRESENTADOS) {
      await usuaria.click(screen.getByRole('button', { name: rotulo }));
      expect(setActiveTab).toHaveBeenCalledWith(aba);
    }
  });

  it('o botão de sair chama-se "Sair da conta" — o nome que os Page Objects procuram', () => {
    montar();

    // Não é preciosismo de rótulo: é o sinal de "entrou" de toda a suíte E2E.
    // Enquanto os Page Objects procuravam "Sair da sessão", que a interface não
    // usa desde o Ticket 01, nenhum login desta suíte conseguia se confirmar.
    expect(screen.getByRole('button', { name: 'Sair da conta' })).toBeTruthy();
  });

  it('marca como página atual apenas o destino ativo', () => {
    montar('sales');

    expect(screen.getByRole('button', { name: 'Vendas & Pedidos' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Visão Geral' }).getAttribute('aria-current')).toBeNull();
  });
});
