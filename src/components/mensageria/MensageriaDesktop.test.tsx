/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MensageriaDesktop } from './MensageriaDesktop';
import type { EspelhoDaMensageria } from './espelhoDaMensageria';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import type { SelecaoDeOrganizacao } from '@/components/organizacao/usePapelNaOrganizacaoAtiva';
import type { ChatwootConversation, ChatwootMessage } from '@/types';

/**
 * A Mensageria pertence a um tenant, e cada leitura pertence a uma conversa.
 *
 * Estes testes existem para os defeitos que a superfície anterior tinha de
 * verdade, e não para hipóteses: conversas das duas organizações de um membro
 * misturadas na mesma lista, histórico da conversa anterior sob o cabeçalho da
 * nova, resposta atrasada gravando por cima do contexto novo, falha de leitura
 * desenhada como "não há mensagens", mensagem otimista com aparência de
 * entregue, texto do lojista perdido no envio falho e mensagens legítimas
 * repetidas descartadas por uma comparação de conteúdo.
 */

/*
 * O espelho de verdade nunca é usado aqui — todo teste injeta o seu. O dublê do
 * cliente Supabase existe só para o módulo poder ser importado: o singleton de
 * `supabaseClient` lê configuração no topo do arquivo e lança sem ela.
 */
vi.mock('@/lib/supabaseClient', () => ({ supabase: {} }));

// O menu ⋯ (Radix) mede o gatilho com ResizeObserver, que o jsdom não tem. Sem
// medida, a central fica no layout de mesa (lista, conversa e painel ao lado).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/** Abre o menu ⋯ da conversa e escolhe uma ação pelo nome. */
async function escolherNoMenu(nome: string | RegExp) {
  await userEvent.click(screen.getByRole('button', { name: 'Mais ações da conversa' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: nome }));
}

const ORG_A: SelecaoDeOrganizacao = { id: 'org-a', versao: 1 };
const ORG_B: SelecaoDeOrganizacao = { id: 'org-b', versao: 2 };

/** UUIDs locais sintéticos: a tela nunca vê o id do Chatwoot (MSG-003B). */
const uuidDaConversa = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuidDoContato = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuidDaMensagem = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function conversa(n: number, nome: string, status = 'open'): ChatwootConversation {
  return {
    id_local: uuidDaConversa(n),
    contato_id_local: uuidDoContato(n),
    status,
    updated_at: '2026-09-10T12:00:00.000Z',
    contact: { id_local: uuidDoContato(n), name: nome, phone_number: `+551199999${1000 + n}` },
  };
}

function mensagem(n: number, conversa: number, content: string, criadaEm: string): ChatwootMessage {
  return {
    id_local: uuidDaMensagem(n),
    conversa_id_local: uuidDaConversa(conversa),
    content,
    message_type: 'incoming',
    sender_name: 'Cliente',
    created_at: criadaEm,
  };
}

interface LeituraPendente<T> {
  readonly organizacaoId: string;
  readonly conversaId?: string;
  readonly responder: (valor: T) => void;
  readonly falhar: (mensagem: string) => void;
}

interface Assinatura {
  readonly tipo: 'conversas' | 'mensagens';
  readonly organizacaoId: string;
  readonly conversaId?: string;
  readonly aoInserir?: (mensagem: ChatwootMessage) => void;
  readonly aoEstado: (ativo: boolean) => void;
  ativa: boolean;
}

/**
 * Um espelho que não responde sozinho.
 *
 * Segurar cada leitura em voo é o que permite provar as duas metades do
 * isolamento: que a leitura de A não é **exibida** sob B, e que a resposta
 * atrasada de A não é **gravada** depois da troca.
 */
function criarEspelho() {
  const conversas: LeituraPendente<ChatwootConversation[]>[] = [];
  const mensagens: LeituraPendente<ChatwootMessage[]>[] = [];
  const assinaturas: Assinatura[] = [];

  const espelho: EspelhoDaMensageria = {
    lerConversas: (organizacaoId) =>
      new Promise((resolver, rejeitar) => {
        conversas.push({ organizacaoId, responder: resolver, falhar: (m) => rejeitar(new Error(m)) });
      }),
    lerMensagens: (organizacaoId, conversaId) =>
      new Promise((resolver, rejeitar) => {
        mensagens.push({ organizacaoId, conversaId, responder: resolver, falhar: (m) => rejeitar(new Error(m)) });
      }),
    assinarMensagens: (organizacaoId, conversaId, aoInserir, aoEstado) => {
      const assinatura: Assinatura = { tipo: 'mensagens', organizacaoId, conversaId, aoInserir, aoEstado, ativa: true };
      assinaturas.push(assinatura);
      return () => {
        assinatura.ativa = false;
      };
    },
    assinarConversas: (organizacaoId, _aoMudar, aoEstado) => {
      const assinatura: Assinatura = { tipo: 'conversas', organizacaoId, aoEstado, ativa: true };
      assinaturas.push(assinatura);
      return () => {
        assinatura.ativa = false;
      };
    },
  };

  return { espelho, conversas, mensagens, assinaturas };
}

function respostaJson(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

/** Solta a última leitura pendente de um tipo, dentro de `act`. */
async function responder<T>(fila: LeituraPendente<T>[], valor: T) {
  const pendente = fila[fila.length - 1];
  await act(async () => {
    pendente.responder(valor);
  });
}

function montar(
  espelho: EspelhoDaMensageria,
  selecao: SelecaoDeOrganizacao | null,
  fetchWithAuth: AuthenticatedFetch = vi.fn(),
) {
  const resultado = render(
    <MensageriaDesktop fetchWithAuth={fetchWithAuth} selecao={selecao} espelho={espelho} />,
  );
  const trocar = (nova: SelecaoDeOrganizacao | null) =>
    resultado.rerender(<MensageriaDesktop fetchWithAuth={fetchWithAuth} selecao={nova} espelho={espelho} />);
  return { ...resultado, trocar, fetchWithAuth };
}

/** Abre uma conversa já listada e devolve a leitura de histórico que isso disparou. */
async function abrir(nome: string) {
  await userEvent.click(screen.getByText(nome));
}

describe('MensageriaDesktop — tenant', () => {
  it('lê e assina somente a organização ativa, e mostra só as conversas dela', async () => {
    const { espelho, conversas, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);

    expect(conversas.map((c) => c.organizacaoId)).toEqual(['org-a']);
    await responder(conversas, [conversa(1, 'Ana de A')]);

    expect(screen.getByText('Ana de A')).toBeInTheDocument();
    expect(assinaturas.filter((a) => a.ativa).map((a) => a.organizacaoId)).toEqual(['org-a']);
  });

  it('A → B limpa conversa selecionada, histórico, rascunho e subscriptions no mesmo passo', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    await responder(conversas, [conversa(1, 'Ana de A')]);
    await abrir('Ana de A');
    await responder(mensagens, [mensagem(10, 1, 'Segredo de A', '2026-09-10T12:00:00.000Z')]);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'rascunho de A');

    expect(screen.getByText('Segredo de A')).toBeInTheDocument();
    expect(screen.getByLabelText('Mensagem')).toHaveValue('rascunho de A');

    await act(async () => {
      trocar(ORG_B);
    });

    // Nada de A sobrevive à troca: nem o histórico, nem o cabeçalho da conversa,
    // nem o rascunho — e o compositor nem existe, porque não há seleção em B.
    expect(screen.queryByText('Segredo de A')).not.toBeInTheDocument();
    expect(screen.queryByText('Ana de A')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Mensagem')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma conversa selecionada')).toBeInTheDocument();

    // As subscriptions de A foram desmontadas e as de B criadas no tenant certo.
    expect(assinaturas.filter((a) => a.ativa && a.organizacaoId === 'org-a')).toHaveLength(0);
    expect(assinaturas.filter((a) => a.ativa).map((a) => a.organizacaoId)).toEqual(['org-b']);
    expect(conversas[conversas.length - 1].organizacaoId).toBe('org-b');
  });

  it('resposta atrasada de A não entra em B', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    const leituraDeA = conversas[0];
    await act(async () => {
      trocar(ORG_B);
    });

    // A resposta de A chega depois da troca. Ela não pode ser gravada nem
    // exibida, e também não pode apagar a leitura boa de B.
    await act(async () => {
      leituraDeA.responder([conversa(1, 'Ana de A')]);
    });
    await responder(conversas, [conversa(2, 'Bruno de B')]);

    expect(screen.queryByText('Ana de A')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno de B')).toBeInTheDocument();
    expect(mensagens).toHaveLength(0);
  });

  it('A → B → A não aceita a resposta da primeira visita a A', async () => {
    const { espelho, conversas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    const primeiraVisita = conversas[0];
    await act(async () => {
      trocar(ORG_B);
    });
    await act(async () => {
      trocar({ id: 'org-a', versao: 3 });
    });

    await act(async () => {
      primeiraVisita.responder([conversa(1, 'Ana antiga')]);
    });
    await responder(conversas, [conversa(4, 'Ana atual')]);

    expect(screen.queryByText('Ana antiga')).not.toBeInTheDocument();
    expect(screen.getByText('Ana atual')).toBeInTheDocument();
  });

  it('logout descarta o estado anterior, e o login seguinte começa limpo', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);

    await responder(conversas, [conversa(1, 'Ana de A')]);
    await abrir('Ana de A');
    await responder(mensagens, [mensagem(10, 1, 'Segredo de A', '2026-09-10T12:00:00.000Z')]);

    await act(async () => {
      trocar(null);
    });

    expect(screen.getByText('Nenhuma organização ativa')).toBeInTheDocument();
    expect(screen.queryByText('Segredo de A')).not.toBeInTheDocument();
    expect(assinaturas.filter((a) => a.ativa)).toHaveLength(0);

    await act(async () => {
      trocar({ id: 'org-a', versao: 5 });
    });
    expect(screen.queryByText('Ana de A')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma conversa selecionada')).toBeInTheDocument();
  });
});

describe('MensageriaDesktop — leitura do histórico', () => {
  it('lê o histórico uma vez por seleção, e não duas', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);

    await abrir('Ana');

    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ organizacaoId: 'org-a', conversaId: uuidDaConversa(1) });
  });

  it('trocar de conversa some com o histórico anterior antes de o novo chegar', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    await responder(mensagens, [mensagem(10, 1, 'Mensagem da Ana', '2026-09-10T12:00:00.000Z')]);
    expect(screen.getByText('Mensagem da Ana')).toBeInTheDocument();

    await abrir('Bruno');

    expect(screen.queryByText('Mensagem da Ana')).not.toBeInTheDocument();
    expect(screen.getByText('Lendo o histórico desta conversa…')).toBeInTheDocument();
  });

  it('resposta atrasada da conversa 1 não entra na conversa 2', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    const leituraDaAna = mensagens[0];
    await abrir('Bruno');

    await act(async () => {
      leituraDaAna.responder([mensagem(10, 1, 'Mensagem da Ana', '2026-09-10T12:00:00.000Z')]);
    });
    await responder(mensagens, [mensagem(20, 2, 'Mensagem do Bruno', '2026-09-10T12:01:00.000Z')]);

    expect(screen.queryByText('Mensagem da Ana')).not.toBeInTheDocument();
    expect(screen.getByText('Mensagem do Bruno')).toBeInTheDocument();
  });

  it('a subscription de mensagens acompanha a conversa aberta', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    await responder(mensagens, []);
    await abrir('Bruno');

    const vivas = assinaturas.filter((a) => a.ativa && a.tipo === 'mensagens');
    expect(vivas).toHaveLength(1);
    expect(vivas[0]).toMatchObject({ organizacaoId: 'org-a', conversaId: uuidDaConversa(2) });
  });
});

describe('MensageriaDesktop — estados honestos', () => {
  it('falha de leitura do histórico não vira histórico vazio', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');

    await act(async () => {
      mensagens[0].falhar('Não foi possível ler o histórico: rede indisponível');
    });

    expect(screen.getByText('Não foi possível ler o histórico')).toBeInTheDocument();
    expect(screen.queryByText('Conversa sem mensagens')).not.toBeInTheDocument();
  });

  it('conversa realmente sem mensagens é dita como vazia, e não como erro', async () => {
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');
    await responder(mensagens, []);

    expect(screen.getByText('Conversa sem mensagens')).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível ler o histórico')).not.toBeInTheDocument();
  });

  it('separa "nenhuma conversa" de "a busca não encontrou nada"', async () => {
    const { espelho, conversas } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A);
    await responder(conversas, []);
    expect(screen.getByText('Nenhuma conversa nesta organização')).toBeInTheDocument();

    await act(async () => {
      trocar({ id: 'org-a', versao: 2 });
    });
    await responder(conversas, [conversa(1, 'Ana')]);
    await userEvent.type(screen.getByLabelText('Buscar conversa'), 'zzz');

    expect(screen.getByText('Nenhuma conversa encontrada')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma conversa nesta organização')).not.toBeInTheDocument();
  });

  it('só afirma tempo real quando a subscription está confirmada', async () => {
    const { espelho, conversas, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);

    expect(screen.getByText('LISTA SEM TEMPO REAL')).toBeInTheDocument();

    await act(async () => {
      assinaturas.find((a) => a.tipo === 'conversas')!.aoEstado(true);
    });
    expect(screen.getByText('LISTA AO VIVO')).toBeInTheDocument();
  });
});

describe('MensageriaDesktop — envio', () => {
  const CONVERSA = [conversa(1, 'Ana')];

  async function abrirComposer(fetchWithAuth: AuthenticatedFetch) {
    const espelhoDublado = criarEspelho();
    montar(espelhoDublado.espelho, ORG_A, fetchWithAuth);
    await responder(espelhoDublado.conversas, CONVERSA);
    await abrir('Ana');
    await responder(espelhoDublado.mensagens, []);
    return espelhoDublado;
  }

  /**
   * O servidor dublado: o POST registra (ou falha como pedido) e o GET lista os
   * envios da conversa. `lista` é lida a cada GET, para o teste mudar o desfecho.
   */
  function servidor(opcoes: {
    readonly post?: () => Promise<Response>;
    readonly lista?: () => readonly unknown[];
    readonly controle?: () => Record<string, unknown>;
    readonly permissoes?: () => Record<string, unknown>;
    readonly postControle?: (corpo: Record<string, unknown>) => Promise<Response>;
  }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      // O painel do cliente (MSG-010) tem os próprios testes; aqui a conversa fica sem prova.
      if (url.startsWith('/api/sac/')) {
        return respostaJson({
          success: true, versao: 1, candidatos: [],
          verificacao: { estado: 'sem_prova', cliente: null, verificadoEm: null, expiraEm: null, totalDeCandidatos: 0, consultaPorNumeroBloqueada: false },
        });
      }
      if (url.startsWith('/api/chatwoot/controle')) {
        if (init?.method === 'POST') {
          const corpo = JSON.parse(String(init.body));
          if (opcoes.postControle) return opcoes.postControle(corpo);
          return respostaJson({ success: false, error: 'não esperado' }, 500);
        }
        expect(url).toBe(`/api/chatwoot/controle?conversaId=${uuidDaConversa(1)}`);
        return respostaJson({
          success: true,
          controle: opcoes.controle?.() ?? { modo: 'HUMAN_REQUIRED', responsavelId: null, souResponsavel: false, versao: 0 },
          permissoes: opcoes.permissoes?.() ?? SEM_DEVOLVER,
        });
      }
      if (init?.method === 'POST') {
        if (opcoes.post) return opcoes.post();
        const { commandId } = JSON.parse(String(init.body));
        return respostaJson({ success: true, envio: { id: 'envio-1', commandId, estado: 'pendente', duplicado: false } }, 202);
      }
      expect(url).toBe(`/api/chatwoot/send?conversaId=${uuidDaConversa(1)}`);
      return respostaJson({ success: true, envios: opcoes.lista?.() ?? [] });
    });
  }

  const SEM_DEVOLVER = { devolver: false, motivoSemDevolver: 'nao_e_responsavel', automacaoAtiva: false };

  const postsDe = (fetchWithAuth: ReturnType<typeof servidor>) =>
    fetchWithAuth.mock.calls.filter(([url, init]) => init?.method === 'POST' && url === '/api/chatwoot/send')
      .map(([, init]) => JSON.parse(String(init!.body)));
  const postsDeControle = (fetchWithAuth: ReturnType<typeof servidor>) =>
    fetchWithAuth.mock.calls.filter(([url, init]) => init?.method === 'POST' && url === '/api/chatwoot/controle')
      .map(([, init]) => JSON.parse(String(init!.body)));

  describe('atendimento (MSG-009)', () => {
    it('assumir manda a versão vista e mostra a resposta já em voo', async () => {
      const fetchWithAuth = servidor({
        postControle: async () => respostaJson({
          success: true, duplicado: false, invalidados: 0, emVoo: 1, notaRegistrada: true,
          controle: { modo: 'HUMAN', responsavelId: 'eu', souResponsavel: true, versao: 1 },
        }),
      });
      await abrirComposer(fetchWithAuth);
      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Aguardando atendente'));

      await userEvent.click(screen.getByRole('button', { name: 'Assumir atendimento' }));

      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com você'));
      expect(postsDeControle(fetchWithAuth)).toEqual([
        { conversaId: uuidDaConversa(1), commandId: expect.any(String), acao: 'assumir', versaoEsperada: 0 },
      ]);
      expect(screen.getByText(/1 resposta já estava em envio e pode ter chegado à cliente/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Assumir atendimento' })).not.toBeInTheDocument();
    });

    it('outra aba mudou antes: mostra o motivo e o estado atual do servidor', async () => {
      const fetchWithAuth = servidor({
        postControle: async () => respostaJson({
          success: false, error: 'O atendimento mudou desde que você abriu a conversa.', motivo: 'conflito_versao',
          controle: { modo: 'HUMAN', responsavelId: 'outra', souResponsavel: false, versao: 3 },
        }, 409),
      });
      await abrirComposer(fetchWithAuth);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Assumir atendimento' })).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: 'Assumir atendimento' }));

      await waitFor(() => expect(screen.getByText('O atendimento mudou desde que você abriu a conversa.')).toBeInTheDocument());
      expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com outro atendente');
    });

    it('com automação ativa e permissão do servidor, devolver exige resumo, que vai como nota', async () => {
      const ativa = { devolver: true, motivoSemDevolver: null, automacaoAtiva: true };
      const fetchWithAuth = servidor({
        controle: () => ({ modo: 'HUMAN', responsavelId: 'eu', souResponsavel: true, versao: 2 }),
        permissoes: () => ativa,
        postControle: async () => respostaJson({
          success: true, duplicado: false, invalidados: 0, emVoo: 0, notaRegistrada: true,
          controle: { modo: 'AI', responsavelId: null, souResponsavel: false, versao: 3 },
          permissoes: { ...ativa, devolver: false, motivoSemDevolver: 'nao_e_responsavel' },
        }),
      });
      await abrirComposer(fetchWithAuth);
      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com você'));

      // Devolver mora no ⋯ e abre o painel do atendimento já com o resumo.
      await escolherNoMenu('Devolver à automação…');
      expect(screen.getByRole('tab', { name: 'Atendimento' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('button', { name: 'Devolver' })).toBeDisabled();
      await userEvent.type(screen.getByLabelText('Resumo para a nota privada'), 'Pedido localizado');
      await userEvent.click(screen.getByRole('button', { name: 'Devolver' }));

      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Automação responde'));
      expect(postsDeControle(fetchWithAuth)).toEqual([
        { conversaId: uuidDaConversa(1), commandId: expect.any(String), acao: 'devolver', versaoEsperada: 2, nota: 'Pedido localizado' },
      ]);
      expect(screen.getByRole('button', { name: 'Pedir atendente' })).toBeInTheDocument();
    });

    it.each([
      ['dono comum: ser responsável não é poder gerenciar', 'sem_capacidade', 'Só quem gerencia a organização devolve à automação.'],
      ['dono gestor sem automação ativa', 'automacao_inativa', 'Devolver à automação fica disponível quando a automação estiver ativa.'],
    ])('%s: não oferece devolver e diz por quê', async (_nome, motivo, explicacao) => {
      const fetchWithAuth = servidor({
        controle: () => ({ modo: 'HUMAN', responsavelId: 'eu', souResponsavel: true, versao: 2 }),
        permissoes: () => ({ devolver: false, motivoSemDevolver: motivo, automacaoAtiva: false }),
      });
      await abrirComposer(fetchWithAuth);
      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com você'));

      await userEvent.click(screen.getByRole('button', { name: 'Mais ações da conversa' }));
      expect(screen.queryByRole('menuitem', { name: /Devolver à automação/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Detalhes do atendimento' }));

      expect(screen.getByText(explicacao)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Devolver à automação' })).not.toBeInTheDocument();
    });

    it('conversa em AI sem confirmação de atividade: aguarda atualização sem afirmar que o bot não responde', async () => {
      const fetchWithAuth = servidor({ controle: () => ({ modo: 'AI', responsavelId: null, souResponsavel: false, versao: 4 }) });
      await abrirComposer(fetchWithAuth);

      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Aguardando automação'));
      expect(screen.queryByText('Automação responde')).not.toBeInTheDocument();
      expect(screen.queryByText(/A automação ainda não responde conversas/)).not.toBeInTheDocument();
      expect(screen.getByText(/A atividade do bot ainda não foi confirmada/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Assumir atendimento' })).toBeInTheDocument();
    });

    it('devolução aceita aguarda a projeção sem avisar falsamente que o bot não assume', async () => {
      const fetchWithAuth = servidor({
        controle: () => ({ modo: 'HUMAN', responsavelId: 'eu', souResponsavel: true, versao: 2 }),
        permissoes: () => ({ devolver: true, motivoSemDevolver: null, automacaoAtiva: true }),
        postControle: async () => respostaJson({
          success: true, duplicado: false, invalidados: 0, emVoo: 0, notaRegistrada: true,
          controle: { modo: 'AI', responsavelId: null, souResponsavel: false, versao: 3 },
          permissoes: { devolver: false, motivoSemDevolver: 'nao_e_responsavel', automacaoAtiva: false },
        }),
      });
      await abrirComposer(fetchWithAuth);
      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com você'));
      await escolherNoMenu('Devolver à automação…');
      await userEvent.type(screen.getByLabelText('Resumo para a nota privada'), 'Atendimento concluído');
      await userEvent.click(screen.getByRole('button', { name: 'Devolver' }));
      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Aguardando automação'));
      expect(screen.queryByText(/A automação ainda não responde conversas|ninguém está atendendo esta/)).not.toBeInTheDocument();
      expect(screen.getByText(/A atividade do bot ainda não foi confirmada/)).toBeInTheDocument();
      expect(postsDeControle(fetchWithAuth)).toHaveLength(1);
    });

    it('assumir a conversa de outro atendente pede confirmação antes de transferir', async () => {
      const fetchWithAuth = servidor({
        controle: () => ({ modo: 'HUMAN', responsavelId: 'outra', souResponsavel: false, versao: 3 }),
        postControle: async () => respostaJson({
          success: true, duplicado: false, invalidados: 1, emVoo: 0, notaRegistrada: true,
          controle: { modo: 'HUMAN', responsavelId: 'eu', souResponsavel: true, versao: 4 },
          permissoes: { devolver: false, motivoSemDevolver: 'sem_capacidade', automacaoAtiva: false },
        }),
      });
      await abrirComposer(fetchWithAuth);
      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com outro atendente'));

      await userEvent.click(screen.getByRole('button', { name: 'Assumir atendimento' }));
      expect(postsDeControle(fetchWithAuth)).toEqual([]);
      expect(screen.getByRole('alertdialog', { name: 'Confirmar transferência' })).toHaveTextContent('Esta conversa está com outro atendente');

      await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(screen.queryByRole('alertdialog', { name: 'Confirmar transferência' })).not.toBeInTheDocument();
      expect(postsDeControle(fetchWithAuth)).toEqual([]);

      await userEvent.click(screen.getByRole('button', { name: 'Assumir atendimento' }));
      await userEvent.click(screen.getByRole('button', { name: 'Transferir para mim' }));

      await waitFor(() => expect(screen.getByLabelText('Quem atende')).toHaveTextContent('Com você'));
      expect(postsDeControle(fetchWithAuth)).toEqual([
        { conversaId: uuidDaConversa(1), commandId: expect.any(String), acao: 'assumir', versaoEsperada: 3 },
      ]);
      expect(screen.getByText('1 resposta na fila foi cancelada.')).toBeInTheDocument();
    });

    it('envio invalidado pela troca de responsável aparece como não enviado, com o texto recuperável', async () => {
      const fetchWithAuth = servidor({
        lista: () => [{
          id: 'envio-9', commandId: '90000000-0000-4000-8000-000000000009', conteudo: 'resposta antiga', estado: 'invalidado',
          explicacao: 'Não enviada: o atendimento mudou de responsável antes do envio.', mensagemIdLocal: null, criadoEm: '2026-11-09T12:00:00Z',
        }],
      });
      await abrirComposer(fetchWithAuth);

      await waitFor(() => expect(screen.getByText('resposta antiga')).toBeInTheDocument());
      expect(screen.getByText(/mudou de responsável antes do envio; nada saiu/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Recuperar texto' }));
      expect(screen.getByLabelText('Mensagem')).toHaveValue('resposta antiga');
    });
  });

  describe('central de mensagens (UX)', () => {
    it('autoria: cliente à esquerda, atendimento à direita com a conta, evento discreto; nada de "IA" ou "Você" sem prova', async () => {
      const fetchWithAuth = servidor({});
      const dublado = criarEspelho();
      montar(dublado.espelho, ORG_A, fetchWithAuth);
      await responder(dublado.conversas, CONVERSA);
      await abrir('Ana');
      await responder(dublado.mensagens, [
        { ...mensagem(1, 1, 'Oi, cadê meu pedido?', '2026-11-20T12:00:00.000Z'), sender_type: 'contact', sender_name: 'Ana' },
        { ...mensagem(2, 1, 'Já verifico para você.', '2026-11-20T12:01:00.000Z'), message_type: 'outgoing', sender_type: 'user', sender_name: 'Atendente Orbita' },
        { ...mensagem(3, 1, 'Conversa atribuída', '2026-11-20T12:02:00.000Z'), message_type: 'activity', sender_name: null },
      ]);

      const daCliente = screen.getByText('Oi, cadê meu pedido?').closest('article')!;
      const doAtendimento = screen.getByText('Já verifico para você.').closest('article')!;
      expect(daCliente).toHaveAttribute('data-lado', 'esquerda');
      expect(daCliente).toHaveTextContent('Ana');
      expect(doAtendimento).toHaveAttribute('data-lado', 'direita');
      expect(doAtendimento).toHaveTextContent('Atendimento');
      expect(doAtendimento).toHaveTextContent('Atendente Orbita');
      expect(screen.getByText('Conversa atribuída').closest('article')).toBeNull();
      expect(screen.getByText(/Evento do sistema/)).toBeInTheDocument();
      const historico = screen.getByRole('log', { name: 'Histórico da conversa' });
      expect(within(historico).queryByText('Você')).not.toBeInTheDocument();
      expect(within(historico).queryByText(/^IA$|Assistente virtual/)).not.toBeInTheDocument();
    });

    it('"Você" só no que este navegador enviou; o que volta da fila do servidor é "Atendimento"', async () => {
      const fetchWithAuth = servidor({
        lista: () => [{
          id: 'envio-7', commandId: '70000000-0000-4000-8000-000000000007', conteudo: 'resposta na fila', estado: 'pendente',
          explicacao: 'Na fila.', mensagemIdLocal: null, criadoEm: '2026-11-20T12:00:00Z',
        }],
      });
      await abrirComposer(fetchWithAuth);
      const daFila = (await screen.findByText('resposta na fila')).closest('article')!;
      expect(daFila).toHaveTextContent('Atendimento');
      expect(daFila).not.toHaveTextContent('Você');

      await userEvent.type(screen.getByLabelText('Mensagem'), 'minha resposta');
      await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));
      const minha = (await screen.findByText('minha resposta')).closest('article')!;
      expect(minha).toHaveTextContent('Você');
    });

    it('Enter envia; Shift+Enter quebra a linha; Enter vazio não envia', async () => {
      const fetchWithAuth = servidor({});
      await abrirComposer(fetchWithAuth);
      const campo = screen.getByLabelText('Mensagem');

      await userEvent.type(campo, '{Enter}');
      expect(postsDe(fetchWithAuth)).toEqual([]);

      await userEvent.type(campo, 'linha 1{Shift>}{Enter}{/Shift}linha 2');
      expect(campo).toHaveValue('linha 1\nlinha 2');
      expect(postsDe(fetchWithAuth)).toEqual([]);

      await userEvent.type(campo, '{Enter}');
      await waitFor(() => expect(postsDe(fetchWithAuth)).toEqual([
        { conversaId: uuidDaConversa(1), commandId: expect.any(String), content: 'linha 1\nlinha 2' },
      ]));
      expect(campo).toHaveValue('');
    });

    it('as ferramentas ficam no ⋯ e abrem no painel por assunto; o rascunho e o compositor continuam lá', async () => {
      const fetchWithAuth = servidor({});
      await abrirComposer(fetchWithAuth);
      await userEvent.type(screen.getByLabelText('Mensagem'), 'rascunho em andamento');

      // Sem painel aberto, as ferramentas não ocupam a conversa.
      expect(screen.queryByRole('complementary', { name: 'Ferramentas da conversa' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Gerar rascunho de resposta' })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Mais ações da conversa' }));
      for (const nome of ['Marcar resolvida', 'Atualizar conversa', 'Detalhes do atendimento', 'Triagem da IA', 'Resposta sugerida',
        'Identidade do cliente', 'Pedidos e informações comerciais']) {
        expect(screen.getByRole('menuitem', { name: nome })).toBeInTheDocument();
      }
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Mensagem')).toHaveValue('rascunho em andamento');

      await escolherNoMenu('Resposta sugerida');
      const painel = screen.getByRole('complementary', { name: 'Ferramentas da conversa' });
      expect(within(painel).getByRole('tab', { name: 'Resposta' })).toHaveAttribute('aria-selected', 'true');
      expect(within(painel).getByRole('button', { name: 'Gerar rascunho de resposta' })).toBeInTheDocument();
      expect(screen.getByLabelText('Mensagem')).toHaveValue('rascunho em andamento');

      // Setas trocam de aba, como numa lista de abas.
      within(painel).getByRole('tab', { name: 'Resposta' }).focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(within(painel).getByRole('tab', { name: 'Cliente' })).toHaveAttribute('aria-selected', 'true');
      expect(within(painel).getByRole('tab', { name: 'Cliente' })).toHaveFocus();

      await userEvent.click(within(painel).getByRole('button', { name: 'Fechar ferramentas' }));
      expect(screen.queryByRole('complementary', { name: 'Ferramentas da conversa' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Mensagem')).toHaveValue('rascunho em andamento');
    });

    it('fechar o painel (Escape ou X) devolve o foco ao ⋯ que abriu o menu, e não ao <body>', async () => {
      const fetchWithAuth = servidor({});
      await abrirComposer(fetchWithAuth);
      const gatilho = screen.getByRole('button', { name: 'Mais ações da conversa' });

      await escolherNoMenu('Triagem da IA');
      const painel = screen.getByRole('complementary', { name: 'Ferramentas da conversa' });
      within(painel).getByRole('tab', { name: 'Triagem' }).focus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('complementary', { name: 'Ferramentas da conversa' })).not.toBeInTheDocument();
      await waitFor(() => expect(gatilho).toHaveFocus());

      await escolherNoMenu('Identidade do cliente');
      await userEvent.click(screen.getByRole('button', { name: 'Fechar ferramentas' }));
      await waitFor(() => expect(gatilho).toHaveFocus());
    });

    it('quem lê mensagens antigas não é puxado para o fim: aparece "Ir para as recentes"', async () => {
      const fetchWithAuth = servidor({});
      const dublado = criarEspelho();
      montar(dublado.espelho, ORG_A, fetchWithAuth);
      await responder(dublado.conversas, CONVERSA);
      await abrir('Ana');
      await responder(dublado.mensagens, [mensagem(1, 1, 'primeira', '2026-11-20T12:00:00.000Z')]);

      const historico = screen.getByRole('log', { name: 'Histórico da conversa' });
      Object.defineProperty(historico, 'scrollHeight', { configurable: true, value: 2000 });
      Object.defineProperty(historico, 'clientHeight', { configurable: true, value: 500 });
      historico.scrollTop = 200;
      fireEvent.scroll(historico);
      expect(screen.getByRole('button', { name: 'Ir para as recentes' })).toBeInTheDocument();

      const assinatura = dublado.assinaturas.find((a) => a.tipo === 'mensagens' && a.ativa)!;
      await act(async () => {
        assinatura.aoInserir!(mensagem(2, 1, 'chegou agora', '2026-11-20T12:05:00.000Z'));
      });
      expect(historico.scrollTop).toBe(200);
      await userEvent.click(screen.getByRole('button', { name: 'Ir para as recentes · 1 nova' }));
      expect(historico.scrollTop).toBe(2000);
      expect(screen.queryByRole('button', { name: /Ir para as recentes/ })).not.toBeInTheDocument();
    });
  });

  async function escreverEEnviar(texto: string) {
    await userEvent.type(screen.getByLabelText('Mensagem'), texto);
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));
  }

  it('o servidor recusa o pedido: não enviada, nada registrado, e o texto volta', async () => {
    const fetchWithAuth = servidor({
      post: async () => respostaJson({ success: false, error: 'Conversa não encontrada' }, 404),
    });
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('preciso confirmar o pedido');

    await waitFor(() => expect(screen.getByText('Não enviada')).toBeInTheDocument());
    expect(screen.getByText('Conversa não encontrada')).toBeInTheDocument();
    expect(screen.getByText(/nada foi registrado nem enviado/)).toBeInTheDocument();
    expect(postsDe(fetchWithAuth)).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Recuperar texto' }));
    expect(screen.getByLabelText('Mensagem')).toHaveValue('preciso confirmar o pedido');
    expect(screen.queryByText('Não enviada')).not.toBeInTheDocument();
  });

  it('MSG-008: enviar registra e mostra na fila; só o recibo transforma em histórico, uma vez', async () => {
    let estado = 'pendente';
    const fetchWithAuth = servidor({
      lista: () => (estado === 'pendente' ? [] : [{
        commandId: postsDe(fetchWithAuth)[0].commandId, conteudo: 'já está a caminho', estado: 'enviado',
        explicacao: 'Confirmado pelo provedor.', mensagemIdLocal: uuidDaMensagem(55), criadoEm: '2026-09-10T12:05:00.000Z',
      }]),
    });
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('já está a caminho');

    await waitFor(() => expect(screen.getByText('Na fila de envio')).toBeInTheDocument());
    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
    estado = 'enviado';
    await waitFor(() => expect(screen.queryByText('Na fila de envio')).not.toBeInTheDocument(), { timeout: 4_000 });
    expect(screen.getAllByText('já está a caminho')).toHaveLength(1);
  });

  it('MSG-008: o pedido leva o UUID local da conversa e um commandId gerado antes da rede', async () => {
    const fetchWithAuth = servidor({});
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('segue o código');

    await waitFor(() => expect(postsDe(fetchWithAuth)).toHaveLength(1));
    const [corpo] = postsDe(fetchWithAuth);
    expect(corpo).toEqual({ conversaId: uuidDaConversa(1), commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), content: 'segue o código' });
  });

  it('MSG-008: sem resposta do servidor, "Tentar de novo" repete o mesmo comando, e não um envio novo', async () => {
    let falhar = true;
    const fetchWithAuth = servidor({
      post: async () => {
        if (falhar) throw new Error('Failed to fetch');
        return respostaJson({ success: true, envio: { id: 'envio-1', commandId: postsDe(fetchWithAuth)[0].commandId, estado: 'pendente', duplicado: true } }, 202);
      },
    });
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('confirmado?');

    await waitFor(() => expect(screen.getByText('Sem resposta do servidor')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Recuperar texto' })).not.toBeInTheDocument();
    falhar = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    await waitFor(() => expect(screen.getByText('Na fila de envio')).toBeInTheDocument());
    const [primeiro, segundo] = postsDe(fetchWithAuth);
    expect(segundo).toEqual(primeiro);
  });

  it('MSG-008: resposta sem a intenção de volta não vira fila nem entrega', async () => {
    const fetchWithAuth = servidor({
      post: async () => respostaJson({ success: true, message: { id: 55, created_at: '2026-09-10T12:05:00.000Z' } }),
    });
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('confirmado?');

    await waitFor(() => expect(screen.getByText('Sem resposta do servidor')).toBeInTheDocument());
    expect(screen.getByText('O servidor respondeu em um formato inesperado.')).toBeInTheDocument();
    expect(screen.queryByText('Na fila de envio')).not.toBeInTheDocument();
  });

  it('MSG-007/008: o worker registrou desconhecido — "não confirmada", com a explicação, sem botão de reenvio', async () => {
    let estado = 'pendente';
    const fetchWithAuth = servidor({
      lista: () => (estado === 'pendente' ? [] : [{
        commandId: postsDe(fetchWithAuth)[0].commandId, conteudo: 'chegou?', estado: 'desconhecido',
        explicacao: 'O provedor não respondeu a tempo. A mensagem pode ter sido entregue. Não reenvie: confira no provedor e registre o resultado.',
        mensagemIdLocal: null, criadoEm: '2026-09-10T12:05:00.000Z',
      }]),
    });
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('chegou?');
    await waitFor(() => expect(screen.getByText('Na fila de envio')).toBeInTheDocument());
    estado = 'desconhecido';

    await waitFor(() => expect(screen.getByText('Entrega não confirmada')).toBeInTheDocument(), { timeout: 4_000 });
    expect(screen.getByText(/Não reenvie/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recuperar texto' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument();
    expect(postsDe(fetchWithAuth)).toHaveLength(1);
  });

  it('MSG-008: depois de um reload, o envio ainda na fila volta à tela, sem novo pedido', async () => {
    const fetchWithAuth = servidor({
      lista: () => [{
        commandId: 'a0000000-0000-4000-8000-000000000001', conteudo: 'enviado antes do reload', estado: 'pendente',
        explicacao: 'Ainda não enviado.', mensagemIdLocal: null, criadoEm: '2026-09-10T12:04:00.000Z',
      }],
    });
    await abrirComposer(fetchWithAuth);

    await waitFor(() => expect(screen.getByText('enviado antes do reload')).toBeInTheDocument());
    expect(screen.getByText('Na fila de envio')).toBeInTheDocument();
    expect(postsDe(fetchWithAuth)).toHaveLength(0);
  });

  it('a indisponibilidade da integração bloqueia o envio e é dita como tal', async () => {
    const fetchWithAuth = servidor({
      post: async () => respostaJson({ success: false, error: 'Integração Chatwoot indisponível para esta conversa.', motivo: 'conexao_indisponivel' }, 409),
    });
    await abrirComposer(fetchWithAuth);
    await escreverEEnviar('alguém aí?');

    await waitFor(() => expect(screen.getAllByText(/Integração Chatwoot indisponível/).length).toBeGreaterThan(0));
    expect(screen.getByLabelText('Mensagem')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Enviar/ })).toBeDisabled();
  });

  it('a falha tardia de A não devolve texto nenhum em B', async () => {
    let responderEnvio: (resposta: Response) => void = () => {};
    const fetchWithAuth = vi.fn((_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Promise<Response>((resolver) => { responderEnvio = resolver; })
      : Promise.resolve(respostaJson({ success: true, envios: [] }))));
    const { espelho, conversas, mensagens } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, CONVERSA);
    await abrir('Ana');
    await responder(mensagens, []);

    await escreverEEnviar('texto de A');

    await act(async () => {
      trocar(ORG_B);
    });
    await act(async () => {
      responderEnvio(respostaJson({ success: false, error: 'deu ruim' }, 502));
    });
    await responder(conversas, [conversa(9, 'Bruno de B')]);
    await abrir('Bruno de B');
    await responder(mensagens, []);

    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
    expect(screen.queryByText('texto de A')).not.toBeInTheDocument();
    expect(screen.queryByText('deu ruim')).not.toBeInTheDocument();
  });
});

describe('MensageriaDesktop — deduplicação', () => {
  it('mensagens legítimas de mesmo texto e ids distintos aparecem as duas', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');
    await responder(mensagens, [mensagem(10, 1, 'ok', '2026-09-10T12:00:00.000Z')]);

    // Mesmo conteúdo, um segundo depois: a heurística anterior (conteúdo igual
    // dentro de 5 s) descartava esta segunda mensagem para sempre.
    await act(async () => {
      assinaturas
        .find((a) => a.tipo === 'mensagens' && a.ativa)!
        .aoInserir!(mensagem(11, 1, 'ok', '2026-09-10T12:00:01.000Z'));
    });

    expect(screen.getAllByText('ok')).toHaveLength(2);
  });

  it('a mesma mensagem chegando duas vezes pelo id aparece uma vez só', async () => {
    const { espelho, conversas, mensagens, assinaturas } = criarEspelho();
    montar(espelho, ORG_A);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrir('Ana');
    await responder(mensagens, [mensagem(10, 1, 'bom dia', '2026-09-10T12:00:00.000Z')]);

    await act(async () => {
      assinaturas
        .find((a) => a.tipo === 'mensagens' && a.ativa)!
        .aoInserir!(mensagem(10, 1, 'bom dia', '2026-09-10T12:00:00.000Z'));
    });

    expect(screen.getAllByText('bom dia')).toHaveLength(1);
  });
});

describe('MensageriaDesktop — resolver e reabrir', () => {
  it('a resposta de status altera só a conversa que a iniciou', async () => {
    let responderStatus: (resposta: Response) => void = () => {};
    // Os GETs são a leitura dos envios ao abrir a conversa (MSG-008); o POST é o status.
    const fetchWithAuth = vi.fn((_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Promise<Response>((resolver) => { responderStatus = resolver; })
      : Promise.resolve(respostaJson({ success: true, envios: [] }))));
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrir('Ana');
    await responder(mensagens, []);
    await escolherNoMenu('Marcar resolvida');
    // MSG-003B: o status também referencia a conversa só pelo UUID local.
    const [, pedidoDeStatus] = fetchWithAuth.mock.calls.find(([url]) => url === '/api/chatwoot/status')!;
    expect(JSON.parse(String(pedidoDeStatus!.body))).toEqual({ conversaId: uuidDaConversa(1), status: 'resolved' });

    await abrir('Bruno');
    await responder(mensagens, []);
    await act(async () => {
      responderStatus(respostaJson({ success: true }));
    });

    // O cabeçalho aberto é o do Bruno, e ele continua aberto.
    const cabecalho = screen.getByRole('heading', { name: 'Bruno' }).closest('header')!;
    await userEvent.click(within(cabecalho).getByRole('button', { name: 'Mais ações da conversa' }));
    expect(await screen.findByRole('menuitem', { name: 'Marcar resolvida' })).toBeInTheDocument();
  });
});

/**
 * O rascunho pertence a uma conversa. Trocar de conversa não pode levar o texto
 * escrito para uma cliente ao compositor de outra, e voltar não pode perder o
 * que estava sendo escrito. A chave é a mesma que já isola o histórico:
 * organização + conversa.
 */
describe('MensageriaDesktop — rascunho por conversa', () => {
  /** Um servidor que aceita tudo: lista vazia de envios e POST de envio registrado. */
  function servidorQualquer() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sac/')) {
        return respostaJson({
          success: true, versao: 1, candidatos: [],
          verificacao: { estado: 'sem_prova', cliente: null, verificadoEm: null, expiraEm: null, totalDeCandidatos: 0, consultaPorNumeroBloqueada: false },
        });
      }
      if (url.startsWith('/api/chatwoot/controle')) {
        return respostaJson({
          success: true,
          controle: { modo: 'HUMAN_REQUIRED', responsavelId: null, souResponsavel: false, versao: 0 },
          permissoes: { devolver: false, motivoSemDevolver: 'nao_e_responsavel', automacaoAtiva: false },
        });
      }
      if (init?.method === 'POST' && url === '/api/chatwoot/send') {
        const { commandId } = JSON.parse(String(init.body));
        return respostaJson({ success: true, envio: { id: 'envio-1', commandId, estado: 'pendente', duplicado: false } }, 202);
      }
      return respostaJson({ success: true, envios: [] });
    });
  }

  const enviosDe = (fetchWithAuth: ReturnType<typeof servidorQualquer>) =>
    fetchWithAuth.mock.calls.filter(([url, init]) => init?.method === 'POST' && url === '/api/chatwoot/send')
      .map(([, init]) => JSON.parse(String(init!.body)) as { conversaId: string; content: string });

  async function abrirNaLista(nome: string, mensagens: LeituraPendente<ChatwootMessage[]>[]) {
    await abrir(nome);
    await responder(mensagens, []);
  }

  it('o rascunho da Ana não aparece no compositor do Bruno, e enviar no Bruno leva só o texto dele', async () => {
    const fetchWithAuth = servidorQualquer();
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrirNaLista('Ana', mensagens);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'para a Ana');
    await abrirNaLista('Bruno', mensagens);

    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Mensagem'), 'para o Bruno');
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));

    await waitFor(() => expect(enviosDe(fetchWithAuth)).toHaveLength(1));
    expect(enviosDe(fetchWithAuth)[0]).toMatchObject({ conversaId: uuidDaConversa(2), content: 'para o Bruno' });
  });

  it('voltar à conversa devolve o rascunho dela; o que foi enviado não volta', async () => {
    const fetchWithAuth = servidorQualquer();
    const { espelho, conversas, mensagens } = criarEspelho();
    montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, [conversa(1, 'Ana'), conversa(2, 'Bruno')]);

    await abrirNaLista('Ana', mensagens);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'para a Ana');
    await abrirNaLista('Bruno', mensagens);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'para o Bruno');
    await userEvent.click(screen.getByRole('button', { name: /Enviar/ }));
    await waitFor(() => expect(enviosDe(fetchWithAuth)).toHaveLength(1));

    await abrirNaLista('Ana', mensagens);
    expect(screen.getByLabelText('Mensagem')).toHaveValue('para a Ana');

    await abrirNaLista('Bruno', mensagens);
    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
  });

  it('trocar de organização descarta os rascunhos da anterior', async () => {
    const fetchWithAuth = servidorQualquer();
    const { espelho, conversas, mensagens } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrirNaLista('Ana', mensagens);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'rascunho em A');

    await act(async () => {
      trocar(ORG_B);
    });
    await act(async () => {
      trocar({ ...ORG_A, versao: 3 });
    });
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrirNaLista('Ana', mensagens);

    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
  });

  it('sair da sessão descarta os rascunhos, mesmo voltando à mesma organização', async () => {
    const fetchWithAuth = servidorQualquer();
    const { espelho, conversas, mensagens } = criarEspelho();
    const { trocar } = montar(espelho, ORG_A, fetchWithAuth);
    await responder(conversas, [conversa(1, 'Ana')]);
    await abrirNaLista('Ana', mensagens);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'rascunho antes de sair');

    await act(async () => {
      trocar(null);
    });
    // Mesma organização e mesma versão: a chave volta igual, e mesmo assim nada sobrevive.
    await act(async () => {
      trocar(ORG_A);
    });
    await responder(conversas, [conversa(1, 'Ana')]);
    // Com a mesma chave, a seleção carimbada volta e a Ana já está aberta.
    await responder(mensagens, []);

    expect(screen.getByRole('heading', { name: 'Ana' })).toBeInTheDocument();
    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
  });
});
