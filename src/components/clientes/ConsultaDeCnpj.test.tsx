/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { EmpresaCompleta } from '@/lib/empresas/empresaContract';

import { ConsultaDeCnpj } from './ConsultaDeCnpj';

/**
 * Debounce e corrida com relógio falso: o teste controla quando o temporizador
 * dispara e em que ordem as respostas chegam.
 */

const A = '11222333000181';
const B = '33000167000101';
const empresa = (cnpj: string, razaoSocial: string): EmpresaCompleta => ({
  cnpj, razaoSocial, nomeFantasia: null, situacao: 'ATIVA', email: null, telefone: null, cep: null,
  logradouro: null, numero: null, bairro: null, municipio: null, uf: null,
});
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const encontrada = (cnpj: string, nome: string) => json({ resultado: 'EmpresaEncontrada', empresa: empresa(cnpj, nome) });

function pendente() {
  let soltar: (r: Response) => void = () => {};
  const promessa = new Promise<Response>((resolve) => { soltar = resolve; });
  return { promessa, soltar };
}

type Buscar = (url: string, opcoes?: RequestInit) => Promise<Response>;
const digitar = (valor: string) => fireEvent.change(screen.getByLabelText('Consultar CNPJ'), { target: { value: valor } });
const esperar = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ConsultaDeCnpj: só CNPJ, sem prometer o que não existe', () => {
  it('campo e ajuda falam de CNPJ; nada de "nome" ou "razão social"', () => {
    render(<ConsultaDeCnpj buscar={vi.fn()} onEmpresa={vi.fn()} />);
    const campo = screen.getByLabelText('Consultar CNPJ');
    expect(campo).toHaveAttribute('placeholder', '00.000.000/0000-00');
    expect(document.body.textContent).not.toMatch(/nome fantasia|razão social|buscar empresa/iu);
  });

  it('incompleto: nada é consultado; CNPJ inválido e letras têm aviso próprio, sem requisição', async () => {
    const buscar = vi.fn<Buscar>();
    render(<ConsultaDeCnpj buscar={buscar} onEmpresa={vi.fn()} />);
    digitar('11.222.333/0001-8');
    await esperar(2_000);
    digitar('11222333000180');
    await esperar(2_000);
    expect(screen.getByText('CNPJ inválido: confira os dígitos.')).toBeInTheDocument();
    digitar('11111111111111');
    await esperar(2_000);
    expect(screen.getByText('CNPJ inválido: confira os dígitos.')).toBeInTheDocument();
    digitar('padaria do joão');
    await esperar(2_000);
    expect(screen.getByText('A consulta é só por CNPJ: informe os 14 dígitos, com ou sem pontuação.')).toBeInTheDocument();
    expect(buscar).not.toHaveBeenCalled();
  });

  it('debounce: digitar rápido gera UMA consulta, 400 ms depois da última tecla', async () => {
    const buscar = vi.fn<Buscar>(async () => encontrada(A, 'A LTDA'));
    render(<ConsultaDeCnpj buscar={buscar} onEmpresa={vi.fn()} />);
    digitar(A);
    await esperar(200);
    digitar('11.222.333/0001-81');
    await esperar(399);
    expect(buscar).not.toHaveBeenCalled();
    await esperar(1);
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(buscar.mock.calls[0]![0]).toBe(`/api/empresas/cnpj/${A}`);
  });

  it('consulta A termina DEPOIS da B: só B preenche, e A foi abortada', async () => {
    const lenta = pendente();
    const buscar = vi.fn<Buscar>()
      .mockImplementationOnce(() => lenta.promessa)
      .mockImplementationOnce(async () => encontrada(B, 'B SA'));
    const onEmpresa = vi.fn();
    render(<ConsultaDeCnpj buscar={buscar} onEmpresa={onEmpresa} />);
    digitar(A);
    await esperar(400);
    digitar(B);
    await esperar(400);
    await act(async () => { lenta.soltar(encontrada(A, 'A LTDA')); });
    expect(onEmpresa).toHaveBeenCalledTimes(1);
    expect(onEmpresa.mock.calls[0]![0].cnpj).toBe(B);
    expect((buscar.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('apagar o CNPJ enquanto a consulta está no ar: a resposta é descartada', async () => {
    const lenta = pendente();
    const onEmpresa = vi.fn();
    render(<ConsultaDeCnpj buscar={() => lenta.promessa} onEmpresa={onEmpresa} />);
    digitar(A);
    await esperar(400);
    digitar('');
    await act(async () => { lenta.soltar(encontrada(A, 'A LTDA')); });
    expect(onEmpresa).not.toHaveBeenCalled();
  });

  it('fechar (desmontar) com a consulta no ar: cancela, e a resposta tardia não preenche nada', async () => {
    const lenta = pendente();
    const buscar = vi.fn<Buscar>(() => lenta.promessa);
    const onEmpresa = vi.fn();
    const { unmount } = render(<ConsultaDeCnpj buscar={buscar} onEmpresa={onEmpresa} />);
    digitar(A);
    await esperar(400);
    unmount();
    await act(async () => { lenta.soltar(encontrada(A, 'A LTDA')); });
    expect((buscar.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(onEmpresa).not.toHaveBeenCalled();
  });

  it('fechar antes do debounce: nenhuma requisição sai', async () => {
    const buscar = vi.fn<Buscar>();
    const { unmount } = render(<ConsultaDeCnpj buscar={buscar} onEmpresa={vi.fn()} />);
    digitar(A);
    unmount();
    await esperar(2_000);
    expect(buscar).not.toHaveBeenCalled();
  });

  it('a resposta usa o `onEmpresa` da renderização ATUAL, não o de quando a consulta começou', async () => {
    const lenta = pendente();
    const antigo = vi.fn();
    const atual = vi.fn();
    const { rerender } = render(<ConsultaDeCnpj buscar={() => lenta.promessa} onEmpresa={antigo} />);
    digitar(A);
    await esperar(400);
    rerender(<ConsultaDeCnpj buscar={() => lenta.promessa} onEmpresa={atual} />);
    await act(async () => { lenta.soltar(encontrada(A, 'A LTDA')); });
    expect(antigo).not.toHaveBeenCalled();
    expect(atual).toHaveBeenCalledTimes(1);
  });

  it('cada desfecho da rota tem mensagem própria, e nenhum preenche', async () => {
    const casos = [
      [json({ resultado: 'EmpresaNaoEncontrada' }, 404), 'CNPJ não encontrado na Receita Federal.'],
      [json({ resultado: 'LimiteDeConsultas' }, 429), 'Muitas consultas em pouco tempo. Aguarde um instante e tente de novo.'],
      [json({ resultado: 'ConsultaIndisponivel' }, 503), 'Não foi possível consultar o CNPJ agora. Você ainda pode preencher o cadastro manualmente.'],
      [json({ resultado: 'SemPermissao' }, 403), 'Sua conta não pode cadastrar contatos nesta organização, por isso a consulta não está disponível.'],
      [new Response('', { status: 200 }), 'Não foi possível consultar o CNPJ agora. Você ainda pode preencher o cadastro manualmente.'],
      [encontrada(B, 'OUTRA SA'), 'Não foi possível consultar o CNPJ agora. Você ainda pode preencher o cadastro manualmente.'],
    ] as const;
    for (const [resposta, mensagem] of casos) {
      const onEmpresa = vi.fn();
      const { unmount } = render(<ConsultaDeCnpj buscar={async () => resposta.clone()} onEmpresa={onEmpresa} />);
      digitar(A);
      await esperar(400);
      expect(screen.getByText(mensagem)).toBeInTheDocument();
      expect(onEmpresa).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('falha de rede: aviso, sem exceção escapando', async () => {
    render(<ConsultaDeCnpj buscar={async () => { throw new TypeError('Failed to fetch'); }} onEmpresa={vi.fn()} />);
    digitar(A);
    await esperar(400);
    expect(screen.getByText('Não foi possível consultar o CNPJ agora. Você ainda pode preencher o cadastro manualmente.')).toBeInTheDocument();
  });
});
