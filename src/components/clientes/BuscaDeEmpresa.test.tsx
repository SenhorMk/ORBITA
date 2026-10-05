/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { BuscaDeEmpresa } from './BuscaDeEmpresa';

/**
 * Debounce e corrida: com relógio falso, o teste controla quando o
 * temporizador dispara e em que ordem as respostas chegam.
 */

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const resumo = (nome: string, cnpj = '11222333000181', fantasia: string | null = null) => ({
  cnpj, razaoSocial: nome, nomeFantasia: fantasia, municipio: 'PONTA GROSSA', uf: 'PR', situacao: 'ATIVA',
});

function pendente() {
  let soltar: (r: Response) => void = () => {};
  const promessa = new Promise<Response>((resolve) => { soltar = resolve; });
  return { promessa, soltar };
}

const digitar = (valor: string) => fireEvent.change(screen.getByLabelText('Buscar empresa'), { target: { value: valor } });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('BuscaDeEmpresa', () => {
  it('menos de 3 caracteres: não consulta e pede mais', () => {
    const buscar = vi.fn();
    render(<BuscaDeEmpresa buscar={buscar} onEmpresa={vi.fn()} />);
    digitar('ab');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(buscar).not.toHaveBeenCalled();
    expect(screen.getByText('Digite ao menos 3 caracteres.')).toBeInTheDocument();
  });

  it('debounce: digitar rápido gera UMA consulta, 400 ms depois da última tecla', async () => {
    const buscar = vi.fn<(url: string, opcoes?: RequestInit) => Promise<Response>>(async () => json({ resultado: 'Empresas', empresas: [] }));
    render(<BuscaDeEmpresa buscar={buscar} onEmpresa={vi.fn()} />);
    digitar('pad');
    act(() => { vi.advanceTimersByTime(200); });
    digitar('padar');
    act(() => { vi.advanceTimersByTime(200); });
    digitar('padaria');
    act(() => { vi.advanceTimersByTime(399); });
    expect(buscar).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(buscar.mock.calls[0]![0]).toBe('/api/empresas/busca?termo=padaria');
  });

  it('resposta antiga que chega depois não substitui a busca mais nova', async () => {
    const antiga = pendente();
    const buscar = vi.fn()
      .mockImplementationOnce(() => antiga.promessa)
      .mockImplementationOnce(async () => json({ resultado: 'Empresas', empresas: [resumo('NOVA LTDA')] }));
    render(<BuscaDeEmpresa buscar={buscar} onEmpresa={vi.fn()} />);
    digitar('antiga');
    await act(async () => { vi.advanceTimersByTime(400); });
    digitar('nova');
    await act(async () => { vi.advanceTimersByTime(400); });
    await act(async () => { antiga.soltar(json({ resultado: 'Empresas', empresas: [resumo('ANTIGA LTDA')] })); });
    expect(screen.getByText('NOVA LTDA')).toBeInTheDocument();
    expect(screen.queryByText('ANTIGA LTDA')).toBeNull();
    // A requisição antiga também foi abortada.
    expect((buscar.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('sugestão: nome fantasia como título, razão social abaixo, CNPJ • cidade/UF • situação', async () => {
    const buscar = vi.fn(async () => json({ resultado: 'Empresas', empresas: [resumo('Empresa Exemplo LTDA', '11222333000181', 'EMPRESA EXEMPLO')] }));
    render(<BuscaDeEmpresa buscar={buscar} onEmpresa={vi.fn()} />);
    digitar('exemplo');
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('EMPRESA EXEMPLO')).toBeInTheDocument();
    expect(screen.getByText('Empresa Exemplo LTDA')).toBeInTheDocument();
    expect(screen.getByText('11.222.333/0001-81 • PONTA GROSSA/PR • ATIVA')).toBeInTheDocument();
  });

  it('nenhum resultado, provedor indisponível e busca por nome sem provedor têm mensagens próprias', async () => {
    const casos = [
      [{ resultado: 'Empresas', empresas: [] }, 'Nenhuma empresa encontrada.'],
      [{ resultado: 'BuscaIndisponivel' }, 'Não foi possível pesquisar empresas agora. Você ainda pode preencher o cadastro manualmente ou informar o CNPJ.'],
      [{ resultado: 'BuscaPorNomeIndisponivel' }, 'A busca por nome não está disponível. Informe o CNPJ para preencher os dados, ou preencha o cadastro manualmente.'],
    ] as const;
    for (const [corpo, mensagem] of casos) {
      const { unmount } = render(<BuscaDeEmpresa buscar={async () => json(corpo)} onEmpresa={vi.fn()} />);
      digitar('padaria');
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(screen.getByText(mensagem)).toBeInTheDocument();
      unmount();
    }
  });

  it('escolher uma sugestão dispara a consulta COMPLETA por CNPJ, e só ela vai para o formulário', async () => {
    const completa = { ...resumo('EMPRESA EXEMPLO LTDA'), email: 'a@b.com', telefone: null, cep: null, logradouro: null, numero: null, bairro: null };
    const buscar = vi.fn(async (url: string) => (url.startsWith('/api/empresas/busca')
      ? json({ resultado: 'Empresas', empresas: [resumo('EMPRESA EXEMPLO LTDA')] })
      : json({ resultado: 'EmpresaEncontrada', empresa: completa })));
    const onEmpresa = vi.fn();
    render(<BuscaDeEmpresa buscar={buscar} onEmpresa={onEmpresa} />);
    digitar('exemplo');
    await act(async () => { vi.advanceTimersByTime(400); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /EMPRESA EXEMPLO LTDA/u })); });
    expect(buscar.mock.calls.map((c) => c[0])).toEqual(['/api/empresas/busca?termo=exemplo', '/api/empresas/cnpj/11222333000181']);
    expect(onEmpresa).toHaveBeenCalledWith(completa);
  });

  it('CNPJ digitado: consulta direta, sem passar pela busca por nome', async () => {
    const buscar = vi.fn<(url: string, opcoes?: RequestInit) => Promise<Response>>(async () => json({ resultado: 'EmpresaNaoEncontrada' }, 404));
    render(<BuscaDeEmpresa buscar={buscar} onEmpresa={vi.fn()} />);
    digitar('11.222.333/0001-81');
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(buscar.mock.calls.map((c) => c[0])).toEqual(['/api/empresas/cnpj/11222333000181']);
    expect(screen.getByText('CNPJ não encontrado na Receita Federal.')).toBeInTheDocument();
  });
});
