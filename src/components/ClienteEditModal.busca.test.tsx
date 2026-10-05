/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ClienteEditModal } from './ClienteEditModal';

/**
 * Buscar empresa no cadastro de contato: só preenche. Nada é salvo nem vai ao
 * Bling até "Salvar contato", pelo fluxo de sempre (`POST /api/clientes/update`).
 */

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

const json = (corpo: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response;

const EMPRESA = {
  cnpj: '11222333000181', razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
  email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV', numero: '100',
  bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
};
const RESUMO = { cnpj: EMPRESA.cnpj, razaoSocial: EMPRESA.razaoSocial, nomeFantasia: EMPRESA.nomeFantasia, municipio: 'PONTA GROSSA', uf: 'PR', situacao: 'ATIVA' };

function rede(busca: unknown = { resultado: 'Empresas', empresas: [RESUMO] }) {
  const chamadas: Array<{ url: string; metodo: string; corpo: unknown }> = [];
  fetchWithAuthMock.mockImplementation(async (url: string, opcoes: RequestInit = {}) => {
    chamadas.push({ url, metodo: opcoes.method ?? 'GET', corpo: typeof opcoes.body === 'string' ? JSON.parse(opcoes.body) : null });
    if (url.startsWith('/api/empresas/busca')) return json(busca);
    if (url.startsWith('/api/empresas/cnpj/')) return json({ resultado: 'EmpresaEncontrada', empresa: EMPRESA });
    if (url === '/api/clientes/update') return json({ success: true, client: { id: 'c1', nome: 'x' } });
    throw new Error(`Requisição não prevista: ${url}`);
  });
  return chamadas;
}

const campo = (rotulo: string) => screen.getByLabelText(rotulo) as HTMLInputElement | HTMLSelectElement;
const valores = () => ({
  nome: campo('Nome / Razão social *').value, cpfCnpj: campo('CPF / CNPJ').value, email: campo('E-mail').value,
  telefone: campo('Telefone / Celular').value, cep: campo('CEP').value, endereco: campo('Endereço / Rua').value,
  numero: campo('Número').value, bairro: campo('Bairro').value, cidade: campo('Cidade').value, uf: campo('UF').value,
  tipo: campo('Tipo de pessoa *').value, contribuinte: campo('Tipo de contribuinte *').value,
});

beforeEach(() => { fetchWithAuthMock.mockReset(); });

describe('ClienteEditModal — buscar empresa', () => {
  it('aparece no cadastro novo; não aparece na edição de um contato existente', () => {
    rede();
    const { unmount } = render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    expect(screen.getByLabelText('Buscar empresa')).toHaveAttribute('placeholder', 'Digite nome, razão social, nome fantasia ou CNPJ');
    expect(screen.getByText('Encontre a empresa e preencha os dados automaticamente.')).toBeInTheDocument();
    unmount();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={{ id: 'c1', bling_id: '9', nome: 'Ana' } as never} />);
    expect(screen.queryByLabelText('Buscar empresa')).toBeNull();
  });

  it('CNPJ: preenche cada campo, tipo = J, contribuinte NÃO é deduzido, e nada é salvo nem vai ao Bling', async () => {
    const chamadas = rede();
    const onSave = vi.fn();
    const usuaria = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={onSave} />);
    await usuaria.type(screen.getByLabelText('Buscar empresa'), '11.222.333/0001-81');
    expect(await screen.findByText('Dados encontrados. Confira antes de salvar.')).toBeInTheDocument();
    expect(valores()).toEqual({
      nome: 'EMPRESA EXEMPLO LTDA', cpfCnpj: '11.222.333/0001-81', email: 'contato@exemplo.com.br', telefone: '4232220000',
      cep: '84010000', endereco: 'RUA XV', numero: '100', bairro: 'CENTRO', cidade: 'PONTA GROSSA', uf: 'PR',
      tipo: 'J', contribuinte: '9',
    });
    expect(screen.getByText('Confira o tipo de contribuinte: o CNPJ não indica se a empresa é contribuinte de ICMS.')).toBeInTheDocument();
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual(['GET /api/empresas/cnpj/11222333000181']);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('nome: escolher a sugestão consulta o CNPJ completo e preenche', async () => {
    const chamadas = rede();
    const usuaria = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await usuaria.type(screen.getByLabelText('Buscar empresa'), 'exemplo');
    await usuaria.click(await screen.findByRole('button', { name: /EMPRESA EXEMPLO/u }));
    await waitFor(() => expect(valores().nome).toBe('EMPRESA EXEMPLO LTDA'));
    expect(chamadas.map((c) => c.url)).toEqual(['/api/empresas/busca?termo=exemplo', '/api/empresas/cnpj/11222333000181']);
  });

  it('o nome fantasia só vira o nome por decisão explícita', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await usuaria.type(screen.getByLabelText('Buscar empresa'), '11222333000181');
    await screen.findByText('Dados encontrados. Confira antes de salvar.');
    expect(valores().nome).toBe('EMPRESA EXEMPLO LTDA');
    await usuaria.click(screen.getByRole('button', { name: 'Usar nome fantasia como nome' }));
    expect(valores().nome).toBe('EMPRESA EXEMPLO');
  });

  it('o que a pessoa já tinha digitado é mantido, e a tela diz quais campos', async () => {
    rede();
    const usuaria = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} />);
    await usuaria.type(campo('E-mail'), 'compras@cliente.com');
    await usuaria.type(screen.getByLabelText('Buscar empresa'), '11222333000181');
    expect(await screen.findByText('Mantidos os campos que você já tinha preenchido: E-mail.')).toBeInTheDocument();
    expect(valores().email).toBe('compras@cliente.com');
    expect(valores().telefone).toBe('4232220000');
  });

  it('depois de preencher dá para editar, e só "Salvar contato" grava — com o que a pessoa conferiu', async () => {
    const chamadas = rede();
    const usuaria = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={vi.fn()} />);
    await usuaria.type(screen.getByLabelText('Buscar empresa'), '11222333000181');
    await screen.findByText('Dados encontrados. Confira antes de salvar.');
    await usuaria.clear(campo('Número'));
    await usuaria.type(campo('Número'), '250');
    await usuaria.selectOptions(campo('Tipo de contribuinte *'), '1');
    await usuaria.click(screen.getByRole('button', { name: 'Salvar contato' }));
    await waitFor(() => expect(chamadas.some((c) => c.url === '/api/clientes/update')).toBe(true));
    const salvo = chamadas.find((c) => c.url === '/api/clientes/update')!.corpo as Record<string, unknown>;
    expect(salvo).toMatchObject({ nome: 'EMPRESA EXEMPLO LTDA', cpfCnpj: '11.222.333/0001-81', numero: '250', tipo: 'J', indicadorIe: 1 });
    expect(chamadas.filter((c) => c.metodo === 'POST').map((c) => c.url)).toEqual(['/api/clientes/update']);
  });

  it('busca indisponível não impede o cadastro manual', async () => {
    const chamadas = rede({ resultado: 'BuscaIndisponivel' });
    const usuaria = userEvent.setup();
    render(<ClienteEditModal isOpen onClose={vi.fn()} cliente={null} onSave={vi.fn()} />);
    await usuaria.type(screen.getByLabelText('Buscar empresa'), 'padaria');
    expect(await screen.findByText(/Não foi possível pesquisar empresas agora/u)).toBeInTheDocument();
    await usuaria.type(campo('Nome / Razão social *'), 'Padaria do Bairro');
    await usuaria.click(screen.getByRole('button', { name: 'Salvar contato' }));
    await waitFor(() => expect(chamadas.some((c) => c.url === '/api/clientes/update')).toBe(true));
    expect(chamadas.find((c) => c.url === '/api/clientes/update')!.corpo).toMatchObject({ nome: 'Padaria do Bairro' });
  });
});
