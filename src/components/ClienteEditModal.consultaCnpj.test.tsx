/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Cliente } from '@/types';

import { ClienteEditModal } from './ClienteEditModal';

/**
 * Consultar CNPJ no cadastro de contato: só preenche. Nada é salvo nem vai ao
 * Bling até "Salvar contato", pelo fluxo de sempre (`POST /api/clientes/update`).
 * E o tipo de contribuinte nunca é deduzido do documento.
 */

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

const json = (corpo: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response;

const CNPJ_A = '11222333000181';
const CNPJ_B = '33000167000101';
const EMPRESA = {
  cnpj: CNPJ_A, razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
  email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV', numero: '100',
  bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
};

/** Rede falsa. `consulta` permite segurar a resposta da consulta para testar corrida. */
function rede(consulta: () => Promise<Response> = async () => json({ resultado: 'EmpresaEncontrada', empresa: EMPRESA })) {
  const chamadas: Array<{ url: string; metodo: string; corpo: Record<string, unknown> | null }> = [];
  fetchWithAuthMock.mockImplementation(async (url: string, opcoes: RequestInit = {}) => {
    chamadas.push({ url, metodo: opcoes.method ?? 'GET', corpo: typeof opcoes.body === 'string' ? JSON.parse(opcoes.body) : null });
    if (url.startsWith('/api/empresas/cnpj/')) return consulta();
    if (url === '/api/clientes/update') return json({ success: true, client: { id: 'c1', nome: 'x' } });
    throw new Error(`Requisição não prevista: ${url}`);
  });
  const gravacoes = () => chamadas.filter((c) => c.metodo !== 'GET');
  return { chamadas, gravacoes };
}

const campo = (rotulo: string) => screen.getByLabelText(rotulo) as HTMLInputElement | HTMLSelectElement;
const valores = () => ({
  nome: campo('Nome / Razão social *').value, cpfCnpj: campo('CPF / CNPJ').value, email: campo('E-mail').value,
  telefone: campo('Telefone / Celular').value, cep: campo('CEP').value, endereco: campo('Endereço / Rua').value,
  numero: campo('Número').value, bairro: campo('Bairro').value, cidade: campo('Cidade').value, uf: campo('UF').value,
  tipo: campo('Tipo de pessoa *').value, contribuinte: campo('Tipo de contribuinte *').value,
});
const salvar = (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: 'Salvar contato' }));
async function consultar(u: ReturnType<typeof userEvent.setup>, cnpj = CNPJ_A) {
  await u.type(campo('Consultar CNPJ'), cnpj);
  return screen.findByText('Dados encontrados. Confira antes de salvar.');
}

beforeEach(() => { fetchWithAuthMock.mockReset(); });

describe('ClienteEditModal: consulta por CNPJ', () => {
  it('aparece no cadastro novo, como CNPJ; não aparece na edição de um contato existente', () => {
    rede();
    const { unmount } = render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    expect(campo('Consultar CNPJ')).toHaveAttribute('placeholder', '00.000.000/0000-00');
    expect(screen.queryByLabelText('Buscar empresa')).toBeNull();
    unmount();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={{ id: 'c1', bling_id: '9', nome: 'Ana' } as Cliente} />);
    expect(screen.queryByLabelText('Consultar CNPJ')).toBeNull();
  });

  it('preenche cada campo, tipo = J, contribuinte continua SEM escolha, e nada é gravado', async () => {
    const { chamadas, gravacoes } = rede();
    const onSave = vi.fn();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={onSave} />);
    await consultar(u);
    expect(valores()).toEqual({
      nome: 'EMPRESA EXEMPLO LTDA', cpfCnpj: '11.222.333/0001-81', email: 'contato@exemplo.com.br', telefone: '4232220000',
      cep: '84010000', endereco: 'RUA XV', numero: '100', bairro: 'CENTRO', cidade: 'PONTA GROSSA', uf: 'PR',
      tipo: 'J', contribuinte: '',
    });
    expect(screen.getByText('Empresa consultada: EMPRESA EXEMPLO LTDA (CNPJ 11.222.333/0001-81).')).toBeInTheDocument();
    expect(screen.getByText('Confira o tipo de contribuinte: o CNPJ não indica se a empresa é contribuinte de ICMS.')).toBeInTheDocument();
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([`GET /api/empresas/cnpj/${CNPJ_A}`]);
    expect(gravacoes()).toEqual([]);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('salvar exige escolher o contribuinte; depois grava UMA vez, com a escolha da pessoa', async () => {
    const { gravacoes } = rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={vi.fn()} />);
    await consultar(u);
    await salvar(u);
    expect(screen.getByText('Selecione o tipo de contribuinte')).toBeInTheDocument();
    expect(gravacoes()).toEqual([]);
    await u.selectOptions(campo('Tipo de contribuinte *'), '9');
    await u.clear(campo('Número'));
    await u.type(campo('Número'), '250');
    await salvar(u);
    await waitFor(() => expect(gravacoes()).toHaveLength(1));
    expect(gravacoes()[0]!.url).toBe('/api/clientes/update');
    expect(gravacoes()[0]!.corpo).toMatchObject({ nome: 'EMPRESA EXEMPLO LTDA', cpfCnpj: '11.222.333/0001-81', numero: '250', tipo: 'J', indicadorIe: 9 });
  });

  it('o nome fantasia só vira o nome por decisão explícita', async () => {
    rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await consultar(u);
    expect(valores().nome).toBe('EMPRESA EXEMPLO LTDA');
    await u.click(screen.getByRole('button', { name: 'Usar nome fantasia como nome' }));
    expect(valores().nome).toBe('EMPRESA EXEMPLO');
  });

  it('o que a pessoa já tinha digitado fica, e a tela diz quais campos', async () => {
    rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.type(campo('E-mail'), 'compras@cliente.com');
    await u.type(campo('Nome / Razão social *'), 'Loja da Esquina');
    await consultar(u);
    expect(screen.getByText('Mantidos os campos que você já tinha preenchido: Nome, E-mail.')).toBeInTheDocument();
    expect(valores()).toMatchObject({ nome: 'Loja da Esquina', email: 'compras@cliente.com', telefone: '4232220000' });
  });

  it('CNPJ de OUTRA empresa digitado antes: o consultado assume, e a troca é dita', async () => {
    rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.type(campo('CPF / CNPJ'), '33.000.167/0001-01');
    await consultar(u);
    expect(valores().cpfCnpj).toBe('11.222.333/0001-81');
    expect(screen.getByText('O documento que você tinha informado (33.000.167/0001-01) foi substituído pelo CNPJ consultado.')).toBeInTheDocument();
  });

  it('CNPJ trocado à mão depois de preencher: alerta, salvar bloqueado; "Descartar consulta" libera com o que a pessoa assumiu', async () => {
    const { gravacoes } = rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={vi.fn()} />);
    await consultar(u);
    await u.selectOptions(campo('Tipo de contribuinte *'), '1');
    await u.clear(campo('CPF / CNPJ'));
    await u.type(campo('CPF / CNPJ'), CNPJ_B);
    expect(screen.getByRole('alert')).toHaveTextContent('O CPF/CNPJ do formulário não é mais o da empresa consultada.');
    await salvar(u);
    expect(screen.getByText('O documento não é o da empresa consultada. Corrija o CPF/CNPJ ou descarte a consulta.')).toBeInTheDocument();
    expect(gravacoes()).toEqual([]);

    await u.click(screen.getByRole('button', { name: 'Descartar consulta' }));
    expect(screen.queryByText('Dados encontrados. Confira antes de salvar.')).toBeNull();
    await salvar(u);
    await waitFor(() => expect(gravacoes()).toHaveLength(1));
    expect(gravacoes()[0]!.corpo).toMatchObject({ cpfCnpj: CNPJ_B, indicadorIe: 1 });
  });

  it('voltar o CNPJ ao da empresa consultada desfaz o bloqueio', async () => {
    const { gravacoes } = rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={vi.fn()} />);
    await consultar(u);
    await u.selectOptions(campo('Tipo de contribuinte *'), '9');
    await u.clear(campo('CPF / CNPJ'));
    await u.type(campo('CPF / CNPJ'), '123');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await u.clear(campo('CPF / CNPJ'));
    await u.type(campo('CPF / CNPJ'), CNPJ_A);
    expect(screen.queryByRole('alert')).toBeNull();
    await salvar(u);
    await waitFor(() => expect(gravacoes()).toHaveLength(1));
  });

  it('o que a pessoa digita enquanto a consulta está no ar é dela: não é sobrescrito', async () => {
    let soltar: (r: Response) => void = () => {};
    rede(() => new Promise<Response>((resolve) => { soltar = resolve; }));
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.type(campo('Consultar CNPJ'), CNPJ_A);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await u.type(campo('E-mail'), 'digitado@durante.com');
    await act(async () => { soltar(json({ resultado: 'EmpresaEncontrada', empresa: EMPRESA })); });
    await screen.findByText('Dados encontrados. Confira antes de salvar.');
    expect(valores().email).toBe('digitado@durante.com');
    expect(screen.getByText('Mantidos os campos que você já tinha preenchido: E-mail.')).toBeInTheDocument();
  });

  it('fechar o modal com a consulta no ar: ao reabrir, a resposta tardia não preenche nada', async () => {
    let soltar: (r: Response) => void = () => {};
    rede(() => new Promise<Response>((resolve) => { soltar = resolve; }));
    const u = userEvent.setup();
    const { rerender } = render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.type(campo('Consultar CNPJ'), CNPJ_A);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    rerender(<ClienteEditModal isOpen={false} onClose={vi.fn()} cliente={null} />);
    rerender(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await act(async () => { soltar(json({ resultado: 'EmpresaEncontrada', empresa: EMPRESA })); });
    expect(valores().nome).toBe('');
    expect(screen.queryByText('Dados encontrados. Confira antes de salvar.')).toBeNull();
  });

  it('consulta indisponível não impede o cadastro manual', async () => {
    const { gravacoes } = rede(async () => json({ resultado: 'ConsultaIndisponivel' }, 503));
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={vi.fn()} />);
    await u.type(campo('Consultar CNPJ'), CNPJ_A);
    expect(await screen.findByText(/Não foi possível consultar o CNPJ agora/u)).toBeInTheDocument();
    await u.type(campo('Nome / Razão social *'), 'Padaria do Bairro');
    await u.selectOptions(campo('Tipo de pessoa *'), 'J');
    await u.selectOptions(campo('Tipo de contribuinte *'), '9');
    await salvar(u);
    await waitFor(() => expect(gravacoes()).toHaveLength(1));
    expect(gravacoes()[0]!.corpo).toMatchObject({ nome: 'Padaria do Bairro', tipo: 'J', indicadorIe: 9 });
  });
});

describe('ClienteEditModal: CNPJ não define contribuinte de ICMS', () => {
  it('digitar um CNPJ válido muda o tipo para J, mas NÃO toca no contribuinte já escolhido', async () => {
    rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.selectOptions(campo('Tipo de contribuinte *'), '2');
    await u.type(campo('CPF / CNPJ'), '11.222.333/0001-81');
    expect(valores()).toMatchObject({ tipo: 'J', contribuinte: '2' });
  });

  it('digitar um CNPJ sem contribuinte escolhido: continua sem escolha (nada de "1")', async () => {
    rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.type(campo('CPF / CNPJ'), CNPJ_A);
    expect(valores()).toMatchObject({ tipo: 'J', contribuinte: '' });
  });

  it('14 dígitos com verificador errado não indicam pessoa jurídica; CPF válido indica física', async () => {
    rede();
    const u = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await u.type(campo('CPF / CNPJ'), '11222333000180');
    expect(valores().tipo).toBe('');
    await u.clear(campo('CPF / CNPJ'));
    await u.type(campo('CPF / CNPJ'), '529.982.247-25');
    expect(valores()).toMatchObject({ tipo: 'F', contribuinte: '' });
  });

  it('contato existente SEM classificação local: nada pré-selecionado, e salvar não envia um 9 inventado', async () => {
    const { gravacoes } = rede();
    const u = userEvent.setup();
    const existente = { id: '33333333-3333-4333-8333-333333333333', bling_id: '4321', nome: 'Empresa Antiga', cpf_cnpj: '' } as Cliente;
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={existente} onSave={vi.fn()} />);
    expect(valores()).toMatchObject({ tipo: '', contribuinte: '' });
    await salvar(u);
    expect(screen.getByText('Selecione o tipo de pessoa')).toBeInTheDocument();
    expect(screen.getByText('Selecione o tipo de contribuinte')).toBeInTheDocument();
    expect(gravacoes()).toEqual([]);
  });

  it('contato existente com CNPJ válido e sem tipo gravado: tipo J vem do documento, contribuinte não', () => {
    rede();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={{ id: 'c1', bling_id: '9', nome: 'X', cpf_cnpj: '11.222.333/0001-81' } as Cliente} />);
    expect(valores()).toMatchObject({ tipo: 'J', contribuinte: '' });
  });

  it('contato existente com classificação gravada: mudar o documento não a altera', async () => {
    rede();
    const u = userEvent.setup();
    const existente = { id: 'c1', bling_id: '9', nome: 'X', tipo: 'J', indicador_ie: 2, cpf_cnpj: '11.222.333/0001-81' } as Cliente;
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={existente} />);
    expect(valores()).toMatchObject({ tipo: 'J', contribuinte: '2' });
    await u.clear(campo('CPF / CNPJ'));
    await u.type(campo('CPF / CNPJ'), '33.000.167/0001-01');
    expect(valores()).toMatchObject({ tipo: 'J', contribuinte: '2' });
  });
});
