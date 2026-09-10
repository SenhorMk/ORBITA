/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrganizationPanel } from './OrganizationPanel';
import { useOrganizationsList } from './useOrganizationsList';
import type { AuthenticatedFetch } from './useOrganizationPanel';

/**
 * O painel recebe o estado de organizações de fora desde o Ticket 01 — o topo
 * da aplicação cria uma instância só, para o painel e para o indicador do
 * shell. Este arranjo monta o painel do mesmo jeito que a produção monta, e
 * deixa a **sessão** trocável: é ela que o logout/login move.
 */
function PainelComEstadoDoTopo({
  fetchWithAuth,
  sessao = 'sessao@exemplo.com',
}: {
  fetchWithAuth: AuthenticatedFetch;
  sessao?: string | null;
}) {
  const lista = useOrganizationsList(fetchWithAuth, sessao);
  return <OrganizationPanel fetchWithAuth={fetchWithAuth} lista={lista} />;
}

const ORG_A = {
  id: '10000000-0000-4000-8000-000000000001',
  nome: 'Loja A',
  slug: 'loja-a',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};
const ORG_B = {
  id: '10000000-0000-4000-8000-000000000002',
  nome: 'Loja B',
  slug: 'loja-b',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const MEMBRO_DE_A = { user_id: 'membro-de-a', papel: 'member', created_at: '2026-08-01T00:00:00Z' };
const MEMBRO_DE_B = { user_id: 'membro-de-b', papel: 'admin', created_at: '2026-08-02T00:00:00Z' };
const OWNER_DE_A = { user_id: 'dona-de-a', papel: 'owner', created_at: '2026-07-01T00:00:00Z' };

const CONVITE_DE_A = { id: 'conv-a', email: 'convidada-a@empresa.com', papel: 'member', status: 'pending' };
const CONVITE_DE_B = { id: 'conv-b', email: 'convidado-b@empresa.com', papel: 'admin', status: 'pending' };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Uma promise cuja resolução o teste controla — é assim que "resposta atrasada" existe. */
function respostaControlada() {
  let resolver: (resposta: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => { resolver = resolve; });
  return { promise, responder: (body: unknown) => resolver(jsonResponse(body)) };
}

interface Cenario {
  /** O papel do chamador na organização ativa. */
  readonly papel?: 'owner' | 'admin' | 'member';
  readonly overrides?: Record<string, (url: string, options?: RequestInit) => Promise<Response>>;
}

/**
 * Fronteira de fetch por URL+método, com fixtures **por organização**: é o que
 * permite provar que o que está na tela é de B, e não de A.
 */
function buildFetchWithAuth({ papel = 'owner', overrides = {} }: Cenario = {}) {
  const membrosPorOrg: Record<string, unknown[]> = {
    [ORG_A.id]: [OWNER_DE_A, MEMBRO_DE_A],
    [ORG_B.id]: [MEMBRO_DE_B],
  };
  const convitesPorOrg: Record<string, unknown[]> = {
    [ORG_A.id]: [CONVITE_DE_A],
    [ORG_B.id]: [CONVITE_DE_B],
  };

  return vi.fn(async (url: string, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    const chave = `${method} ${url.replace(/\/[0-9a-f-]{36}\//g, '/:id/')}`;
    if (overrides[chave]) return overrides[chave](url, options);

    if (method === 'GET' && url === '/api/organizacoes') {
      return jsonResponse({
        organizacoes: [ORG_A, ORG_B],
        activeOrg: { organizacao: ORG_A, papel },
        selectionVersion: 3,
      });
    }
    const convites = url.match(/\/api\/organizacoes\/([0-9a-f-]+)\/convites$/);
    if (method === 'GET' && convites) return jsonResponse({ convites: convitesPorOrg[convites[1]] ?? [] });

    const membros = url.match(/\/api\/organizacoes\/([0-9a-f-]+)\/membros$/);
    if (method === 'GET' && membros) return jsonResponse({ membros: membrosPorOrg[membros[1]] ?? [] });

    throw new Error(`Requisição não tratada no teste: ${method} ${url}`);
  });
}

/** A troca bem-sucedida para B, com a versão que o CAS devolveria. */
function trocaParaB(versao = 4, papel: 'owner' | 'admin' | 'member' = 'owner') {
  return async () => jsonResponse({
    success: true,
    activeOrg: { organizacao: ORG_B, papel },
    selectionVersion: versao,
  });
}

/**
 * A seção de membros. É `find` porque ela só existe depois de haver
 * organização ativa — sem seleção a coluna diz isso, e não mostra lista alguma.
 */
const secaoDeMembros = () => screen.findByTestId('members-list');

describe('OrganizationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifica a organização ativa, o papel real e carimba o escopo das listas', async () => {
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth()} />);

    expect(await screen.findByText('Organização ativa')).toBeInTheDocument();
    // O nome aparece na faixa de contexto, na lista e no escopo das colunas.
    expect((await screen.findAllByText('Loja A')).length).toBeGreaterThan(1);
    expect(screen.getByText('Loja B')).toBeInTheDocument();
    expect(screen.getAllByText(/^dono$/i).length).toBeGreaterThan(0);
    expect(await within(await secaoDeMembros()).findByText('membro-de-a')).toBeInTheDocument();
  });

  it('troca a organização ativa pelo contrato CAS (organizacao_id + expected_version)', async () => {
    const user = userEvent.setup();
    const postSwitch = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(JSON.parse(String(options?.body))).toEqual({ organizacao_id: ORG_B.id, expected_version: 3 });
      return jsonResponse({ success: true, activeOrg: { organizacao: ORG_B, papel: 'admin' }, selectionVersion: 4 });
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth({ overrides: { 'POST /api/organizacoes/switch': postSwitch } })} />);
    await screen.findByText('Loja B');

    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));

    await waitFor(() => expect(postSwitch).toHaveBeenCalledTimes(1));
  });

  it('A → B invalida membros e convites de A na hora, e mostra os de B', async () => {
    const user = userEvent.setup();
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth({ overrides: { 'POST /api/organizacoes/switch': trocaParaB() } })} />);
    await within(await secaoDeMembros()).findByText('membro-de-a');
    expect(screen.getByText(CONVITE_DE_A.email)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));

    // O membro de A não pode sobreviver à troca — nem por um instante depois
    // dela, nem esperando a resposta de B chegar.
    await waitFor(async () => expect(within(await secaoDeMembros()).queryByText('membro-de-a')).toBeNull());
    expect(await within(await secaoDeMembros()).findByText('membro-de-b')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(CONVITE_DE_A.email)).toBeNull());
    expect(await screen.findByText(CONVITE_DE_B.email)).toBeInTheDocument();
  });

  it('resposta atrasada de A não repovoa B', async () => {
    const user = userEvent.setup();
    const atrasada = respostaControlada();
    let primeiraLeituraDeA = true;
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/organizacoes/switch': trocaParaB(),
        [`GET /api/organizacoes/:id/membros`]: async (url) => {
          if (url.includes(ORG_A.id) && primeiraLeituraDeA) {
            primeiraLeituraDeA = false;
            return atrasada.promise;
          }
          return jsonResponse({ membros: url.includes(ORG_A.id) ? [MEMBRO_DE_A] : [MEMBRO_DE_B] });
        },
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));
    expect(await within(await secaoDeMembros()).findByText('membro-de-b')).toBeInTheDocument();

    // A leitura de A responde só agora, depois de B já estar na tela.
    atrasada.responder({ membros: [MEMBRO_DE_A] });

    await waitFor(async () => expect(within(await secaoDeMembros()).queryByText('membro-de-a')).toBeNull());
    expect(within(await secaoDeMembros()).getByText('membro-de-b')).toBeInTheDocument();
  });

  it('A → B → A: a resposta atrasada da primeira visita a A não vale na segunda', async () => {
    const user = userEvent.setup();
    const primeiraDeA = respostaControlada();
    let leiturasDeA = 0;
    // Cada troca devolve uma versão nova — é ela que separa a primeira visita a
    // A da segunda. Só o `organizacao_id` não separaria.
    const versoes = [4, 5];
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/organizacoes/switch': async (_url, options) => {
          const alvo = JSON.parse(String(options?.body)).organizacao_id === ORG_A.id ? ORG_A : ORG_B;
          return jsonResponse({
            success: true,
            activeOrg: { organizacao: alvo, papel: 'owner' },
            selectionVersion: versoes.shift() ?? 6,
          });
        },
        [`GET /api/organizacoes/:id/membros`]: async (url) => {
          if (!url.includes(ORG_A.id)) return jsonResponse({ membros: [MEMBRO_DE_B] });
          leiturasDeA += 1;
          if (leiturasDeA === 1) return primeiraDeA.promise;
          return jsonResponse({ membros: [OWNER_DE_A] });
        },
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);

    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));
    expect(await within(await secaoDeMembros()).findByText('membro-de-b')).toBeInTheDocument();

    // De volta para A — nova seleção, nova versão, nova leitura.
    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));
    expect(await within(await secaoDeMembros()).findByText('dona-de-a')).toBeInTheDocument();

    // A resposta da PRIMEIRA visita a A chega agora. Mesma organização, seleção
    // diferente: ela é passado, e não pode ser apresentada como presente.
    primeiraDeA.responder({ membros: [MEMBRO_DE_A] });

    await waitFor(async () => expect(within(await secaoDeMembros()).queryByText('membro-de-a')).toBeNull());
    expect(within(await secaoDeMembros()).getByText('dona-de-a')).toBeInTheDocument();
  });

  it('logout não deixa membros, convites nem papel da identidade anterior na tela', async () => {
    const fetchWithAuth = buildFetchWithAuth();
    const { rerender } = render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} sessao="dona@exemplo.com" />);
    await within(await secaoDeMembros()).findByText('membro-de-a');

    rerender(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} sessao={null} />);

    // Sem sessão não há organização ativa, então a coluna de membros nem existe
    // — e é por isso que a busca é na tela inteira: nada da identidade anterior
    // pode ter sobrado em lugar nenhum.
    await waitFor(() => expect(screen.queryByTestId('members-list')).toBeNull());
    expect(screen.queryByText('membro-de-a')).toBeNull();
    expect(screen.queryByText(CONVITE_DE_A.email)).toBeNull();
    expect(screen.queryByText(/^dono$/i)).toBeNull();
    // A faixa de contexto e a coluna de membros dizem a mesma coisa, cada uma
    // no seu lugar: não há organização ativa.
    expect(screen.getAllByText(/nenhuma organização ativa/i).length).toBeGreaterThan(0);
  });

  it('erro ao ler membros não vira "nenhum membro", e não derruba a lista de convites', async () => {
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'GET /api/organizacoes/:id/membros': async () => jsonResponse({ error: 'Falha ao processar a solicitação' }, 500),
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);

    const membros = await screen.findByTestId('members-list');
    expect(await within(membros).findByText(/não foi possível carregar os membros/i)).toBeInTheDocument();
    expect(within(membros).queryByText(/nenhum membro/i)).toBeNull();
    // A falha de uma leitura não apaga a outra: os convites continuam na tela.
    expect(await screen.findByText(CONVITE_DE_A.email)).toBeInTheDocument();
  });

  it('erro ao ler convites não vira "nenhum convite", e não derruba a lista de membros', async () => {
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'GET /api/organizacoes/:id/convites': async () => jsonResponse({ error: 'Falha ao processar a solicitação' }, 500),
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);

    expect(await screen.findByText(/não foi possível carregar os convites/i)).toBeInTheDocument();
    expect(screen.queryByText(/nenhum convite criado/i)).toBeNull();
    expect(await within(await secaoDeMembros()).findByText('membro-de-a')).toBeInTheDocument();
  });

  it('cria o convite, entrega o código copiável e não promete envio de e-mail', async () => {
    const user = userEvent.setup();
    const escritoNaAreaDeTransferencia: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (texto: string) => { escritoNaAreaDeTransferencia.push(texto); } },
    });

    const CODIGO = 'c'.repeat(64);
    const postConvite = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe(`/api/organizacoes/${ORG_A.id}/convites`);
      expect(JSON.parse(String(options?.body))).toEqual({ email: 'nova@empresa.com', papel: 'member' });
      return jsonResponse({ convite: { id: 'conv-novo', token: CODIGO } }, 201);
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth({ overrides: { 'POST /api/organizacoes/:id/convites': postConvite } })} />);
    await screen.findByText('Loja B');

    // O rótulo é "Criar convite" nos dois lugares — nenhuma mensagem é enviada
    // por este sistema, e escrever "enviar" prometeria uma entrega que ninguém faz.
    expect(screen.queryByRole('button', { name: /enviar convite/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /criar convite/i }));

    const dialogo = await screen.findByRole('dialog');
    await user.type(within(dialogo).getByLabelText(/e-mail do convidado/i), 'nova@empresa.com');
    await user.click(within(dialogo).getByRole('button', { name: /criar convite/i }));

    await waitFor(() => expect(postConvite).toHaveBeenCalledTimes(1));

    // O código volta para a tela: sem ele não existe entrega manual.
    const campoDoCodigo = await within(dialogo).findByLabelText(/código do convite/i);
    expect(campoDoCodigo).toHaveValue(CODIGO);
    // E a tela diz a verdade sobre quem entrega.
    expect(within(dialogo).getByText(/não envia e-mail nenhum/i)).toBeInTheDocument();

    await user.click(within(dialogo).getByRole('button', { name: /copiar código/i }));
    expect(escritoNaAreaDeTransferencia).toEqual([CODIGO]);
  });

  it('member não administra: sem criar convite, sem lista de convites, sem remover membro', async () => {
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth({ papel: 'member' })} />);

    expect(await screen.findByText(/^membro$/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /criar convite/i })).toBeNull();
    expect(screen.queryByText(CONVITE_DE_A.email)).toBeNull();
    await within(await secaoDeMembros()).findByText('membro-de-a');
    expect(within(await secaoDeMembros()).queryByRole('button', { name: /remover/i })).toBeNull();
  });

  it('o owner nunca aparece removível, mesmo para quem administra', async () => {
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth()} />);

    const membros = await screen.findByTestId('members-list');
    await within(membros).findByText('dona-de-a');
    expect(within(membros).queryByRole('button', { name: /remover dona-de-a/i })).toBeNull();
    expect(within(membros).getByRole('button', { name: /remover membro-de-a/i })).toBeInTheDocument();
  });

  it('aceite com contexto não resolvido não vira sucesso normal nem falha total', async () => {
    const user = userEvent.setup();
    const CODIGO = 'f'.repeat(64);
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/convites/aceitar': async () => jsonResponse({
          success: true,
          organizacaoId: ORG_B.id,
          contexto: 'nao_resolvido',
          aviso: 'Convite aceito, mas não foi possível atualizar a organização ativa. '
            + 'Recarregue as suas organizações — não use o código de novo.',
        }),
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.click(screen.getByRole('button', { name: /aceitar convite/i }));
    const dialogo = await screen.findByRole('dialog');
    await user.type(within(dialogo).getByLabelText(/código do convite/i), CODIGO);
    await user.click(within(dialogo).getByRole('button', { name: /aceitar convite/i }));

    // O diálogo não fecha como num sucesso normal: a pessoa precisa saber que a
    // segunda metade não terminou.
    expect(await within(dialogo).findByText(/não foi possível atualizar a organização ativa/i)).toBeInTheDocument();
    // E o campo do código sai de cena, porque o token já foi consumido —
    // deixá-lo ali convidaria a tentar de novo um código que não existe mais.
    expect(within(dialogo).queryByLabelText(/código do convite/i)).toBeNull();
    expect(within(dialogo).queryByRole('button', { name: /^aceitar convite$/i })).toBeNull();
  });

  /*
   * Os quatro casos abaixo são a terceira lacuna da revisão externa da PR #84.
   * As LEITURAS já eram carimbadas pela seleção; os estados de AÇÃO não eram —
   * e uma ação iniciada em A que termina depois da troca publicava o resultado
   * de A sob o contexto de B.
   */

  it('falha tardia de uma remoção iniciada em A não aparece sob B', async () => {
    const user = userEvent.setup();
    const remocaoLenta = respostaControlada();
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/organizacoes/switch': trocaParaB(),
        'DELETE /api/organizacoes/:id/membros/membro-de-a': async () => remocaoLenta.promise,
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await within(await secaoDeMembros()).findByText('membro-de-a');

    await user.click(within(await secaoDeMembros()).getByRole('button', { name: /remover membro-de-a/i }));
    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));
    expect(await within(await secaoDeMembros()).findByText('membro-de-b')).toBeInTheDocument();

    // A remoção de A só falha agora, com B na tela.
    remocaoLenta.responder({ error: 'Falha ao remover membro na Loja A' });

    await waitFor(() => expect(screen.queryByText(/falha ao remover membro na loja a/i)).toBeNull());
    expect(within(await secaoDeMembros()).getByText('membro-de-b')).toBeInTheDocument();
  });

  it('erro de ação de A deixa de valer na troca para B', async () => {
    const user = userEvent.setup();
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/organizacoes/switch': trocaParaB(),
        'DELETE /api/organizacoes/:id/membros/membro-de-a': async () =>
          jsonResponse({ error: 'Falha ao remover membro na Loja A' }, 500),
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await within(await secaoDeMembros()).findByText('membro-de-a');

    await user.click(within(await secaoDeMembros()).getByRole('button', { name: /remover membro-de-a/i }));
    expect(await screen.findByText(/falha ao remover membro na loja a/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));

    // O erro não é "limpo": ele simplesmente deixa de valer, porque pertence a
    // uma seleção que já não é a atual.
    await waitFor(() => expect(screen.queryByText(/falha ao remover membro na loja a/i)).toBeNull());
  });

  it('a troca de organização fica suspensa enquanto a criação do convite está em voo', async () => {
    const user = userEvent.setup();
    const criacaoLenta = respostaControlada();
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/organizacoes/switch': trocaParaB(),
        'POST /api/organizacoes/:id/convites': async () => criacaoLenta.promise,
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.click(screen.getByRole('button', { name: /criar convite/i }));
    const dialogo = await screen.findByRole('dialog');
    await user.type(within(dialogo).getByLabelText(/e-mail do convidado/i), 'nova@empresa.com');
    await user.click(within(dialogo).getByRole('button', { name: /criar convite/i }));

    // Enquanto a resposta não chega, trocar de organização é o que faria o token
    // de A chegar sob B. A tela recusa, e diz por quê.
    //
    // `hidden: true` porque o diálogo do Radix marca o resto da página como
    // inerte enquanto está aberto. Essa inerteza é uma segunda barreira, e é
    // bem-vinda — mas quem garante o invariante é o `disabled`, e é ele que
    // este caso mede.
    await waitFor(() => expect(screen.getByRole('button', { name: /tornar ativa/i, hidden: true })).toBeDisabled());
    expect(screen.getByText(/aguarde a criacao do convite terminar/i)).toBeInTheDocument();

    criacaoLenta.responder({ convite: { id: 'conv-novo', token: 'd'.repeat(64) } });
    expect(await within(dialogo).findByDisplayValue('d'.repeat(64))).toBeInTheDocument();
  });

  it('o código criado em A fica preso a A: não some, e a troca só volta quando ele é dispensado', async () => {
    const user = userEvent.setup();
    const CODIGO = 'e'.repeat(64);
    const fetchWithAuth = buildFetchWithAuth({
      overrides: {
        'POST /api/organizacoes/switch': trocaParaB(),
        'POST /api/organizacoes/:id/convites': async () =>
          jsonResponse({ convite: { id: 'conv-novo', token: CODIGO } }, 201),
      },
    });
    render(<PainelComEstadoDoTopo fetchWithAuth={fetchWithAuth} />);
    await screen.findByText('Loja B');

    await user.click(screen.getByRole('button', { name: /criar convite/i }));
    const dialogo = await screen.findByRole('dialog');
    await user.type(within(dialogo).getByLabelText(/e-mail do convidado/i), 'nova@empresa.com');
    await user.click(within(dialogo).getByRole('button', { name: /criar convite/i }));

    // O código está na tela, e diz de qual organização ele é.
    expect(await within(dialogo).findByDisplayValue(CODIGO)).toBeInTheDocument();
    expect(within(dialogo).getByText(/código do convite · loja a/i)).toBeInTheDocument();

    // E a troca continua suspensa: o token não volta a aparecer, então ele não
    // pode ser abandonado nem passar a ser lido ao lado de outro tenant.
    await waitFor(() => expect(screen.getByRole('button', { name: /tornar ativa/i, hidden: true })).toBeDisabled());
    expect(screen.getByText(/feche o codigo do convite antes de trocar/i)).toBeInTheDocument();

    // Dispensar o código é o que libera a troca — e aí ele some da tela.
    await user.click(within(dialogo).getByRole('button', { name: /concluir/i }));
    await waitFor(() => expect(screen.queryByDisplayValue(CODIGO)).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: /tornar ativa/i })).toBeEnabled());
  });

  it('conflito CAS (409) não finge que a troca ocorreu nem cria seleção local', async () => {
    const user = userEvent.setup();
    const postSwitch = vi.fn(async () => jsonResponse({ error: 'Contexto de organização desatualizado' }, 409));
    render(<PainelComEstadoDoTopo fetchWithAuth={buildFetchWithAuth({ overrides: { 'POST /api/organizacoes/switch': postSwitch } })} />);
    await within(await secaoDeMembros()).findByText('membro-de-a');

    await user.click(await screen.findByRole('button', { name: /tornar ativa/i }));
    await waitFor(() => expect(postSwitch).toHaveBeenCalledTimes(1));

    // A autoridade permanece no servidor: a organização ativa continua sendo A,
    // e os membros na tela continuam sendo os de A.
    expect(await screen.findByText(/contexto de organização desatualizado/i)).toBeInTheDocument();
    expect(within(await secaoDeMembros()).getByText('membro-de-a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tornar ativa/i })).toBeInTheDocument();
  });
});
